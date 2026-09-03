/**
 * OMS Step 4 — Return/RTO processing.
 *
 * When an order's status transitions to 'rto' (Return To Origin), the
 * system auto-processes each order_item:
 *   - made_to_order: calls processInventoryTransaction with type
 *     'return_stitched_received' (condition='perfect' assumption),
 *     which flips track_inventory to TRUE and adds stock back.
 *   - stock_based: calls processInventoryTransaction with type
 *     'return_resellable' (condition='resellable' assumption).
 *
 * All auto-processed items get needs_review=TRUE so they surface in
 * the exception-review queue for physical spot-checking.
 *
 * Employees can then correct any item to 'damaged' via
 * correctReturnItemCondition(), which reverses the auto-processed
 * entry and creates a proper stock_loss_records entry instead.
 */

import { db } from '@/lib/db'
import { getWorkspace, requirePermission, ApiError } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { processInventoryTransaction } from '@/lib/inventory'
import { updateCustomerStats, flagCustomer } from './customer.actions'
import { updateEmployeeStats } from './employee-stats.actions'
import { z } from 'zod'

// ──────────────────────────────────────────────────────────────
// Zod validation schemas
// ──────────────────────────────────────────────────────────────
const processOrderReturnSchema = z.object({
  orderId: z.string().min(1, 'Order ID is required'),
  returnReason: z.string().min(3, 'Return reason must be at least 3 characters').max(500),
})

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// ──────────────────────────────────────────────────────────────
// processOrderReturn
// ──────────────────────────────────────────────────────────────

