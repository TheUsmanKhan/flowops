import { getCurrentUser } from '@/lib/session'
import { db } from '@/lib/db'
import { uniqueSlug } from '@/lib/slugify'
import { createCompanySchema } from '@/lib/validations/company'
import { insertAuditLog } from '@/lib/audit'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { buildSessionPayload } from '@/lib/session-payload'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** System role seeds created for every new company. */
const SYSTEM_ROLES = [
  { name: 'Owner', systemRoleKey: 'owner', roleTier: 'elevated' },
  { name: 'Founder', systemRoleKey: 'founder', roleTier: 'elevated' },
  { name: 'Co-Founder', systemRoleKey: 'co_founder', roleTier: 'elevated' },
  { name: 'Investor', systemRoleKey: 'investor', roleTier: 'elevated' },
] as const

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const body = await readBody(req)
    const parsed = createCompanySchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    }
    const d = parsed.data

    const orgSlug = await uniqueSlug(d.orgName, 'organization')
    const companySlug = await uniqueSlug(d.companyName, 'company')

    // Sequential operations (avoids interactive-transaction issues with the
    // Supabase pooled connection). Onboarding is a low-frequency, idempotent
    // flow; a failure mid-way leaves a partial org/company that the user can
    // retry with a different name (slugs are unique).
    const org = await db.organization.create({
      data: {
        name: d.orgName,
        slug: orgSlug,
        ownerId: user.id,
        subscriptionPlan: 'free',
        subscriptionStatus: 'active',
      },
    })

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

    // Seed the 4 system (elevated) roles.
    const roles: { id: string; systemRoleKey: string }[] = []
    for (const sr of SYSTEM_ROLES) {
      roles.push(
        await db.role.create({
          data: {
            companyId: company.id,
            name: sr.name,
            roleTier: sr.roleTier,
            isSystemRole: true,
            systemRoleKey: sr.systemRoleKey,
            createdById: user.id,
          },
          select: { id: true, systemRoleKey: true },
        }),
      )
    }
    const ownerRole = roles.find((r) => r.systemRoleKey === 'owner')!

    // Owner becomes the first employee.
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

    // Activate the new workspace + mark onboarded.
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

    const result = { org, company, employee, ownerRole }

    await insertAuditLog({
      action: 'organization.created',
      entityType: 'organization',
      entityId: result.org.id,
      organizationId: result.org.id,
      userId: user.id,
      newValues: { name: result.org.name, slug: result.org.slug },
    })
    await insertAuditLog({
      action: 'company.created',
      entityType: 'company',
      entityId: result.company.id,
      companyId: result.company.id,
      organizationId: result.org.id,
      userId: user.id,
      employeeId: result.employee.id,
      newValues: {
        name: result.company.name,
        slug: result.company.slug,
        baseCurrency: result.company.baseCurrency,
      },
    })
    await insertAuditLog({
      action: 'employee.joined',
      entityType: 'employee',
      entityId: result.employee.id,
      companyId: result.company.id,
      organizationId: result.org.id,
      userId: user.id,
      employeeId: result.employee.id,
      newValues: { role: 'Owner', status: 'active' },
    })

    const payload = await buildSessionPayload(user.id)
    return Response.json(payload)
  } catch (err) {
    return handleError(err)
  }
}
