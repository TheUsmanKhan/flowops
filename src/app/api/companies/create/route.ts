import { getCurrentUser } from '@/lib/session'
import { db } from '@/lib/db'
import { uniqueSlug } from '@/lib/slugify'
import { createCompanySchema } from '@/lib/validations/organization'
import { insertAuditLog } from '@/lib/audit'
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
 * createCompany — adds a new company to an EXISTING organization.
 * Caller must own the organization. Used by the Create Company wizard.
 */
export async function POST(req: Request) {
  let createdCompanyId: string | null = null

  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Your session has expired. Please sign in again.')

    const body = await readBody<{
      organization_id?: string
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

    const parsed = createCompanySchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(
        400,
        parsed.error.issues[0]?.message ?? 'Please check the form for errors.',
      )
    }
    const d = parsed.data

    // Verify the user owns this organization.
    const org = await db.organization.findFirst({
      where: { id: d.organization_id, ownerId: user.id, isActive: true },
    })
    if (!org) {
      throw new ApiError(403, 'You do not own this organization, or it no longer exists.')
    }

    const companySlug = await uniqueSlug(d.company_name, 'company')

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

    // Seed the 4 system roles.
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

    // Switch the caller's active workspace to the new company.
    await db.userSetting.upsert({
      where: { userId: user.id },
      update: { activeCompanyId: company.id, activeOrgId: org.id },
      create: { userId: user.id, activeCompanyId: company.id, activeOrgId: org.id },
    })

    insertAuditLog({
      action: 'company.created',
      entityType: 'company',
      entityId: company.id,
      companyId: company.id,
      organizationId: org.id,
      userId: user.id,
      employeeId: employee.id,
      newValues: { name: company.name, slug: company.slug, baseCurrency: company.baseCurrency },
    })

    // Auto-create company_order_settings (OMS — both flags default FALSE)
    try {
      const { ensureCompanyOrderSettings } = await import('@/lib/actions/order-settings.actions')
      await ensureCompanyOrderSettings(company.id)
    } catch (e) {
      console.error('[order-settings] Failed to auto-create (non-blocking):', e)
    }

    // Seed the 5 default HR roles (Sales, Sales Manager, Inventory Manager,
    // Warehouse Staff, Manager) so the company is immediately usable for
    // non-Owner employees. Idempotent — skips if already exist.
    try {
      const { seedDefaultRolesForCompany } = await import('@/lib/seed-default-roles')
      const created = await seedDefaultRolesForCompany(company.id, user.id)
      if (created > 0) {
        console.log(`[company-create] Seeded ${created} default roles for company ${company.id}`)
      }
    } catch (e) {
      console.error('[seed-default-roles] Failed to seed (non-blocking):', e)
    }

    return Response.json(await buildSessionPayload(user.id))
  } catch (err) {
    if (createdCompanyId) {
      try { await db.company.delete({ where: { id: createdCompanyId } }) } catch { /* best-effort */ }
    }
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    ) {
      return Response.json(
        { error: 'That company name is already taken. Please try a different name.' },
        { status: 409 },
      )
    }
    return handleError(err)
  }
}
