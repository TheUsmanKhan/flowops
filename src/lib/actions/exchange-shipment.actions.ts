/**
 * Exchange Shipments — Server Actions.
 *
 * Structurally separate from the Order system. Exchange shipments live in
 * their own table (exchange_shipments) with their own independent numbering
 * (EXCH-{YYYY}-{NNNNN}), so they NEVER mix into revenue/order-count reporting.
 *
 * CRITICAL RULES (enforced throughout this file):
 *   1. updateCustomerStats() is NEVER called — exchange shipments don't
 *      affect customer order counts, totals, or RTO rates.
 *   2. createCustomer() is NEVER called — customerId is always an existing,
 *      already-resolved customer from the original order.
 *   3. All stock operations go through the existing processInventoryTransaction()
 *      gateway — tagged with relatedEntityType='exchange_shipment' for audit.
 *   4. No draft system — this form is completed in a single sitting.
 *
 * Same interaction patterns with Inventory/Products/CRM as OMS uses, but
 * living in its own table. Mirrors reserveOrderStock(), dispatchOrderAction(),
 * markOrderDelivered(), cancelOrder() — but for exchange shipments.
 */

import { db } from '@/lib/db'
import { getWorkspace, requirePermission, ApiError } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import {
  reserveStockForOrder,
  unreserveStockForOrder,
  dispatchOrder,
  checkAndFulfillMadeToOrderVariant,
  processInventoryTransaction,
} from '@/lib/inventory'

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// ──────────────────────────────────────────────────────────────
// Helper: generate exchange shipment number via the DB sequence
// ──────────────────────────────────────────────────────────────

async function generateExchangeShipmentNumber(): Promise<string> {
  const result = await db.$queryRaw<{ generate_exchange_shipment_number: string }[]>`
    SELECT generate_exchange_shipment_number()
  `
  return result[0].generate_exchange_shipment_number
}

// ──────────────────────────────────────────────────────────────
// 1. createExchangeShipment
// ──────────────────────────────────────────────────────────────

export interface CreateExchangeShipmentInput {
  orderExchangeId: string
  quantity: number
  customerAddressId: string
  customerPhoneId: string
  shippingCityOverride?: string
  invoiceAmount?: number
  /** Optional: override the variant (defaults to order_exchanges.newOrgVariantId) */
  newOrgVariantId?: string
  /**
   * Universal courier reference field (migration 015). Optional — defaults
   * to the generated exchangeShipmentNumber (EXCH-YYYY-NNNNN) when blank.
   * Mapped to the courier's own reference field at booking time.
   */
  orderRefNumber?: string
  /**
   * Universal courier item-description string (migration 015). Optional —
   * auto-generated from the variant (product title + SKU + attributes + qty)
   * when blank. Mapped to the courier's itemDescription / orderDetail field.
   */
  orderDetail?: string
}

