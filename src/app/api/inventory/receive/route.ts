import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { processInventoryTransaction } from '@/lib/inventory'
import { receiveStockSchema } from '@/lib/validations/inventory'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Receive stock directly (not against a PO) — also used for opening stock.
 * For EACH item: calls processInventoryTransaction with type 'opening_stock'
 * if first-ever transaction for the variant+location, else 'purchase_received'.
 */
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
    if (!orgId || !company) throw new ApiError(403, 'No active company')

    const caller = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_RECEIVE },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to receive stock.')

    const body = await readBody(req)
    const parsed = receiveStockSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    const d = parsed.data

    const transactionIds: string[] = []
    let preMadeStitchedStockAdded = false

    for (const item of d.items) {
      // Check if this is the first-ever transaction for this variant+location
      const existingTxnCount = await db.inventoryTransaction.count({
        where: { orgVariantId: item.org_variant_id, locationId: d.location_id },
      })
      const txnType = existingTxnCount === 0 ? 'opening_stock' : 'purchase_received'

      // Check if variant is made_to_order with track_inventory = FALSE
      const variant = await db.orgProductVariant.findUnique({
        where: { id: item.org_variant_id },
        select: { fulfillmentType: true, trackInventory: true },
      })
      if (variant?.fulfillmentType === 'made_to_order' && !variant.trackInventory) {
        preMadeStitchedStockAdded = true
      }

      const txnResult = await processInventoryTransaction({
        orgVariantId: item.org_variant_id,
        locationId: d.location_id,
        organizationId: orgId,
        companyId: company.id,
        employeeId: caller.id,
        transactionType: txnType,
        quantity: item.quantity,
        costPerUnit: item.cost_per_unit,
        referenceType: 'manual',
        notes: d.notes || d.po_reference || undefined,
      })

      if (!txnResult.success) {
        throw new ApiError(500, `Failed to receive ${item.org_variant_id}: ${txnResult.error}`)
      }
      transactionIds.push(txnResult.transactionId!)

      await insertAuditLog({
        action: txnType === 'opening_stock' ? 'stock.opening' : 'stock.received',
        entityType: 'variant',
        entityId: item.org_variant_id,
        companyId: company.id,
        organizationId: orgId,
        userId: user.id,
        employeeId: caller.id,
        newValues: { quantity: item.quantity, costPerUnit: item.cost_per_unit, locationId: d.location_id },
      })
    }

    // ── Metric event (CRITICAL — powers stock value / procurement KPIs) ──
    const totalValue = d.items.reduce(
      (sum, item) => sum + item.quantity * item.cost_per_unit,
      0,
    )
    const totalQuantity = d.items.reduce((sum, item) => sum + item.quantity, 0)
    const firstVariantId = d.items[0]?.org_variant_id ?? d.location_id
    await insertMetricEvent({
      companyId: company.id,
      entityType: 'product',
      entityId: firstVariantId,
      metricKey: 'inventory.stock_received',
      numericValue: totalValue,
      dimensions: {
        item_count: d.items.length,
        location_id: d.location_id,
        total_quantity: totalQuantity,
      },
    })

    return Response.json({ success: true, transaction_ids: transactionIds, preMadeStitchedStockAdded })
  } catch (err) {
    return handleError(err)
  }
}