export async function processOrderReturn(
  orderId: string,
  returnReason: string,
): Promise<ActionResult<{ itemsProcessed: number }>> {
  try {
    const parsed = processOrderReturnSchema.safeParse({ orderId, returnReason })
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
    }

    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const order = await db.order.findFirst({
      where: { id: orderId, companyId: ctx.company.id },
      include: {
        items: {
          where: { fulfillmentStatus: 'dispatched' },
          include: {
            orgVariant: {
              select: { id: true, sku: true, costPrice: true, stitchingCharges: true, fulfillmentType: true },
            },
          },
        },
      },
    })

    if (!order) return { success: false, error: 'Order not found' }
    if (order.status !== 'dispatched') {
      return { success: false, error: `Can only return a dispatched order (current: ${order.status})` }
    }

    const locationId = order.dispatchLocationId
    if (!locationId) {
      return { success: false, error: 'Order has no dispatch location set' }
    }

    // Update order status
    await db.order.update({
      where: { id: orderId },
      data: { status: 'rto', returnedAt: new Date() },
    })

    let itemsProcessed = 0

    for (const item of order.items) {
      // Compute cost basis from the dispatch transaction
      const dispatchTxn = await db.inventoryTransaction.findFirst({
        where: {
          orgVariantId: item.orgVariantId,
          locationId,
          transactionType: 'sale_dispatched',
          referenceType: 'order',
          referenceId: orderId,
        },
        select: { costPerUnit: true },
        orderBy: { recordedAt: 'desc' },
      })

      const costPerUnit = dispatchTxn ? Number(dispatchTxn.costPerUnit) : Number(item.orgVariant.costPrice)
      const totalCost = costPerUnit * item.quantity

      if (item.fulfillmentTypeSnapshot === 'made_to_order') {
        // Call processInventoryTransaction with type 'return_stitched_received'
        // This adds stock back AND flips track_inventory to TRUE (one-way)
        const txnResult = await processInventoryTransaction({
          orgVariantId: item.orgVariantId,
          locationId,
          organizationId: order.organizationId,
          companyId: ctx.company.id,
          employeeId: ctx.employee.id,
          transactionType: 'return_stitched_received',
          quantity: item.quantity,
          costPerUnit,
          referenceType: 'order',
          referenceId: orderId,
          notes: `Auto-processed RTO return (assumed perfect). Reason: ${returnReason}`,
        })

        if (txnResult.success) {
          await db.orderItem.update({
            where: { id: item.id },
            data: {
              autoProcessedAsPerfect: true,
              needsReview: true,
            },
          })
          itemsProcessed++
        }
      } else {
        // stock_based: call processInventoryTransaction with type 'return_resellable'
        const txnResult = await processInventoryTransaction({
          orgVariantId: item.orgVariantId,
          locationId,
          organizationId: order.organizationId,
          companyId: ctx.company.id,
          employeeId: ctx.employee.id,
          transactionType: 'return_resellable',
          quantity: item.quantity,
          costPerUnit,
          referenceType: 'order',
          referenceId: orderId,
          notes: `Auto-processed RTO return (assumed resellable). Reason: ${returnReason}`,
        })

        if (txnResult.success) {
          await db.orderItem.update({
            where: { id: item.id },
            data: {
              autoProcessedAsPerfect: true,
              needsReview: true,
            },
          })
          itemsProcessed++
        }
      }
    }

    insertAuditLog({
      action: 'order.returned',
      entityType: 'order',
      entityId: orderId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { status: 'rto', returnReason, itemsProcessed },
    })

    // Metric: order.rto
    insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'order',
      entityId: orderId,
      metricKey: 'order.rto',
      numericValue: Number(order.totalOrderValue),
      dimensions: {
        return_reason: returnReason,
        courier_name: order.courierName,
      },
    })

    // Update customer stats (increments totalRtoCount)
    await updateCustomerStats(order.customerId)

    // Phase 6 — Fire-and-forget: recompute the sales employee's funnel stats
    // (RTO changes rtoCount, rtoRate, inTransitCount)
    if (order.salesEmployeeId) {
      updateEmployeeStats(order.salesEmployeeId).catch(() => {})
    }

    // Auto-flag customer if RTO count crosses threshold (3+)
    const customer = await db.customer.findUnique({
      where: { id: order.customerId },
      select: { totalRtoCount: true, isFlagged: true },
    })
    if (customer && customer.totalRtoCount >= 3 && !customer.isFlagged) {
      await flagCustomer(order.customerId, `High RTO rate (${customer.totalRtoCount} returns)`)
    }

    return { success: true, data: { itemsProcessed } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to process order return',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// correctReturnItemCondition
// ──────────────────────────────────────────────────────────────

export async function correctReturnItemCondition(
  orderItemId: string,
  actualCondition: 'damaged',
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.INVENTORY_MANAGE_LOSS)

    const item = await db.orderItem.findFirst({
      where: { id: orderItemId },
      include: {
        order: { select: { id: true, companyId: true, organizationId: true, dispatchLocationId: true } },
        orgVariant: { select: { id: true, sku: true, costPrice: true } },
      },
    })

    if (!item) return { success: false, error: 'Order item not found' }
    if (!item.autoProcessedAsPerfect) {
      return { success: false, error: 'This item was not auto-processed as perfect (no correction needed)' }
    }
    if (!item.needsReview) {
      return { success: false, error: 'This item has already been reviewed' }
    }

    const locationId = item.reservedLocationId ?? item.order.dispatchLocationId
    if (!locationId) return { success: false, error: 'No location associated with this item' }

    // Find the auto-processed return transaction to determine cost basis
    const returnTxn = await db.inventoryTransaction.findFirst({
      where: {
        orgVariantId: item.orgVariantId,
        locationId,
        referenceType: 'order',
        referenceId: item.order.id,
        transactionType: item.fulfillmentTypeSnapshot === 'made_to_order'
          ? 'return_stitched_received'
          : 'return_resellable',
      },
      select: { id: true, costPerUnit: true, quantity: true },
      orderBy: { recordedAt: 'desc' },
    })

    if (!returnTxn) {
      return { success: false, error: 'Could not find the auto-processed return transaction to reverse' }
    }

    const costPerUnit = Number(returnTxn.costPerUnit)
    const quantity = item.quantity

    // Reverse the auto-processed entry — remove the stock that was
    // incorrectly added as "perfect/resellable"
    const reverseTxnType = item.fulfillmentTypeSnapshot === 'made_to_order'
      ? 'damage_writeoff'  // for MTO items, use damage_writeoff to remove
      : 'damage_writeoff'  // same for stock_based

    const reverseResult = await processInventoryTransaction({
      orgVariantId: item.orgVariantId,
      locationId,
      organizationId: item.order.organizationId,
      companyId: item.order.companyId,
      employeeId: ctx.employee.id,
      transactionType: reverseTxnType,
      quantity,
      costPerUnit,
      referenceType: 'order',
      referenceId: item.order.id,
      notes: `Reversing auto-processed RTO return (was assumed perfect, actually damaged). Order item: ${orderItemId}`,
    })

    if (!reverseResult.success) {
      return { success: false, error: `Failed to reverse auto-processed entry: ${reverseResult.error}` }
    }

    // Create the proper stock_loss_records entry via the unified helper.
    //
    // UNIFIED: now uses recordStockLoss() (was: direct db.stockLossRecord.create)
    // so the loss is properly deduped via the (orderItemId, lossType,
    // sourceModule) unique index. If the user already corrected this item's
    // condition (loss already exists), recordStockLoss returns wasDuplicate=true
    // and we skip creating a duplicate — preventing the double-decrement bug
    // where the same damaged return is recorded twice.
    const { recordStockLoss } = await import('@/lib/stock-loss')
    const lossResult = await recordStockLoss({
      organizationId: item.order.organizationId,
      companyId: item.order.companyId,
      orgVariantId: item.orgVariantId,
      locationId,
      lossType: 'damaged',
      sourceModule: 'rto',
      quantity,
      costPerUnit,
      orderItemId: item.id,  // enables dedup
      employeeId: ctx.employee.id,
      subType: 'confirmed',
      damageType: 'other',
      responsibleParty: 'courier',
      notes: `RTO return found damaged on physical inspection. Order item: ${orderItemId}`,
      // createInventoryTransaction=false — the reverseResult above already
      // decremented onHand (damage_writeoff). A separate stock movement
      // would double-decrement.
      createInventoryTransaction: false,
    })

    if (!lossResult.success) {
      // If the loss record failed (not a dedup), we have a problem:
      // the reverse transaction already decremented stock, but we
      // couldn't create the loss record. Log it so admin can reconcile.
      console.error(`[rto-correct] Failed to create loss record for item ${orderItemId}: ${lossResult.error}. Reverse txn ${reverseResult.transactionId} exists but has no loss record.`)
    }

    const lossRecordId = lossResult.lossRecordId ?? (lossResult.wasDuplicate ? 'dedup' : null)

    // Mark item as reviewed + corrected
    await db.orderItem.update({
      where: { id: orderItemId },
      data: { needsReview: false },
    })

    insertAuditLog({
      action: 'order_item.return_condition_corrected',
      entityType: 'order_item',
      entityId: orderItemId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      oldValues: { auto_processed_as: 'perfect', needs_review: true },
      newValues: { corrected_to: actualCondition, loss_record_id: lossRecordId, was_duplicate: lossResult.wasDuplicate },
    })

    // Metric: order_item.return_condition_corrected
    insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'product',
      entityId: item.orgVariantId,
      metricKey: 'order_item.return_condition_corrected',
      numericValue: 1,
      dimensions: { corrected_to: actualCondition },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to correct return item condition',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// dismissReturnReview
// ──────────────────────────────────────────────────────────────

export async function dismissReturnReview(orderItemId: string): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const item = await db.orderItem.findFirst({
      where: { id: orderItemId },
      include: { order: { select: { companyId: true } } },
    })

    if (!item) return { success: false, error: 'Order item not found' }
    if (!item.needsReview) {
      return { success: false, error: 'This item is not in the review queue' }
    }

    await db.orderItem.update({
      where: { id: orderItemId },
      data: { needsReview: false },
    })

    insertAuditLog({
      action: 'order_item.return_review_dismissed',
      entityType: 'order_item',
      entityId: orderItemId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { needs_review: false, note: 'Physical inspection confirmed auto-assumed condition was correct' },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to dismiss return review',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// listReturnsNeedingReview
// ──────────────────────────────────────────────────────────────

export async function listReturnsNeedingReview(filters: {
  limit?: number
  offset?: number
} = {}): Promise<ActionResult<{
  items: Array<{
    id: string
    orderId: string
    flowopsOrderNumber: string
    orgVariantId: string
    sku: string
    productTitle: string
    quantity: number
    fulfillmentTypeSnapshot: string
    autoProcessedAsPerfect: boolean
    returnedAt: Date | null
  }>
  total: number
}>> {
  try {
    const ctx = await getWorkspace()
    const limit = Math.min(filters.limit ?? 50, 100)
    const offset = filters.offset ?? 0

    const where = {
      needsReview: true,
      order: { companyId: ctx.company.id },
    }

    const [items, total] = await Promise.all([
      db.orderItem.findMany({
        where,
        include: {
          order: { select: { id: true, flowopsOrderNumber: true, returnedAt: true } },
          orgVariant: {
            select: { id: true, sku: true, product: { select: { title: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.orderItem.count({ where }),
    ])

    return {
      success: true,
      data: {
        items: items.map((item) => ({
          id: item.id,
          orderId: item.order.id,
          flowopsOrderNumber: item.order.flowopsOrderNumber,
          orgVariantId: item.orgVariantId,
          sku: item.orgVariant.sku,
          productTitle: item.orgVariant.product.title,
          quantity: item.quantity,
          fulfillmentTypeSnapshot: item.fulfillmentTypeSnapshot,
          autoProcessedAsPerfect: item.autoProcessedAsPerfect,
          returnedAt: item.order.returnedAt,
        })),
        total,
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list returns needing review',
    }
  }
}
