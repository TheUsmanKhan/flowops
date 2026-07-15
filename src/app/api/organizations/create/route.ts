import { getCurrentUser } from '@/lib/session'
import { db } from '@/lib/db'
import { uniqueSlug } from '@/lib/slugify'
import { createOrganizationSchema } from '@/lib/validations/organization'
import { insertAuditLog } from '@/lib/audit'
import { seedDefaultAttributes } from '@/lib/attribute-seeding'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { buildSessionPayload } from '@/lib/session-payload'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SYSTEM_ROLES = [
  { name: 'Owner', systemRoleKey: 'owner' as const },
  { name: 'Founder', systemRoleKey: 'founder' as const },
  { name: 'Co-Founder', systemRoleKey: 'co_founder' as const },
  { name: 'Investor', systemRoleKey: 'investor' as const },
]

/**
 * createOrganization — creates a brand new organization AND its first company.
 * The caller becomes the Owner of both. Used by the Create Organization wizard.
 * Logos are uploaded separately via /api/upload; this route receives URLs.
 */
export async function POST(req: Request) {
  let createdOrgId: string | null = null
  let createdCompanyId: string | null = null

  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Your session has expired. Please sign in again.')

    const body = await readBody<{
      org_name?: string
      org_logo_url?: string
      org_description?: string
      org_website?: string
      company_name?: string
      company_legal_name?: string
      company_logo_url?: string
      base_currency?: string
      country_code?: string
      province?: string
      city?: string
      address?: string
      phone?: string
      email?: string
      website?: string
      ntn?: string
      strn?: string
      timezone?: string
      fiscal_year_start?: number
    }>(req)

    const parsed = createOrganizationSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(
        400,
        parsed.error.issues[0]?.message ?? 'Please check the form for errors.',
      )
    }
    const d = parsed.data

    const orgSlug = await uniqueSlug(d.org_name, 'organization')
    const companySlug = await uniqueSlug(d.company_name, 'company')

    // 1. Create the organization.
    const org = await db.organization.create({
      data: {
        name: d.org_name,
        slug: orgSlug,
        logoUrl: body.org_logo_url || null,
        ownerId: user.id,
        subscriptionPlan: 'free',
        subscriptionStatus: 'active',
      },
    })
    createdOrgId = org.id

    // 2. Create the first company.
    const company = await db.company.create({
      data: {
        organizationId: org.id,
        name: d.company_name,
        legalName: d.company_legal_name || null,
        slug: companySlug,
        logoUrl: body.company_logo_url || null,
        baseCurrency: d.base_currency,
        countryCode: d.country_code,
        taxId: d.ntn || null,
        taxIdType: d.ntn ? 'NTN' : null,
        addressStreet: d.address || null,
        addressCity: d.city || null,
        addressProvince: d.province || null,
        addressCountry: d.country_code,
        phone: d.phone || null,
        email: d.email || null,
        website: d.website || null,
        timezone: d.timezone || 'Asia/Karachi',
        fiscalYearStart: d.fiscal_year_start || 1,
        createdById: user.id,
      },
    })
    createdCompanyId = company.id

    // 3. Seed the 4 system roles (batch).
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

    // 4. Make the creator the Owner employee.
    const ownerRole = await db.role.findFirst({
      where: { companyId: company.id, systemRoleKey: 'owner' },
      select: { id: true },
    })
    if (!ownerRole) throw new Error('Failed to seed the Owner role.')

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

    // 5. Activate the new workspace + mark onboarded.
    await db.userSetting.upsert({
      where: { userId: user.id },
      update: { activeCompanyId: company.id, activeOrgId: org.id },
      create: { userId: user.id, activeCompanyId: company.id, activeOrgId: org.id },
    })
    await db.profile.update({
      where: { id: user.id },
      data: { isOnboarded: true },
    })

    // 6. Audit logs.
    await insertAuditLog({
      action: 'organization.created',
      entityType: 'organization',
      entityId: org.id,
      organizationId: org.id,
      userId: user.id,
      newValues: { name: org.name, slug: org.slug },
    })
    await insertAuditLog({
      action: 'company.created',
      entityType: 'company',
      entityId: company.id,
      companyId: company.id,
      organizationId: org.id,
      userId: user.id,
      employeeId: employee.id,
      newValues: { name: company.name, slug: company.slug, baseCurrency: company.baseCurrency },
    })

    // 7. Seed default attributes (Piece Type, Size, Color, Fabric + Unstitched→OneSize rule)
    try {
      await seedDefaultAttributes(org.id, employee.id)
    } catch (e) {
      console.error('[attribute-seeding] Failed (non-blocking):', e)
    }

    return Response.json(await buildSessionPayload(user.id))
  } catch (err) {
    // Roll back partial creates.
    if (createdCompanyId) {
      try { await db.company.delete({ where: { id: createdCompanyId } }) } catch { /* best-effort */ }
    }
    if (createdOrgId) {
      try { await db.organization.delete({ where: { id: createdOrgId } }) } catch { /* best-effort */ }
    }
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    ) {
      return Response.json(
        { error: 'That organization or company name is already taken. Please try a different name.' },
        { status: 409 },
      )
    }
    return handleError(err)
  }
}
