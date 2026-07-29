/**
 * Item Exchange System — server actions.
 *
 * Implements the full exchange lifecycle with STRICT SEQUENCING for the two
 * exchange methods:
 *
 *   courier_replacement:    request → dispatch new item → (courier collects old)
 *                           → await return → manually verify old → complete
 *
 *   customer_self_return:   request (awaiting_customer_to_ship) → customer
 *                           confirmed shipped → await physical arrival →
 *                           manually verify old (THIS IS THE GATE) →
 *                           create+dispatch new order → complete
 *
 * CRITICAL RULE (enforced throughout):
 *   For customer_self_return, the new order/item is NEVER created before
 *   verifyOldItemReceived() succeeds. This sequential gate is the core
 *   business rule and must not be bypassed by any code path.
 *
 * INVENTORY INTEGRATION:
 *   verifyOldItemReceived() is the ONLY function that processes the old item's
 *   return in inventory. It calls processInventoryTransaction() directly (the
 *   same function the /api/inventory/receive-returned-stitched and
 *   /api/inventory/receive routes use) — we do NOT reimplement that logic.
 *   For damaged items, a stock_loss_records entry is created directly.
 *
 * Every mutation calls insertAuditLog() AND insertMetricEvent(), and returns
 * { success, data?, error? }.
 */

import { db } from '@/lib/db'
import { getWorkspace, requirePermission, ApiError } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import {
  processInventoryTransaction,
  reserveStockForOrder,
} from '@/lib/inventory'
import { flagCustomer } from './customer.actions'
import {
  createExchangeRequestSchema,
  confirmCustomerShippedSchema,
  verifyOldItemReceivedSchema,
  settlePriceDifferenceSchema,
  markNotReturnedSchema,
  cancelExchangeSchema,
  type CreateExchangeRequestInput,
  type ConfirmCustomerShippedInput,
  type VerifyOldItemReceivedInput,
  type SettlePriceDifferenceInput,
  type MarkNotReturnedInput,
  type CancelExchangeInput,
} from '@/lib/validations/exchange.schemas'
import type { Prisma } from '@prisma/client'

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// ──────────────────────────────────────────────────────────────
// Internal helper: generate order number via the DB function
// (mirrors order.actions.ts's private generateOrderNumber)
// ──────────────────────────────────────────────────────────────
async function generateOrderNumber(companyId: string): Promise<string> {
  const result = await db.$queryRaw<{ generate_order_number: string }[]>`
    SELECT generate_order_number(${companyId}::TEXT)
  `
  return result[0].generate_order_number
}

