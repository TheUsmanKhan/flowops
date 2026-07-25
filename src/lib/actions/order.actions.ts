/**
 * OMS — Order server actions.
 *
 * Step 2: Order creation + basic lifecycle transitions (confirm, cancel,
 * payment conversion).
 * Step 3: Wired to the REAL Inventory system — reservation at confirmation,
 * dispatch deduction, cancellation unreservation, backorder auto-fulfillment.
 * Step 4: Comprehensive metric_events coverage on every mutation.
 *
 * Every mutation calls insertAuditLog() AND insertMetricEvent().
 */

import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { getWorkspace, requirePermission, isElevated, ApiError } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import {
  reserveStockForOrder,
  unreserveStockForOrder,
  dispatchOrder as dispatchInventory,
  checkAndFulfillMadeToOrderVariant,
} from '@/lib/inventory'
import {
  createManualOrderSchema,
  convertPaymentSchema,
  markCodCollectedSchema,
  cancelOrderSchema,
  shopifyOrderWebhookSchema,
  type CreateManualOrderInput,
  type ConvertPaymentInput,
  type MarkCodCollectedInput,
  type CancelOrderInput,
  type ShopifyOrderWebhook,
} from '@/lib/validations/order.schemas'
import { findOrCreateCustomer, updateCustomerStats } from './customer.actions'
import type { Prisma } from '@prisma/client'

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

interface OrderFilters {
  status?: string
  paymentType?: string
  orderSource?: string
  customerId?: string
  search?: string
  dateFrom?: string
  dateTo?: string
  limit?: number
  offset?: number
}

// ──────────────────────────────────────────────────────────────
// Helper: generate order number via the DB function
// ──────────────────────────────────────────────────────────────

async function generateOrderNumber(companyId: string): Promise<string> {
  const result = await db.$queryRaw<{ generate_order_number: string }[]>`
    SELECT generate_order_number(${companyId}::TEXT)
  `
  return result[0].generate_order_number
}

// ──────────────────────────────────────────────────────────────
// Helper: reserveOrderStock — shared internal function
// ──────────────────────────────────────────────────────────────
// Processes ALL order_items for an order and attempts to reserve
// stock for each based on its fulfillment_type_snapshot.
//
// For stock_based items:
//   - If sufficient available stock → reserveStockForOrder(), fulfillment_status='reserved'
//   - If insufficient + inventory_policy='continue' → fulfillment_status='backordered'
//   - If insufficient + inventory_policy='deny' → outcome='failed'
//
// For made_to_order items:
//   - checkAndFulfillMadeToOrderVariant() checks returned stock first
//   - If existing_stock → fulfillment_status='reserved', returned_stitched_used=true
//   - If fresh_production → fulfillment_status='reserved', production_order_id set
//   - If error → outcome='failed'
//
// After processing: if ANY item is 'backordered', order status → 'partially_backordered'.
// If ALL items are 'reserved', order stays 'confirmed'.
//
// Called from:
//   - createManualOrder() IF the order auto-confirmed at creation
//   - confirmOrder() when a 'pending' order is manually confirmed
//   - dispatchOrderAction() if status is still 'pending' at dispatch time

