import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { incrementIncomingStock } from '@/lib/inventory'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Confirm a draft PO → ordered.
 * Triggers incoming stock increment for each item.
 */
export async function POST(
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
    if (po.status !== 'draft') throw new ApiError(400, `PO is not a draft (status: ${po.status}).`)

    // Update status
    await db.purchaseOrder.update({
      where: { id: poId },
      data: { status: 'ordered' },
    })

    // Increment incoming stock for each item
    for (const item of po.items) {
      await incrementIncomingStock(
        item.orgVariantId,
        po.deliveryLocationId,
        orgId,
        item.orderedQuantity,
      )
    }

    insertAuditLog({
      action: 'purchase_order.confirmed',
      entityType: 'purchase_order',
      entityId: poId,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { status: 'ordered', itemCount: po.items.length },
    })

    insertMetricEvent({
      companyId: company.id,
      entityType: 'purchase_order',
      entityId: poId,
      metricKey: 'purchase_order.confirmed',
      numericValue: 1,
      dimensions: { supplier_id: po.supplierId },
    })

    return Response.json({ success: true, status: 'ordered' })
  } catch (err) {
    return handleError(err)
  }
}
