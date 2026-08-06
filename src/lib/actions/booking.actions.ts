/**
 * Booking Server Actions — reusable courier booking logic.
 *
 * Extracted from /api/booking-workbench/book/route.ts so that the same
 * booking logic can be called from:
 *   1. The manual Booking Workbench (via the API route)
 *   2. Auto-booking after order creation (when courierBookingMode='automatic')
 *
 * The function handles ONLY orders (not exchange shipments) — exchange
 * shipment booking is handled by the exchange-shipment flow separately.
 */

import { db } from '@/lib/db'
import { getWorkspace, requirePermission, ApiError } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { decryptCredentials } from '@/lib/utils/encryption'
import { getCourierAdapter } from '@/lib/integrations/registry'
import { executeLoggedIntegrationAction } from '@/lib/integrations/logged-call'
import { revalidateCityAtBookingTime } from '@/lib/integrations/city-matcher'
import { determinePostExOrderType } from '@/lib/integrations/couriers/postex.order-type'
import { calculateOrderWeightKg } from '@/lib/utils/order-weight'
import type { BookShipmentInput, BookShipmentResult } from '@/lib/integrations/types'

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

export interface BookOrderResult {
  trackingNumber: string
  orderType: string
  providerStatus: string | null
  courierBookingStatus: 'booked' | 'failed'
}

export interface BookOrderOptions {
  /** The order to book. */
  orderId: string
  /** The courier integration to book with. */
  companyIntegrationId: string
  /** Optional per-booking overrides (from the Workbench UI or auto-booking). */
  customerName?: string
  customerPhone?: string
  deliveryAddress?: string
  deliveryCity?: string
  codAmount?: number
  orderType?: string
  transactionNotes?: string
  itemDescription?: string
  orderRefNumber?: string
  pickupAddressCode?: string
}

/**
 * Book a single order with the selected courier.
 *
 * This is the SINGLE source of truth for order booking logic. Both the
 * manual Booking Workbench (via /api/booking-workbench/book) and the
 * auto-booking hook in createManualOrder() call this function.
 *
 * Flow:
 *   1. Fetch the order + items + variant weights + customer
 *   2. Validate the city (with live PostEx fallback on cache miss)
 *   3. Compute weight + orderType
 *   4. Get the pickup address code (from override or default)
 *   5. Build the BookShipmentInput (using stored orderRefNumber/orderDetail/
 *      notesForCourier as defaults, with per-call overrides taking precedence)
 *   6. Call the courier adapter's bookShipment() via executeLoggedIntegrationAction
 *   7. Update the order with trackingNumber + courierBookingStatus='booked'
 *
 * On failure: sets courierBookingStatus='failed' on the order and returns
 * success=false with the error message. Does NOT throw.
 */