async function reserveOrderStock(
  orderId: string,
  ctx: { company: { id: string; organizationId: string }; user: { id: string }; employee: { id: string } },
): Promise<{
  success: boolean
  results: Array<{ orderItemId: string; outcome: 'reserved' | 'backordered' | 'failed'; reason?: string }>
}> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { dispatchLocationId: true, companyId: true, organizationId: true },
  })
  if (!order) return { success: false, results: [] }

  const items = await db.orderItem.findMany({
    where: { orderId },
    include: {
      orgVariant: {
        select: { id: true, fulfillmentType: true, inventoryPolicy: true, stitchingCharges: true },
      },
    },
  })

  const results: Array<{ orderItemId: string; outcome: 'reserved' | 'backordered' | 'failed'; reason?: string }> = []
  let hasBackordered = false

  for (const item of items) {
    if (item.fulfillmentStatus === 'reserved' || item.fulfillmentStatus === 'dispatched') {
      // Already processed (e.g. re-confirmation attempt) — skip
      results.push({ orderItemId: item.id, outcome: 'reserved' })
      continue
    }

    const locationId = item.reservedLocationId ?? order.dispatchLocationId
    if (!locationId) {
      results.push({ orderItemId: item.id, outcome: 'failed', reason: 'No dispatch location set' })
      continue
    }

    if (item.fulfillmentTypeSnapshot === 'stock_based') {
      // Check available stock at the dispatch location
      const pool = await db.inventoryPool.findUnique({
        where: {
          orgVariantId_locationId: {
            orgVariantId: item.orgVariantId,
            locationId,
          },
        },
      })

      const available = pool ? pool.onHand - pool.reserved : 0

      if (available >= item.quantity) {
        // Sufficient stock — reserve it
        const reserveResult = await reserveStockForOrder({
          orgVariantId: item.orgVariantId,
          locationId,
          organizationId: order.organizationId,
          companyId: order.companyId,
          employeeId: ctx.employee.id,
          quantity: item.quantity,
          orderId,
        })

        if (reserveResult.success) {
          await db.orderItem.update({
            where: { id: item.id },
            data: { fulfillmentStatus: 'reserved', reservedLocationId: locationId },
          })
          results.push({ orderItemId: item.id, outcome: 'reserved' })
        } else {
          results.push({ orderItemId: item.id, outcome: 'failed', reason: reserveResult.error })
        }
      } else if (item.orgVariant.inventoryPolicy === 'continue') {
        // Insufficient stock but backordering allowed
        await db.orderItem.update({
          where: { id: item.id },
          data: { fulfillmentStatus: 'backordered', backorderedAt: new Date() },
        })
        await insertMetricEvent({
          companyId: order.companyId,
          entityType: 'product',
          entityId: item.orgVariantId,
          metricKey: 'order.backordered',
          numericValue: item.quantity,
          dimensions: { order_id: orderId },
        }).catch(() => {})
        hasBackordered = true
        results.push({
          orderItemId: item.id,
          outcome: 'backordered',
          reason: `Available: ${available}, required: ${item.quantity}`,
        })
      } else {
        // Insufficient stock + policy='deny' — fail
        results.push({
          orderItemId: item.id,
          outcome: 'failed',
          reason: `Insufficient stock (available: ${available}, required: ${item.quantity}) and inventory_policy='deny'`,
        })
      }
    } else if (item.fulfillmentTypeSnapshot === 'made_to_order') {
      // Made-to-order: check returned stock first, then trigger production
      const mtoResult = await checkAndFulfillMadeToOrderVariant(
        item.orgVariantId,
        item.quantity,
        order.companyId,
        locationId,
      )

      if (mtoResult.source === 'existing_stock' && mtoResult.locationId) {
        // Returned stock available — reserve it
        const reserveResult = await reserveStockForOrder({
          orgVariantId: item.orgVariantId,
          locationId: mtoResult.locationId,
          organizationId: order.organizationId,
          companyId: order.companyId,
          employeeId: ctx.employee.id,
          quantity: item.quantity,
          orderId,
        })

        if (reserveResult.success) {
          await db.orderItem.update({
            where: { id: item.id },
            data: {
              fulfillmentStatus: 'reserved',
              returnedStitchedUsed: true,
              reservedLocationId: mtoResult.locationId,
            },
          })
          await insertMetricEvent({
            companyId: order.companyId,
            entityType: 'product',
            entityId: item.orgVariantId,
            metricKey: 'order.made_to_order_from_returned_stock',
            numericValue: 1,
            dimensions: { order_id: orderId, stitching_cost_saved: Number(item.orgVariant.stitchingCharges) || 0 },
          }).catch(() => {})
          results.push({ orderItemId: item.id, outcome: 'reserved' })
        } else {
          results.push({ orderItemId: item.id, outcome: 'failed', reason: reserveResult.error })
        }
      } else if (mtoResult.source === 'fresh_production' && mtoResult.productionOrderId) {
        // Fresh production triggered — link the production order
        await db.orderItem.update({
          where: { id: item.id },
          data: {
            fulfillmentStatus: 'reserved',
            productionOrderId: mtoResult.productionOrderId,
          },
        })
        // Also link the order_item back to the production order
        await db.productionOrder.update({
          where: { id: mtoResult.productionOrderId },
          data: { orderItemId: item.id },
        })
        await insertMetricEvent({
          companyId: order.companyId,
          entityType: 'product',
          entityId: item.orgVariantId,
          metricKey: 'order.made_to_order_production_triggered',
          numericValue: 1,
          dimensions: { order_id: orderId, production_order_id: mtoResult.productionOrderId },
        }).catch(() => {})
        results.push({ orderItemId: item.id, outcome: 'reserved' })
      } else {
        // Error (no fabric source, insufficient fabric, etc.)
        results.push({
          orderItemId: item.id,
          outcome: 'failed',
          reason: mtoResult.error ?? 'Made-to-order fulfillment failed',
        })
      }
    }
  }

  // Update order status based on results
  if (hasBackordered) {
    await db.order.update({
      where: { id: orderId },
      data: { status: 'partially_backordered' },
    })
  }
  // If no backordered items, order stays 'confirmed' (or whatever it was)

  return { success: true, results }
}

// ──────────────────────────────────────────────────────────────
// createManualOrder
// ──────────────────────────────────────────────────────────────