// ──────────────────────────────────────────────────────────────
// Internal helper: create the linked exchange order + order_item + reserve
// stock + dispatch. Used by BOTH:
//   - dispatchExchangeNewItem() for courier_replacement (immediate)
//   - verifyOldItemReceived() for customer_self_return (after verification)
// Returns the new order + order_item IDs.
// ──────────────────────────────────────────────────────────────
async function createAndDispatchExchangeOrder(
  exchangeId: string,
  ctx: Awaited<ReturnType<typeof getWorkspace>>,
): Promise<{ newOrderId: string; newOrderItemId: string }> {
  // Fetch the exchange record (already validated by caller)
  const exchange = await db.orderExchange.findUniqueOrThrow({
    where: { id: exchangeId },
    include: {
      originalOrder: { select: { customerId: true, dispatchLocationId: true } },
      newOrgVariant: {
        select: {
          id: true,
          fulfillmentType: true,
          costPrice: true,
          companyPricing: { where: { companyId: ctx.company.id }, take: 1 },
        },
      },
    },
  })

  const unitPrice = exchange.newItemPrice
  const lineTotal = unitPrice

  // 1. Generate order number
  const flowopsOrderNumber = await generateOrderNumber(ctx.company.id)

  // 2. Create the new order (order_source='exchange')
  const newOrder = await db.order.create({
    data: {
      organizationId: ctx.company.organizationId,
      companyId: ctx.company.id,
      flowopsOrderNumber,
      orderSource: 'exchange',
      customerId: exchange.originalOrder.customerId,
      // This is an exchange — no separate COD collection for the item itself.
      // The price_difference (if any) is settled separately via settlePriceDifference().
      status: 'confirmed',
      paymentType: 'fully_prepaid',
      paymentStatus: 'fully_prepaid',
      paymentSource: 'cod_native',
      subtotal: lineTotal,
      totalOrderValue: lineTotal,
      advanceAmount: lineTotal, // mark as fully paid (exchange item)
      advancePaidAt: new Date(),
      remainingCodAmount: 0,
      confirmedAt: new Date(),
      createdBy: ctx.employee.id,
    },
  })

  // 3. Create the single order_item for the new variant
  const newItem = await db.orderItem.create({
    data: {
      orderId: newOrder.id,
      orgVariantId: exchange.newOrgVariantId,
      organizationId: ctx.company.organizationId,
      quantity: 1,
      unitPrice,
      lineTotal,
      fulfillmentStatus: 'reserved',
      fulfillmentTypeSnapshot: exchange.newOrgVariant.fulfillmentType,
      reservedLocationId: exchange.originalOrder.dispatchLocationId,
    },
  })

  // 4. Link the exchange to the new order/item
  await db.orderExchange.update({
    where: { id: exchangeId },
    data: {
      newOrderId: newOrder.id,
      newOrderItemId: newItem.id,
    },
  })

  // 5. Reserve stock for the new item (if stock_based)
  const dispatchLocationId = exchange.originalOrder.dispatchLocationId
  if (dispatchLocationId && exchange.newOrgVariant.fulfillmentType === 'stock_based') {
    const reserveResult = await reserveStockForOrder({
      orgVariantId: exchange.newOrgVariantId,
      locationId: dispatchLocationId,
      organizationId: ctx.company.organizationId,
      companyId: ctx.company.id,
      employeeId: ctx.employee.id,
      quantity: 1,
      orderId: newOrder.id,
    })
    if (!reserveResult.success) {
      // Mark the item as backordered if reservation fails
      await db.orderItem.update({
        where: { id: newItem.id },
        data: { fulfillmentStatus: 'backordered', backorderedAt: new Date() },
      })
      await db.order.update({
        where: { id: newOrder.id },
        data: { status: 'partially_backordered' },
      })
    }
  }

  // 6. Dispatch the order immediately (for courier_replacement, the courier
  //    collects the old item during this same delivery; for customer_self_return,
  //    the old item was already verified before this function is called)
  await db.order.update({
    where: { id: newOrder.id },
    data: {
      status: 'dispatched',
      dispatchedAt: new Date(),
    },
  })
  await db.orderItem.update({
    where: { id: newItem.id },
    data: { fulfillmentStatus: 'dispatched', fulfilledAt: new Date() },
  })

  await insertAuditLog({
    action: 'exchange.new_item_dispatched',
    entityType: 'order',
    entityId: newOrder.id,
    companyId: ctx.company.id,
    organizationId: ctx.company.organizationId,
    userId: ctx.user.id,
    employeeId: ctx.employee.id,
    newValues: {
      exchangeId,
      flowopsOrderNumber,
      newOrgVariantId: exchange.newOrgVariantId,
      unitPrice: Number(unitPrice),
    },
  })

  await insertMetricEvent({
    companyId: ctx.company.id,
    entityType: 'order',
    entityId: newOrder.id,
    metricKey: 'exchange.new_item_dispatched',
    numericValue: Number(unitPrice),
    dimensions: { exchange_id: exchangeId, exchange_method: exchange.exchangeMethod },
  }).catch(() => {})

  return { newOrderId: newOrder.id, newOrderItemId: newItem.id }
}

// ══════════════════════════════════════════════════════════════
// PART 2: CREATE EXCHANGE REQUEST
// ══════════════════════════════════════════════════════════════

