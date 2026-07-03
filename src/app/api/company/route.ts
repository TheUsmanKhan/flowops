import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { updateCompanySchema } from '@/lib/validations/company'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Fetch the active company's full profile. */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const company = settings?.activeCompany
    if (!company) throw new ApiError(403, 'No active company')

    const org = await db.organization.findUnique({
      where: { id: company.organizationId },
    })

    return Response.json({
      company: {
        id: company.id,
        name: company.name,
        legalName: company.legalName,
        slug: company.slug,
        baseCurrency: company.baseCurrency,
        countryCode: company.countryCode,
        taxId: company.taxId,
        taxIdType: company.taxIdType,
        timezone: company.timezone,
        email: company.email,
        phone: company.phone,
        website: company.website,
        addressStreet: company.addressStreet,
        addressCity: company.addressCity,
        addressProvince: company.addressProvince,
        addressPostalCode: company.addressPostalCode,
        addressCountry: company.addressCountry,
        fiscalYearStart: company.fiscalYearStart,
        organizationId: company.organizationId,
      },
      organization: org
        ? {
            id: org.id,
            name: org.name,
            slug: org.slug,
            subscriptionPlan: org.subscriptionPlan,
            subscriptionStatus: org.subscriptionStatus,
            ownerId: org.ownerId,
          }
        : null,
    })
  } catch (err) {
    return handleError(err)
  }
}

/** Update the active company's profile (elevated or settings.company.edit). */
export async function PATCH(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const company = settings?.activeCompany
    if (!company) throw new ApiError(403, 'No active company')

    const caller = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: {
          roleId: caller.roleId,
          permissionKey: PERMISSIONS.SETTINGS_COMPANY_EDIT,
        },
      })) > 0
    if (!allowed) {
      throw new ApiError(403, 'You lack permission to edit company settings.')
    }

    const body = await readBody(req)
    const parsed = updateCompanySchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    }
    const d = parsed.data

    const oldValues = {
      name: company.name,
      legalName: company.legalName,
      taxId: company.taxId,
      baseCurrency: company.baseCurrency,
      email: company.email,
      phone: company.phone,
    }

    const updated = await db.company.update({
      where: { id: company.id },
      data: {
        ...(d.name ? { name: d.name } : {}),
        ...(d.legalName !== undefined ? { legalName: d.legalName || null } : {}),
        ...(d.taxId !== undefined ? { taxId: d.taxId || null } : {}),
        ...(d.taxIdType ? { taxIdType: d.taxIdType } : {}),
        ...(d.baseCurrency ? { baseCurrency: d.baseCurrency } : {}),
        ...(d.email !== undefined ? { email: d.email || null } : {}),
        ...(d.phone !== undefined ? { phone: d.phone || null } : {}),
        ...(d.website !== undefined ? { website: d.website || null } : {}),
        ...(d.addressStreet !== undefined ? { addressStreet: d.addressStreet || null } : {}),
        ...(d.addressCity !== undefined ? { addressCity: d.addressCity || null } : {}),
        ...(d.addressProvince !== undefined ? { addressProvince: d.addressProvince || null } : {}),
        ...(d.addressPostalCode !== undefined ? { addressPostalCode: d.addressPostalCode || null } : {}),
        ...(d.addressCountry !== undefined ? { addressCountry: d.addressCountry || null } : {}),
      },
    })

    await insertAuditLog({
      action: 'company.updated',
      entityType: 'company',
      entityId: company.id,
      companyId: company.id,
      organizationId: company.organizationId,
      userId: user.id,
      employeeId: caller.id,
      oldValues,
      newValues: d,
    })

    return Response.json({ id: updated.id })
  } catch (err) {
    return handleError(err)
  }
}