export async function createManualOrder(
  input: CreateManualOrderInput,
): Promise<ActionResult<{
  orderId: string
  flowopsOrderNumber: string
  orderItems: Array<{ id: string; orgVariantId: string; quantity: number }>
}>> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_CREATE)

    // 1. Validate
    const parsed = createManualOrderSchema.safeParse(input)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid order data',
      }
    }
    const d = parsed.data

    // 2. Find or create customer
    let customerId: string
    if (d.customer_id) {
      // Verify existing customer belongs to this org
      const existing = await db.customer.findFirst({
        where: { id: d.customer_id, organizationId: ctx.company.organizationId },
      })
      if (!existing) return { success: false, error: 'Customer not found' }
      customerId = existing.id
    } else if (d.customer) {
      const customerResult = await findOrCreateCustomer({
        ...d.customer,
        organizationId: ctx.company.organizationId,
        companyId: ctx.company.id,
      })
      if (!customerResult.success || !customerResult.data) {
        return { success: false, error: customerResult.error ?? 'Failed to create customer' }
      }
      customerId = customerResult.data.customerId
    } else {
      return { success: false, error: 'Either customer or customer_id is required' }
    }

    // 3. Fetch variants + their pricing for this company + fulfillment_type snapshot
    const variantIds = d.items.map((i) => i.org_variant_id)
    const variants = await db.orgProductVariant.findMany({
      where: { id: { in: variantIds }, organizationId: ctx.company.organizationId },
      include: {
        companyPricing: { where: { companyId: ctx.company.id } },
      },
    })

    if (variants.length !== variantIds.length) {
      return { success: false, error: 'One or more variants not found in this organization' }
    }

    // 4. Compute subtotal + build order items data
    let subtotal = 0
    const orderItemsData: Array<{
      orgVariantId: string
      quantity: number
      unitPrice: number
      lineTotal: number
      fulfillmentTypeSnapshot: string
    }> = []

    for (const item of d.items) {
      const variant = variants.find((v) => v.id === item.org_variant_id)
      if (!variant) continue

      // Use provided unit_price OR fall back to company pricing OR variant cost
      const unitPrice =
        item.unit_price ??
        (variant.companyPricing[0]?.salePrice
          ? Number(variant.companyPricing[0].salePrice)
          : Number(variant.costPrice))

      const lineTotal = item.quantity * unitPrice
      subtotal += lineTotal

      orderItemsData.push({
        orgVariantId: item.org_variant_id,
        quantity: item.quantity,
        unitPrice,
        lineTotal,
        fulfillmentTypeSnapshot: variant.fulfillmentType,
      })
    }

    // 5. Compute totals
    const discountAmount = d.discount_amount ?? 0
    const courierCharges = d.courier_charges ?? 0
    const totalOrderValue = subtotal + courierCharges - discountAmount

    // 6. Determine payment status + source
    let paymentStatus: string = 'cod_pending'
    let paymentSource: string = 'cod_native'
    let advanceAmount: number | null = null
    let advancePaymentMethod: string | null = null
    let advancePaymentReference: string | null = null
    let advancePaidAt: Date | null = null

    if (d.payment_type === 'partial_advance') {
      paymentStatus = 'advance_paid'
      paymentSource = 'manual_conversion'
      advanceAmount = d.advance_amount ?? 0
      advancePaymentMethod = d.advance_payment_method || null
      advancePaymentReference = d.advance_payment_reference || null
      advancePaidAt = new Date()
    } else if (d.payment_type === 'fully_prepaid') {
      paymentStatus = 'fully_prepaid'
      paymentSource = 'manual_conversion'
      advanceAmount = totalOrderValue
      advancePaymentMethod = d.advance_payment_method || null
      advancePaymentReference = d.advance_payment_reference || null
      advancePaidAt = new Date()
    }

    // 7. Determine initial order status
    let orderStatus: string = 'pending'
    let confirmedAt: Date | null = null
    let skippedConfirmation = false

    if (paymentStatus === 'advance_paid' || paymentStatus === 'fully_prepaid') {
      // Payment itself is the confirmation signal — bypasses require_order_confirmation
      orderStatus = 'confirmed'
      confirmedAt = new Date()
    } else {
      // COD order — check company_order_settings
      const settings = await db.companyOrderSetting.findUnique({
        where: { companyId: ctx.company.id },
      })
      if (!settings?.requireOrderConfirmation) {
        orderStatus = 'confirmed'
        confirmedAt = new Date()
        skippedConfirmation = true
      }
    }

    // 8. Generate order number
    const flowopsOrderNumber = await generateOrderNumber(ctx.company.id)

    // 9. Create the order
    const order = await db.order.create({
      data: {
        organizationId: ctx.company.organizationId,
        companyId: ctx.company.id,
        flowopsOrderNumber,
        orderSource: 'manual',
        customerId,
        status: orderStatus,
        paymentType: d.payment_type,
        paymentStatus,
        paymentSource,
        subtotal,
        discountAmount: discountAmount || null,
        discountReason: d.discount_reason || null,
        courierCharges: courierCharges || null,
        totalOrderValue,
        advanceAmount,
        advancePaymentMethod,
        advancePaymentReference,
        advancePaidAt,
        deliveryAddress: d.delivery_address,
        deliveryCity: d.delivery_city,
        courierName: d.courier_name || null,
        dispatchLocationId: d.dispatch_location_id,
        notesForCourier: d.notes_for_courier || null,
        skippedConfirmation,
        confirmedAt,
        createdBy: ctx.employee.id,
      },
    })

    // 10. Create order items (fulfillment_status = 'reserved' as PLACEHOLDER)
    const createdItems: Array<{ id: string; orgVariantId: string; quantity: number }> = []
    for (const itemData of orderItemsData) {
      const item = await db.orderItem.create({
        data: {
          orderId: order.id,
          orgVariantId: itemData.orgVariantId,
          organizationId: ctx.company.organizationId,
          quantity: itemData.quantity,
          unitPrice: itemData.unitPrice,
          lineTotal: itemData.lineTotal,
          fulfillmentStatus: 'reserved', // PLACEHOLDER — Step 3 will validate/adjust
          fulfillmentTypeSnapshot: itemData.fulfillmentTypeSnapshot,
          reservedLocationId: d.dispatch_location_id,
        },
      })
      createdItems.push({
        id: item.id,
        orgVariantId: item.orgVariantId,
        quantity: item.quantity,
      })
    }

    // 11. Audit log
    await insertAuditLog({
      action: 'order.created',
      entityType: 'order',
      entityId: order.id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: {
        flowopsOrderNumber,
        status: orderStatus,
        paymentType: d.payment_type,
        paymentStatus,
        itemCount: orderItemsData.length,
        totalOrderValue,
        customerId,
      },
    })

    // 12. Update customer stats
    await updateCustomerStats(customerId)

    // 13. If the order auto-confirmed (payment-driven or company setting),
    // run the stock reservation logic immediately.
    if (orderStatus === 'confirmed') {
      await reserveOrderStock(order.id, ctx)
    }

    await insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'order',
      entityId: order.id,
      metricKey: 'order.created',
      numericValue: Number(totalOrderValue),
      dimensions: { order_source: 'manual', payment_type: d.payment_type, company_id: ctx.company.id },
    }).catch(() => {})

    return {
      success: true,
      data: { orderId: order.id, flowopsOrderNumber, orderItems: createdItems },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to create order',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// createOrderFromShopifyWebhook — STUB (structured but not wired)
// ──────────────────────────────────────────────────────────────

export async function createOrderFromShopifyWebhook(
  payload: ShopifyOrderWebhook,
  companyId: string,
  organizationId: string,
): Promise<ActionResult<{ orderId: string; flowopsOrderNumber: string }>> {
  try {
    const ctx = await getWorkspace()
    // This function would be called by a future webhook handler.
    // For now it's structured and unit-testable with a mock payload.

    const parsed = shopifyOrderWebhookSchema.safeParse(payload)
    if (!parsed.success) {
      return { success: false, error: 'Invalid Shopify webhook payload' }
    }
    const d = parsed.data

    // Map Shopify financial_status → FlowOps payment_status
    let paymentStatus: string
    let paymentSource: string = 'shopify_gateway'
    let paymentType: string
    let orderStatus: string = 'pending'
    let confirmedAt: Date | null = null

    switch (d.financial_status) {
      case 'paid':
        paymentStatus = 'fully_prepaid'
        paymentType = 'fully_prepaid'
        orderStatus = 'confirmed'
        confirmedAt = new Date()
        break
      case 'partially_paid':
        paymentStatus = 'advance_paid'
        paymentType = 'partial_advance'
        orderStatus = 'confirmed'
        confirmedAt = new Date()
        break
      default:
        paymentStatus = 'cod_pending'
        paymentType = 'full_cod'
        paymentSource = 'cod_native'
        // Check company settings for COD orders
        const settings = await db.companyOrderSetting.findUnique({ where: { companyId } })
        if (!settings?.requireOrderConfirmation) {
          orderStatus = 'confirmed'
          confirmedAt = new Date()
        }
    }

    // Find or create customer from Shopify customer data
    const customerPhone = d.customer.phone || '0000000000' // fallback
    let customer = await db.customer.findFirst({
      where: { organizationId, phone: customerPhone },
    })

    if (!customer && d.customer.first_name) {
      customer = await db.customer.create({
        data: {
          organizationId,
          name: `${d.customer.first_name} ${d.customer.last_name ?? ''}`.trim(),
          phone: customerPhone,
          email: d.customer.email || null,
          addresses: JSON.stringify(
            d.customer.default_address
              ? [{
                  address: d.customer.default_address.address1 || '',
                  city: d.customer.default_address.city || '',
                  province: d.customer.default_address.province || '',
                  is_default: true,
                }]
              : [],
          ),
        },
      })
    }

    if (!customer) {
      return { success: false, error: 'Could not resolve customer from Shopify payload' }
    }

    // Resolve variants by SKU
    const skus = d.line_items.map((li) => li.sku).filter(Boolean) as string[]
    const variants = await db.orgProductVariant.findMany({
      where: { sku: { in: skus }, organizationId },
    })

    // Compute subtotal
    let subtotal = 0
    const orderItemsData: Array<{
      orgVariantId: string
      quantity: number
      unitPrice: number
      fulfillmentTypeSnapshot: string
    }> = []

    for (const li of d.line_items) {
      const variant = variants.find((v) => v.sku === li.sku)
      if (!variant) continue // skip unmatched items for now
      const unitPrice = parseFloat(li.price)
      subtotal += unitPrice * li.quantity
      orderItemsData.push({
        orgVariantId: variant.id,
        quantity: li.quantity,
        unitPrice,
        fulfillmentTypeSnapshot: variant.fulfillmentType,
      })
    }

    if (orderItemsData.length === 0) {
      return { success: false, error: 'No matching variants found for Shopify line items' }
    }

    const totalOrderValue = parseFloat(d.total_price)
    const flowopsOrderNumber = await generateOrderNumber(companyId)

    const order = await db.order.create({
      data: {
        organizationId,
        companyId,
        flowopsOrderNumber,
        orderSource: 'shopify',
        externalOrderReference: d.name,
        externalOrderId: String(d.id),
        customerId: customer.id,
        status: orderStatus,
        paymentType,
        paymentStatus,
        paymentSource,
        subtotal,
        totalOrderValue,
        confirmedAt,
        deliveryAddress: d.customer.default_address?.address1 || null,
        deliveryCity: d.customer.default_address?.city || null,
      },
    })

    for (const itemData of orderItemsData) {
      await db.orderItem.create({
        data: {
          orderId: order.id,
          orgVariantId: itemData.orgVariantId,
          organizationId,
          quantity: itemData.quantity,
          unitPrice: itemData.unitPrice,
          lineTotal: itemData.quantity * itemData.unitPrice,
          fulfillmentStatus: 'reserved',
          fulfillmentTypeSnapshot: itemData.fulfillmentTypeSnapshot,
        },
      })
    }

    await insertAuditLog({
      action: 'order.created_from_shopify',
      entityType: 'order',
      entityId: order.id,
      companyId,
      organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: {
        flowopsOrderNumber,
        externalOrderReference: d.name,
        financialStatus: d.financial_status,
        totalOrderValue,
      },
    })

    await updateCustomerStats(customer.id)

    await insertMetricEvent({
      companyId,
      entityType: 'order',
      entityId: order.id,
      metricKey: 'order.created',
      numericValue: Number(totalOrderValue),
      dimensions: { order_source: 'shopify', payment_type: paymentType, company_id: companyId },
    }).catch(() => {})

    return { success: true, data: { orderId: order.id, flowopsOrderNumber } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to create order from Shopify webhook',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// confirmOrder
// ──────────────────────────────────────────────────────────────

export async function confirmOrder(orderId: string): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const order = await db.order.findFirst({
      where: { id: orderId, companyId: ctx.company.id },
    })
    if (!order) return { success: false, error: 'Order not found' }
    if (order.status !== 'pending') {
      return { success: false, error: `Order is already ${order.status} (cannot confirm)` }
    }

    await db.order.update({
      where: { id: orderId },
      data: { status: 'confirmed', confirmedAt: new Date() },
    })

    await insertAuditLog({
      action: 'order.confirmed',
      entityType: 'order',
      entityId: orderId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      oldValues: { status: 'pending' },
      newValues: { status: 'confirmed' },
    })

    // Step 3: Run stock reservation for all items.
    // This may flip the order to 'partially_backordered' if some items
    // can't be fulfilled immediately.
    const reserveResult = await reserveOrderStock(orderId, ctx)
    if (!reserveResult.success) {
      // Non-fatal — the order is confirmed, but reservation had issues.
      // The results array has per-item details.
    }

    await insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'order',
      entityId: orderId,
      metricKey: 'order.confirmed',
      numericValue: Number(order.totalOrderValue),
      dimensions: { confirmation_method: 'manual' },
    }).catch(() => {})

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to confirm order',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// convertPaymentStatus
// ──────────────────────────────────────────────────────────────

export async function convertPaymentStatus(
  input: ConvertPaymentInput,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const parsed = convertPaymentSchema.safeParse(input)
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
    }
    const d = parsed.data

    const order = await db.order.findFirst({
      where: { id: d.order_id, companyId: ctx.company.id },
    })
    if (!order) return { success: false, error: 'Order not found' }
    if (order.paymentStatus !== 'cod_pending') {
      return { success: false, error: 'Order payment is already converted' }
    }

    const oldValues = {
      paymentType: order.paymentType,
      paymentStatus: order.paymentStatus,
      paymentSource: order.paymentSource,
      status: order.status,
    }

    const newPaymentStatus = d.new_payment_type === 'fully_prepaid' ? 'fully_prepaid' : 'advance_paid'
    const updateData: Prisma.OrderUncheckedUpdateInput = {
      paymentType: d.new_payment_type,
      paymentStatus: newPaymentStatus,
      paymentSource: 'manual_conversion',
      advanceAmount: d.advance_amount ?? null,
      advancePaymentMethod: d.advance_payment_method || null,
      advancePaymentReference: d.advance_payment_reference || null,
      advancePaymentScreenshotUrl: d.advance_payment_screenshot_url || null,
      advancePaidAt: new Date(),
      convertedBy: ctx.employee.id,
      convertedAt: new Date(),
    }

    // If order was pending (awaiting confirmation), payment conversion is
    // itself a confirmation signal
    if (order.status === 'pending') {
      updateData.status = 'confirmed'
      updateData.confirmedAt = new Date()
    }

    await db.order.update({ where: { id: d.order_id }, data: updateData })

    await insertAuditLog({
      action: 'order.payment_converted',
      entityType: 'order',
      entityId: d.order_id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      oldValues,
      newValues: {
        paymentType: d.new_payment_type,
        paymentStatus: newPaymentStatus,
        paymentSource: 'manual_conversion',
        advanceAmount: d.advance_amount,
        status: updateData.status ?? order.status,
      },
    })

    await insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'order',
      entityId: d.order_id,
      metricKey: 'order.payment_converted',
      numericValue: d.advance_amount ?? 0,
      dimensions: { converted_by: ctx.employee.id, method: d.advance_payment_method || 'unknown' },
    }).catch(() => {})

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to convert payment status',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// markCodCollected
// ──────────────────────────────────────────────────────────────

