import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getWorkspace, handleError, readBody, ApiError, requirePermission } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { processOrderReturn } from '@/lib/actions/order-return.actions'
import { recordStockLoss } from '@/lib/stock-loss'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/scan/confirm-return
 *
 * One-go return confirmation: confirms RTO, and optionally records damage —
 * all in a single request. This eliminates the 3-module flow (Scan → Order
 * Detail → Returns Review Queue) that was required before.
 *
 * This is the user's point #5: "when we scan a return, RTO confirmation
 * should happen in one go, AND damage/transit-loss options should be
 * available right there."
 *
 * Body:
 *   - orderId: string (the order being returned)
 *   - condition: 'perfect' | 'good' | 'damaged'
 *   - returnReason: string (why the customer returned it)
 *   - damageType?: string (required if condition='damaged')
 *   - notes?: string
 */
export async function POST(req: NextRequest) {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)

    const body = await readBody<{
      orderId?: string
      condition?: 'perfect' | 'good' | 'damaged'
      returnReason?: string
      damageType?: string
      notes?: string
    }>(req)

    if (!body.orderId) {
      throw new ApiError(400, 'orderId is required')
    }
    if (!body.condition || !['perfect', 'good', 'damaged'].includes(body.condition)) {
      throw new ApiError(400, 'condition must be one of: perfect, good, damaged')
    }
    if (!body.returnReason?.trim()) {
      throw new ApiError(400, 'returnReason is required')
    }

    // ── 1. Validate the order ──
    const order = await db.order.findFirst({
      where: { id: body.orderId, companyId: ctx.company.id },
      include: {
        items: {
          select: {
            id: true,
            orgVariantId: true,
            quantity: true,
            fulfillmentTypeSnapshot: true,
            reservedLocationId: true,
          },
        },
      },
    })
    if (!order) {
      throw new ApiError(404, 'Order not found.')
    }

    // ── 2. Confirm RTO ──
    // F2 fix: pass the scanned condition to processOrderReturn so it picks
    // the right inventory transaction type per item:
    //   - condition='perfect' | 'good': creates +return_resellable /
    //     +return_stitched_received (adds stock back).
    //   - condition='damaged': creates ONE return_damaged txn per item
    //     (NO pool change — stock stays decremented from the original
    //     sale_dispatched). Previously, the damaged path created TWO
    //     offsetting transactions per item (+return_resellable then
    //     -damage_writeoff via recordStockLoss), which was net-zero on
    //     onHand but generated 2 noisy ledger entries.
    const returnResult = await processOrderReturn(
      body.orderId,
      body.returnReason.trim(),
      { condition: body.condition },
    )
    if (!returnResult.success) {
      throw new ApiError(400, returnResult.error ?? 'Failed to process return')
    }

    // ── 3. If damaged, record the loss ──
    // F2 fix: call recordStockLoss with createInventoryTransaction=false
    // because processOrderReturn already created the single return_damaged
    // ledger entry per item. A separate damage_writeoff txn would
    // double-decrement onHand AND re-introduce the 2-txn-per-item noise.
    // We just need the StockLossRecord for the Stock Losses dashboard +
    // financial reporting.
    let lossResult: { wasDuplicate: boolean; lossRecordId: string | null } = {
      wasDuplicate: false,
      lossRecordId: null,
    }

    if (body.condition === 'damaged') {
      const locationId = order.dispatchLocationId
      if (!locationId) {
        throw new ApiError(400, 'Order has no dispatch location — cannot record damage.')
      }

      for (const item of order.items) {
        if (!item.orgVariantId) continue

        const pool = await db.inventoryPool.findUnique({
          where: {
            orgVariantId_locationId: {
              orgVariantId: item.orgVariantId,
              locationId,
            },
          },
          select: { avgCost: true },
        })
        const avgCost = pool ? Number(pool.avgCost) : 0

        const result = await recordStockLoss({
          organizationId: ctx.company.organizationId,
          companyId: ctx.company.id,
          orgVariantId: item.orgVariantId,
          locationId,
          lossType: 'damaged',
          sourceModule: 'return_scan',
          quantity: item.quantity,
          costPerUnit: avgCost,
          orderItemId: item.id,
          employeeId: ctx.employee.id,
          subType: 'confirmed',
          damageType: body.damageType || 'other',
          responsibleParty: 'courier',
          notes: `Damaged return confirmed via Return Order Scan. Order: ${order.flowopsOrderNumber}. Reason: ${body.returnReason}. ${body.notes || ''}`,
          // F2 fix: do NOT create another inventory transaction —
          // processOrderReturn already created the single return_damaged
          // txn per item. Setting this to false creates ONLY the
          // StockLossRecord (for the Stock Losses dashboard + financial
          // reporting) without an additional damage_writeoff ledger entry.
          createInventoryTransaction: false,
        })

        if (result.success && result.wasDuplicate) {
          lossResult.wasDuplicate = true
        }
        if (result.success && result.lossRecordId) {
          lossResult.lossRecordId = result.lossRecordId
        }
      }
    }

    insertAuditLog({
      action: 'order.return_confirmed_via_scan',
      entityType: 'order',
      entityId: body.orderId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: {
        condition: body.condition,
        returnReason: body.returnReason,
        damageType: body.damageType || null,
        lossRecordId: lossResult.lossRecordId,
        wasDuplicate: lossResult.wasDuplicate,
      },
    })

    return Response.json({
      success: true,
      orderId: body.orderId,
      flowopsOrderNumber: order.flowopsOrderNumber,
      condition: body.condition,
      lossRecordId: lossResult.lossRecordId,
      wasDuplicate: lossResult.wasDuplicate,
      message:
        body.condition === 'damaged'
          ? lossResult.wasDuplicate
            ? 'Return confirmed + damage was already recorded (dedup — no duplicate created). Stock stays decremented (damaged, not resellable).'
            : 'Return confirmed + damage recorded. Stock stays decremented (damaged, not resellable).'
          : 'Return confirmed. Item added back to inventory.',
    })
  } catch (err) {
    return handleError(err)
  }
}
