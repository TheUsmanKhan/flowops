import { getCurrentUser } from '@/lib/session'
import { db } from '@/lib/db'
import { uniqueSlug } from '@/lib/slugify'
import { createCompanySchema } from '@/lib/validations/company'
import { insertAuditLog } from '@/lib/audit'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { buildSessionPayload } from '@/lib/session-payload'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * System role seeds created for every new company.
 * roleTier = 'elevated' means they bypass ALL permission checks.
 */
const SYSTEM_ROLES = [
  { name: 'Owner', systemRoleKey: 'owner' as const },
  { name: 'Founder', systemRoleKey: 'founder' as const },
  { name: 'Co-Founder', systemRoleKey: 'co_founder' as const },
  { name: 'Investor', systemRoleKey: 'investor' as const },
]

export async function POST(req: Request) {
  // Track created record IDs so we can roll back on partial failure.
  let createdOrgId: string | null = null
  let createdCompanyId: string | null = null

  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Your session has expired. Please sign in again.')

    const body = await readBody(req)
    const parsed = createCompanySchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(
        400,
        parsed.error.issues[0]?.message ?? 'Please check the form for errors.',
      )
    }
    const d = parsed.data

    // Pre-compute unique slugs (avoids collision mid-transaction).
    const orgSlug = await uniqueSlug(d.orgName, 'organization')
    const companySlug = await uniqueSlug(d.companyName, 'company')

    // 1. Create the organization.
    const org = await db.organization.create({
      data: {
        name: d.orgName,
        slug: orgSlug,
        ownerId: user.id,
        subscriptionPlan: 'free',
        subscriptionStatus: 'active',
      },
    })
    createdOrgId = org.id

    // 2. Create the company.
    const company = await db.company.create({
      data: {
        organizationId: org.id,
        name: d.companyName,
        legalName: d.legalName || null,
        slug: companySlug,
        baseCurrency: d.baseCurrency,
        countryCode: d.countryCode,
        taxId: d.taxId || null,
        taxIdType: d.taxIdType ?? null,
        addressStreet: d.addressStreet || null,
        addressCity: d.city || null,
        addressProvince: d.province || null,
        addressPostalCode: d.postalCode || null,
        addressCountry: d.countryCode,
        timezone: d.timezone,
        createdById: user.id,
      },
    })
    createdCompanyId = company.id

    // 3. Seed the 4 system roles in a SINGLE batch insert (1 DB round-trip
    //    instead of 4). systemRoleKey is unique per-company, so this is safe.
    await db.role.createMany({
      data: SYSTEM_ROLES.map((sr) => ({
        companyId: company.id,
        name: sr.name,
        roleTier: 'elevated',
        isSystemRole: true,
        systemRoleKey: sr.systemRoleKey,
        createdById: user.id,
      })),
    })

    // 4. Fetch the owner role back (createMany doesn't return records).
    const ownerRole = await db.role.findFirst({
      where: { companyId: company.id, systemRoleKey: 'owner' },
      select: { id: true },
    })
    if (!ownerRole) {
      throw new Error('Failed to seed the Owner role.')
    }

    // 5. Make the creator the first employee (Owner).
    const employee = await db.employee.create({
      data: {
        companyId: company.id,
        userId: user.id,
        roleId: ownerRole.id,
        designation: 'Owner',
        status: 'active',
        invitedById: user.id,
      },
    })

    // 6. Activate the new workspace + mark the user as onboarded.
    await db.userSetting.upsert({
      where: { userId: user.id },
      update: {
        activeCompanyId: company.id,
        activeOrgId: org.id,
      },
      create: {
        userId: user.id,
        activeCompanyId: company.id,
        activeOrgId: org.id,
      },
    })
    await db.profile.update({
      where: { id: user.id },
      data: { isOnboarded: true },
    })

    // 7. Audit logs (non-blocking — failures are logged but don't break flow).
    insertAuditLog({
      action: 'organization.created',
      entityType: 'organization',
      entityId: org.id,
      organizationId: org.id,
      userId: user.id,
      newValues: { name: org.name, slug: org.slug },
    })
    insertAuditLog({
      action: 'company.created',
      entityType: 'company',
      entityId: company.id,
      companyId: company.id,
      organizationId: org.id,
      userId: user.id,
      employeeId: employee.id,
      newValues: {
        name: company.name,
        slug: company.slug,
        baseCurrency: company.baseCurrency,
      },
    })
    insertAuditLog({
      action: 'employee.joined',
      entityType: 'employee',
      entityId: employee.id,
      companyId: company.id,
      organizationId: org.id,
      userId: user.id,
      employeeId: employee.id,
      newValues: { role: 'Owner', status: 'active' },
    })

    // 7b. Auto-create company_order_settings (OMS — both flags default FALSE)
    try {
      const { ensureCompanyOrderSettings } = await import('@/lib/actions/order-settings.actions')
      await ensureCompanyOrderSettings(company.id)
    } catch (e) {
      console.error('[order-settings] Failed to auto-create (non-blocking):', e)
    }

    // 7c. Seed the 5 default HR roles (Sales, Sales Manager, Inventory Manager,
    // Warehouse Staff, Manager) so the new company is immediately usable for
    // non-Owner employees. Idempotent.
    try {
      const { seedDefaultRolesForCompany } = await import('@/lib/seed-default-roles')
      await seedDefaultRolesForCompany(company.id, user.id)
    } catch (e) {
      console.error('[seed-default-roles] Failed to seed (non-blocking):', e)
    }

    // 8. Return the fresh session payload.
    const payload = await buildSessionPayload(user.id)
    return Response.json(payload)
  } catch (err) {
    // Roll back partial creates so the user can retry cleanly.
    // (Slugs are globally unique, so leftover org/company rows would block
    // a retry with the same name.)
    if (createdCompanyId) {
      try {
        await db.company.delete({ where: { id: createdCompanyId } })
      } catch {
        /* best-effort */
      }
    }
    if (createdOrgId) {
      try {
        await db.organization.delete({ where: { id: createdOrgId } })
      } catch {
        /* best-effort */
      }
    }

    // Translate Prisma unique-constraint violations into friendly messages.
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    ) {
      return Response.json(
        {
          error:
            'That organization or company name is already taken. Please try a different name.',
        },
        { status: 409 },
      )
    }
    return handleError(err)
  }
}
