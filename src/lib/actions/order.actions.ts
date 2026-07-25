/**
 * OMS — Order server actions.
 *
 * This step (Step 2) covers order CREATION and basic LIFECYCLE
 * transitions (confirm, cancel, payment conversion). It does NOT
 * implement inventory reservation/dispatch (Step 3) or returns (Step 4).
 *
 * Every mutation calls insertAuditLog(). Metric events (insertMetricEvent)
 * are NOT yet added in this step — they'll be added deliberately in a
 * later step to avoid the pattern where metrics get silently skipped.
 *
 * CRITICAL: No inventory stock movements happen here. Order items are
 * created with fulfillment_status = 'reserved' as a PLACEHOLDER — actual
 * stock reservation logic happens in Step 3.
 */

import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { getWorkspace, requirePermission, isElevated, ApiError } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
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

    // Step 3 will extend this to trigger actual stock reservation.
    // For now, just the status transition.

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

    await insertAuditLog({
      action: 'order.cancelled',
      entityType: 'order',
      entityId: d.order_id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      oldValues: { status: order.status },
      newValues: { status: 'cancelled', reason: d.cancellation_reason },
    })

    // Step 3 will extend this to call unreserveStockForOrder() for any
    // items with fulfillment_status='reserved'. The hook point is here —
    // the actual stock call happens in Step 3.

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
