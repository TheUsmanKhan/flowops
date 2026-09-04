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

// ──────────────────────────────────────────────────────────────
// Exchange Shipments System (migration 008) — generate shipment number
// via the INDEPENDENT sequence (completely separate from generate_order_number).
// ──────────────────────────────────────────────────────────────
async function generateExchangeShipmentNumber(): Promise<string> {
  const result = await db.$queryRaw<{ generate_exchange_shipment_number: string }[]>`
    SELECT generate_exchange_shipment_number()
  `
  return result[0].generate_exchange_shipment_number
}

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// ──────────────────────────────────────────────────────────────
// Internal helper: create the linked EXCHANGE SHIPMENT + reserve stock +
// dispatch. Used by BOTH:
//   - dispatchExchangeNewItem() for courier_replacement (immediate)
//   - verifyOldItemReceived() for customer_self_return (after verification)
//
// MIGRATION 008 CHANGE: this function now creates an ExchangeShipment
// (EXCH-{YYYY}-{NNNNN}) instead of an Order row. The legacy newOrderId/
// newOrderItemId columns on order_exchanges remain populated only on old,
// pre-migration historical exchange records. NEW exchanges are linked via
// the exchange_shipments.orderExchangeId FK.
//
// Returns the new exchange shipment ID + number.
// ──────────────────────────────────────────────────────────────
async function createAndReserveExchangeShipment(
  exchangeId: string,
  ctx: Awaited<ReturnType<typeof getWorkspace>>,
  options?: {
    orderRefNumber?: string
    orderDetail?: string
  },
): Promise<{ newExchangeShipmentId: string; exchangeShipmentNumber: string }> {
  // Fetch the exchange record (already validated by caller)
  const exchange = await db.orderExchange.findUniqueOrThrow({
    where: { id: exchangeId },
    include: {
      originalOrder: {
        select: {
          customerId: true,
          dispatchLocationId: true,
          usedCustomerAddressId: true,
          usedCustomerPhoneId: true,
        },
      },
      newOrgVariant: {
        select: {
          id: true,
          fulfillmentType: true,
          costPrice: true,
          sku: true,
          attributeValues: true,
          product: { select: { title: true } },
        },
      },
    },
  })

  const customerId = exchange.originalOrder.customerId

  const shippingAddressId = exchange.originalOrder.usedCustomerAddressId
  const shippingPhoneId = exchange.originalOrder.usedCustomerPhoneId

  const priceDiff = Number(exchange.priceDifference)
  const baseInvoiceAmount =
    exchange.priceDifferenceStatus === 'customer_owes' && priceDiff > 0 ? priceDiff : 0
  const invoiceAmount = baseInvoiceAmount

  // 1. Generate the EXCH-{YYYY}-{NNNNN} number
  const exchangeShipmentNumber = await generateExchangeShipmentNumber()

  // 1a. Universal courier reference fields (migration 015)
  const orderRefNumber =
    (options?.orderRefNumber && options.orderRefNumber.trim()) || exchangeShipmentNumber
  let orderDetail = (options?.orderDetail && options.orderDetail.trim()) || ''
  if (!orderDetail) {
    const attrParts: string[] = []
    try {
      const attrs = JSON.parse(exchange.newOrgVariant.attributeValues || '{}') as Record<string, string>
      for (const [k, v] of Object.entries(attrs)) {
        if (v) attrParts.push(`${k}: ${v}`)
      }
    } catch {
      // ignore parse errors
    }
    const inner = [exchange.newOrgVariant.sku, ...attrParts].filter(Boolean).join(', ')
    orderDetail = `${exchange.newOrgVariant.product.title}${inner ? ` (${inner})` : ''} ×1`
  }

  // 2. Create the exchange shipment — status='confirmed' (NOT dispatched!)
  // The shipment will be booked via the Booking Workbench or SendExchangeShipmentModal,
  // and only transition to 'dispatched' after a real courier booking succeeds.
  const shipment = await db.exchangeShipment.create({
    data: {
      exchangeShipmentNumber,
      organizationId: ctx.company.organizationId,
      companyId: ctx.company.id,
      orderExchangeId: exchangeId,
      newOrgVariantId: exchange.newOrgVariantId,
      quantity: 1,
      fulfillmentTypeSnapshot: exchange.newOrgVariant.fulfillmentType,
      customerId,
      shippingAddressId,
      shippingPhoneId,
      status: 'confirmed',
      isPriorityBackorder: true,
      invoiceAmount,
      orderRefNumber,
      orderDetail,
      confirmedAt: new Date(),
      createdBy: ctx.employee.id,
    },
  })

  // 3. Reserve stock (if stock_based) — mirrors reserveOrderStock()
  const locationId = exchange.originalOrder.dispatchLocationId
  if (locationId && exchange.newOrgVariant.fulfillmentType === 'stock_based') {
    const pool = await db.inventoryPool.findUnique({
      where: {
        orgVariantId_locationId: {
          orgVariantId: exchange.newOrgVariantId,
          locationId,
        },
      },
    })
    const available = pool ? pool.onHand - pool.reserved : 0

    if (available >= 1) {
      await reserveStockForOrder({
        orgVariantId: exchange.newOrgVariantId,
        locationId,
        organizationId: ctx.company.organizationId,
        companyId: ctx.company.id,
        employeeId: ctx.employee.id,
        quantity: 1,
      })
    } else {
      // Insufficient stock — mark as backordered (isPriorityBackorder=true)
      await db.exchangeShipment.update({
        where: { id: shipment.id },
        data: { status: 'backordered', backorderedAt: new Date() },
      })
    }
  }

  // 4. Audit + metric
  insertAuditLog({
    action: 'exchange_shipment.created',
    entityType: 'exchange_shipment',
    entityId: shipment.id,
    companyId: ctx.company.id,
    organizationId: ctx.company.organizationId,
    userId: ctx.user.id,
    employeeId: ctx.employee.id,
    newValues: {
      exchangeId,
      exchangeShipmentNumber,
      newOrgVariantId: exchange.newOrgVariantId,
      invoiceAmount,
    },
  })

  insertMetricEvent({
    companyId: ctx.company.id,
    entityType: 'exchange_shipment',
    entityId: shipment.id,
    metricKey: 'exchange_shipment.created',
    numericValue: 1,
    dimensions: { exchange_method: exchange.exchangeMethod },
  })

  return { newExchangeShipmentId: shipment.id, exchangeShipmentNumber }
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
        priceDifference: newItemPrice - oldItemPrice,
        priceDifferenceStatus,
        reason: d.reason,
        requestedBy: ctx.employee.id,
      },
    })

    // 8. Audit log
    insertAuditLog({
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
    insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'order',
      entityId: orderItem.order.id,
      metricKey: 'exchange.requested',
      numericValue: 1,
      dimensions: {
        exchange_id: exchange.id,
        exchange_method: d.exchange_method,
      },
    })

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
  options?: {
    /** Universal courier reference field override (migration 015) */
    orderRefNumber?: string
    /** Universal courier item-description override (migration 015) */
    orderDetail?: string
  },
): Promise<ActionResult<{ newExchangeShipmentId: string; exchangeShipmentNumber: string }>> {
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

    // Create + reserve the new EXCHANGE SHIPMENT (courier booking happens later via Workbench)
    const { newExchangeShipmentId, exchangeShipmentNumber } = await createAndReserveExchangeShipment(
      exchangeId,
      ctx,
      options,
    )

    // Update exchange status to 'awaiting_old_item_return' (old item collection
    // happens during this delivery, but manual verification still needed)
    await db.orderExchange.update({
      where: { id: exchangeId },
      data: { status: 'awaiting_old_item_return' },
    })

    return { success: true, data: { newExchangeShipmentId, exchangeShipmentNumber } }
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

    insertAuditLog({
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
    // 6. IF condition = 'damaged': create stock_loss_records entry via
    //    the unified recordStockLoss helper (dedup + sourceModule tracked)
    if (d.condition === 'damaged') {
      // UNIFIED: now uses recordStockLoss() (was: direct db.stockLossRecord.create)
      // so the loss is properly deduped + sourceModule is set. Enables tracing
      // "this loss came from the exchange module" + prevents duplicates.
      const { recordStockLoss } = await import('@/lib/stock-loss')
      const lossResult = await recordStockLoss({
        organizationId: ctx.company.organizationId,
        companyId: ctx.company.id,
        orgVariantId: exchange.originalOrderItem.orgVariantId,
        locationId,
        lossType: 'damaged',
        sourceModule: 'exchange',
        quantity: 1,
        costPerUnit: oldItemCost,
        orderItemId: exchange.originalOrderItemId, // enables dedup
        employeeId: ctx.employee.id,
        subType: 'confirmed',
        damageType: 'other',
        responsibleParty: 'customer',
        notes: `Damaged exchanged item. ${d.notes || ''}`.trim(),
        // createInventoryTransaction=false — the old item was returned, not
        // in-stock. No stock movement needed (the item was never added back).
        createInventoryTransaction: false,
      })
      if (lossResult.success) {
        stockLossId = lossResult.lossRecordId ?? null
        inventoryTxnId = lossResult.inventoryTxnId ?? null
      }
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

    // 8. IF customer_self_return: THIS IS THE GATING POINT.
    //    PROMPT 5 CHANGE: verification now STOPS at 'old_item_manually_verified'.
    //    The actual shipment creation + dispatch is a separate explicit step,
    //    triggered by the "Send Replacement Order" button in the Exchange Detail UI.
    //    This lets staff select a courier, address, and city before dispatching.
    //    For courier_replacement, the new item was already dispatched in Part 3
    //    (via dispatchExchangeNewItem), so we mark as completed here.
    if (exchange.exchangeMethod === 'courier_replacement') {
      // For courier_replacement: the new item was already dispatched earlier,
      // so we can mark the exchange as completed now.
      await db.orderExchange.update({
        where: { id: d.exchange_id },
        data: {
          status: 'completed',
          completedAt: new Date(),
        },
      })
    }
    // For customer_self_return: status stays at 'old_item_manually_verified'.
    // The "Send Replacement Order" button (Prompt 5 Phase 1) calls
    // dispatchReplacementForSelfReturnExchange() to create + dispatch the shipment.

    // 10. Audit log
    insertAuditLog({
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
    insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'order_exchange',
      entityId: d.exchange_id,
      metricKey: 'exchange.old_item_verified',
      numericValue: oldItemCost,
      dimensions: {
        condition: d.condition,
        exchange_method: exchange.exchangeMethod,
      },
    })

    // Also fire exchange.completed metric — ONLY for courier_replacement
    // (customer_self_return no longer auto-completes; completion happens when
    // the "Send Replacement Order" button is clicked and the shipment is dispatched)
    if (exchange.exchangeMethod === 'courier_replacement') {
      insertMetricEvent({
        companyId: ctx.company.id,
        entityType: 'order_exchange',
        entityId: d.exchange_id,
        metricKey: 'exchange.completed',
        numericValue: Number(exchange.newItemPrice) - Number(exchange.oldItemPrice),
        dimensions: {
          exchange_method: exchange.exchangeMethod,
          condition: d.condition,
        },
      })
    }

    return {
      success: true,
      data: {
        exchangeStatus: exchange.exchangeMethod === 'courier_replacement'
          ? 'completed'
          : 'old_item_manually_verified',
      },
    }
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
      include: {
        exchangeShipments: {
          select: { estimatedDeliveryCharge: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    })
    if (!exchange) return { success: false, error: 'Exchange not found' }

    // ── Compute refundAmount for refund_due case ──
    let refundAmount: number | null = null
    if (d.settlement_type === 'refunded_to_customer') {
      const rawPriceDiff = Math.abs(Number(exchange.priceDifference))
      const estimatedDeliveryCharge = exchange.exchangeShipments[0]?.estimatedDeliveryCharge
        ? Number(exchange.exchangeShipments[0].estimatedDeliveryCharge)
        : 0

      // Check company setting
      const orderSettings = await db.companyOrderSetting.findUnique({
        where: { companyId: ctx.company.id },
        select: { deductDeliveryChargeFromRefund: true },
      })
      const deductDelivery = orderSettings?.deductDeliveryChargeFromRefund ?? false

      if (deductDelivery) {
        refundAmount = Math.max(0, rawPriceDiff - estimatedDeliveryCharge)
      } else {
        // Default: customer gets full price difference back; delivery charge is business-absorbed
        refundAmount = rawPriceDiff
      }
    }

    await db.orderExchange.update({
      where: { id: d.exchange_id },
      data: {
        priceDifferenceSettledAmount: d.settled_amount,
        priceDifferenceSettledAt: new Date(),
        priceDifferenceSettledBy: ctx.employee.id,
        priceDifferenceStatus: 'settled',
        // Refund tracking (migration 014)
        ...(d.settlement_type === 'refunded_to_customer'
          ? {
              refundMethod: d.refund_method ?? null,
              refundReference: d.refund_reference?.trim() || null,
              refundProcessedAt: new Date(),
              refundProcessedBy: ctx.employee.id,
              refundAmount,
            }
          : {}),
      },
    })

    insertAuditLog({
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
        ...(refundAmount !== null ? { refundAmount, refundMethod: d.refund_method } : {}),
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
    insertAuditLog({
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
    insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'order_exchange',
      entityId: d.exchange_id,
      metricKey: 'exchange.not_returned',
      numericValue: Number(exchange.oldItemPrice), // loss value
      dimensions: {
        exchange_method: exchange.exchangeMethod,
        recovery_status: d.recovery_status,
      },
    })

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

    insertAuditLog({
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
    // NEW (migration 008): exchange shipments linked to this exchange
    exchangeShipments: Array<{
      id: string
      exchangeShipmentNumber: string
      status: string
    }>
  }>
  total: number
}>> {
  try {
    const ctx = await getWorkspace()
    const limit = Math.min(filters.limit ?? 50, 100)
    const offset = filters.offset ?? 0

    const where: { companyId: string; status?: string; exchangeMethod?: string; requestedAt?: { gte?: Date; lte?: Date } } = {
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
          // NEW: include exchange shipments (migration 008)
          exchangeShipments: {
            select: { id: true, exchangeShipmentNumber: true, status: true, trackingNumber: true, courierSubStatus: true, dispatchedAt: true, deliveredAt: true, returnedAt: true, createdAt: true, invoiceAmount: true, quantity: true },
            orderBy: { createdAt: 'desc' },
          },
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
          exchangeShipments: e.exchangeShipments,
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
        // NEW (migration 008): include exchange shipments linked to this exchange
        exchangeShipments: {
          select: {
            id: true,
            exchangeShipmentNumber: true,
            status: true,
            quantity: true,
            invoiceAmount: true,
            trackingNumber: true,
            courierSubStatus: true,
            dispatchedAt: true,
            deliveredAt: true,
            returnedAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
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

// ══════════════════════════════════════════════════════════════
// PART 11: DISPATCH REPLACEMENT FOR SELF-RETURN EXCHANGE (Prompt 5)
// ══════════════════════════════════════════════════════════════

/**
 * Dispatch the replacement shipment for a customer_self_return exchange
 * AFTER old item verification is complete (status='old_item_manually_verified').
 *
 * This is the explicit "Send Replacement Order" action — it creates an
 * ExchangeShipment, reserves stock, and dispatches it.
 *
 * PROMPT 5 CHANGE: Previously, verifyOldItemReceived() auto-dispatched
 * for customer_self_return. Now verification stops at 'old_item_manually_verified'
 * and this function is the separate explicit dispatch step.
 */
export async function dispatchReplacementForSelfReturnExchange(
  exchangeId: string,
  options?: {
    /** Universal courier reference field override (migration 015) */
    orderRefNumber?: string
    /** Universal courier item-description override (migration 015) */
    orderDetail?: string
  },
): Promise<ActionResult<{
  newExchangeShipmentId: string
  exchangeShipmentNumber: string
}>> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const exchange = await db.orderExchange.findFirst({
      where: { id: exchangeId, companyId: ctx.company.id },
      select: { exchangeMethod: true, status: true, newItemPrice: true, oldItemPrice: true },
    })
    if (!exchange) {
      return { success: false, error: 'Exchange not found.' }
    }

    // Guard: only for customer_self_return at status='old_item_manually_verified'
    if (exchange.exchangeMethod !== 'customer_self_return') {
      return { success: false, error: 'This action is only for customer_self_return exchanges.' }
    }
    if (exchange.status !== 'old_item_manually_verified') {
      return { success: false, error: `Cannot dispatch replacement for an exchange with status '${exchange.status}'. Expected 'old_item_manually_verified'.` }
    }

    // Use the internal helper to create + reserve the ExchangeShipment
    const result = await createAndReserveExchangeShipment(exchangeId, ctx, options)

    // Mark the exchange as completed
    await db.orderExchange.update({
      where: { id: exchangeId },
      data: { status: 'completed', completedAt: new Date() },
    })

    // Fire exchange.completed metric
    insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'order_exchange',
      entityId: exchangeId,
      metricKey: 'exchange.completed',
      numericValue: Number(exchange.newItemPrice) - Number(exchange.oldItemPrice),
      dimensions: { exchange_method: exchange.exchangeMethod },
    })

    return { success: true, data: result }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to dispatch replacement' }
  }
}
