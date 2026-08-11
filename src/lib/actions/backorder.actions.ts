/**
 * OMS — Backorder auto-fulfillment.
 *
 * When a Purchase Order receipt adds stock for a variant+location,
 * this function checks if any backordered order_items for that
 * variant can now be fulfilled. Processes the FIFO queue (oldest
 * backordered_at first), reserving stock until it runs out.
 *
 * EXCHANGE SHIPMENT PRIORITY (migration 008): this function ALSO checks
 * backordered exchange_shipments for the same variant. The combined queue
 * is ordered: all isPriorityBackorder=true exchange shipments first (oldest
 * first among them), then regular OrderItems (oldest first). This is the
 * concrete implementation of the "exchange shipments get priority" rule.
 *
 * After each OrderItem is reserved, recomputes the parent order's status
 * — if all items are now 'reserved', the order flips from
 * 'partially_backordered' to 'confirmed'.
 *
 * After each ExchangeShipment is reserved, flips its status from 'backordered'
 * to 'confirmed'.
 *
 * SECURITY: This is an internal function called from the purchase-order
 * receipt API route (which has its own auth guard via getWorkspace +
 * requirePermission). It does NOT directly accept user input — the
 * orgVariantId and locationId come from the authenticated PO receipt
 * flow. Adding getWorkspace() here would be redundant since the caller
 * already validated the session. However, we add Zod validation for
 * defense-in-depth on the parameter types.
 */

import { db } from '@/lib/db'
import { reserveStockForOrder } from '@/lib/inventory'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { z } from 'zod'

// Zod schema for input validation (defense-in-depth)
const backorderInputSchema = z.object({
  orgVariantId: z.string().min(1, 'orgVariantId is required'),
  locationId: z.string().min(1, 'locationId is required'),
})

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

// Internal unified type for the combined priority queue
interface QueueEntry {
  kind: 'order_item' | 'exchange_shipment'
  id: string
  quantity: number
  backorderedAt: Date
  isPriority: boolean // exchange shipments are always priority; OrderItems are not
  // For order_item entries:
  orderItemId?: string
  orderId?: string
  flowopsOrderNumber?: string
  companyId: string
  organizationId: string
  // For exchange_shipment entries:
  exchangeShipmentId?: string
  exchangeShipmentNumber?: string
}

/**
 * Check and fulfill backordered order_items AND exchange_shipments for a
 * specific variant+location. Called after receiveAgainstPurchaseOrder()
 * successfully adds stock.
 *
 * PRIORITY QUEUE: all isPriorityBackorder=true exchange shipments first
 * (oldest first among them), then regular OrderItems (oldest first).
 *
 * Skips order_items belonging to cancelled orders and exchange_shipments
 * with status='cancelled'.
 *
 * @param orgVariantId - The variant that just received new stock
 * @param locationId - The location where stock was received
 */
