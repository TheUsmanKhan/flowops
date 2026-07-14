import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Update a location. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

    const { id } = await params
    const location = await db.inventoryLocation.findFirst({ where: { id, organizationId: orgId } })
    if (!location) throw new ApiError(404, 'Location not found.')

    const body = await readBody<{
      name?: string
      locationType?: string
      city?: string
      province?: string
      contactPerson?: string
      contactPhone?: string
      isDefault?: boolean
      isActive?: boolean
    }>(req)

    const oldValues = { name: location.name, isDefault: location.isDefault, isActive: location.isActive }
    const updated = await db.inventoryLocation.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.locationType ? { locationType: body.locationType } : {}),
        ...(body.city ? { city: body.city } : {}),
        ...(body.province ? { province: body.province } : {}),
        ...(body.contactPerson !== undefined ? { contactPerson: body.contactPerson || null } : {}),
        ...(body.contactPhone !== undefined ? { contactPhone: body.contactPhone || null } : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    })

    await insertAuditLog({
      action: 'location.updated',
      entityType: 'location',
      entityId: id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues,
      newValues: body,
    })

    return Response.json({ id: updated.id })
  } catch (err) {
    return handleError(err)
  }
}

/** Deactivate a location (never hard-delete). */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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
    if (caller.role.roleTier !== 'elevated') {
      throw new ApiError(403, 'Only elevated employees can deactivate locations.')
    }

    const { id } = await params
    const location = await db.inventoryLocation.findFirst({ where: { id, organizationId: orgId } })
    if (!location) throw new ApiError(404, 'Location not found.')

    await db.inventoryLocation.update({ where: { id }, data: { isActive: false, isDefault: false } })

    await insertAuditLog({
      action: 'location.deactivated',
      entityType: 'location',
      entityId: id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues: { name: location.name },
    })

    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