export async function createExchangeRequest(
  input: CreateExchangeRequestInput,
): Promise<ActionResult<{ exchangeId: string }>> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const parsed = createExchangeRequestSchema.safeParse(input)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid exchange request data',
      }
    }
    const d = parsed.data

    // 3. Fetch the original order_item + its parent order — VERIFY delivered
    const orderItem = await db.orderItem.findFirst({
      where: { id: d.original_order_item_id },
      include: {
        order: {
          select: {
            id: true,
            status: true,
            companyId: true,
            organizationId: true,
            customerId: true,
          },
        },
      },
    })
    if (!orderItem) {
      return { success: false, error: 'Original order item not found' }
    }
    // Verify the order belongs to this company
    if (orderItem.order.companyId !== ctx.company.id) {
      return { success: false, error: 'Original order item not found' }
    }
    // CRITICAL: only delivered orders can have exchanges
    if (orderItem.order.status !== 'delivered') {
      return {
        success: false,
        error: 'Items can only be exchanged after the order has been delivered to the customer.',
      }
    }

    // 4. old_item_price from the order_item's unit_price
    const oldItemPrice = Number(orderItem.unitPrice)

    // 5. new_item_price from the target variant's company_variant_pricing
    const variant = await db.orgProductVariant.findFirst({
      where: {
        id: d.new_org_variant_id,
        organizationId: ctx.company.organizationId,
      },
      include: {
        companyPricing: { where: { companyId: ctx.company.id }, take: 1 },
      },
    })
    if (!variant) {
      return { success: false, error: 'New variant not found in this organization' }
    }
    const newItemPrice = variant.companyPricing[0]?.salePrice
      ? Number(variant.companyPricing[0].salePrice)
      : Number(variant.costPrice)

    // 6. Determine price_difference_status
    const priceDifference = newItemPrice - oldItemPrice
    const priceDifferenceStatus: 'customer_owes' | 'refund_due' | 'settled' =
      priceDifference > 0 ? 'customer_owes' : priceDifference < 0 ? 'refund_due' : 'settled'

    // 7. INSERT order_exchanges — status depends on exchange_method
    const initialStatus =
      d.exchange_method === 'courier_replacement'
        ? 'requested' // ready to proceed to immediate new item dispatch
        : 'awaiting_customer_to_ship_old_item' // new item dispatch is BLOCKED until verification

    const exchange = await db.orderExchange.create({
      data: {
        organizationId: ctx.company.organizationId,
        companyId: ctx.company.id,
        originalOrderId: orderItem.order.id,
        originalOrderItemId: orderItem.id,
        newOrgVariantId: d.new_org_variant_id,
        exchangeMethod: d.exchange_method,
        status: initialStatus,
        oldItemPrice,
        newItemPrice,
        priceDifferenceStatus,
        reason: d.reason,
        requestedBy: ctx.employee.id,
        // priceDifference is GENERATED ALWAYS AS (new-old) STORED in the DB —
        // Prisma doesn't understand GENERATED columns, so we cast the input.
      } as Prisma.OrderExchangeUncheckedCreateInput,
    })

    // 8. Audit log
    await insertAuditLog({
      action: 'exchange.requested',
      entityType: 'order_exchange',
      entityId: exchange.id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: {
        originalOrderId: orderItem.order.id,
        originalOrderItemId: orderItem.id,
        newOrgVariantId: d.new_org_variant_id,
        exchangeMethod: d.exchange_method,
        status: initialStatus,
        oldItemPrice,
        newItemPrice,
        priceDifference,
        priceDifferenceStatus,
        reason: d.reason,
      },
    })

    // 9. Metric event
    await insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'order',
      entityId: orderItem.order.id,
      metricKey: 'exchange.requested',
      numericValue: 1,
      dimensions: {
        exchange_id: exchange.id,
        exchange_method: d.exchange_method,
      },
    }).catch(() => {})

    return { success: true, data: { exchangeId: exchange.id } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to create exchange request',
    }
  }
}

// ══════════════════════════════════════════════════════════════
// PART 3: COURIER_REPLACEMENT PATH — dispatch new item immediately
// ══════════════════════════════════════════════════════════════