export async function checkAndFulfillBackorders(
  orgVariantId: string,
  locationId: string,
): Promise<BackorderFulfillmentResult> {
  // Defense-in-depth: validate inputs even though caller is trusted
  const parsed = backorderInputSchema.safeParse({ orgVariantId, locationId })
  if (!parsed.success) {
    return {
      success: false,
      fulfilledCount: 0,
      remainingBackordered: 0,
      results: [],
    }
  }

  // ── Fetch backordered OrderItems (same as before) ──
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

  // ── Fetch backordered ExchangeShipments (NEW — migration 008) ──
  // Only stock_based exchange shipments can be backordered (MTO uses production)
  const backorderedShipments = await db.exchangeShipment.findMany({
    where: {
      newOrgVariantId: orgVariantId,
      status: 'backordered',
      fulfillmentTypeSnapshot: 'stock_based',
    },
    select: {
      id: true,
      exchangeShipmentNumber: true,
      quantity: true,
      backorderedAt: true,
      isPriorityBackorder: true,
      companyId: true,
      organizationId: true,
      createdAt: true,
    },
    orderBy: { backorderedAt: 'asc' },
  })

  // ── Build the combined priority queue ──
  // Priority: isPriorityBackorder=true first (oldest first), then regular (oldest first)
  const queue: QueueEntry[] = []

  // Add exchange shipments (all are isPriorityBackorder=true by default)
  for (const s of backorderedShipments) {
    queue.push({
      kind: 'exchange_shipment',
      id: s.id,
      quantity: s.quantity,
      backorderedAt: s.backorderedAt ?? s.createdAt ?? new Date(),
      isPriority: s.isPriorityBackorder, // true by default
      companyId: s.companyId,
      organizationId: s.organizationId,
      exchangeShipmentId: s.id,
      exchangeShipmentNumber: s.exchangeShipmentNumber,
    })
  }

  // Add order items (regular priority — isPriority=false)
  for (const item of backorderedItems) {
    queue.push({
      kind: 'order_item',
      id: item.id,
      quantity: item.quantity,
      backorderedAt: item.backorderedAt ?? new Date(),
      isPriority: false,
      companyId: item.order.companyId,
      organizationId: item.order.organizationId,
      orderItemId: item.id,
      orderId: item.order.id,
      flowopsOrderNumber: item.order.flowopsOrderNumber,
    })
  }

  // Sort: priority items first, then by backorderedAt ascending (oldest first)
  queue.sort((a, b) => {
    if (a.isPriority && !b.isPriority) return -1
    if (!a.isPriority && b.isPriority) return 1
    return a.backorderedAt.getTime() - b.backorderedAt.getTime()
  })

  if (queue.length === 0) {
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
      remainingBackordered: queue.length,
      results: queue.map((entry) => ({
        orderItemId: entry.orderItemId ?? entry.exchangeShipmentId ?? entry.id,
        orderId: entry.orderId ?? '',
        flowopsOrderNumber: entry.flowopsOrderNumber ?? entry.exchangeShipmentNumber ?? '',
        outcome: 'still_backordered' as const,
        reason: 'No inventory pool at this location',
      })),
    }
  }

  const results: BackorderFulfillmentResult['results'] = []
  let fulfilledCount = 0
  let remainingBackordered = 0

  for (const entry of queue) {
    const available = pool.onHand - pool.reserved

    if (available >= entry.quantity) {
      // Enough stock to fulfill this backorder
      const reserveResult = await reserveStockForOrder({
        orgVariantId,
        locationId,
        organizationId: entry.organizationId,
        companyId: entry.companyId,
        quantity: entry.quantity,
        orderId: entry.orderId, // undefined for exchange_shipments — that's OK
      })

      if (reserveResult.success) {
        // Update the appropriate record based on kind
        if (entry.kind === 'order_item' && entry.orderItemId) {
          await db.orderItem.update({
            where: { id: entry.orderItemId },
            data: {
              fulfillmentStatus: 'reserved',
              fulfilledAt: new Date(),
              reservedLocationId: locationId,
            },
          })

          insertAuditLog({
            action: 'order.backorder_fulfilled',
            entityType: 'order_item',
            entityId: entry.orderItemId,
            companyId: entry.companyId,
            organizationId: entry.organizationId,
            newValues: {
              flowopsOrderNumber: entry.flowopsOrderNumber,
              quantity: entry.quantity,
              locationId,
            },
          })

          const daysWaited = Math.round(
            (Date.now() - entry.backorderedAt.getTime()) / (1000 * 60 * 60 * 24),
          )
          insertMetricEvent({
            companyId: entry.companyId,
            entityType: 'product',
            entityId: orgVariantId,
            metricKey: 'order.backorder_fulfilled',
            numericValue: entry.quantity,
            dimensions: { order_id: entry.orderId, days_waited: daysWaited },
          })

          // Recompute the parent order's status
          if (entry.orderId) {
            await db.$queryRaw`SELECT recompute_order_status(${entry.orderId}::TEXT)`

            const remainingBackorderedItems = await db.orderItem.count({
              where: {
                orderId: entry.orderId,
                fulfillmentStatus: 'backordered',
              },
            })

            if (remainingBackorderedItems === 0) {
              await db.order.update({
                where: { id: entry.orderId },
                data: { status: 'confirmed' },
              })

              insertAuditLog({
                action: 'order.all_backorders_fulfilled',
                entityType: 'order',
                entityId: entry.orderId,
                companyId: entry.companyId,
                organizationId: entry.organizationId,
                newValues: { status: 'confirmed' },
              })

              // ── Phase 3.5: Deferred automatic booking ──
              // When a previously-backordered order transitions to 'confirmed'
              // (all items now reserved), if the company's courierBookingMode
              // is 'automatic', fire the booking now. This is the case where an
              // order was backordered at creation time and only becomes bookable
              // once stock arrives later.
              //
              // NON-BLOCKING: if booking fails, the order stays 'confirmed' with
              // courierBookingStatus='failed' — it lands in the manual Workbench
              // for retry. The backorder fulfillment itself is NOT affected.
              try {
                const { maybeAutoBookOrder } = await import('./booking.actions')
                const bookResult = await maybeAutoBookOrder(
                  entry.orderId,
                  'manual', // backorder-fulfilled orders retain their original source
                  'confirmed',
                )
                if (bookResult.success) {
                  console.log(
                    `[backorder] Auto-booked order ${entry.orderId} after backorder fulfillment`,
                  )
                } else if (bookResult.error && !bookResult.error.includes('skipped')) {
                  console.warn(
                    `[backorder] Auto-booking failed for order ${entry.orderId}: ${bookResult.error}`,
                  )
                }
              } catch (err) {
                // Booking threw — log but don't fail the backorder fulfillment
                console.error(
                  `[backorder] Auto-booking threw for order ${entry.orderId}:`,
                  err,
                )
              }
            }
          }

          results.push({
            orderItemId: entry.orderItemId,
            orderId: entry.orderId ?? '',
            flowopsOrderNumber: entry.flowopsOrderNumber ?? '',
            outcome: 'reserved',
          })
        } else if (entry.kind === 'exchange_shipment' && entry.exchangeShipmentId) {
          // Flip the exchange shipment from 'backordered' to 'confirmed'
          await db.exchangeShipment.update({
            where: { id: entry.exchangeShipmentId },
            data: {
              status: 'confirmed',
              backorderedAt: null,
            },
          })

          insertAuditLog({
            action: 'exchange_shipment.backorder_fulfilled',
            entityType: 'exchange_shipment',
            entityId: entry.exchangeShipmentId,
            companyId: entry.companyId,
            organizationId: entry.organizationId,
            newValues: {
              exchangeShipmentNumber: entry.exchangeShipmentNumber,
              quantity: entry.quantity,
              locationId,
              status: 'confirmed',
            },
          })

          const daysWaited = Math.round(
            (Date.now() - entry.backorderedAt.getTime()) / (1000 * 60 * 60 * 24),
          )
          insertMetricEvent({
            companyId: entry.companyId,
            entityType: 'exchange_shipment',
            entityId: entry.exchangeShipmentId,
            metricKey: 'exchange_shipment.backorder_fulfilled',
            numericValue: entry.quantity,
            dimensions: {
              exchange_shipment_number: entry.exchangeShipmentNumber,
              days_waited: daysWaited,
            },
          })

          results.push({
            orderItemId: entry.exchangeShipmentId, // reuse field for result shape compat
            orderId: '',
            flowopsOrderNumber: entry.exchangeShipmentNumber ?? '',
            outcome: 'reserved',
          })
        }

        fulfilledCount++
      } else {
        // Reservation failed (race condition? stock was taken by another process)
        results.push({
          orderItemId: entry.orderItemId ?? entry.exchangeShipmentId ?? entry.id,
          orderId: entry.orderId ?? '',
          flowopsOrderNumber: entry.flowopsOrderNumber ?? entry.exchangeShipmentNumber ?? '',
          outcome: 'still_backordered',
          reason: reserveResult.error,
        })
        remainingBackordered++
        break // Stock likely exhausted — stop processing the queue
      }
    } else {
      // Not enough stock for this item — stop (FIFO: later items won't have enough either)
      results.push({
        orderItemId: entry.orderItemId ?? entry.exchangeShipmentId ?? entry.id,
        orderId: entry.orderId ?? '',
        flowopsOrderNumber: entry.flowopsOrderNumber ?? entry.exchangeShipmentNumber ?? '',
        outcome: 'still_backordered',
        reason: `Available: ${available}, required: ${entry.quantity}`,
      })
      remainingBackordered++
      break // FIFO — if this item can't be fulfilled, later ones can't either
    }
  }

  // Count any remaining items we didn't process
  remainingBackordered += queue.length - fulfilledCount - results.filter((r) => r.outcome === 'still_backordered').length

  return { success: true, fulfilledCount, remainingBackordered, results }
}
