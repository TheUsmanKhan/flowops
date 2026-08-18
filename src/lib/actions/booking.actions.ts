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

  // ════════════════════════════════════════════════════════════════
  // TEMPORARY DIAGNOSTIC INSTRUMENTATION — booking flow timing.
  // Measures each step's wall-clock duration and logs a structured
  // breakdown at the end. Will be removed after diagnosis.
  // ════════════════════════════════════════════════════════════════
  const T: Record<string, number> = {}
  const marks: Record<string, number> = {}
  function mark(label: string) { marks[label] = Date.now() }
  function measure(from: string, to: string, key: string) { T[key] = marks[to] - marks[from] }
  const flowStart = Date.now()
  mark('start')

  try {
    mark('authStart')
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)
    mark('authEnd')
    measure('authStart', 'authEnd', '1_auth_resolution')

    // ── Fetch the integration ──
    mark('integrationFetchStart')
    const integration = await db.companyIntegration.findFirst({
      where: { id: companyIntegrationId, companyId: ctx.company.id, isActive: true },
      include: { provider: true },
    })
    mark('integrationFetchEnd')
    measure('integrationFetchStart', 'integrationFetchEnd', '2a_integration_fetch')
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
    mark('orderLoadStart')
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
    mark('orderLoadEnd')
    measure('orderLoadStart', 'orderLoadEnd', '2b_order_load')
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

    // ── Validate city (with live courier fallback + staleness check) ──
    // revalidateCityAtBookingTime() is provider-agnostic — it uses the
    // adapter's fetchOperationalCities() for the live fallback.
    mark('cityValidateStart')
    const cityValid = await revalidateCityAtBookingTime(
      providerKey,
      deliveryCity,
      integration.id,
    )
    mark('cityValidateEnd')
    measure('cityValidateStart', 'cityValidateEnd', '4_city_validation')
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

    // ── Compute weight ──
    mark('weightStart')
    const weightResult = calculateOrderWeightKg(
      order.items.map((i) => ({
        quantity: i.quantity,
        variant: { weightKg: i.orgVariant.weightKg as { toNumber: () => number } | number | null },
      })),
    )
    mark('weightEnd')
    measure('weightStart', 'weightEnd', '3_weight_calc')

    // ── Compute orderType (PostEx-specific; Leopard doesn't use this concept) ──
    // Leopard's shipment_type field is a DIFFERENT thing (optional, defaults to "overnight")
    // — do NOT apply PostEx's Normal/Overland/Replacement logic to Leopard.
    mark('orderTypeStart')
    let orderType: string | undefined
    if (providerKey === 'postex') {
      orderType = options.orderType || determinePostExOrderType(
        weightResult.totalWeightKg,
        weightResult.hasMissingWeight,
        false, // isExchangeReplacement=false for regular orders
      )
    } else {
      orderType = options.orderType // pass through for other couriers (may be undefined)
    }
    mark('orderTypeEnd')
    measure('orderTypeStart', 'orderTypeEnd', '5_orderType_calc')

    // ── Get pickup address code ──
    // Priority: per-call override > order's persisted pickupAddressId >
    // integration's default.
    mark('pickupAddrStart')
    let pickupAddressCode = options.pickupAddressCode
    if (!pickupAddressCode && order.pickupAddressId) {
      const orderAddr = await db.courierPickupAddress.findFirst({
        where: { id: order.pickupAddressId, companyIntegrationId: integration.id },
        select: { providerAddressCode: true },
      })
      pickupAddressCode = orderAddr?.providerAddressCode
    }
    if (!pickupAddressCode) {
      const defaultAddr = await db.courierPickupAddress.findFirst({
        where: { companyIntegrationId: integration.id, isDefault: true },
        select: { providerAddressCode: true },
      })
      pickupAddressCode = defaultAddr?.providerAddressCode
    }
    mark('pickupAddrEnd')
    measure('pickupAddrStart', 'pickupAddrEnd', '6_pickup_addr_resolution')

    // ── For Leopard: resolve delivery city NAME to numeric cityId ──
    // Leopard requires numeric city IDs (integers), NOT city name strings.
    // PostEx accepts city name strings directly.
    let resolvedDeliveryCity = deliveryCity
    if (providerKey === 'leopard') {
      const cityRecord = await db.courierOperationalCity.findFirst({
        where: {
          providerKey: 'leopard',
          cityName: { equals: deliveryCity, mode: 'insensitive' },
          isDeliveryCity: true,
        },
        select: { cityId: true },
      })
      if (!cityRecord?.cityId) {
        const reason = `Could not resolve city "${deliveryCity}" to a Leopard numeric city ID. Sync Leopard cities first.`
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
      resolvedDeliveryCity = cityRecord.cityId // numeric ID as string
    }

    // ── Build the BookShipmentInput ──
    const bookInput: BookShipmentInput = {
      orderNumber: orderRefNumber,
      recipientName: customerName,
      recipientPhone: customerPhone,
      deliveryAddress,
      deliveryCity: resolvedDeliveryCity, // numeric ID for Leopard, name for PostEx
      pickupLocationAddress: '',
      pickupLocationCity: '',
      weightGrams: Math.round(weightResult.totalWeightKg * 1000), // KG → grams
      codAmount,
      itemDescription,
      pickupAddressCode,
      orderType,
      quantity: order.items.reduce((sum, i) => sum + i.quantity, 0),
      transactionNotes,
    }

    // ── Call the courier adapter ──
    // executeLoggedIntegrationAction wraps the adapter call AND does an
    // awaited DB write (integration_action_logs insert) in its finally
    // block. To isolate the EXTERNAL API call time from the log write, we
    // measure the adapter call separately from the wrapper.
    const credentials = decryptCredentials(integration.credentialsEncrypted!)
    const adapter = getCourierAdapter(providerKey, credentials)

    // Measure the adapter call (external API) in isolation
    mark('adapterCallStart')
    let adapterResult: BookShipmentResult
    try {
      adapterResult = await adapter.bookShipment(bookInput)
    } catch (err) {
      mark('adapterCallEnd')
      measure('adapterCallStart', 'adapterCallEnd', '7_external_api_call')
      T['7_external_api_call'] = marks['adapterCallEnd'] - marks['adapterCallStart']
      throw err
    }
    mark('adapterCallEnd')
    measure('adapterCallStart', 'adapterCallEnd', '7_external_api_call')

    // Now wrap in the logged action — but the fn is a no-op since we
    // already called the adapter. We pass the captured result so the
    // logged-call wrapper only does its DB write (timing it separately).
    mark('loggedActionWriteStart')
    const bookResult = await executeLoggedIntegrationAction<BookShipmentResult>({
      companyIntegrationId: integration.id,
      organizationId: ctx.company.organizationId,
      actionType: 'book_shipment',
      direction: 'outbound',
      relatedEntityType: 'order',
      relatedEntityId: orderId,
      fn: async () => adapterResult,
    })
    mark('loggedActionWriteEnd')
    measure('loggedActionWriteStart', 'loggedActionWriteEnd', '8_action_log_write')

    if (!bookResult.success || !bookResult.trackingNumber) {
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

    // ── Map the providerStatus to canonical courierSubStatus ──
    // Provider-agnostic: PostEx uses mapPostExStatus, Leopard uses a simpler
    // mapping (just 'Booked' → null for now, since Leopard doesn't return a
    // meaningful initial sub-status; Prompt 7 will add the full status map).
    let mappedBookingStatus: { courierSubStatus: string | null } | null = null
    if (bookResult.providerStatus && providerKey === 'postex') {
      const { mapPostExStatus } = await import('@/lib/integrations/couriers/postex.status-map')
      mappedBookingStatus = mapPostExStatus(bookResult.providerStatus)
    } else if (providerKey === 'leopard') {
      // Leopard returns 'Booked' as the initial status — map to 'slip_generated'
      // (the canonical sub-status for "booked but not yet pickup_requested")
      mappedBookingStatus = { courierSubStatus: 'slip_generated' }
    }

    // ── Download the slip_link if provided (Leopard-specific) ──
    // Store our own copy — don't trust external courier URLs long-term.
    let courierSlipStoragePath: string | null = null
    if (bookResult.slipLink) {
      try {
        const fs = await import('fs/promises')
        const path = await import('path')
        const dir = path.join(process.cwd(), 'public', 'uploads', 'courier-slips', ctx.company.id)
        await fs.mkdir(dir, { recursive: true })
        const filename = `slip-${order.flowopsOrderNumber}-${Date.now()}.pdf`
        const filepath = path.join(dir, filename)
        const slipResponse = await fetch(bookResult.slipLink)
        if (slipResponse.ok) {
          const arrayBuffer = await slipResponse.arrayBuffer()
          await fs.writeFile(filepath, Buffer.from(arrayBuffer))
          courierSlipStoragePath = `/uploads/courier-slips/${ctx.company.id}/${filename}`
        }
      } catch (slipErr) {
        console.error('[booking] Failed to download courier slip:', slipErr)
        // Non-fatal — booking still succeeded
      }
    }

    mark('orderUpdateStart')
    await db.order.update({
      where: { id: orderId },
      data: {
        courierCompanyIntegrationId: integration.id,
        trackingNumber: bookResult.trackingNumber,
        courierCityStatus: 'matched',
        courierSubStatus: mappedBookingStatus?.courierSubStatus ?? null,
        courierName: integration.provider.providerName,
        courierBookingStatus: 'booked',
        courierBookingFailureReason: null,
        // Store our own copy of the courier slip PDF (if downloaded)
        ...(courierSlipStoragePath ? { courierSlipStoragePath } : {}),
        // Persist the (possibly corrected) delivery city + address on the order
        deliveryCity: resolvedDeliveryCity || deliveryCity,
        ...(deliveryAddress ? { deliveryAddress } : {}),
      },
    })
    mark('orderUpdateEnd')
    measure('orderUpdateStart', 'orderUpdateEnd', '9_order_update')

    // ── Propagate city correction back to the customer's saved address ──
    // If the city was corrected during booking (e.g., via the mismatch
    // resolver or manual override), and the order used a SAVED customer
    // address (usedCustomerAddressId is non-null), update that
    // CustomerAddress row so the corrected city shows up on future orders
    // for this customer — the same correction won't need to be repeated.
    // If the order used a one-off address (usedCustomerAddressId is null),
    // skip propagation — we only fix the order's own address (above).
    if (order.usedCustomerAddressId && resolvedDeliveryCity) {
      db.customerAddress.update({
        where: { id: order.usedCustomerAddressId },
        data: { city: resolvedDeliveryCity },
      }).catch(() => {
        // Non-fatal: if this fails, the order is still booked successfully.
      })
    }

    // Audit log (fire-and-forget — see src/lib/audit.ts)
    mark('auditMetricStart')
    insertAuditLog({
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
        slipLink: bookResult.slipLink ?? null,
        courierSlipStoragePath,
      },
    })
    mark('auditMetricEnd')
    measure('auditMetricStart', 'auditMetricEnd', '10_audit_metric')

    // ════════════════════════════════════════════════════════════════
    // LOG THE TIMING BREAKDOWN
    // ════════════════════════════════════════════════════════════════
    const totalMs = Date.now() - flowStart
    const codebaseMs = totalMs - (T['7_external_api_call'] ?? 0)
    console.log(JSON.stringify({
      __BOOKING_TIMING__: true,
      orderId,
      orderNumber: order.flowopsOrderNumber,
      provider: providerKey,
      steps_ms: T,
      external_api_ms: T['7_external_api_call'] ?? 0,
      codebase_ms: codebaseMs,
      total_ms: totalMs,
    }))

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
    console.error(JSON.stringify({
      __BOOKING_TIMING_ERROR__: true,
      orderId,
      steps_ms: T,
      total_ms: Date.now() - flowStart,
      error: reason,
    }))
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
      insertMetricEvent({
        companyId: ctx.company.id,
        entityType: 'order',
        entityId: orderId,
        metricKey: 'order.auto_booked',
        numericValue: 1,
        dimensions: { provider: 'postex', mode: 'automatic' },
      })
    } else {
      // Metric event for failed auto-booking
      insertMetricEvent({
        companyId: ctx.company.id,
        entityType: 'order',
        entityId: orderId,
        metricKey: 'order.auto_booking_failed',
        numericValue: 1,
        dimensions: { reason: result.error?.slice(0, 100) ?? 'unknown' },
      })
    }

    return result
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Auto-booking failed',
    }
  }
}