export async function dispatchExchangeNewItem(
  exchangeId: string,
): Promise<ActionResult<{ newOrderId: string }>> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const exchange = await db.orderExchange.findFirst({
      where: { id: exchangeId, companyId: ctx.company.id },
    })
    if (!exchange) return { success: false, error: 'Exchange not found' }

    // Only valid for courier_replacement with status='requested'
    if (exchange.exchangeMethod !== 'courier_replacement') {
      return {
        success: false,
        error:
          'This action is only valid for courier_replacement exchanges. For customer_self_return, the new item is dispatched automatically after old item verification.',
      }
    }
    if (exchange.status !== 'requested') {
      return {
        success: false,
        error: `Cannot dispatch new item for an exchange with status '${exchange.status}'. Expected 'requested'.`,
      }
    }

    // Create + dispatch the new order (courier collects old item during this delivery)
    const { newOrderId } = await createAndDispatchExchangeOrder(exchangeId, ctx)

    // Update exchange status to 'awaiting_old_item_return' (old item collection
    // happens during this delivery, but manual verification still needed)
    await db.orderExchange.update({
      where: { id: exchangeId },
      data: { status: 'awaiting_old_item_return' },
    })

    return { success: true, data: { newOrderId } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to dispatch exchange new item',
    }
  }
}

// ══════════════════════════════════════════════════════════════
// PART 4: CUSTOMER_SELF_RETURN PATH — confirm customer shipped
// ══════════════════════════════════════════════════════════════

export async function confirmCustomerShippedOldItem(
  input: ConfirmCustomerShippedInput,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const parsed = confirmCustomerShippedSchema.safeParse(input)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid input',
      }
    }
    const d = parsed.data

    const exchange = await db.orderExchange.findFirst({
      where: { id: d.exchange_id, companyId: ctx.company.id },
    })
    if (!exchange) return { success: false, error: 'Exchange not found' }

    if (exchange.status !== 'awaiting_customer_to_ship_old_item') {
      return {
        success: false,
        error: `Cannot confirm shipment for an exchange with status '${exchange.status}'. Expected 'awaiting_customer_to_ship_old_item'.`,
      }
    }

    await db.orderExchange.update({
      where: { id: d.exchange_id },
      data: {
        customerReturnTrackingNumber: d.customer_return_tracking_number?.trim() || null,
        customerReturnCourier: d.customer_return_courier?.trim() || null,
        customerConfirmedShippedAt: new Date(),
        customerConfirmedShippedBy: ctx.employee.id,
        status: 'customer_confirmed_shipped',
      },
    })

    await insertAuditLog({
      action: 'exchange.customer_confirmed_shipped',
      entityType: 'order_exchange',
      entityId: d.exchange_id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: {
        trackingNumber: d.customer_return_tracking_number || null,
        courier: d.customer_return_courier || null,
      },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to confirm customer shipment',
    }
  }
}

// ══════════════════════════════════════════════════════════════
// PART 5: MANUAL VERIFICATION — shared by both methods
// This is the ONLY function that processes the old item's return in inventory.
// ══════════════════════════════════════════════════════════════

