import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Resolve a supplier return.
 * Sets status + resolution_type + resolution_amount.
 * If resolution = 'credit_note': increments the supplier's credit_balance.
 */
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
    const companyId = settings?.activeCompanyId
    const orgId = settings?.activeOrgId
    if (!companyId || !orgId) throw new ApiError(403, 'No active company')

    const { id } = await params
    const record = await db.supplierReturn.findFirst({ where: { id, companyId } })
    if (!record) throw new ApiError(404, 'Supplier return not found.')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_MANAGE_SUPPLIER_RETURNS },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to resolve supplier returns.')

    const body = await readBody<{
      status?: string
      resolution_type?: string
      resolution_amount?: number
      notes?: string
    }>(req)

    const oldValues = { status: record.status, resolutionType: record.resolutionType }

    const updated = await db.supplierReturn.update({
      where: { id },
      data: {
        ...(body.status ? { status: body.status } : {}),
        ...(body.resolution_type !== undefined ? { resolutionType: body.resolution_type || null } : {}),
        ...(body.resolution_amount !== undefined ? { resolutionAmount: body.resolution_amount } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        resolvedById: caller.id,
        resolvedAt: new Date(),
      },
    })

    // If resolution = credit_note: increment supplier's credit_balance
    if (body.resolution_type === 'credit_note' && body.resolution_amount) {
      await db.supplier.update({
        where: { id: record.supplierId },
        data: { creditBalance: { increment: body.resolution_amount } },
      })
    }

    await insertAuditLog({
      action: 'supplier_return.resolved',
      entityType: 'supplier_return',
      entityId: id,
      companyId,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues,
      newValues: body,
    })

    return Response.json({ id: updated.id, status: updated.status })
  } catch (err) {
    return handleError(err)
  }
}