export async function bookOrderWithCourier(
  options: BookOrderOptions,
): Promise<ActionResult<BookOrderResult>> {
  // Extract orderId + companyIntegrationId BEFORE the try block so they're
  // accessible in the catch block (const is block-scoped in JS).
  const { orderId, companyIntegrationId } = options
  if (!orderId || !companyIntegrationId) {
    return { success: false, error: 'orderId and companyIntegrationId are required' }
  }

  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)

    // ── Fetch the integration ──
    const integration = await db.companyIntegration.findFirst({
      where: { id: companyIntegrationId, companyId: ctx.company.id, isActive: true },
      include: { provider: true },
    })
    if (!integration) {
      const reason = `Courier integration not found or inactive (integrationId: ${companyIntegrationId}).`
      await db.order.update({
        where: { id: orderId },
        data: { courierBookingStatus: 'failed', courierBookingFailureReason: reason },
      })
      return { success: false, error: reason }
    }

    const providerKey = integration.provider.providerKey
    if (providerKey !== 'postex') {
      return {
        success: false,
        error: `Booking not yet implemented for provider '${providerKey}'.`,
      }
    }

    // ── Fetch the order with items + variant weights + customer ──
    const order = await db.order.findFirst({
      where: { id: orderId, companyId: ctx.company.id },
      include: {
        customer: {
          select: {
            id: true, name: true,
            phones: { select: { id: true, phoneRaw: true, isPrimary: true }, orderBy: { isPrimary: 'desc' } },
          },
        },
        items: {
          include: {
            orgVariant: {
              select: { id: true, sku: true, weightKg: true, product: { select: { title: true } } },
            },
          },
        },
      },
    })
    if (!order) {
      return { success: false, error: 'Order not found.' }
    }

    // ── Apply overrides + stored-value defaults ──
    const customerName = options.customerName?.trim() || order.customer?.name || 'Customer'
    const customerPhone =
      options.customerPhone?.trim() ||
      order.customer?.phones.find((p) => p.isPrimary)?.phoneRaw ||
      order.customer?.phones[0]?.phoneRaw || ''
    const deliveryAddress = options.deliveryAddress?.trim() || order.deliveryAddress || ''
    const deliveryCity = options.deliveryCity?.trim() || order.deliveryCity || ''
    const codAmount = options.codAmount ?? Number(order.remainingCodAmount ?? order.totalOrderValue ?? 0)
    // Universal courier reference fields (migration 015): per-call override >
    // stored value > flowops order number
    const orderRefNumber =
      options.orderRefNumber?.trim() ||
      (order.orderRefNumber && order.orderRefNumber.trim()) ||
      order.flowopsOrderNumber
    const itemDescription =
      options.itemDescription?.trim() ||
      (order.orderDetail && order.orderDetail.trim()) ||
      order.items.map((i) => `${i.orgVariant.product.title} (${i.orgVariant.sku}) ×${i.quantity}`).join(', ')
    const transactionNotes =
      options.transactionNotes?.trim() || (order.notesForCourier && order.notesForCourier.trim()) || ''

    if (!deliveryCity) {
      const reason = 'Delivery city is required.'
      await db.order.update({
        where: { id: orderId },
        data: { courierBookingStatus: 'failed', courierBookingFailureReason: reason },
      })
      return { success: false, error: reason }
    }
    if (!customerPhone) {
      const reason = 'Customer phone is required.'
      await db.order.update({
        where: { id: orderId },
        data: { courierBookingStatus: 'failed', courierBookingFailureReason: reason },
      })
      return { success: false, error: reason }
    }

    // ── Validate city (with live PostEx fallback + staleness check) ──
    const cityValid = await revalidateCityAtBookingTime(
      providerKey,
      deliveryCity,
      integration.id,
    )
    if (!cityValid) {
      const reason = `City not recognized: "${deliveryCity}" is not available for delivery with ${integration.provider.providerName}. The city may need to be resolved or the courier may not serve this area.`
      await db.order.update({
        where: { id: orderId },
        data: {
          courierCityStatus: 'unresolved',
          courierBookingStatus: 'failed',
          courierBookingFailureReason: reason,
          courierCompanyIntegrationId: integration.id,
          courierName: integration.provider.providerName,
        },
      })
      return { success: false, error: reason }
    }

    // ── Compute weight + orderType ──
    const weightResult = calculateOrderWeightKg(
      order.items.map((i) => ({
        quantity: i.quantity,
        variant: { weightKg: i.orgVariant.weightKg as { toNumber: () => number } | number | null },
      })),
    )

    const orderType = options.orderType || determinePostExOrderType(
      weightResult.totalWeightKg,
      weightResult.hasMissingWeight,
      false, // isExchangeReplacement=false for regular orders
    )

    // ── Get pickup address code ──
    // Priority: per-call override > order's persisted pickupAddressId >
    // integration's default. This allows per-order pickup address override
    // set in the order creation form.
    let pickupAddressCode = options.pickupAddressCode
    if (!pickupAddressCode && order.pickupAddressId) {
      // Use the per-order override
      const orderAddr = await db.courierPickupAddress.findFirst({
        where: { id: order.pickupAddressId, companyIntegrationId: integration.id },
        select: { providerAddressCode: true },
      })
      pickupAddressCode = orderAddr?.providerAddressCode
    }
    if (!pickupAddressCode) {
      // Fall back to the integration's default address
      const defaultAddr = await db.courierPickupAddress.findFirst({
        where: { companyIntegrationId: integration.id, isDefault: true },
        select: { providerAddressCode: true },
      })
      pickupAddressCode = defaultAddr?.providerAddressCode
    }

    // ── Build the BookShipmentInput ──
    const bookInput: BookShipmentInput = {
      orderNumber: orderRefNumber,
      recipientName: customerName,
      recipientPhone: customerPhone,
      deliveryAddress,
      deliveryCity,
      pickupLocationAddress: '',
      pickupLocationCity: '',
      weightGrams: Math.round(weightResult.totalWeightKg * 1000),
      codAmount,
      itemDescription,
      pickupAddressCode,
      orderType,
      quantity: order.items.reduce((sum, i) => sum + i.quantity, 0),
      transactionNotes,
    }

    // ── Call the courier adapter ──
    const credentials = decryptCredentials(integration.credentialsEncrypted!)
    const adapter = getCourierAdapter(providerKey, credentials)

    const bookResult = await executeLoggedIntegrationAction<BookShipmentResult>({
      companyIntegrationId: integration.id,
      organizationId: ctx.company.organizationId,
      actionType: 'book_shipment',
      direction: 'outbound',
      relatedEntityType: 'order',
      relatedEntityId: orderId,
      fn: async () => adapter.bookShipment(bookInput),
    })

    if (!bookResult.success || !bookResult.trackingNumber) {
      // Mark as failed so it shows up in the manual workbench for retry.
      // Persist the failure reason so it survives navigation — the user can
      // see WHY booking failed from the order detail page or the Workbench
      // without re-attempting.
      const reason = bookResult.error || 'Booking failed — no tracking number returned.'
      await db.order.update({
        where: { id: orderId },
        data: {
          courierBookingStatus: 'failed',
          courierBookingFailureReason: reason,
          courierCompanyIntegrationId: integration.id,
          courierName: integration.provider.providerName,
        },
      })
      return { success: false, error: reason }
    }

    // ── Update the order with tracking + booking status ──
    // Map the PostEx providerStatus through the status map to get the
    // canonical courierSubStatus (e.g. "Unbooked" → "slip_generated").
    // Without this, the raw PostEx string would be stored directly.
    const { mapPostExStatus } = await import('@/lib/integrations/couriers/postex.status-map')
    const mappedBookingStatus = bookResult.providerStatus
      ? mapPostExStatus(bookResult.providerStatus)
      : null

    await db.order.update({
      where: { id: orderId },
      data: {
        courierCompanyIntegrationId: integration.id,
        trackingNumber: bookResult.trackingNumber,
        courierCityStatus: 'matched',
        courierSubStatus: mappedBookingStatus?.courierSubStatus ?? null,
        courierName: integration.provider.providerName,
        courierBookingStatus: 'booked',
        // Clear any previous failure reason on success
        courierBookingFailureReason: null,
      },
    })

    // Audit log
    await insertAuditLog({
      action: 'order.auto_booked',
      entityType: 'order',
      entityId: orderId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: {
        trackingNumber: bookResult.trackingNumber,
        courierIntegrationId: integration.id,
        orderType,
        providerStatus: bookResult.providerStatus,
      },
    }).catch(() => {})

    return {
      success: true,
      data: {
        trackingNumber: bookResult.trackingNumber,
        orderType,
        providerStatus: bookResult.providerStatus ?? null,
        courierBookingStatus: 'booked',
      },
    }
  } catch (err) {
    // Any uncaught error (credential decryption, network, etc.) — persist
    // the failure status so the order shows up in the Workbench for retry.
    const reason = err instanceof Error ? err.message : 'Failed to book order'
    try {
      await db.order.update({
        where: { id: orderId },
        data: { courierBookingStatus: 'failed', courierBookingFailureReason: reason },
      })
    } catch {
      // Best-effort — don't mask the original error
    }
    return { success: false, error: reason }
  }
}