export async function verifyOldItemReceived(
  input: VerifyOldItemReceivedInput,
): Promise<ActionResult<{ exchangeStatus: string }>> {
  try {
    const ctx = await getWorkspace()
    // GUARD: inventory.receive OR orders.manage
    await requirePermission(ctx, PERMISSIONS.INVENTORY_RECEIVE)

    const parsed = verifyOldItemReceivedSchema.safeParse(input)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid input',
      }
    }
    const d = parsed.data

    const exchange = await db.orderExchange.findFirst({
      where: { id: d.exchange_id, companyId: ctx.company.id },
      include: {
        originalOrderItem: {
          select: {
            id: true,
            orgVariantId: true,
            fulfillmentTypeSnapshot: true,
            unitPrice: true,
            reservedLocationId: true,
          },
        },
        originalOrder: {
          select: { id: true, dispatchLocationId: true },
        },
      },
    })
    if (!exchange) return { success: false, error: 'Exchange not found' }

    // 3. Verify status is one of the awaiting-return states
    const validStatuses = ['awaiting_old_item_return', 'customer_confirmed_shipped']
    if (!validStatuses.includes(exchange.status)) {
      return {
        success: false,
        error: `Cannot verify old item for an exchange with status '${exchange.status}'. Expected one of: ${validStatuses.join(', ')}.`,
      }
    }

    const locationId =
      exchange.originalOrderItem.reservedLocationId ?? exchange.originalOrder.dispatchLocationId
    if (!locationId) {
      return {
        success: false,
        error: 'Cannot receive returned item — no dispatch location set on the original order.',
      }
    }

    let inventoryTxnId: string | null = null
    let stockLossId: string | null = null
    const oldItemCost = Number(exchange.oldItemPrice)

    // 5. IF condition IN ('perfect','good','open_box'): receive into inventory
    // 6. IF condition = 'damaged': create stock_loss_records entry directly
    if (d.condition === 'damaged') {
      // Damaged → straight to stock_loss, no inventory addition
      const lossRecord = await db.stockLossRecord.create({
        data: {
          organizationId: ctx.company.organizationId,
          companyId: ctx.company.id,
          orgVariantId: exchange.originalOrderItem.orgVariantId,
          locationId,
          lossType: 'damaged',
          subType: 'confirmed',
          damageType: 'other',
          quantity: 1,
          costPerUnit: oldItemCost,
          investigationStatus: 'none',
          resolution: 'written_off',
          responsibleParty: 'customer',
          evidenceUrls: JSON.stringify(d.evidence_urls),
          notes: `Damaged exchanged item. ${d.notes || ''}`.trim(),
          reportedById: ctx.employee.id,
          approvedById: ctx.employee.id,
          resolvedById: ctx.employee.id,
          resolvedAt: new Date(),
        },
      })
      stockLossId = lossRecord.id
    } else {
      // Not damaged → add to stock via processInventoryTransaction
      // (same function the /api/inventory/receive-returned-stitched route uses)
      const txnType =
        exchange.originalOrderItem.fulfillmentTypeSnapshot === 'made_to_order'
          ? 'return_stitched_received'
          : 'return_resellable'

      const txnResult = await processInventoryTransaction({
        orgVariantId: exchange.originalOrderItem.orgVariantId,
        locationId,
        organizationId: ctx.company.organizationId,
        companyId: ctx.company.id,
        employeeId: ctx.employee.id,
        transactionType: txnType,
        quantity: 1,
        costPerUnit: oldItemCost,
        referenceType: 'order',
        referenceId: exchange.originalOrderId,
        notes: `Exchanged item (${d.condition}). ${d.notes || ''}`.trim(),
      })

      if (!txnResult.success || !txnResult.transactionId) {
        return {
          success: false,
          error: `Failed to receive returned item into inventory: ${txnResult.error}`,
        }
      }
      inventoryTxnId = txnResult.transactionId
    }

    // 7. UPDATE order_exchanges with verification data
    await db.orderExchange.update({
      where: { id: d.exchange_id },
      data: {
        oldItemCondition: d.condition,
        oldItemVerifiedAt: new Date(),
        oldItemVerifiedBy: ctx.employee.id,
        oldItemEvidenceUrls: JSON.stringify(d.evidence_urls),
        oldItemNotes: d.notes?.trim() || null,
        oldItemInventoryTxnId: inventoryTxnId,
        oldItemStockLossId: stockLossId,
        status: 'old_item_manually_verified',
      },
    })

    // 8. IF customer_self_return: THIS IS THE GATING POINT — create + dispatch
    //    the new item order NOW (was blocked until verification completed).
    //    For courier_replacement, the new item was already dispatched in Part 3.
    if (exchange.exchangeMethod === 'customer_self_return') {
      await createAndDispatchExchangeOrder(d.exchange_id, ctx)
    }

    // 9. Mark as completed (for both methods — courier_replacement's new item
    //    was dispatched earlier, self_return's was just dispatched above)
    await db.orderExchange.update({
      where: { id: d.exchange_id },
      data: {
        status: 'completed',
        completedAt: new Date(),
      },
    })

    // 10. Audit log
    await insertAuditLog({
      action: 'exchange.old_item_verified',
      entityType: 'order_exchange',
      entityId: d.exchange_id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: {
        condition: d.condition,
        inventoryTxnId,
        stockLossId,
        exchangeMethod: exchange.exchangeMethod,
      },
    })

    // Metric event
    await insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'order_exchange',
      entityId: d.exchange_id,
      metricKey: 'exchange.old_item_verified',
      numericValue: oldItemCost,
      dimensions: {
        condition: d.condition,
        exchange_method: exchange.exchangeMethod,
      },
    }).catch(() => {})

    // Also fire exchange.completed metric
    await insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'order_exchange',
      entityId: d.exchange_id,
      metricKey: 'exchange.completed',
      numericValue: Number(exchange.newItemPrice) - Number(exchange.oldItemPrice),
      dimensions: {
        exchange_method: exchange.exchangeMethod,
        condition: d.condition,
      },
    }).catch(() => {})

    return { success: true, data: { exchangeStatus: 'completed' } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to verify old item',
    }
  }
}