export async function markCodCollected(
  input: MarkCodCollectedInput,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const parsed = markCodCollectedSchema.safeParse(input)
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
    }
    const d = parsed.data

    const order = await db.order.findFirst({
      where: { id: d.order_id, companyId: ctx.company.id },
    })
    if (!order) return { success: false, error: 'Order not found' }
    if (order.status !== 'dispatched' && order.status !== 'delivered') {
      return { success: false, error: 'COD can only be collected for dispatched or delivered orders' }
    }

    await db.order.update({
      where: { id: d.order_id },
      data: {
        codCollected: true,
        codCollectedAmount: d.collected_amount,
        codCollectedAt: new Date(),
      },
    })

    await insertAuditLog({
      action: 'order.cod_collected',
      entityType: 'order',
      entityId: d.order_id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { collectedAmount: d.collected_amount },
    })

    await insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'order',
      entityId: d.order_id,
      metricKey: 'order.cod_collected',
      numericValue: d.collected_amount,
    }).catch(() => {})

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to mark COD collected',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// cancelOrder
// ──────────────────────────────────────────────────────────────

export async function cancelOrder(input: CancelOrderInput): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_CANCEL)

    const parsed = cancelOrderSchema.safeParse(input)
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
    }
    const d = parsed.data

    const order = await db.order.findFirst({
      where: { id: d.order_id, companyId: ctx.company.id },
    })
    if (!order) return { success: false, error: 'Order not found' }

    const nonCancellableStatuses = ['dispatched', 'delivered', 'rto', 'cancelled', 'refunded']
    if (nonCancellableStatuses.includes(order.status)) {
      return {
        success: false,
        error: `Cannot cancel an order that is already ${order.status} (use the returns flow instead)`,
      }
    }

    await db.order.update({
      where: { id: d.order_id },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancellationReason: d.cancellation_reason,
      },
    })

    // Step 3: Unreserve stock for any items with fulfillment_status='reserved'.
    // Items with fulfillment_status='backordered' need no inventory action
    // (no reservation ever existed for them) — they'll be orphaned since
    // the order is now cancelled and won't be picked up by future
    // checkAndFulfillBackorders() runs (which skip cancelled orders).
    const reservedItems = await db.orderItem.findMany({
      where: { orderId: d.order_id, fulfillmentStatus: 'reserved' },
    })

    for (const item of reservedItems) {
      const locationId = item.reservedLocationId ?? order.dispatchLocationId
      if (!locationId) continue

      await unreserveStockForOrder({
        orgVariantId: item.orgVariantId,
        locationId,
        organizationId: order.organizationId,
        companyId: ctx.company.id,
        employeeId: ctx.employee.id,
        quantity: item.quantity,
        orderId: d.order_id,
      })
    }

    await insertAuditLog({
      action: 'order.cancelled',
      entityType: 'order',
      entityId: d.order_id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      oldValues: { status: order.status },
      newValues: { status: 'cancelled', reason: d.cancellation_reason, unreservedItems: reservedItems.length },
    })

    await insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'order',
      entityId: d.order_id,
      metricKey: 'order.cancelled',
      numericValue: Number(order.totalOrderValue),
      dimensions: { cancellation_reason: d.cancellation_reason, had_reserved_items: reservedItems.length > 0 },
    }).catch(() => {})

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to cancel order',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// listOrders
// ──────────────────────────────────────────────────────────────