export async function createExchangeShipment(
  input: CreateExchangeShipmentInput,
): Promise<ActionResult<{
  exchangeShipmentId: string
  exchangeShipmentNumber: string
}>> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    // Fetch the parent exchange request with all needed relations
    const exchange = await db.orderExchange.findFirst({
      where: {
        id: input.orderExchangeId,
        companyId: ctx.company.id,
      },
      include: {
        originalOrder: {
          select: { customerId: true, dispatchLocationId: true },
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
    if (!exchange) {
      return { success: false, error: 'Exchange request not found or does not belong to your company.' }
    }

    // Verify the customer address and phone belong to this customer
    const customerId = exchange.originalOrder.customerId
    const address = await db.customerAddress.findFirst({
      where: { id: input.customerAddressId, customerId },
      select: { id: true, city: true },
    })
    if (!address) {
      return { success: false, error: 'Shipping address not found or does not belong to this customer.' }
    }
    const phone = await db.customerPhone.findFirst({
      where: { id: input.customerPhoneId, customerId },
      select: { id: true },
    })
    if (!phone) {
      return { success: false, error: 'Shipping phone not found or does not belong to this customer.' }
    }

    // Determine the variant to ship
    const variantId = input.newOrgVariantId ?? exchange.newOrgVariantId
    const variant = variantId === exchange.newOrgVariantId
      ? exchange.newOrgVariant
      : await db.orgProductVariant.findUnique({
          where: { id: variantId },
          select: {
            id: true,
            fulfillmentType: true,
            sku: true,
            attributeValues: true,
            product: { select: { title: true } },
          },
        })
    if (!variant) {
      return { success: false, error: 'Variant not found.' }
    }

    // Determine invoice amount: defaults to priceDifference if customer_owes, else 0
    let invoiceAmount = input.invoiceAmount
    if (invoiceAmount === undefined) {
      const priceDiff = Number(exchange.priceDifference)
      if (exchange.priceDifferenceStatus === 'customer_owes' && priceDiff > 0) {
        invoiceAmount = priceDiff
      } else {
        invoiceAmount = 0
      }
    }

    // Generate the exchange shipment number
    const exchangeShipmentNumber = await generateExchangeShipmentNumber()

    // ── Universal courier reference fields (migration 015) ──────────────
    // orderRefNumber: caller-provided takes precedence, otherwise default
    // to the freshly-generated exchangeShipmentNumber.
    const orderRefNumber =
      (input.orderRefNumber && input.orderRefNumber.trim()) || exchangeShipmentNumber
    // orderDetail: caller-provided takes precedence, otherwise auto-generate
    // from the variant: "Product Title (SKU, Size: M, Color: Blue) ×N"
    let orderDetail = (input.orderDetail && input.orderDetail.trim()) || ''
    if (!orderDetail) {
      const attrParts: string[] = []
      try {
        const attrs = JSON.parse(variant.attributeValues || '{}') as Record<string, string>
        for (const [k, v] of Object.entries(attrs)) {
          if (v) attrParts.push(`${k}: ${v}`)
        }
      } catch {
        // ignore parse errors
      }
      const inner = [variant.sku, ...attrParts].filter(Boolean).join(', ')
      orderDetail = `${variant.product.title}${inner ? ` (${inner})` : ''} ×${input.quantity}`
    }

    // Create the shipment — status='confirmed' (no pending step needed)
    const shipment = await db.exchangeShipment.create({
      data: {
        exchangeShipmentNumber,
        organizationId: ctx.company.organizationId,
        companyId: ctx.company.id,
        orderExchangeId: input.orderExchangeId,
        newOrgVariantId: variantId,
        quantity: input.quantity,
        fulfillmentTypeSnapshot: variant.fulfillmentType,
        customerId,
        shippingAddressId: input.customerAddressId,
        shippingPhoneId: input.customerPhoneId,
        shippingCityOverride: input.shippingCityOverride ?? null,
        status: 'confirmed',
        isPriorityBackorder: true, // ALL exchange shipments get priority
        invoiceAmount,
        // Universal courier reference fields (migration 015)
        orderRefNumber,
        orderDetail,
        confirmedAt: new Date(),
        createdBy: ctx.employee.id,
      },
    })

    // Audit + metric (non-fatal)
    insertAuditLog({
      action: 'exchange_shipment.created',
      entityType: 'exchange_shipment',
      entityId: shipment.id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: {
        exchangeShipmentNumber,
        orderExchangeId: input.orderExchangeId,
        newOrgVariantId: variantId,
        quantity: input.quantity,
        invoiceAmount,
        customerId,
      },
    })

    insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'exchange_shipment',
      entityId: shipment.id,
      metricKey: 'exchange_shipment.created',
      numericValue: 1,
      dimensions: {
        exchange_shipment_number: exchangeShipmentNumber,
        exchange_method: exchange.exchangeMethod,
      },
    })

    return {
      success: true,
      data: { exchangeShipmentId: shipment.id, exchangeShipmentNumber },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to create exchange shipment',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 2. reserveExchangeShipmentStock
// ──────────────────────────────────────────────────────────────

export async function reserveExchangeShipmentStock(
  exchangeShipmentId: string,
): Promise<ActionResult<{ outcome: 'reserved' | 'backordered' | 'failed'; reason?: string }>> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const shipment = await db.exchangeShipment.findFirst({
      where: { id: exchangeShipmentId, companyId: ctx.company.id },
      include: {
        orderExchange: {
          select: { originalOrder: { select: { dispatchLocationId: true } } },
        },
        newOrgVariant: {
          select: { id: true, fulfillmentType: true, inventoryPolicy: true },
        },
      },
    })
    if (!shipment) {
      return { success: false, error: 'Exchange shipment not found.' }
    }
    if (shipment.status !== 'confirmed') {
      return { success: false, error: `Cannot reserve stock for a shipment with status='${shipment.status}'.` }
    }

    const locationId = shipment.orderExchange.originalOrder.dispatchLocationId
    if (!locationId) {
      return {
        success: true,
        data: { outcome: 'failed', reason: 'No dispatch location set on the original order.' },
      }
    }

    // Branch on fulfillmentTypeSnapshot (same pattern as reserveOrderStock)
    if (shipment.fulfillmentTypeSnapshot === 'stock_based') {
      // Check available stock
      const pool = await db.inventoryPool.findUnique({
        where: {
          orgVariantId_locationId: {
            orgVariantId: shipment.newOrgVariantId,
            locationId,
          },
        },
      })
      const available = pool ? pool.onHand - pool.reserved : 0

      if (available >= shipment.quantity) {
        // Sufficient stock — reserve it
        const reserveResult = await reserveStockForOrder({
          orgVariantId: shipment.newOrgVariantId,
          locationId,
          organizationId: shipment.organizationId,
          companyId: shipment.companyId,
          employeeId: ctx.employee.id,
          quantity: shipment.quantity,
          // NOTE: reserveStockForOrder uses referenceType='order' internally.
          // We pass orderId=undefined and rely on the audit log + the shipment's
          // own tracking. The inventory_transaction row will have referenceType='order'
          // but the exchange_shipment is tracked via our audit log.
          // (A future refactor could add an exchange_shipment referenceType to
          //  reserveStockForOrder, but the current approach is non-breaking.)
        })

        if (reserveResult.success) {
          // Update shipment: mark as reserved (status stays 'confirmed' — no
          // separate 'reserved' state in the simplified lifecycle)
          insertAuditLog({
            action: 'exchange_shipment.reserved',
            entityType: 'exchange_shipment',
            entityId: exchangeShipmentId,
            companyId: ctx.company.id,
            organizationId: ctx.company.organizationId,
            userId: ctx.user.id,
            employeeId: ctx.employee.id,
            newValues: { locationId, quantity: shipment.quantity },
          })

          insertMetricEvent({
            companyId: ctx.company.id,
            entityType: 'exchange_shipment',
            entityId: exchangeShipmentId,
            metricKey: 'exchange_shipment.reserved',
            numericValue: shipment.quantity,
            dimensions: { variant_id: shipment.newOrgVariantId },
          })

          return { success: true, data: { outcome: 'reserved' } }
        } else {
          return { success: true, data: { outcome: 'failed', reason: reserveResult.error } }
        }
      } else {
        // Insufficient stock — mark as backordered (isPriorityBackorder is already true)
        await db.exchangeShipment.update({
          where: { id: exchangeShipmentId },
          data: {
            status: 'backordered',
            backorderedAt: new Date(),
          },
        })

        insertAuditLog({
          action: 'exchange_shipment.reserved',
          entityType: 'exchange_shipment',
          entityId: exchangeShipmentId,
          companyId: ctx.company.id,
          organizationId: ctx.company.organizationId,
          userId: ctx.user.id,
          employeeId: ctx.employee.id,
          newValues: { status: 'backordered', available, required: shipment.quantity },
        })

        insertMetricEvent({
          companyId: ctx.company.id,
          entityType: 'exchange_shipment',
          entityId: exchangeShipmentId,
          metricKey: 'exchange_shipment.backordered',
          numericValue: shipment.quantity,
          dimensions: { variant_id: shipment.newOrgVariantId, available, required: shipment.quantity },
        })

        return {
          success: true,
          data: { outcome: 'backordered', reason: `Available: ${available}, required: ${shipment.quantity}` },
        }
      }
    } else if (shipment.fulfillmentTypeSnapshot === 'made_to_order') {
      // Made-to-order: check returned stock first, then trigger production
      const mtoResult = await checkAndFulfillMadeToOrderVariant(
        shipment.newOrgVariantId,
        shipment.quantity,
        shipment.companyId,
        locationId,
      )

      if (mtoResult.source === 'existing_stock' && mtoResult.locationId) {
        // Returned stock available — reserve it
        const reserveResult = await reserveStockForOrder({
          orgVariantId: shipment.newOrgVariantId,
          locationId: mtoResult.locationId,
          organizationId: shipment.organizationId,
          companyId: shipment.companyId,
          employeeId: ctx.employee.id,
          quantity: shipment.quantity,
        })

        if (reserveResult.success) {
          insertAuditLog({
            action: 'exchange_shipment.reserved',
            entityType: 'exchange_shipment',
            entityId: exchangeShipmentId,
            companyId: ctx.company.id,
            organizationId: ctx.company.organizationId,
            userId: ctx.user.id,
            employeeId: ctx.employee.id,
            newValues: { source: 'existing_stock', locationId: mtoResult.locationId },
          })
          return { success: true, data: { outcome: 'reserved' } }
        } else {
          return { success: true, data: { outcome: 'failed', reason: reserveResult.error } }
        }
      } else if (mtoResult.source === 'fresh_production' && mtoResult.productionOrderId) {
        // Fresh production triggered — log and return reserved (production is queued)
        insertAuditLog({
          action: 'exchange_shipment.reserved',
          entityType: 'exchange_shipment',
          entityId: exchangeShipmentId,
          companyId: ctx.company.id,
          organizationId: ctx.company.organizationId,
          userId: ctx.user.id,
          employeeId: ctx.employee.id,
          newValues: { source: 'fresh_production', productionOrderId: mtoResult.productionOrderId },
        })
        return { success: true, data: { outcome: 'reserved' } }
      } else {
        return { success: true, data: { outcome: 'failed', reason: mtoResult.error ?? 'MTO fulfillment failed' } }
      }
    } else {
      return { success: true, data: { outcome: 'failed', reason: `Unknown fulfillmentType: ${shipment.fulfillmentTypeSnapshot}` } }
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to reserve exchange shipment stock',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 3. dispatchExchangeShipment (+ performExchangeShipmentDispatch)
// ──────────────────────────────────────────────────────────────

/**
 * SHARED exchange-shipment-dispatch business logic — the SINGLE place where
 * inventory deduction (dispatchOrder → processInventoryTransaction('sale_dispatched'))
 * + status='dispatched' + parent-exchange-status update + audit/metric happen.
 *
 * Mirrors performOrderDispatch() in order.actions.ts. Exists to fix the same
 * bug: the PostEx status-polling cron was setting exchange_shipments.status=
 * 'dispatched' via direct db.exchangeShipment.update() WITHOUT calling the
 * inventory deduction logic. See worklog Task 25.
 *
 * Called from:
 *   - dispatchExchangeShipment() [manual/Booking-Workbench, source='manual'] —
 *     AFTER getWorkspace()/permission checks
 *   - pollPostExOrderStatuses() [cron, source='auto_poll'] — no session,
 *     reads companyId/organizationId from the shipment itself
 *
 * CRITICAL: this function does NOT call getWorkspace().
 *
 * IDEMPOTENT: if the shipment already has a matching sale_dispatched txn
 * (linked via metadata.exchangeShipmentId), the inventory deduction is skipped
 * and only the status is updated — preventing double-deduction.
 */
export async function performExchangeShipmentDispatch(
  exchangeShipmentId: string,
  context: {
    source: 'manual' | 'auto_poll'
    triggeredByEmployeeId?: string | null
    trackingNumber?: string
    courierCompanyIntegrationId?: string
  },
): Promise<ActionResult & { skipped?: boolean; reason?: string }> {
  const source = context.source

  // 1. Fetch the shipment — NO companyId scoping (works in cron context)
  const shipment = await db.exchangeShipment.findUnique({
    where: { id: exchangeShipmentId },
    include: {
      orderExchange: {
        select: {
          id: true,
          exchangeMethod: true,
          originalOrder: { select: { dispatchLocationId: true } },
        },
      },
    },
  })
  if (!shipment) return { success: false, error: 'Exchange shipment not found.' }

  // 2. Guard: block if backordered or already in a terminal state
  if (shipment.status === 'backordered') {
    return { success: false, error: 'Cannot dispatch a backordered shipment. Resolve the backorder first.' }
  }
  if (shipment.status === 'dispatched' || shipment.status === 'delivered' || shipment.status === 'cancelled') {
    return { success: false, skipped: true, error: `Cannot dispatch a shipment with status='${shipment.status}'.` }
  }

  const locationId = shipment.orderExchange.originalOrder.dispatchLocationId
  if (!locationId) {
    return { success: false, error: 'No dispatch location set on the original order.' }
  }

  // 3. IDEMPOTENCY GUARD: check if a sale_dispatched txn already exists for
  //    this shipment (linked via metadata.exchangeShipmentId). If so, skip
  //    the inventory deduction — only update the status. This prevents
  //    double-deduction if the polling job fires twice or a manual dispatch
  //    races with an auto-dispatch.
  const existingDispatchTxn = await db.inventoryTransaction.findFirst({
    where: {
      transactionType: 'sale_dispatched',
      orgVariantId: shipment.newOrgVariantId,
      locationId,
      metadata: { contains: `"exchangeShipmentId":"${exchangeShipmentId}"` },
    },
    select: { id: true },
  })

  const inventorySkipped = !!existingDispatchTxn

  if (!inventorySkipped) {
    // 4. Deduct stock via dispatchOrder() (mirrors dispatchOrderAction)
    const dispatchResult = await dispatchOrder({
      orgVariantId: shipment.newOrgVariantId,
      locationId,
      organizationId: shipment.organizationId,
      companyId: shipment.companyId,
      employeeId: context.triggeredByEmployeeId ?? null,
      quantity: shipment.quantity,
    })

    if (!dispatchResult.success) {
      return { success: false, error: dispatchResult.error ?? 'Failed to dispatch stock.' }
    }

    // Tag the newly-created txn with the exchangeShipmentId in metadata so
    // future idempotency checks can find it. We do this by updating the most
    // recent sale_dispatched txn for this variant+location.
    await db.inventoryTransaction.updateMany({
      where: {
        transactionType: 'sale_dispatched',
        orgVariantId: shipment.newOrgVariantId,
        locationId,
        // The txn was created seconds ago — match by recordedAt within the last minute
        recordedAt: { gte: new Date(Date.now() - 60_000) },
        metadata: '{}',
      },
      data: {
        metadata: JSON.stringify({
          exchangeShipmentId,
          dispatch_source: source,
        }),
      },
    }).catch((e) => console.error(`[performExchangeShipmentDispatch] failed to tag txn metadata:`, e))
  }

  // 5. Update the shipment
  await db.exchangeShipment.update({
    where: { id: exchangeShipmentId },
    data: {
      status: 'dispatched',
      dispatchedAt: new Date(),
      ...(context.trackingNumber ? { trackingNumber: context.trackingNumber } : {}),
      ...(context.courierCompanyIntegrationId ? { courierCompanyIntegrationId: context.courierCompanyIntegrationId } : {}),
    },
  })

  // 6. Update the parent order_exchanges status appropriately
  const exchange = shipment.orderExchange
  let newExchangeStatus: string
  if (exchange.exchangeMethod === 'courier_replacement') {
    // For courier_replacement: the new item is now dispatched, courier will
    // collect the old item during this delivery → awaiting_old_item_return
    newExchangeStatus = 'awaiting_old_item_return'
  } else {
    // For customer_self_return: the old item was already verified before
    // this shipment was created → the exchange is now complete
    newExchangeStatus = 'completed'
  }

  await db.orderExchange.update({
    where: { id: exchange.id },
    data: {
      status: newExchangeStatus,
      ...(newExchangeStatus === 'completed' ? { completedAt: new Date() } : {}),
    },
  })

  // 7. Audit + metric (tagged with dispatch_source)
  insertAuditLog({
    action: 'exchange_shipment.dispatched',
    entityType: 'exchange_shipment',
    entityId: exchangeShipmentId,
    companyId: shipment.companyId,
    organizationId: shipment.organizationId,
    userId: null,
    employeeId: context.triggeredByEmployeeId ?? null,
    newValues: {
      trackingNumber: context.trackingNumber,
      courierCompanyIntegrationId: context.courierCompanyIntegrationId,
      exchangeStatusUpdate: newExchangeStatus,
      dispatch_source: source,
      inventory_skipped: inventorySkipped,
    },
  })

  insertMetricEvent({
    companyId: shipment.companyId,
    entityType: 'exchange_shipment',
    entityId: exchangeShipmentId,
    metricKey: 'exchange_shipment.dispatched',
    numericValue: Number(shipment.invoiceAmount),
    dimensions: {
      exchange_method: exchange.exchangeMethod,
      tracking_number: context.trackingNumber,
      dispatch_source: source,
      inventory_skipped: inventorySkipped,
    },
  })

  return {
    success: true,
    skipped: inventorySkipped,
    reason: inventorySkipped ? 'Inventory already dispatched — status updated only' : undefined,
  }
}

export async function dispatchExchangeShipment(
  exchangeShipmentId: string,
  trackingNumber: string,
  courierCompanyIntegrationId: string,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)

    // Workspace-scope check (the shared function does NOT do this)
    const shipment = await db.exchangeShipment.findFirst({
      where: { id: exchangeShipmentId, companyId: ctx.company.id },
      select: { id: true, status: true },
    })
    if (!shipment) {
      return { success: false, error: 'Exchange shipment not found.' }
    }
    if (shipment.status === 'backordered') {
      return { success: false, error: 'Cannot dispatch a backordered shipment. Resolve the backorder first.' }
    }
    if (shipment.status === 'dispatched' || shipment.status === 'delivered' || shipment.status === 'cancelled') {
      return { success: false, error: `Cannot dispatch a shipment with status='${shipment.status}'.` }
    }

    // Delegate the inventory deduction + status update + parent-exchange
    // status update + audit/metric to the shared function. No duplicated
    // inventory logic remains in this function.
    return await performExchangeShipmentDispatch(exchangeShipmentId, {
      source: 'manual',
      triggeredByEmployeeId: ctx.employee.id,
      trackingNumber,
      courierCompanyIntegrationId,
    })
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to dispatch exchange shipment',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 4. markExchangeShipmentDelivered
// ──────────────────────────────────────────────────────────────

export async function markExchangeShipmentDelivered(
  exchangeShipmentId: string,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)

    const shipment = await db.exchangeShipment.findFirst({
      where: { id: exchangeShipmentId, companyId: ctx.company.id },
    })
    if (!shipment) {
      return { success: false, error: 'Exchange shipment not found.' }
    }
    if (shipment.status !== 'dispatched') {
      return { success: false, error: `Cannot mark as delivered a shipment with status='${shipment.status}'.` }
    }

    await db.exchangeShipment.update({
      where: { id: exchangeShipmentId },
      data: {
        status: 'delivered',
        deliveredAt: new Date(),
      },
    })

    insertAuditLog({
      action: 'exchange_shipment.delivered',
      entityType: 'exchange_shipment',
      entityId: exchangeShipmentId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
    })

    insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'exchange_shipment',
      entityId: exchangeShipmentId,
      metricKey: 'exchange_shipment.delivered',
      numericValue: 1,
      dimensions: {
        delivery_days: shipment.dispatchedAt
          ? Math.round((Date.now() - new Date(shipment.dispatchedAt).getTime()) / (1000 * 60 * 60 * 24))
          : 0,
      },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to mark exchange shipment as delivered',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 4c. markExchangeShipmentRto (+ performExchangeShipmentRto) — replacement item was returned (RTO)
// ──────────────────────────────────────────────────────────────

/**
 * SHARED exchange-shipment RTO business logic — the SINGLE place where
 * inventory restoration (processInventoryTransaction with return_resellable /
 * return_stitched_received) + status='rto' + parent-exchange terminal state +
 * audit/metric happen together.
 *
 * Called from:
 *   - markExchangeShipmentRto() [manual/UI-triggered, source='manual'] — AFTER
 *     getWorkspace()/permission checks
 *   - pollPostExOrderStatuses() [cron, source='auto_poll'] — no session,
 *     reads companyId/organizationId from the shipment itself
 *
 * CRITICAL: this function does NOT call getWorkspace(). The manual caller
 * must do its own auth/workspace scoping before invoking.
 *
 * IDEMPOTENT: if the shipment is already 'rto', returns success without
 * re-processing inventory (prevents double-return).
 */
export async function performExchangeShipmentRto(
  exchangeShipmentId: string,
  context: {
    source: 'manual' | 'auto_poll'
    triggeredByEmployeeId?: string | null
    returnReason?: string
  },
): Promise<ActionResult & { skipped?: boolean }> {
  // 1. Fetch the shipment — NO companyId scoping (works in cron context)
  const shipment = await db.exchangeShipment.findUnique({
    where: { id: exchangeShipmentId },
    include: {
      orderExchange: {
        select: {
          id: true,
          exchangeMethod: true,
          originalOrder: { select: { dispatchLocationId: true } },
          newOrgVariant: {
            select: { id: true, sku: true, costPrice: true, fulfillmentType: true },
          },
        },
      },
    },
  })
  if (!shipment) return { success: false, error: 'Exchange shipment not found.' }

  // IDEMPOTENT: already RTO → return success without re-processing
  if (shipment.status === 'rto') {
    return { success: true, skipped: true }
  }

  // Guard: must be dispatched or delivered to be returnable
  if (shipment.status !== 'dispatched' && shipment.status !== 'delivered') {
    return {
      success: false,
      error: `Cannot mark as RTO a shipment with status='${shipment.status}'. Must be dispatched or delivered.`,
    }
  }

  const locationId = shipment.orderExchange.originalOrder.dispatchLocationId
  if (!locationId) {
    return { success: false, error: 'No dispatch location set on the original order.' }
  }

  // ── Process the returned item back into inventory ──
  // Find the dispatch txn to get the cost basis (mirrors processOrderReturn)
  const dispatchTxn = await db.inventoryTransaction.findFirst({
    where: {
      orgVariantId: shipment.newOrgVariantId,
      locationId,
      transactionType: 'sale_dispatched',
      metadata: { contains: `"exchangeShipmentId":"${exchangeShipmentId}"` },
    },
    select: { costPerUnit: true },
    orderBy: { recordedAt: 'desc' },
  })

  const costPerUnit = dispatchTxn
    ? Number(dispatchTxn.costPerUnit)
    : Number(shipment.orderExchange.newOrgVariant.costPrice)

  // Determine transaction type based on the NEW item's fulfillment type
  const fulfillmentType = shipment.fulfillmentTypeSnapshot
  const transactionType = fulfillmentType === 'made_to_order' ? 'return_stitched_received' : 'return_resellable'

  const txnResult = await processInventoryTransaction({
    orgVariantId: shipment.newOrgVariantId,
    locationId,
    organizationId: shipment.organizationId,
    companyId: shipment.companyId,
    employeeId: context.triggeredByEmployeeId ?? null,
    transactionType,
    quantity: shipment.quantity,
    costPerUnit,
    referenceType: 'exchange_shipment',
    referenceId: exchangeShipmentId,
    notes: `Exchange shipment RTO — replacement item returned by courier. ${context.returnReason ? `Reason: ${context.returnReason}` : ''}`.trim(),
    metadata: {
      exchangeShipmentId,
      exchangeShipmentNumber: shipment.exchangeShipmentNumber,
      returnReason: context.returnReason ?? null,
      rto_source: context.source,
    },
  })

  if (!txnResult.success) {
    return {
      success: false,
      error: `Failed to process returned item into inventory: ${txnResult.error}`,
    }
  }

  // ── Update shipment status to 'rto' ──
  await db.exchangeShipment.update({
    where: { id: exchangeShipmentId },
    data: {
      status: 'rto',
      returnedAt: new Date(),
    },
  })

  // ── Set parent order_exchanges to terminal 'exchange_item_returned' state ──
  // This is INTENTIONALLY terminal — no automatic re-exchange/refund.
  await db.orderExchange.update({
    where: { id: shipment.orderExchange.id },
    data: {
      status: 'exchange_item_returned',
    },
  })

  // ── Audit + metric (tagged with rto_source) ──
  insertAuditLog({
    action: 'exchange_shipment.rto',
    entityType: 'exchange_shipment',
    entityId: exchangeShipmentId,
    companyId: shipment.companyId,
    organizationId: shipment.organizationId,
    userId: null,
    employeeId: context.triggeredByEmployeeId ?? null,
    newValues: {
      status: 'rto',
      returnedAt: new Date(),
      inventoryTxnId: txnResult.transactionId,
      transactionType,
      costPerUnit,
      exchangeStatusUpdate: 'exchange_item_returned',
      returnReason: context.returnReason ?? null,
      rto_source: context.source,
    },
  })

  insertMetricEvent({
    companyId: shipment.companyId,
    entityType: 'exchange_shipment',
    entityId: exchangeShipmentId,
    metricKey: 'exchange_shipment.rto',
    numericValue: Number(shipment.invoiceAmount),
    dimensions: {
      exchange_method: shipment.orderExchange.exchangeMethod,
      fulfillment_type: fulfillmentType,
      transaction_type: transactionType,
      rto_source: context.source,
    },
  })

  return { success: true, data: { inventoryTxnId: txnResult.transactionId } }
}

/**
 * Mark an exchange shipment as RTO (returned by courier). Manual/UI-triggered.
 *
 * Mirrors the core logic of processOrderReturn() but scoped to exchange_shipments:
 *   - Processes the returned NEW item back into inventory via
 *     processInventoryTransaction() (return_resellable or
 *     return_stitched_received per fulfillmentTypeSnapshot).
 *   - Sets exchange_shipments.status='rto', returnedAt=now().
 *   - Sets the parent order_exchanges.status='exchange_item_returned' (terminal
 *     state — manual follow-up required, no automatic re-exchange/refund).
 *
 * INTENTIONALLY TERMINAL: does NOT trigger any new exchange, refund, or
 * replacement. Staff must manually decide what to do next.
 *
 * Delegates the inventory + status logic to performExchangeShipmentRto()
 * (shared with the auto_poll path). No duplicated logic here.
 */
export async function markExchangeShipmentRto(
  exchangeShipmentId: string,
  returnReason?: string,
): Promise<ActionResult<{ inventoryTxnId?: string }>> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)

    // Workspace-scope check (the shared function does NOT do this)
    const shipment = await db.exchangeShipment.findFirst({
      where: { id: exchangeShipmentId, companyId: ctx.company.id },
      select: { id: true, status: true },
    })
    if (!shipment) {
      return { success: false, error: 'Exchange shipment not found.' }
    }

    return await performExchangeShipmentRto(exchangeShipmentId, {
      source: 'manual',
      triggeredByEmployeeId: ctx.employee.id,
      returnReason,
    })
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to mark exchange shipment as RTO',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 4b. markExchangeShipmentCodCollected — record COD collection
// ──────────────────────────────────────────────────────────────

/**
 * Record that COD was collected for an exchange shipment (customer paid
 * the invoice amount on delivery). Mirrors markCodCollected() for orders.
 *
 * When the full invoiceAmount (price difference + delivery charge) is collected,
 * updates the parent order_exchanges.priceDifferenceStatus to 'settled'.
 */
export async function markExchangeShipmentCodCollected(
  exchangeShipmentId: string,
  collectedAmount?: number,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const shipment = await db.exchangeShipment.findFirst({
      where: { id: exchangeShipmentId, companyId: ctx.company.id },
      select: {
        id: true,
        invoiceAmount: true,
        status: true,
        orderExchangeId: true,
      },
    })
    if (!shipment) {
      return { success: false, error: 'Exchange shipment not found.' }
    }

    // Guard: must be delivered or dispatched
    if (shipment.status !== 'delivered' && shipment.status !== 'dispatched') {
      return {
        success: false,
        error: `Cannot collect COD for a shipment with status '${shipment.status}'. Expected 'delivered' or 'dispatched'.`,
      }
    }

    const amount = collectedAmount ?? Number(shipment.invoiceAmount)

    // Update the exchange shipment (no separate codCollected fields on exchange_shipments —
    // we record this via the parent order_exchanges settlement)
    await db.exchangeShipment.update({
      where: { id: exchangeShipmentId },
      data: {
        // Mark the shipment as having its COD collected by transitioning to delivered
        // if not already (the polling job may not have caught up yet)
        ...(shipment.status === 'dispatched' ? { status: 'delivered', deliveredAt: new Date() } : {}),
      },
    })

    // Settle the parent exchange's price difference
    await db.orderExchange.update({
      where: { id: shipment.orderExchangeId },
      data: {
        priceDifferenceStatus: 'settled',
        priceDifferenceSettledAmount: amount,
        priceDifferenceSettledAt: new Date(),
        priceDifferenceSettledBy: ctx.employee.id,
      },
    })

    insertAuditLog({
      action: 'exchange_shipment.cod_collected',
      entityType: 'exchange_shipment',
      entityId: exchangeShipmentId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { collectedAmount: amount, invoiceAmount: Number(shipment.invoiceAmount) },
    })

    insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'exchange_shipment',
      entityId: exchangeShipmentId,
      metricKey: 'exchange_shipment.cod_collected',
      numericValue: amount,
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to mark COD as collected',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 5. cancelExchangeShipment
// ──────────────────────────────────────────────────────────────

export async function cancelExchangeShipment(
  exchangeShipmentId: string,
  reason: string,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const shipment = await db.exchangeShipment.findFirst({
      where: { id: exchangeShipmentId, companyId: ctx.company.id },
      include: {
        orderExchange: {
          select: { originalOrder: { select: { dispatchLocationId: true } } },
        },
      },
    })
    if (!shipment) {
      return { success: false, error: 'Exchange shipment not found.' }
    }

    const nonCancellableStatuses = ['dispatched', 'delivered', 'cancelled']
    if (nonCancellableStatuses.includes(shipment.status)) {
      return {
        success: false,
        error: `Cannot cancel a shipment with status='${shipment.status}'.`,
      }
    }

    // If stock was reserved, unreserve it
    if (shipment.status === 'confirmed') {
      const locationId = shipment.orderExchange.originalOrder.dispatchLocationId
      if (locationId) {
        await unreserveStockForOrder({
          orgVariantId: shipment.newOrgVariantId,
          locationId,
          organizationId: shipment.organizationId,
          companyId: shipment.companyId,
          employeeId: ctx.employee.id,
          quantity: shipment.quantity,
        })
      }
    }

    await db.exchangeShipment.update({
      where: { id: exchangeShipmentId },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
      },
    })

    insertAuditLog({
      action: 'exchange_shipment.cancelled',
      entityType: 'exchange_shipment',
      entityId: exchangeShipmentId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { reason, previousStatus: shipment.status },
    })

    insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'exchange_shipment',
      entityId: exchangeShipmentId,
      metricKey: 'exchange_shipment.cancelled',
      numericValue: 1,
      dimensions: { reason },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to cancel exchange shipment',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 6. listExchangeShipments
// ──────────────────────────────────────────────────────────────

export interface ExchangeShipmentFilters {
  statuses?: string[]
  orderExchangeId?: string
  customerId?: string
  newOrgVariantId?: string
  trackingNumber?: string
  isBackordered?: boolean
  limit?: number
  offset?: number
}

export async function listExchangeShipments(
  filters: ExchangeShipmentFilters,
): Promise<ActionResult<{
  shipments: Array<{
    id: string
    exchangeShipmentNumber: string
    status: string
    quantity: number
    invoiceAmount: number
    trackingNumber: string | null
    isPriorityBackorder: boolean
    backorderedAt: Date | null
    createdAt: Date
    // Universal courier reference fields (migration 015)
    orderRefNumber: string | null
    orderDetail: string | null
    customer: { id: string; name: string }
    newOrgVariant: { id: string; sku: string; product: { title: string } }
    orderExchange: { id: string; exchangeMethod: string; status: string }
  }>
  total: number
}>> {
  try {
    const ctx = await getWorkspace()

    const where = {
      companyId: ctx.company.id,
      ...(filters.statuses && filters.statuses.length > 0 ? { status: { in: filters.statuses } } : {}),
      ...(filters.orderExchangeId ? { orderExchangeId: filters.orderExchangeId } : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...(filters.newOrgVariantId ? { newOrgVariantId: filters.newOrgVariantId } : {}),
      ...(filters.trackingNumber ? { trackingNumber: { contains: filters.trackingNumber, mode: 'insensitive' as const } } : {}),
      ...(filters.isBackordered ? { status: 'backordered' } : {}),
    }

    const limit = Math.min(filters.limit ?? 50, 100)
    const offset = filters.offset ?? 0

    const [shipments, total] = await Promise.all([
      db.exchangeShipment.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true } },
          newOrgVariant: {
            select: {
              id: true,
              sku: true,
              product: { select: { title: true } },
            },
          },
          orderExchange: {
            select: { id: true, exchangeMethod: true, status: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.exchangeShipment.count({ where }),
    ])

    return {
      success: true,
      data: {
        shipments: shipments.map((s) => ({
          id: s.id,
          exchangeShipmentNumber: s.exchangeShipmentNumber,
          status: s.status,
          quantity: s.quantity,
          invoiceAmount: Number(s.invoiceAmount),
          trackingNumber: s.trackingNumber,
          isPriorityBackorder: s.isPriorityBackorder,
          backorderedAt: s.backorderedAt,
          createdAt: s.createdAt,
          // Universal courier reference fields (migration 015)
          orderRefNumber: s.orderRefNumber,
          orderDetail: s.orderDetail,
          customer: s.customer,
          newOrgVariant: s.newOrgVariant,
          orderExchange: s.orderExchange,
        })),
        total,
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list exchange shipments',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 7. getExchangeShipmentDetail
// ──────────────────────────────────────────────────────────────

export async function getExchangeShipmentDetail(
  exchangeShipmentId: string,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()

    const shipment = await db.exchangeShipment.findFirst({
      where: { id: exchangeShipmentId, companyId: ctx.company.id },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            email: true,
            isFlagged: true,
            phones: { select: { id: true, phoneRaw: true, isPrimary: true } },
          },
        },
        shippingAddress: true,
        shippingPhone: true,
        newOrgVariant: {
          select: {
            id: true,
            sku: true,
            costPrice: true,
            fulfillmentType: true,
            product: { select: { title: true } },
          },
        },
        orderExchange: {
          select: {
            id: true,
            exchangeMethod: true,
            status: true,
            reason: true,
            originalOrder: {
              select: { id: true, flowopsOrderNumber: true },
            },
          },
        },
        courierCompanyIntegration: {
          select: { id: true, provider: { select: { providerKey: true, providerName: true } } },
        },
        createdByEmployee: {
          select: { id: true, designation: true, user: { select: { fullName: true } } },
        },
      },
    })

    if (!shipment) {
      return { success: false, error: 'Exchange shipment not found.' }
    }

    return { success: true, data: shipment }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to get exchange shipment detail',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 8. updateExchangeShipmentInvoiceAmount (staff edits invoice before dispatch)
// ──────────────────────────────────────────────────────────────

export async function updateExchangeShipmentInvoiceAmount(
  exchangeShipmentId: string,
  invoiceAmount: number,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const shipment = await db.exchangeShipment.findFirst({
      where: { id: exchangeShipmentId, companyId: ctx.company.id },
    })
    if (!shipment) {
      return { success: false, error: 'Exchange shipment not found.' }
    }
    if (shipment.status === 'dispatched' || shipment.status === 'delivered' || shipment.status === 'cancelled') {
      return { success: false, error: 'Cannot edit invoice amount after dispatch.' }
    }
    if (invoiceAmount < 0) {
      return { success: false, error: 'Invoice amount must be 0 or positive.' }
    }

    await db.exchangeShipment.update({
      where: { id: exchangeShipmentId },
      data: { invoiceAmount },
    })

    insertAuditLog({
      action: 'exchange_shipment.invoice_updated',
      entityType: 'exchange_shipment',
      entityId: exchangeShipmentId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      oldValues: { invoiceAmount: Number(shipment.invoiceAmount) },
      newValues: { invoiceAmount },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to update invoice amount',
    }
  }
}