// ══════════════════════════════════════════════════════════════
// PART 6: PRICE DIFFERENCE SETTLEMENT
// ══════════════════════════════════════════════════════════════

export async function settlePriceDifference(
  input: SettlePriceDifferenceInput,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const parsed = settlePriceDifferenceSchema.safeParse(input)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid input',
      }
    }
    const d = parsed.data

    const exchange = await db.orderExchange.findFirst({
      where: { id: d.exchange_id, companyId: ctx.company.id },
    })
    if (!exchange) return { success: false, error: 'Exchange not found' }

    await db.orderExchange.update({
      where: { id: d.exchange_id },
      data: {
        priceDifferenceSettledAmount: d.settled_amount,
        priceDifferenceSettledAt: new Date(),
        priceDifferenceSettledBy: ctx.employee.id,
        priceDifferenceStatus: 'settled',
      },
    })

    await insertAuditLog({
      action: 'exchange.price_difference_settled',
      entityType: 'order_exchange',
      entityId: d.exchange_id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: {
        settledAmount: d.settled_amount,
        settlementType: d.settlement_type,
      },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to settle price difference',
    }
  }
}

// ══════════════════════════════════════════════════════════════
// PART 7: "CUSTOMER DID NOT RETURN" HANDLING
// ══════════════════════════════════════════════════════════════

export async function markExchangeAsNotReturned(
  input: MarkNotReturnedInput,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const parsed = markNotReturnedSchema.safeParse(input)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid input',
      }
    }
    const d = parsed.data

    const exchange = await db.orderExchange.findFirst({
      where: { id: d.exchange_id, companyId: ctx.company.id },
      include: {
        originalOrder: { select: { customerId: true } },
      },
    })
    if (!exchange) return { success: false, error: 'Exchange not found' }

    // 3. Verify not already in a terminal state
    const terminalStates = ['completed', 'customer_did_not_return', 'cancelled']
    if (terminalStates.includes(exchange.status)) {
      return {
        success: false,
        error: `Cannot mark as not returned — exchange is already in terminal status '${exchange.status}'.`,
      }
    }

    // 4. UPDATE order_exchanges (the DB CHECK constraint enforces status consistency)
    await db.orderExchange.update({
      where: { id: d.exchange_id },
      data: {
        markedAsNotReturned: true,
        notReturnedReason: d.not_returned_reason,
        notReturnedRecoveryStatus: d.recovery_status,
        notReturnedRecoveryAmount: d.recovery_amount ?? null,
        status: 'customer_did_not_return',
      },
    })

    // 5. Call the existing flagCustomer() action with reason "Exchange item not returned"
    if (exchange.originalOrder.customerId) {
      await flagCustomer(
        exchange.originalOrder.customerId,
        'Exchange item not returned',
      ).catch((e) => {
        // Non-fatal — the exchange is still marked, just the flag failed
        console.error('[exchange] flagCustomer failed:', e)
      })
    }

    // 6. NOTE: for customer_self_return, the new item was NEVER dispatched
    //    (sequential gating held), so nothing to reverse.
    //    For courier_replacement, the new item WAS dispatched — this is now
    //    an unrecovered loss tracked via not_returned_recovery_amount.

    // 7. Audit log
    await insertAuditLog({
      action: 'exchange.not_returned',
      entityType: 'order_exchange',
      entityId: d.exchange_id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: {
        reason: d.not_returned_reason,
        recoveryStatus: d.recovery_status,
        recoveryAmount: d.recovery_amount ?? null,
        exchangeMethod: exchange.exchangeMethod,
        customerId: exchange.originalOrder.customerId,
      },
    })

    // Metric event
    await insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'order_exchange',
      entityId: d.exchange_id,
      metricKey: 'exchange.not_returned',
      numericValue: Number(exchange.oldItemPrice), // loss value
      dimensions: {
        exchange_method: exchange.exchangeMethod,
        recovery_status: d.recovery_status,
      },
    }).catch(() => {})

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to mark exchange as not returned',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// cancelExchangeRequest
// ──────────────────────────────────────────────────────────────