export async function listOrders(
  filters: OrderFilters = {},
): Promise<ActionResult<{
  orders: Array<{
    id: string
    flowopsOrderNumber: string
    externalOrderReference: string | null
    orderSource: string
    status: string
    paymentType: string
    paymentStatus: string
    totalOrderValue: number
    customerName: string
    customerPhone: string
    createdAt: Date
  }>
  total: number
}>> {
  try {
    const ctx = await getWorkspace()
    const limit = Math.min(filters.limit ?? 50, 100)
    const offset = filters.offset ?? 0

    const where: Prisma.OrderWhereInput = {
      companyId: ctx.company.id,
    }
    if (filters.status) where.status = filters.status
    if (filters.paymentType) where.paymentType = filters.paymentType
    if (filters.orderSource) where.orderSource = filters.orderSource
    if (filters.customerId) where.customerId = filters.customerId
    if (filters.dateFrom || filters.dateTo) {
      where.createdAt = {}
      if (filters.dateFrom) where.createdAt.gte = new Date(filters.dateFrom)
      if (filters.dateTo) where.createdAt.lte = new Date(filters.dateTo)
    }
    if (filters.search) {
      where.OR = [
        { flowopsOrderNumber: { contains: filters.search, mode: 'insensitive' } },
        { externalOrderReference: { contains: filters.search, mode: 'insensitive' } },
        { customer: { phone: { contains: filters.search } } },
        { customer: { name: { contains: filters.search, mode: 'insensitive' } } },
      ]
    }

    const [orders, total] = await Promise.all([
      db.order.findMany({
        where,
        include: {
          customer: { select: { name: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.order.count({ where }),
    ])

    return {
      success: true,
      data: {
        orders: orders.map((o) => ({
          ...o,
          totalOrderValue: Number(o.totalOrderValue),
          customerName: o.customer.name,
          customerPhone: o.customer.phone,
        })),
        total,
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list orders',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// getOrderDetail
// ──────────────────────────────────────────────────────────────

export async function getOrderDetail(
  orderId: string,
): Promise<ActionResult<{
  order: {
    id: string
    flowopsOrderNumber: string
    externalOrderReference: string | null
    externalOrderId: string | null
    orderSource: string
    status: string
    paymentType: string
    paymentStatus: string
    paymentSource: string
    subtotal: number
    discountAmount: number | null
    courierCharges: number | null
    totalOrderValue: number
    advanceAmount: number | null
    advancePaidAt: Date | null
    codCollected: boolean
    codCollectedAmount: number | null
    codCollectedAt: Date | null
    deliveryAddress: string | null
    deliveryCity: string | null
    courierName: string | null
    trackingNumber: string | null
    confirmedAt: Date | null
    packedAt: Date | null
    dispatchedAt: Date | null
    deliveredAt: Date | null
    cancelledAt: Date | null
    cancellationReason: string | null
    createdAt: Date
  }
  customer: {
    id: string
    name: string
    phone: string
    email: string | null
    isFlagged: boolean
  }
  items: Array<{
    id: string
    orgVariantId: string
    quantity: number
    unitPrice: number
    lineTotal: number
    fulfillmentStatus: string
    fulfillmentTypeSnapshot: string
    variant: {
      sku: string
      productTitle: string
      attributeValues: Record<string, string>
    }
  }>
}>> {
  try {
    const ctx = await getWorkspace()

    const order = await db.order.findFirst({
      where: { id: orderId, companyId: ctx.company.id },
      include: {
        customer: {
          select: { id: true, name: true, phone: true, email: true, isFlagged: true },
        },
        items: {
          include: {
            orgVariant: {
              select: {
                sku: true,
                attributeValues: true,
                product: { select: { title: true } },
              },
            },
          },
        },
      },
    })

    if (!order) return { success: false, error: 'Order not found' }

    return {
      success: true,
      data: {
        order: {
          ...order,
          subtotal: Number(order.subtotal),
          discountAmount: order.discountAmount ? Number(order.discountAmount) : null,
          courierCharges: order.courierCharges ? Number(order.courierCharges) : null,
          totalOrderValue: Number(order.totalOrderValue),
          advanceAmount: order.advanceAmount ? Number(order.advanceAmount) : null,
          codCollectedAmount: order.codCollectedAmount ? Number(order.codCollectedAmount) : null,
          deliveryAddress: order.deliveryAddress,
        },
        customer: order.customer,
        items: order.items.map((item) => ({
          id: item.id,
          orgVariantId: item.orgVariantId,
          quantity: item.quantity,
          unitPrice: Number(item.unitPrice),
          lineTotal: Number(item.lineTotal),
          fulfillmentStatus: item.fulfillmentStatus,
          fulfillmentTypeSnapshot: item.fulfillmentTypeSnapshot,
          variant: {
            sku: item.orgVariant.sku,
            productTitle: item.orgVariant.product.title,
            attributeValues: JSON.parse(item.orgVariant.attributeValues),
          },
        })),
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to get order detail',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Step 3: Dispatch + Processing/Packing actions
// ──────────────────────────────────────────────────────────────

/**
 * Dispatch an order — deducts stock from inventory, sets tracking info.
 *
 * Business rules:
 *   - If order.status = 'pending' (confirmation was skipped): run the
 *     full confirmation/reservation logic inline first, then proceed.
 *   - If any item is still 'backordered' after reservation: BLOCK dispatch
 *     with a clear error (hard rule — no split shipments).
 *   - For each reserved item: call dispatchOrder() (inventory) which
 *     deducts on_hand, releases the reservation, and locks COGS.
 *   - The backfill_order_timestamps() trigger auto-sets confirmed_at/
 *     packed_at if they were still NULL.
 *   - If company_order_settings.require_packing_step = TRUE, verify
 *     order.packed_at IS NOT NULL before proceeding.
 */
export async function dispatchOrderAction(
  orderId: string,
  trackingNumber: string,
  courierName?: string,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)

    const order = await db.order.findFirst({
      where: { id: orderId, companyId: ctx.company.id },
    })
    if (!order) return { success: false, error: 'Order not found' }

    // Cannot dispatch already-dispatched/delivered/cancelled orders
    if (['dispatched', 'delivered', 'rto', 'cancelled', 'refunded'].includes(order.status)) {
      return { success: false, error: `Cannot dispatch an order that is already ${order.status}` }
    }

    // Check packing requirement
    const settings = await db.companyOrderSetting.findUnique({
      where: { companyId: ctx.company.id },
    })
    if (settings?.requirePackingStep && !order.packedAt) {
      return {
        success: false,
        error: 'This order must be marked as packed before dispatching. Use markOrderPacked() first.',
      }
    }

    // If order is still 'pending' (confirmation was skipped), run the
    // full confirmation + reservation logic inline first.
    if (order.status === 'pending') {
      await db.order.update({
        where: { id: orderId },
        data: { status: 'confirmed', confirmedAt: new Date() },
      })
      await reserveOrderStock(orderId, ctx)
    }

    // Re-fetch the order to get the updated status after reservation
    const updatedOrder = await db.order.findFirst({
      where: { id: orderId },
      select: { status: true, dispatchLocationId: true, organizationId: true },
    })
    if (!updatedOrder) return { success: false, error: 'Order not found after reservation' }

    // Check for backordered items — BLOCK dispatch if any exist
    const backorderedItems = await db.orderItem.findMany({
      where: { orderId, fulfillmentStatus: 'backordered' },
      include: {
        orgVariant: { select: { sku: true } },
      },
    })

    if (backorderedItems.length > 0) {
      const itemList = backorderedItems
        .map((i) => `${i.orgVariant.sku} (qty: ${i.quantity})`)
        .join(', ')
      return {
        success: false,
        error: `Cannot dispatch: ${backorderedItems.length} item(s) are still backordered: ${itemList}. Receive stock or cancel those items first.`,
      }
    }

    // Dispatch each reserved item
    const itemsToDispatch = await db.orderItem.findMany({
      where: { orderId, fulfillmentStatus: 'reserved' },
    })

    for (const item of itemsToDispatch) {
      const locationId = item.reservedLocationId ?? updatedOrder.dispatchLocationId
      if (!locationId) {
        return { success: false, error: `Order item ${item.id} has no dispatch location` }
      }

      const dispatchResult = await dispatchInventory({
        orgVariantId: item.orgVariantId,
        locationId,
        organizationId: updatedOrder.organizationId,
        companyId: ctx.company.id,
        employeeId: ctx.employee.id,
        quantity: item.quantity,
        orderId,
      })

      if (!dispatchResult.success) {
        return {
          success: false,
          error: `Failed to dispatch item: ${dispatchResult.error}`,
        }
      }

      // Mark item as dispatched
      await db.orderItem.update({
        where: { id: item.id },
        data: { fulfillmentStatus: 'dispatched', fulfilledAt: new Date() },
      })
    }

    // Update order status — the backfill_order_timestamps() trigger
    // will auto-set confirmedAt/packedAt if they were still NULL.
    await db.order.update({
      where: { id: orderId },
      data: {
        status: 'dispatched',
        dispatchedAt: new Date(),
        trackingNumber: trackingNumber || null,
        courierName: courierName || order.courierName,
      },
    })

    await insertAuditLog({
      action: 'order.dispatched',
      entityType: 'order',
      entityId: orderId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      oldValues: { status: updatedOrder.status },
      newValues: {
        status: 'dispatched',
        trackingNumber,
        courierName,
        itemsDispatched: itemsToDispatch.length,
      },
    })

    const timeToDispatchHours = order.createdAt
      ? Math.round((new Date().getTime() - new Date(order.createdAt).getTime()) / (1000 * 60 * 60))
      : 0
    await insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'order',
      entityId: orderId,
      metricKey: 'order.dispatched',
      numericValue: Number(order.totalOrderValue),
      dimensions: {
        courier_name: courierName || order.courierName,
        employee_id: ctx.employee.id,
        skipped_confirmation: updatedOrder.status === 'pending',
        skipped_packing: !order.packedAt,
        time_to_dispatch_hours: timeToDispatchHours,
      },
    }).catch(() => {})

    // Update customer stats
    const orderWithCustomer = await db.order.findUnique({
      where: { id: orderId },
      select: { customerId: true },
    })
    if (orderWithCustomer) {
      await updateCustomerStats(orderWithCustomer.customerId)
    }

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to dispatch order',
    }
  }
}

/**
 * Mark an order as "processing" (being packed). Only meaningful when
 * company_order_settings.require_packing_step = TRUE.
 */
export async function markOrderProcessing(orderId: string): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)

    const order = await db.order.findFirst({
      where: { id: orderId, companyId: ctx.company.id },
    })
    if (!order) return { success: false, error: 'Order not found' }

    if (!['confirmed', 'partially_backordered'].includes(order.status)) {
      return { success: false, error: `Order must be confirmed to start processing (current: ${order.status})` }
    }

    await db.order.update({
      where: { id: orderId },
      data: { status: 'processing' },
    })

    await insertAuditLog({
      action: 'order.processing_started',
      entityType: 'order',
      entityId: orderId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      oldValues: { status: order.status },
      newValues: { status: 'processing' },
    })

    await insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'order',
      entityId: orderId,
      metricKey: 'order.processing_started',
      numericValue: 1,
    }).catch(() => {})

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to mark order as processing',
    }
  }
}

/**
 * Mark an order as packed. Only enforced when
 * company_order_settings.require_packing_step = TRUE — when FALSE,
 * the backfill trigger sets packedAt automatically at dispatch time.
 */
export async function markOrderPacked(orderId: string): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)

    const order = await db.order.findFirst({
      where: { id: orderId, companyId: ctx.company.id },
    })
    if (!order) return { success: false, error: 'Order not found' }

    if (!['confirmed', 'partially_backordered', 'processing'].includes(order.status)) {
      return { success: false, error: `Order must be confirmed or processing to pack (current: ${order.status})` }
    }

    await db.order.update({
      where: { id: orderId },
      data: { packedAt: new Date() },
    })

    await insertAuditLog({
      action: 'order.packed',
      entityType: 'order',
      entityId: orderId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { packedAt: new Date() },
    })

    await insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'order',
      entityId: orderId,
      metricKey: 'order.packed',
      numericValue: 1,
    }).catch(() => {})

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to mark order as packed',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Step 4: markOrderDelivered
// ──────────────────────────────────────────────────────────────

/**
 * Mark a dispatched order as delivered.
 */
export async function markOrderDelivered(orderId: string): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)

    const order = await db.order.findFirst({
      where: { id: orderId, companyId: ctx.company.id },
    })
    if (!order) return { success: false, error: 'Order not found' }
    if (order.status !== 'dispatched') {
      return { success: false, error: `Order must be dispatched to mark as delivered (current: ${order.status})` }
    }

    await db.order.update({
      where: { id: orderId },
      data: { status: 'delivered', deliveredAt: new Date() },
    })

    await insertAuditLog({
      action: 'order.delivered',
      entityType: 'order',
      entityId: orderId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      oldValues: { status: 'dispatched' },
      newValues: { status: 'delivered' },
    })

    // Metric: order.delivered
    const deliveryDays = order.dispatchedAt
      ? Math.round((Date.now() - new Date(order.dispatchedAt).getTime()) / (1000 * 60 * 60 * 24))
      : 0

    await insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'order',
      entityId: orderId,
      metricKey: 'order.delivered',
      numericValue: Number(order.totalOrderValue),
      dimensions: { delivery_days: deliveryDays },
    }).catch(() => {})

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to mark order as delivered',
    }
  }
}
