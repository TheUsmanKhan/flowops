/**
 * OMS — Backorder auto-fulfillment.
 *
 * When a Purchase Order receipt adds stock for a variant+location,
 * this function checks if any backordered order_items for that
 * variant can now be fulfilled. Processes the FIFO queue (oldest
 * backordered_at first), reserving stock until it runs out.
 *
 * After each item is reserved, recomputes the parent order's status
 * — if all items are now 'reserved', the order flips from
 * 'partially_backordered' to 'confirmed'.
 */

import { db } from '@/lib/db'
import { reserveStockForOrder } from '@/lib/inventory'
import { insertAuditLog } from '@/lib/audit'

interface BackorderFulfillmentResult {
  success: boolean
  fulfilledCount: number
  remainingBackordered: number
  results: Array<{
    orderItemId: string
    orderId: string
    flowopsOrderNumber: string
    outcome: 'reserved' | 'still_backordered'
    reason?: string
  }>
}

/**
 * Check and fulfill backordered order_items for a specific variant+location.
 * Called after receiveAgainstPurchaseOrder() successfully adds stock.
 *
 * FIFO ordering: oldest backordered_at first (fairness).
 * Skips order_items belonging to cancelled orders.
 *
 * @param orgVariantId - The variant that just received new stock
 * @param locationId - The location where stock was received
 */
export async function checkAndFulfillBackorders(
  orgVariantId: string,
  locationId: string,
): Promise<BackorderFulfillmentResult> {
  // Query backordered order_items for this variant, ordered oldest first.
  // Skip items belonging to cancelled orders.
  const backorderedItems = await db.orderItem.findMany({
    where: {
      orgVariantId,
      fulfillmentStatus: 'backordered',
      order: { status: { not: 'cancelled' } },
    },
    include: {
      order: {
        select: {
          id: true,
          flowopsOrderNumber: true,
          companyId: true,
          organizationId: true,
        },
      },
    },
    orderBy: { backorderedAt: 'asc' },
  })

  if (backorderedItems.length === 0) {
    return { success: true, fulfilledCount: 0, remainingBackordered: 0, results: [] }
  }

  // Get current available stock at this location
  const pool = await db.inventoryPool.findUnique({
    where: {
      orgVariantId_locationId: { orgVariantId, locationId },
    },
  })

  if (!pool) {
    return {
      success: true,
      fulfilledCount: 0,
      remainingBackordered: backorderedItems.length,
      results: backorderedItems.map((item) => ({
        orderItemId: item.id,
        orderId: item.order.id,
        flowopsOrderNumber: item.order.flowopsOrderNumber,
        outcome: 'still_backordered' as const,
        reason: 'No inventory pool at this location',
      })),
    }
  }

  const results: BackorderFulfillmentResult['results'] = []
  let fulfilledCount = 0
  let remainingBackordered = 0

  for (const item of backorderedItems) {
    const available = pool.onHand - pool.reserved

    if (available >= item.quantity) {
      // Enough stock to fulfill this backorder
      const reserveResult = await reserveStockForOrder({
        orgVariantId,
        locationId,
        organizationId: item.order.organizationId,
        companyId: item.order.companyId,
        quantity: item.quantity,
        orderId: item.order.id,
      })

      if (reserveResult.success) {
        await db.orderItem.update({
          where: { id: item.id },
          data: {
            fulfillmentStatus: 'reserved',
            fulfilledAt: new Date(),
            reservedLocationId: locationId,
          },
        })

        await insertAuditLog({
          action: 'order.backorder_fulfilled',
          entityType: 'order_item',
          entityId: item.id,
          companyId: item.order.companyId,
          organizationId: item.order.organizationId,
          newValues: {
            flowopsOrderNumber: item.order.flowopsOrderNumber,
            quantity: item.quantity,
            locationId,
          },
        })

        // Recompute the parent order's status
        await db.$queryRaw`SELECT recompute_order_status(${item.order.id}::TEXT)`

        // Check if the order should flip from 'partially_backordered' to 'confirmed'
        const remainingBackorderedItems = await db.orderItem.count({
          where: {
            orderId: item.order.id,
            fulfillmentStatus: 'backordered',
          },
        })

        if (remainingBackorderedItems === 0) {
          // All items are now reserved — flip order to 'confirmed'
          await db.order.update({
            where: { id: item.order.id },
            data: { status: 'confirmed' },
          })

          await insertAuditLog({
            action: 'order.all_backorders_fulfilled',
            entityType: 'order',
            entityId: item.order.id,
            companyId: item.order.companyId,
            organizationId: item.order.organizationId,
            newValues: { status: 'confirmed' },
          })
        }

        results.push({
          orderItemId: item.id,
          orderId: item.order.id,
          flowopsOrderNumber: item.order.flowopsOrderNumber,
          outcome: 'reserved',
        })
        fulfilledCount++
      } else {
        // Reservation failed (race condition? stock was taken by another process)
        results.push({
          orderItemId: item.id,
          orderId: item.order.id,
          flowopsOrderNumber: item.order.flowopsOrderNumber,
          outcome: 'still_backordered',
          reason: reserveResult.error,
        })
        remainingBackordered++
        break // Stock likely exhausted — stop processing the queue
      }
    } else {
      // Not enough stock for this item — stop (FIFO: later items won't have enough either)
      results.push({
        orderItemId: item.id,
        orderId: item.order.id,
        flowopsOrderNumber: item.order.flowopsOrderNumber,
        outcome: 'still_backordered',
        reason: `Available: ${available}, required: ${item.quantity}`,
      })
      remainingBackordered++
      break // FIFO — if this item can't be fulfilled, later ones can't either
    }
  }

  // Count any remaining items we didn't process
  remainingBackordered += backorderedItems.length - fulfilledCount - results.filter((r) => r.outcome === 'still_backordered').length

  return { success: true, fulfilledCount, remainingBackordered, results }
}