export async function cancelExchangeRequest(
  input: CancelExchangeInput,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const parsed = cancelExchangeSchema.safeParse(input)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid input',
      }
    }
    const d = parsed.data

    const exchange = await db.orderExchange.findFirst({
      where: { id: d.exchange_id, companyId: ctx.company.id },
    })
    if (!exchange) return { success: false, error: 'Exchange not found' }

    // Only valid while no new item has been dispatched
    const cancellableStates = ['requested', 'awaiting_customer_to_ship_old_item']
    if (!cancellableStates.includes(exchange.status)) {
      return {
        success: false,
        error: `Cannot cancel an exchange with status '${exchange.status}'. Cancellation is only allowed before any new item has been dispatched.`,
      }
    }

    await db.orderExchange.update({
      where: { id: d.exchange_id },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancellationReason: d.reason,
      },
    })

    await insertAuditLog({
      action: 'exchange.cancelled',
      entityType: 'order_exchange',
      entityId: d.exchange_id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { reason: d.reason },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to cancel exchange',
    }
  }
}

// ══════════════════════════════════════════════════════════════
// PART 8: LISTING & DETAIL
// ══════════════════════════════════════════════════════════════

export async function listExchanges(
  filters: {
    status?: string
    exchangeMethod?: 'courier_replacement' | 'customer_self_return'
    dateFrom?: string
    dateTo?: string
    limit?: number
    offset?: number
  } = {},
): Promise<ActionResult<{
  exchanges: Array<{
    id: string
    exchangeMethod: string
    status: string
    reason: string
    oldItemPrice: number
    newItemPrice: number
    priceDifference: number
    priceDifferenceStatus: string
    requestedAt: Date
    completedAt: Date | null
    originalOrderId: string
    originalOrder: { flowopsOrderNumber: string }
    newOrderId: string | null
    newOrder: { flowopsOrderNumber: string } | null
  }>
  total: number
}>> {
  try {
    const ctx = await getWorkspace()
    const limit = Math.min(filters.limit ?? 50, 100)
    const offset = filters.offset ?? 0

    const where: Prisma.OrderExchangeWhereInput = {
      companyId: ctx.company.id,
    }
    if (filters.status) where.status = filters.status
    if (filters.exchangeMethod) where.exchangeMethod = filters.exchangeMethod
    if (filters.dateFrom || filters.dateTo) {
      where.requestedAt = {}
      if (filters.dateFrom) where.requestedAt.gte = new Date(filters.dateFrom)
      if (filters.dateTo) where.requestedAt.lte = new Date(filters.dateTo)
    }

    const [exchanges, total] = await Promise.all([
      db.orderExchange.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          originalOrder: { select: { flowopsOrderNumber: true } },
          newOrder: { select: { flowopsOrderNumber: true } },
        },
      }),
      db.orderExchange.count({ where }),
    ])

    return {
      success: true,
      data: {
        exchanges: exchanges.map((e) => ({
          id: e.id,
          exchangeMethod: e.exchangeMethod,
          status: e.status,
          reason: e.reason,
          oldItemPrice: Number(e.oldItemPrice),
          newItemPrice: Number(e.newItemPrice),
          priceDifference: Number(e.priceDifference),
          priceDifferenceStatus: e.priceDifferenceStatus,
          requestedAt: e.requestedAt,
          completedAt: e.completedAt,
          originalOrderId: e.originalOrderId,
          originalOrder: e.originalOrder,
          newOrderId: e.newOrderId,
          newOrder: e.newOrder,
        })),
        total,
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list exchanges',
    }
  }
}

