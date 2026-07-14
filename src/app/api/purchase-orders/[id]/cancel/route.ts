import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { decrementIncomingStock } from '@/lib/inventory'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Cancel a purchase order.
 * For each unreceived item: decrement incoming stock.
 */
export async function POST(
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
    if (!orgId || !company) throw new ApiError(403, 'No active company')

    const caller = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_MANAGE_PURCHASE_ORDERS },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to manage purchase orders.')

    const { id: poId } = await params
    const po = await db.purchaseOrder.findFirst({
      where: { id: poId, companyId: company.id },
      include: { items: true },
    })
    if (!po) throw new ApiError(404, 'Purchase order not found.')
    if (po.status === 'cancelled') throw new ApiError(400, 'PO is already cancelled.')
    if (po.status === 'received') throw new ApiError(400, 'Cannot cancel a fully received PO.')

    const body = await readBody<{ reason?: string }>(req)
    const reason = body.reason || 'No reason provided'

    // Decrement incoming for each unreceived item
    for (const item of po.items) {
      const unreceived = item.orderedQuantity - item.receivedQuantity
      if (unreceived > 0) {
        await decrementIncomingStock(item.orgVariantId, po.deliveryLocationId, unreceived)
      }
    }

    await db.purchaseOrder.update({
      where: { id: poId },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledById: caller.id,
        cancellationReason: reason,
      },
    })

    await insertAuditLog({
      action: 'purchase_order.cancelled',
      entityType: 'purchase_order',
      entityId: poId,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { reason },
    })

    return Response.json({ success: true, status: 'cancelled' })
  } catch (err) {
    return handleError(err)
  }
}
