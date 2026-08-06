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
  updatePaymentScreenshotSchema,
  type CreateManualOrderInput,
  type ConvertPaymentInput,
  type MarkCodCollectedInput,
  type CancelOrderInput,
  type ShopifyOrderWebhook,
  type UpdatePaymentScreenshotInput,
} from '@/lib/validations/order.schemas'
import { updateCustomerStats, createCustomer, markAddressAsUsed, matchOrCreateExternalCustomer } from './customer.actions'
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
  // Multi-select filters (preferred — used by the OMS filter panel)
  statuses?: string[]        // multi-select status filter
  paymentTypes?: string[]    // multi-select payment_type filter
  paymentStatuses?: string[] // multi-select payment_status filter
  orderSources?: string[]    // multi-select order_source filter
  courierNames?: string[]    // multi-select courier filter
  // Range / scalar filters
  dateFrom?: string
  dateTo?: string
  amountMin?: number         // total_order_value >=
  amountMax?: number         // total_order_value <=
  orgVariantId?: string      // filter to orders containing this variant
  customerId?: string
  deliveryCity?: string      // case-insensitive contains on delivery_city
  search?: string
  limit?: number
  offset?: number
  // Backward compat with single-value filters
  status?: string
  paymentType?: string
  paymentStatus?: string
  orderSource?: string
  courierName?: string
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
  /** Phase 5: auto-booking result — distinct from order creation success. */
  bookingAttempted: boolean
  bookingSucceeded: boolean
  bookingError?: string
  bookingTrackingNumber?: string
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

    // 2. Resolve customer (existing customer_id OR inline new_customer).
    //    Also resolve optional saved address/phone selection and recipient_name.
    let customerId: string
    let customerName: string
    let usedCustomerAddressId: string | null = null
    let usedCustomerPhoneId: string | null = null
    let saveAddressForNextTime = d.save_address_for_next_time ?? false
    // Whether the delivery_address came from a saved customer_addresses row
    // (vs. typed as a one-off). Used to decide whether to bump lastUsedAt.
    let selectedSavedAddressId: string | null = null

    if (d.customer_id) {
      // Existing customer path — verify they belong to this org.
      const existing = await db.customer.findFirst({
        where: { id: d.customer_id, organizationId: ctx.company.organizationId },
        select: { id: true, name: true },
      })
      if (!existing) return { success: false, error: 'Customer not found' }
      customerId = existing.id
      customerName = existing.name

      // If a saved address was selected, verify it belongs to this customer.
      if (d.used_customer_address_id) {
        const addr = await db.customerAddress.findFirst({
          where: {
            id: d.used_customer_address_id,
            customerId: existing.id,
            organizationId: ctx.company.organizationId,
          },
          select: { id: true, address: true, city: true },
        })
        if (addr) {
          usedCustomerAddressId = addr.id
          selectedSavedAddressId = addr.id
          // The delivery_address snapshot is the order's own editable copy.
          // If the caller passed the same address text, we trust it; if they
          // passed different text (edited it), we still record the link to
          // the saved address for lastUsedAt tracking but keep the edited text
          // as the order's snapshot. Either way, delivery_address comes from
          // the input — we do NOT override it here.
        }
      }

      // If a saved phone was selected, verify it belongs to this customer.
      if (d.used_customer_phone_id) {
        const phone = await db.customerPhone.findFirst({
          where: {
            id: d.used_customer_phone_id,
            customerId: existing.id,
            organizationId: ctx.company.organizationId,
          },
          select: { id: true },
        })
        if (phone) {
          usedCustomerPhoneId = phone.id
        }
      }
    } else if (d.new_customer) {
      // Inline new-customer path — create the customer + their phones +
      // addresses now via the Customer Management System. The first phone is
      // primary and the first address is default (validated by createCustomerSchema).
      const createResult = await createCustomer(d.new_customer)
      if (!createResult.success || !createResult.data) {
        return { success: false, error: createResult.error ?? 'Failed to create customer' }
      }
      customerId = createResult.data.customerId
      customerName = d.new_customer.name.trim()
      // For a brand-new customer, the first address they provided IS the
      // saved default address. Mark it as the selected address so we bump
      // its lastUsedAt after order creation.
      const newAddr = await db.customerAddress.findFirst({
        where: { customerId, isDefault: true },
        select: { id: true },
      })
      if (newAddr) {
        usedCustomerAddressId = newAddr.id
        selectedSavedAddressId = newAddr.id
      }
      // Same for the primary phone.
      const newPhone = await db.customerPhone.findFirst({
        where: { customerId, isPrimary: true },
        select: { id: true },
      })
      if (newPhone) {
        usedCustomerPhoneId = newPhone.id
      }
      // For a brand-new customer, we already saved the address as part of
      // createCustomer — don't double-save it.
      saveAddressForNextTime = false
    } else {
      return { success: false, error: 'Either customer_id or new_customer is required' }
    }

    // 3. recipient_name defaults to the customer's name if not explicitly overridden.
    const recipientName = (d.recipient_name && d.recipient_name.trim()) || customerName

    // 3. Fetch variants + their pricing for this company + fulfillment_type snapshot
    const variantIds = d.items.map((i) => i.org_variant_id)
    const variants = await db.orgProductVariant.findMany({
      where: { id: { in: variantIds }, organizationId: ctx.company.organizationId },
      include: {
        product: { select: { title: true } },
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

    // Build the order_detail string as we iterate — universal courier
    // reference field (migration 015). Format:
    //   "Product Title (SKU-001, Size: M, Color: Blue) ×2, ..."
    // Auto-generated but editable from the order-create form. If the caller
    // supplies an explicit order_detail, we honour it verbatim.
    const orderDetailParts: string[] = []

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

      // Append to orderDetail: "Product Title (SKU-001, Size: M) ×2"
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
      orderDetailParts.push(
        `${variant.product.title}${inner ? ` (${inner})` : ''} ×${item.quantity}`,
      )
    }

    // 5. Compute totals
    const discountAmount = d.discount_amount ?? 0
    const courierCharges = d.courier_charges ?? 0
    const estimatedDeliveryCharge = d.estimated_delivery_charge ?? 0
    const taxAmount = d.tax_amount ?? 0
    // Total = subtotal + courier charges + delivery charge + tax - discount
    // (delivery charge and tax are ADDITIVE — not absorbed into subtotal)
    const totalOrderValue = subtotal + courierCharges + estimatedDeliveryCharge + taxAmount - discountAmount

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

    // remainingCodAmount is NOT a GENERATED column in the DB — the application
    // MUST compute it as totalOrderValue - (advanceAmount ?? 0).
    const remainingCodAmount = totalOrderValue - (advanceAmount ?? 0)

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

    // 8a. Universal courier reference fields (migration 015).
    // orderRefNumber: defaults to flowopsOrderNumber if the caller left it
    // blank — every courier has a "reference" field so this is a core OMS
    // field, mapped to the courier's own ref at booking time.
    const orderRefNumber =
      (d.order_ref_number && d.order_ref_number.trim()) || flowopsOrderNumber
    // orderDetail: caller-provided takes precedence, otherwise use the
    // auto-generated string from the cart items (product title + SKU +
    // variant attributes + quantity).
    const orderDetail =
      (d.order_detail && d.order_detail.trim()) || orderDetailParts.join(', ')

    // 9. Create the order
    const order = await db.order.create({
      data: {
        organizationId: ctx.company.organizationId,
        companyId: ctx.company.id,
        flowopsOrderNumber,
        orderSource: 'manual',
        customerId,
        // Customer Management System integration (migration 002):
        //   - recipientName: the name to deliver to (defaults to customer.name)
        //   - usedCustomerAddressId / usedCustomerPhoneId: which saved
        //     customer_addresses / customer_phones rows were used for this
        //     order, for lastUsedAt tracking and reporting. Nullable when a
        //     one-off address/phone was typed without saving.
        recipientName,
        usedCustomerAddressId,
        usedCustomerPhoneId,
        status: orderStatus,
        paymentType: d.payment_type,
        paymentStatus,
        paymentSource,
        subtotal,
        discountAmount: discountAmount || null,
        discountReason: d.discount_reason || null,
        courierCharges: courierCharges || null,
        estimatedDeliveryCharge: estimatedDeliveryCharge || null,
        taxAmount: taxAmount || null,
        taxLabel: d.tax_label?.trim() || null,
        totalOrderValue,
        advanceAmount,
        advancePaymentMethod,
        advancePaymentReference,
        advancePaidAt,
        remainingCodAmount,
        deliveryAddress: d.delivery_address,
        deliveryCity: d.delivery_city,
        courierName: d.courier_name || null,
        courierCompanyIntegrationId: d.courier_company_integration_id || null,
        recommendedCourierCompanyIntegrationId: d.courier_company_integration_id || null,
        dispatchLocationId: d.dispatch_location_id,
        notesForCourier: d.notes_for_courier || null,
        // Per-order pickup address override (null = use integration default at booking time)
        pickupAddressId: d.pickup_address_id || null,
        // Universal courier reference fields (migration 015)
        orderRefNumber,
        orderDetail,
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

    // 12. Customer Management System integration:
    //   a. If a saved address was selected, bump its lastUsedAt to NOW() so
    //      the UI can sort saved addresses by recency.
    //   b. If a brand-new one-off address was typed AND the caller set
    //      save_address_for_next_time=true, persist it as a new
    //      customer_addresses row (and link it via usedCustomerAddressId
    //      for future tracking). This is the "Save this address for next
    //      time" UX from Step 3's frontend.
    //   c. Recompute cached customer stats (total_orders_count, etc.) and
    //      auto-flag if RTO threshold crossed.
    if (selectedSavedAddressId) {
      await markAddressAsUsed(selectedSavedAddressId)
    } else if (saveAddressForNextTime && d.delivery_address && d.delivery_city) {
      // One-off address typed + user opted to save it for next time.
      // Persist as a non-default customer_addresses row (default stays as-is
      // unless the user explicitly changes it via the customer profile).
      const savedAddr = await db.customerAddress.create({
        data: {
          customerId,
          organizationId: ctx.company.organizationId,
          label: null,
          address: d.delivery_address,
          city: d.delivery_city,
          isDefault: false,
          lastUsedAt: new Date(),
        },
      })
      // Link the order to the newly-saved address for future tracking.
      await db.order.update({
        where: { id: order.id },
        data: { usedCustomerAddressId: savedAddr.id },
      })
    }

    await updateCustomerStats(customerId)

    // 13. If the order auto-confirmed (payment-driven or company setting),
    // run the stock reservation logic immediately.
    if (orderStatus === 'confirmed') {
      await reserveOrderStock(order.id, ctx)
    }

    // 14. AUTO-BOOKING (Phase 3): if the company's courierBookingMode is
    // 'automatic' AND the order is confirmed (NOT 'partially_backordered' —
    // backordered orders are deferred to backorder fulfillment), automatically
    // book the courier right now. maybeAutoBookOrder() reads the default courier
    // from CompanyOrderSetting, so we attempt it regardless of whether the user
    // explicitly selected a courier on the form.
    //
    // NON-BLOCKING: if auto-booking fails, the order is STILL created
    // successfully — courierBookingStatus='failed' + courierBookingFailureReason
    // are persisted on the order, and it lands in the manual Workbench for retry.
    // The failure reason is returned in bookingError so the frontend can show a
    // distinct warning (separate from the order-created success message).
    let bookingAttempted = false
    let bookingSucceeded = false
    let bookingError: string | undefined
    let bookingTrackingNumber: string | undefined
    if (orderStatus === 'confirmed') {
      try {
        const { maybeAutoBookOrder } = await import('./booking.actions')
        const bookResult = await maybeAutoBookOrder(order.id, 'manual', orderStatus)
        if (bookResult.success && bookResult.data) {
          bookingAttempted = true
          bookingSucceeded = true
          bookingTrackingNumber = bookResult.data.trackingNumber
        } else if (bookResult.error) {
          // Distinguish between "skipped" (intentional — mode is semi_manual,
          // or no courier selected and no default) vs genuine errors (inactive
          // integration, API failure, city not recognized).
          // - "skipped" messages: NOT surfaced as errors (the user is in
          //   semi-manual mode or didn't select a courier — that's fine).
          // - Other messages: surfaced as warnings so the user knows WHY
          //   auto-booking failed and can fix it.
          const isSkipped = bookResult.error.includes('skipped')
          bookingAttempted = !isSkipped // skipped = not really "attempted"
          bookingSucceeded = false
          if (!isSkipped) {
            bookingError = bookResult.error
          }
        }
      } catch (err) {
        // Auto-booking threw — log but don't fail the order creation
        console.error('[createManualOrder] Auto-booking failed:', err)
        bookingAttempted = true
        bookingSucceeded = false
        bookingError = err instanceof Error ? err.message : 'Auto-booking failed'
      }
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
      data: {
        orderId: order.id,
        flowopsOrderNumber,
        orderItems: createdItems,
        // Phase 5: booking result — distinct from order creation success.
        // The frontend uses bookingAttempted + bookingSucceeded to show TWO
        // separate messages: "Order created" + (if applicable) "Booking failed".
        bookingAttempted,
        bookingSucceeded,
        bookingError,
        bookingTrackingNumber,
      },
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
    let advanceAmount: number | null = null
    let advancePaidAt: Date | null = null

    switch (d.financial_status) {
      case 'paid':
        paymentStatus = 'fully_prepaid'
        paymentType = 'fully_prepaid'
        orderStatus = 'confirmed'
        confirmedAt = new Date()
        advancePaidAt = new Date()
        // advanceAmount will be set to totalOrderValue below (after total_price is parsed)
        break
      case 'partially_paid':
        paymentStatus = 'advance_paid'
        paymentType = 'partial_advance'
        orderStatus = 'confirmed'
        confirmedAt = new Date()
        advancePaidAt = new Date()
        // Shopify webhook does not carry the partial amount paid — leave advanceAmount null.
        // remainingCodAmount will be computed as totalOrderValue - 0 = totalOrderValue.
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

    // Resolve customer via the cross-platform matching strategy (Step 1's
    // match_or_create_customer() SQL function, wrapped by
    // matchOrCreateExternalCustomer). This handles the layered:
    //   1. exact_identity (existing Shopify customer mapping)
    //   2. phone_match (normalized phone)
    //   3. email_match
    //   4. create new customer + primary phone + external identity mapping
    //
    // The customer's name comes from Shopify's first_name + last_name.
    // Phone/email come from the Shopify payload (may be null for guest orders).
    const shopifyCustomerName =
      `${d.customer.first_name ?? ''} ${d.customer.last_name ?? ''}`.trim() ||
      'Unknown Shopify Customer'

    const matchResult = await matchOrCreateExternalCustomer({
      platform: 'shopify',
      external_customer_id: String(d.customer.id ?? d.id),
      phone: d.customer.phone || undefined,
      email: d.customer.email || undefined,
      name: shopifyCustomerName,
      organizationId,
    })
    if (!matchResult.success || !matchResult.data) {
      return {
        success: false,
        error: matchResult.error ?? 'Could not resolve customer from Shopify payload',
      }
    }
    const customerId = matchResult.data.customerId

    // Fetch the resolved customer (for recipient_name default + address lookup).
    const customer = await db.customer.findUnique({
      where: { id: customerId },
      include: {
        phones: { where: { isPrimary: true }, take: 1 },
        addresses: { where: { isDefault: true }, take: 1 },
      },
    })
    if (!customer) {
      return { success: false, error: 'Resolved customer not found' }
    }

    // If Shopify sent a default_address AND the customer has no saved address
    // yet (newly created), persist it as their default customer_addresses row.
    // For existing customers, we leave their saved addresses alone — the
    // Shopify address becomes a one-off delivery snapshot on this order only.
    let usedCustomerAddressId: string | null = null
    let usedCustomerPhoneId: string | null = customer.phones[0]?.id ?? null
    const shopifyAddress1 = d.customer.default_address?.address1 || null
    const shopifyCity = d.customer.default_address?.city || null

    if (shopifyAddress1 && shopifyCity && customer.addresses.length === 0) {
      const newAddr = await db.customerAddress.create({
        data: {
          customerId: customer.id,
          organizationId,
          label: 'Shopify Default',
          address: shopifyAddress1,
          city: shopifyCity,
          isDefault: true,
          lastUsedAt: new Date(),
        },
      })
      usedCustomerAddressId = newAddr.id
    } else if (customer.addresses.length > 0) {
      // Existing customer with a saved default address — use it for this order.
      usedCustomerAddressId = customer.addresses[0].id
      await markAddressAsUsed(usedCustomerAddressId)
    }

    const recipientName = shopifyCustomerName

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

    // For fully_prepaid Shopify orders, advanceAmount = totalOrderValue.
    if (paymentStatus === 'fully_prepaid') {
      advanceAmount = totalOrderValue
    }

    // remainingCodAmount is NOT a GENERATED column in the DB — the application
    // MUST compute it as totalOrderValue - (advanceAmount ?? 0).
    const remainingCodAmount = totalOrderValue - (advanceAmount ?? 0)

    const flowopsOrderNumber = await generateOrderNumber(companyId)

    // Build orderDetail from Shopify line items for the universal courier
    // reference field (migration 015). Shopify doesn't expose variant
    // attributes cleanly in the webhook payload, so we use a simpler
    // format: "Product Title (SKU) ×qty, ..." — matching the existing
    // booking-workbench book route's itemDescription format.
    const orderDetailParts: string[] = []
    for (const li of d.line_items) {
      const variant = variants.find((v) => v.sku === li.sku)
      const title = variant?.sku ?? li.sku ?? 'Item'
      orderDetailParts.push(`${title} ×${li.quantity}`)
    }
    const orderDetail = orderDetailParts.join(', ')

    const order = await db.order.create({
      data: {
        organizationId,
        companyId,
        flowopsOrderNumber,
        orderSource: 'shopify',
        externalOrderReference: d.name,
        externalOrderId: String(d.id),
        customerId,
        // Customer Management System integration (migration 002):
        recipientName,
        usedCustomerAddressId,
        usedCustomerPhoneId,
        status: orderStatus,
        paymentType,
        paymentStatus,
        paymentSource,
        subtotal,
        totalOrderValue,
        advanceAmount,
        advancePaidAt,
        remainingCodAmount,
        confirmedAt,
        // delivery_address is the order's own editable snapshot. Use the
        // Shopify address if provided; otherwise fall back to the saved
        // default address's text (if any).
        deliveryAddress: shopifyAddress1 || customer.addresses[0]?.address || null,
        deliveryCity: shopifyCity || customer.addresses[0]?.city || null,
        // Universal courier reference fields (migration 015):
        // orderRefNumber defaults to the Shopify order name (e.g. "#1001")
        // — staff can override post-creation if needed. orderDetail is the
        // auto-generated item summary above.
        orderRefNumber: d.name || flowopsOrderNumber,
        orderDetail,
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

    await updateCustomerStats(customerId)

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

    // Recompute cached customer stats (order count may change if this was a
    // re-confirmation, and the status transition affects value/rto calcs).
    // Non-fatal — never break the confirm action on a stats failure.
    await updateCustomerStats(order.customerId).catch(() => {})

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

    // remainingCodAmount is NOT a GENERATED column in the DB — recompute it
    // whenever the advance amount changes: totalOrderValue - (advanceAmount ?? 0).
    const newRemainingCod = Number(order.totalOrderValue) - (d.advance_amount ?? 0)

    const updateData: Prisma.OrderUncheckedUpdateInput = {
      paymentType: d.new_payment_type,
      paymentStatus: newPaymentStatus,
      paymentSource: 'manual_conversion',
      advanceAmount: d.advance_amount ?? null,
      advancePaymentMethod: d.advance_payment_method || null,
      advancePaymentReference: d.advance_payment_reference || null,
      advancePaymentScreenshotUrl: d.advance_payment_screenshot_url || null,
      advancePaidAt: new Date(),
      remainingCodAmount: newRemainingCod,
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
        remainingCodAmount: newRemainingCod,
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
// updatePaymentScreenshot
// ──────────────────────────────────────────────────────────────
//
// Lightweight endpoint used to attach (or clear) a payment proof
// screenshot URL on an EXISTING order. Used in two scenarios:
//
// 1. Order creation flow: file is held in browser memory during the
//    single-page form (no order_id yet), uploaded to /api/upload
//    immediately after createManualOrder() returns the new order_id,
//    then this action is called to persist the resulting URL.
//
// 2. Order detail page: "Add payment proof" affordance when the order
//    was created without a screenshot or the original upload failed.
//
// Does NOT change payment_type / payment_status / advance_amount —
// only the screenshot URL field. If the order's payment_status is
// 'cod_pending' (no advance yet), the convert-payment endpoint should
// be used instead.
//
// Audit logged with old/new URL. No metric event (no $ change).

export async function updatePaymentScreenshot(
  input: UpdatePaymentScreenshotInput,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const parsed = updatePaymentScreenshotSchema.safeParse(input)
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
    }
    const d = parsed.data

    const order = await db.order.findFirst({
      where: { id: d.order_id, companyId: ctx.company.id },
      select: { id: true, advancePaymentScreenshotUrl: true, paymentType: true },
    })
    if (!order) return { success: false, error: 'Order not found' }

    const oldUrl = order.advancePaymentScreenshotUrl
    const newUrl = d.advance_payment_screenshot_url || null

    // No-op if nothing changed — saves an audit entry + DB write.
    if (oldUrl === newUrl) return { success: true }

    await db.order.update({
      where: { id: d.order_id },
      data: { advancePaymentScreenshotUrl: newUrl },
    })

    await insertAuditLog({
      action: 'order.payment_screenshot_updated',
      entityType: 'order',
      entityId: d.order_id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      oldValues: oldUrl ? { advance_payment_screenshot_url: oldUrl } : null,
      newValues: newUrl ? { advance_payment_screenshot_url: newUrl } : null,
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to update payment screenshot',
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

    // Recompute cached customer stats (COD collection is a financial event
    // that may affect the value calculations). Non-fatal.
    await updateCustomerStats(order.customerId).catch(() => {})

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

    // Recompute cached customer stats (cancelled orders are excluded from
    // total_orders_count, so this count drops). Non-fatal.
    await updateCustomerStats(order.customerId).catch(() => {})

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
    remainingCodAmount: number | null
    codCollected: boolean
    courierName: string | null
    trackingNumber: string | null
    dispatchLocationId: string | null
    customerId: string
    deliveryAddress: string | null
    deliveryCity: string | null
    confirmedAt: Date | null
    dispatchedAt: Date | null
    deliveredAt: Date | null
    createdAt: Date
    customerName: string
    customerPhone: string
    itemCount: number
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

    // Status filter — prefer multi-select `statuses`, fall back to single `status`
    if (filters.statuses && filters.statuses.length > 0) {
      where.status = { in: filters.statuses }
    } else if (filters.status) {
      where.status = filters.status
    }

    // Payment type filter — prefer multi-select `paymentTypes`, fall back to single `paymentType`
    if (filters.paymentTypes && filters.paymentTypes.length > 0) {
      where.paymentType = { in: filters.paymentTypes }
    } else if (filters.paymentType) {
      where.paymentType = filters.paymentType
    }

    // Payment status filter (multi-select preferred)
    if (filters.paymentStatuses && filters.paymentStatuses.length > 0) {
      where.paymentStatus = { in: filters.paymentStatuses }
    } else if (filters.paymentStatus) {
      where.paymentStatus = filters.paymentStatus
    }

    // Order source filter — prefer multi-select `orderSources`, fall back to single `orderSource`
    if (filters.orderSources && filters.orderSources.length > 0) {
      where.orderSource = { in: filters.orderSources }
    } else if (filters.orderSource) {
      where.orderSource = filters.orderSource
    }

    // Courier filter — prefer multi-select `courierNames`, fall back to single `courierName`
    if (filters.courierNames && filters.courierNames.length > 0) {
      where.courierName = { in: filters.courierNames }
    } else if (filters.courierName) {
      where.courierName = filters.courierName
    }

    if (filters.customerId) where.customerId = filters.customerId

    // Delivery city filter — case-insensitive contains on delivery_city
    if (filters.deliveryCity) {
      where.deliveryCity = { contains: filters.deliveryCity, mode: 'insensitive' }
    }

    if (filters.dateFrom || filters.dateTo) {
      where.createdAt = {}
      if (filters.dateFrom) where.createdAt.gte = new Date(filters.dateFrom)
      if (filters.dateTo) {
        // date_to is inclusive of the whole day
        const end = new Date(filters.dateTo)
        end.setHours(23, 59, 59, 999)
        where.createdAt.lte = end
      }
    }

    // Amount range filter on total_order_value
    if (filters.amountMin !== undefined || filters.amountMax !== undefined) {
      where.totalOrderValue = {}
      if (filters.amountMin !== undefined) where.totalOrderValue.gte = filters.amountMin
      if (filters.amountMax !== undefined) where.totalOrderValue.lte = filters.amountMax
    }

    // Filter to orders containing a specific variant — uses Prisma's `some`
    // relation filter which compiles to an EXISTS subquery (avoids duplicate
    // rows that a join-based filter would introduce).
    if (filters.orgVariantId) {
      where.items = { some: { orgVariantId: filters.orgVariantId } }
    }

    if (filters.search) {
      where.OR = [
        { flowopsOrderNumber: { contains: filters.search, mode: 'insensitive' } },
        { externalOrderReference: { contains: filters.search, mode: 'insensitive' } },
        // Customer Management System: phones live in customer_phones now.
        // Search across the customer's name + any of their phone numbers.
        { customer: { name: { contains: filters.search, mode: 'insensitive' } } },
        { customer: { phones: { some: { phoneRaw: { contains: filters.search, mode: 'insensitive' } } } } },
      ]
    }

    const [orders, total] = await Promise.all([
      db.order.findMany({
        where,
        include: {
          customer: {
            select: {
              name: true,
              phones: {
                where: { isPrimary: true },
                take: 1,
                select: { phoneRaw: true },
              },
            },
          },
          _count: { select: { items: true } },
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
          id: o.id,
          flowopsOrderNumber: o.flowopsOrderNumber,
          externalOrderReference: o.externalOrderReference,
          externalOrderId: o.externalOrderId,
          orderSource: o.orderSource,
          status: o.status,
          paymentType: o.paymentType,
          paymentStatus: o.paymentStatus,
          paymentSource: o.paymentSource,
          subtotal: Number(o.subtotal),
          discountAmount: o.discountAmount ? Number(o.discountAmount) : null,
          courierCharges: o.courierCharges ? Number(o.courierCharges) : null,
          estimatedDeliveryCharge: o.estimatedDeliveryCharge ? Number(o.estimatedDeliveryCharge) : null,
          actualDeliveryCharge: o.actualDeliveryCharge ? Number(o.actualDeliveryCharge) : null,
          taxAmount: o.taxAmount ? Number(o.taxAmount) : null,
          taxLabel: o.taxLabel ?? null,
          totalOrderValue: Number(o.totalOrderValue),
          advanceAmount: o.advanceAmount ? Number(o.advanceAmount) : null,
          remainingCodAmount: o.remainingCodAmount
            ? Number(o.remainingCodAmount)
            : Math.max(
                0,
                Number(o.totalOrderValue) - (o.advanceAmount ? Number(o.advanceAmount) : 0),
              ),
          codCollected: o.codCollected,
          courierName: o.courierName,
          trackingNumber: o.trackingNumber,
          courierCompanyIntegrationId: o.courierCompanyIntegrationId,
          courierBookingStatus: o.courierBookingStatus,
          courierBookingFailureReason: o.courierBookingFailureReason,
          courierCityStatus: o.courierCityStatus,
          courierSubStatus: o.courierSubStatus,
          needsShipperAdvice: o.needsShipperAdvice,
          dispatchLocationId: o.dispatchLocationId,
          customerId: o.customerId,
          deliveryAddress: o.deliveryAddress,
          deliveryCity: o.deliveryCity,
          // Universal courier reference fields (migration 015)
          orderRefNumber: o.orderRefNumber,
          orderDetail: o.orderDetail,
          notesForCourier: o.notesForCourier,
          confirmedAt: o.confirmedAt,
          dispatchedAt: o.dispatchedAt,
          deliveredAt: o.deliveredAt,
          createdAt: o.createdAt,
          customerName: o.customer.name,
          customerPhone: o.customer.phones[0]?.phoneRaw ?? null,
          itemCount: o._count.items,
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
    discountReason: string | null
    courierCharges: number | null
    totalOrderValue: number
    advanceAmount: number | null
    advancePaymentMethod: string | null
    advancePaymentReference: string | null
    advancePaymentScreenshotUrl: string | null
    advancePaidAt: Date | null
    remainingCodAmount: number | null
    codCollected: boolean
    codCollectedAmount: number | null
    codCollectedAt: Date | null
    convertedBy: string | null
    convertedAt: Date | null
    deliveryAddress: string | null
    deliveryCity: string | null
    courierName: string | null
    trackingNumber: string | null
    dispatchLocationId: string | null
    notesForCourier: string | null
    // Universal courier reference fields (migration 015)
    orderRefNumber: string | null
    orderDetail: string | null
    skippedConfirmation: boolean
    skippedPacking: boolean
    confirmedAt: Date | null
    packedAt: Date | null
    dispatchedAt: Date | null
    deliveredAt: Date | null
    cancelledAt: Date | null
    cancellationReason: string | null
    returnedAt: Date | null
    createdAt: Date
  }
  customer: {
    id: string
    name: string
    primaryPhone: string | null
    primaryPhoneNormalized: string | null
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
          select: {
            id: true,
            name: true,
            email: true,
            isFlagged: true,
            // Customer Management System: phones live in customer_phones now.
            phones: {
              where: { isPrimary: true },
              take: 1,
              select: { phoneRaw: true, phoneNormalized: true },
            },
          },
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
          remainingCodAmount: order.remainingCodAmount ? Number(order.remainingCodAmount) : null,
          codCollectedAmount: order.codCollectedAmount ? Number(order.codCollectedAmount) : null,
          deliveryAddress: order.deliveryAddress,
        },
        customer: {
          id: order.customer.id,
          name: order.customer.name,
          email: order.customer.email,
          isFlagged: order.customer.isFlagged,
          // Convenience: flatten the primary phone for backwards-compatible
          // frontend consumption.
          primaryPhone: order.customer.phones[0]?.phoneRaw ?? null,
          primaryPhoneNormalized: order.customer.phones[0]?.phoneNormalized ?? null,
        },
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

    // Recompute cached customer stats (delivery affects total_order_value
    // and delivery_rate). Non-fatal.
    await updateCustomerStats(order.customerId).catch(() => {})

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to mark order as delivered',
    }
  }
}
