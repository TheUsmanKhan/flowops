import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Update a supplier. */
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
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_MANAGE_SUPPLIERS },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to manage suppliers.')

    const { id } = await params
    const supplier = await db.supplier.findFirst({ where: { id, organizationId: orgId } })
    if (!supplier) throw new ApiError(404, 'Supplier not found.')

    const body = await readBody<{
      name?: string
      contactPerson?: string
      phone?: string
      email?: string
      paymentTerms?: string
      isActive?: boolean
    }>(req)

    const oldValues = { name: supplier.name, phone: supplier.phone, isActive: supplier.isActive }
    const updated = await db.supplier.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.contactPerson !== undefined ? { contactPerson: body.contactPerson || null } : {}),
        ...(body.phone !== undefined ? { phone: body.phone || null } : {}),
        ...(body.email !== undefined ? { email: body.email || null } : {}),
        ...(body.paymentTerms ? { paymentTerms: body.paymentTerms } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    })

    insertAuditLog({
      action: 'supplier.updated',
      entityType: 'supplier',
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

/** Deactivate a supplier (never hard-delete). */
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
      throw new ApiError(403, 'Only elevated employees can deactivate suppliers.')
    }

    const { id } = await params
    const supplier = await db.supplier.findFirst({ where: { id, organizationId: orgId } })
    if (!supplier) throw new ApiError(404, 'Supplier not found.')

    await db.supplier.update({ where: { id }, data: { isActive: false } })

    insertAuditLog({
      action: 'supplier.deactivated',
      entityType: 'supplier',
      entityId: id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues: { name: supplier.name },
    })

    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
