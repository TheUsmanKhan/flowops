import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** List locations visible to the active company (org-level shared + company-level). */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    const orgId = settings?.activeOrgId
    if (!companyId || !orgId) throw new ApiError(403, 'No active company')

    const locations = await db.inventoryLocation.findMany({
      where: {
        organizationId: orgId,
        isActive: true,
        OR: [
          { companyId: null }, // org-level shared
          { companyId }, // company-level private
        ],
      },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    })

    return Response.json({
      locations: locations.map((l) => ({
        id: l.id,
        name: l.name,
        locationType: l.locationType,
        city: l.city,
        province: l.province,
        countryCode: l.countryCode,
        isOrgLevel: l.companyId === null,
        isDefault: l.isDefault,
        contactPerson: l.contactPerson,
        contactPhone: l.contactPhone,
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}

/** Create a location. */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const orgId = settings?.activeOrgId
    const company = settings?.activeCompany
    if (!orgId || !company) throw new ApiError(403, 'No active organization')

    const caller = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_MANAGE_LOCATIONS },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to manage locations.')

    const body = await readBody<{
      name?: string
      locationType?: string
      city?: string
      province?: string
      isOrgLevel?: boolean
      contactPerson?: string
      contactPhone?: string
      isDefault?: boolean
    }>(req)
    if (!body.name || body.name.trim().length < 2) {
      throw new ApiError(400, 'Location name is required')
    }

    // If is_default = true, unset any existing default for this company scope
    const scopeCompanyId = body.isOrgLevel ? null : company.id
    if (body.isDefault) {
      await db.inventoryLocation.updateMany({
        where: {
          organizationId: orgId,
          companyId: scopeCompanyId,
          isDefault: true,
        },
        data: { isDefault: false },
      })
    }

    const location = await db.inventoryLocation.create({
      data: {
        organizationId: orgId,
        companyId: body.isOrgLevel ? null : company.id,
        name: body.name.trim(),
        locationType: body.locationType || 'warehouse',
        city: body.city || 'Lahore',
        province: body.province || 'Punjab',
        contactPerson: body.contactPerson || null,
        contactPhone: body.contactPhone || null,
        isDefault: body.isDefault ?? false,
        createdById: caller.id,
      },
    })

    insertAuditLog({
      action: 'location.created',
      entityType: 'location',
      entityId: location.id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { name: location.name, isOrgLevel: body.isOrgLevel },
    })

    return Response.json({ id: location.id, name: location.name })
  } catch (err) {
    return handleError(err)
  }
}