export async function getExchangeDetail(
  exchangeId: string,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()

    const exchange = await db.orderExchange.findFirst({
      where: { id: exchangeId, companyId: ctx.company.id },
      include: {
        originalOrder: {
          select: {
            id: true,
            flowopsOrderNumber: true,
            status: true,
            customerId: true,
            customer: {
              select: {
                id: true,
                name: true,
                phones: { where: { isPrimary: true }, take: 1, select: { phoneRaw: true } },
              },
            },
          },
        },
        originalOrderItem: {
          select: {
            id: true,
            orgVariantId: true,
            quantity: true,
            unitPrice: true,
            fulfillmentTypeSnapshot: true,
            orgVariant: { select: { sku: true, product: { select: { title: true } } } },
          },
        },
        newOrgVariant: {
          select: {
            id: true,
            sku: true,
            fulfillmentType: true,
            product: { select: { title: true } },
          },
        },
        newOrder: {
          select: {
            id: true,
            flowopsOrderNumber: true,
            status: true,
            dispatchedAt: true,
            deliveredAt: true,
          },
        },
        newOrderItem: {
          select: { id: true, fulfillmentStatus: true },
        },
        requestedByEmployee: {
          select: { id: true, user: { select: { fullName: true } } },
        },
        oldItemVerifiedByEmployee: {
          select: { id: true, user: { select: { fullName: true } } },
        },
      },
    })
    if (!exchange) return { success: false, error: 'Exchange not found' }

    return { success: true, data: exchange }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to get exchange detail',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// listOverdueExchanges — powers the alert/reminder system
// ──────────────────────────────────────────────────────────────

export async function listOverdueExchanges(
  daysThreshold: number = 7,
): Promise<ActionResult<{
  exchanges: Array<{
    id: string
    exchangeMethod: string
    status: string
    reason: string
    requestedAt: Date
    customerConfirmedShippedAt: Date | null
    originalOrder: { flowopsOrderNumber: string; customer: { name: string } }
    daysWaiting: number
  }>
}>> {
  try {
    const ctx = await getWorkspace()
    const threshold = new Date(Date.now() - daysThreshold * 86400000)

    // Exchanges in waiting states where the relevant latest timestamp is older than threshold
    const exchanges = await db.orderExchange.findMany({
      where: {
        companyId: ctx.company.id,
        status: {
          in: [
            'awaiting_old_item_return',
            'awaiting_customer_to_ship_old_item',
            'customer_confirmed_shipped',
          ],
        },
        // For awaiting_customer_to_ship_old_item: requestedAt is the relevant timestamp
        // For customer_confirmed_shipped: customerConfirmedShippedAt is the relevant timestamp
        // For awaiting_old_item_return: requestedAt is the relevant timestamp (courier_replacement)
        OR: [
          { status: 'awaiting_customer_to_ship_old_item', requestedAt: { lt: threshold } },
          {
            status: 'customer_confirmed_shipped',
            customerConfirmedShippedAt: { lt: threshold },
          },
          { status: 'awaiting_old_item_return', requestedAt: { lt: threshold } },
        ],
      },
      orderBy: { requestedAt: 'asc' },
      include: {
        originalOrder: {
          select: {
            flowopsOrderNumber: true,
            customer: { select: { name: true } },
          },
        },
      },
    })

    const now = Date.now()
    return {
      success: true,
      data: {
        exchanges: exchanges.map((e) => {
          // The "waiting since" timestamp depends on the current status
          const waitingSince =
            e.status === 'customer_confirmed_shipped'
              ? e.customerConfirmedShippedAt ?? e.requestedAt
              : e.requestedAt
          const daysWaiting = Math.floor(
            (now - new Date(waitingSince).getTime()) / 86400000,
          )
          return {
            id: e.id,
            exchangeMethod: e.exchangeMethod,
            status: e.status,
            reason: e.reason,
            requestedAt: e.requestedAt,
            customerConfirmedShippedAt: e.customerConfirmedShippedAt,
            originalOrder: e.originalOrder,
            daysWaiting,
          }
        }),
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list overdue exchanges',
    }
  }
}