/**
 * Auto-book an order if the company's courierBookingMode is 'automatic'.
 *
 * Called from createManualOrder() AFTER the order is created + stock is
 * reserved. Reads the company's order settings to decide whether to book.
 *
 * This function is NON-BLOCKING for order creation — if booking fails, the
 * order is still created successfully (with courierBookingStatus='failed'),
 * and the user can retry from the Booking Workbench. The error is logged
 * and returned in the result so the caller can surface a toast.
 *
 * Skips auto-booking when:
 *   - courierBookingMode !== 'automatic'
 *   - No defaultCourierCompanyIntegrationId is set
 *   - The order source is not 'manual' (Shopify/Daraz always manual per UI)
 *   - The order is not yet confirmed (pending orders shouldn't auto-book)
 */
export async function maybeAutoBookOrder(
  orderId: string,
  orderSource: string,
  orderStatus: string,
): Promise<ActionResult<BookOrderResult>> {
  try {
    // Only auto-book manual orders that are confirmed (or processing)
    if (orderSource !== 'manual') {
      return { success: false, error: 'Auto-booking skipped: order source is not manual.' }
    }
    if (orderStatus !== 'confirmed' && orderStatus !== 'processing') {
      return { success: false, error: `Auto-booking skipped: order status is '${orderStatus}' (not confirmed).` }
    }

    const ctx = await getWorkspace()

    // Read the company's order settings
    const settings = await db.companyOrderSetting.findUnique({
      where: { companyId: ctx.company.id },
    })
    if (!settings) {
      return { success: false, error: 'No order settings found for this company.' }
    }

    if (settings.courierBookingMode !== 'automatic') {
      return { success: false, error: `Auto-booking skipped: courierBookingMode is '${settings.courierBookingMode}'.` }
    }

    // ── Determine which integration to book with ──
    // Priority: the courier the user selected on the order form
    // (Order.courierCompanyIntegrationId) → falls back to the company's
    // default courier (CompanyOrderSetting.defaultCourierCompanyIntegrationId).
    // This fixes the bug where auto-booking didn't fire when the user
    // selected a courier on the form but the company default was null
    // (e.g. after a disconnect/reconnect cycle).
    const order = await db.order.findUnique({
      where: { id: orderId },
      select: { courierCompanyIntegrationId: true, flowopsOrderNumber: true },
    })
    if (!order) {
      return { success: false, error: 'Order not found.' }
    }

    const integrationId = order.courierCompanyIntegrationId || settings.defaultCourierCompanyIntegrationId
    if (!integrationId) {
      return { success: false, error: 'Auto-booking skipped: no courier selected on the order and no default courier set in Order Settings.' }
    }

    // ── Early bail: check if the integration is still active ──
    const defaultIntegration = await db.companyIntegration.findFirst({
      where: { id: integrationId, companyId: ctx.company.id },
      select: { id: true, isActive: true, connectionName: true, provider: { select: { providerName: true } } },
    })
    if (!defaultIntegration) {
      return {
        success: false,
        error: 'Courier integration was deleted. Update Order Settings or select a different courier.',
      }
    }
    if (!defaultIntegration.isActive) {
      return {
        success: false,
        error: `Courier integration "${defaultIntegration.provider.providerName} — ${defaultIntegration.connectionName}" is disconnected. Reconnect it in Integrations settings or choose a different courier.`,
      }
    }

    // Fire the booking
    const result = await bookOrderWithCourier({
      orderId,
      companyIntegrationId: integrationId,
    })

    if (result.success) {
      // Metric event for successful auto-booking
      await insertMetricEvent({
        companyId: ctx.company.id,
        entityType: 'order',
        entityId: orderId,
        metricKey: 'order.auto_booked',
        numericValue: 1,
        dimensions: { provider: 'postex', mode: 'automatic' },
      }).catch(() => {})
    } else {
      // Metric event for failed auto-booking
      await insertMetricEvent({
        companyId: ctx.company.id,
        entityType: 'order',
        entityId: orderId,
        metricKey: 'order.auto_booking_failed',
        numericValue: 1,
        dimensions: { reason: result.error?.slice(0, 100) ?? 'unknown' },
      }).catch(() => {})
    }

    return result
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Auto-booking failed',
    }
  }
}
