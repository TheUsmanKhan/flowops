/**
 * PostEx Courier Adapter — REAL implementation.
 *
 * Replaces the previous stub. Implements all required CourierAdapter methods
 * plus the optional capabilities (fetchOperationalCities, createPickupAddress,
 * fetchExistingPickupAddresses, trackBulkShipments, generateLoadSheet).
 *
 * Base URL: https://api.postex.pk/services/integration/api/order/
 * Auth: single `token` header.
 *
 * CONFIRMED via live Postman testing:
 *   - Order Creation API (v3/create-order) matches PDF documentation exactly.
 *   - NO weight/handling/itemsQty/paymentMethod/orderTags fields exist in this API.
 *   - Available order types: "Normal", "Reversed", "Replacement", "Overland".
 *   - "Reversed" must NEVER be used — no code path generates this value.
 *   - PostEx does NOT support webhooks — use polling instead.
 *   - PostEx does NOT provide a rate calculation API.
 *
 * Every network call goes through executeLoggedIntegrationAction() via the
 * caller (the caller wraps the adapter call). The adapter itself is a thin
 * API wrapper — it makes the HTTP request and parses the response, nothing more.
 */

import type {
  CourierAdapter,
  BookShipmentInput,
  BookShipmentResult,
  TrackShipmentResult,
  CancelShipmentResult,
  CalculateRateInput,
  CalculateRateResult,
  ParseStatusWebhookResult,
  OperationalCity,
  PickupAddressInput,
  PickupAddressResult,
} from '../types'
import { mapPostExStatus } from './postex.status-map'

const POSTEX_BASE_URL = 'https://api.postex.pk/services/integration/api/order'

// ──────────────────────────────────────────────────────────────
// Phone format conversion helper
// ──────────────────────────────────────────────────────────────

/**
 * Convert a Pakistani phone number to PostEx's required format: 03XXXXXXXXX.
 *
 * PostEx's API requires customerPhone in format "03xxxxxxxxx" (11 digits,
 * starting with 03). Our CRM stores phones in E.164 format (+92XXXXXXXXXX).
 *
 * Conversion rules:
 *   +92 3XX XXXXXXX → 03XX XXXXXXX  (strip +92, prepend 0)
 *   92 3XX XXXXXXX  → 03XX XXXXXXX  (strip 92, prepend 0)
 *   03XXXXXXXXX     → 03XXXXXXXXX  (already correct)
 *   3XXXXXXXXX      → 03XXXXXXXXX  (prepend 0)
 *   Anything else   → return as-is (let PostEx validate/reject)
 */
function convertToPostExPhone(phone: string): string {
  const trimmed = phone.trim()

  // Already in 03XXXXXXXXX format
  if (/^03\d{9}$/.test(trimmed)) {
    return trimmed
  }

  // +92 3XX... → 03XX...
  if (trimmed.startsWith('+92')) {
    const rest = trimmed.substring(3) // remove +92
    if (rest.startsWith('3')) {
      return '0' + rest
    }
    return '0' + rest // fallback
  }

  // 92 3XX... → 03XX...
  if (trimmed.startsWith('92') && trimmed.length >= 11) {
    const rest = trimmed.substring(2) // remove 92
    if (rest.startsWith('3')) {
      return '0' + rest
    }
    return '0' + rest
  }

  // 3XX... (missing leading 0) → 03XX...
  if (/^3\d{9}$/.test(trimmed)) {
    return '0' + trimmed
  }

  // Unknown format — return as-is, let PostEx validate
  return trimmed
}

// ──────────────────────────────────────────────────────────────
// PostEx API response types (internal)
// ──────────────────────────────────────────────────────────────

interface PostExApiResponse<T = unknown> {
  statusCode: string | number
  statusMessage: string
  dist?: T
}

interface PostExCreateOrderDist {
  trackingNumber: string
  orderStatus: string
  orderDate: string
}

interface PostExTrackOrderDist {
  trackingNumber: string
  transactionStatus: string
  transactionStatusHistory?: Array<{
    transactionStatusMessage: string
    transactionStatusMessageCode: string
  }>
  [key: string]: unknown
}

interface PostExBulkTrackItem {
  trackingNumber: string
  trackingResponse: PostExTrackOrderDist | null
  message: string
}

interface PostExOperationalCity {
  operationalCityName: string
  countryName: string
  isPickupCity: string | boolean
  isDeliveryCity: string | boolean
}

interface PostExMerchantAddress {
  phone1: string
  phone2: string
  contactPersonName: string
  cityName: string
  address: string
  addressCode: string
}

// ──────────────────────────────────────────────────────────────
// PostEx Adapter
// ──────────────────────────────────────────────────────────────

export class PostExAdapter implements CourierAdapter {
  constructor(private readonly credentials: Record<string, string>) {}

  private get token(): string {
    const token = this.credentials.token
    if (!token) {
      throw new Error('PostEx adapter requires a "token" credential.')
    }
    return token
  }

  // ──────────────────────────────────────────────────────────────
  // 1. bookShipment — POST v3/create-order
  // ──────────────────────────────────────────────────────────────

  async bookShipment(input: BookShipmentInput): Promise<BookShipmentResult> {
    // NOTE: City validation is handled by the CALLER (booking-workbench/book
    // route or the auto-booking server action) via revalidateCityAtBookingTime()
    // with the companyIntegrationId — which enables the live PostEx fallback.
    // The adapter doesn't have the integration ID, so it can't do the live
    // fallback. We trust the caller's pre-validation.

    // Build the request body — ONLY fields that exist in the confirmed API.
    // NO weight/handling/itemsQty/paymentMethod/orderTags fields.
    const body: Record<string, unknown> = {
      cityName: input.deliveryCity,
      customerName: input.recipientName,
      customerPhone: convertToPostExPhone(input.recipientPhone),
      deliveryAddress: input.deliveryAddress,
      invoiceDivision: 1, // default 1 (split airway bills for larger orders)
      invoicePayment: input.codAmount,
      items: input.quantity ?? 1,
      orderDetail: input.itemDescription || 'Order',
      orderRefNumber: input.orderNumber,
      orderType: input.orderType ?? 'Normal',
      transactionNotes: input.transactionNotes ?? '',
      pickupAddressCode: input.pickupAddressCode ?? '',
    }
    // NOTE: storeAddressCode is intentionally OMITTED. Sending it (even as
    // empty string) causes PostEx to validate it and reject with
    // "INVALID MERCHANT STORE ADDRESS CODE". PostEx uses its default store
    // address when the field is absent.

    const response = await fetch(`${POSTEX_BASE_URL}/v3/create-order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        token: this.token,
      },
      body: JSON.stringify(body),
    })

    const json: PostExApiResponse<PostExCreateOrderDist> = await response.json()

    if (json.statusCode === 200 || json.statusCode === '200') {
      const trackingNumber = json.dist?.trackingNumber
      if (!trackingNumber) {
        return {
          success: false,
          error: 'PostEx returned success but no tracking number in response.',
          rawResponse: json,
        }
      }

      return {
        success: true,
        trackingNumber,
        providerStatus: json.dist?.orderStatus ?? 'Unbooked',
        rawResponse: json,
      }
    }

    return {
      success: false,
      error: json.statusMessage || `PostEx API returned statusCode ${json.statusCode}`,
      rawResponse: json,
    }
  }

  // ──────────────────────────────────────────────────────────────
  // 2. trackShipment — GET v1/track-order/{trackingNumber}
  // ──────────────────────────────────────────────────────────────

  async trackShipment(trackingNumber: string): Promise<TrackShipmentResult> {
    const response = await fetch(
      `${POSTEX_BASE_URL}/v1/track-order/${encodeURIComponent(trackingNumber)}`,
      {
        method: 'GET',
        headers: {
          token: this.token,
        },
      },
    )

    const json: PostExApiResponse<PostExTrackOrderDist> = await response.json()

    if (json.statusCode === 200 || json.statusCode === '200') {
      const dist = json.dist
      if (!dist) {
        return {
          success: false,
          error: 'PostEx returned success but no dist in response.',
          rawResponse: json,
        }
      }

      const postexStatus = dist.transactionStatus || 'Unbooked'
      const mapped = mapPostExStatus(postexStatus)

      // Map to the generic TrackShipmentResult status enum
      let genericStatus: TrackShipmentResult['status'] = 'booked'
      if (mapped.triggerDelivered) genericStatus = 'delivered'
      else if (mapped.triggerRto) genericStatus = 'returned'
      else if (mapped.triggerDispatch) genericStatus = 'in_transit'
      else if (mapped.orderStatus === 'cancelled') genericStatus = 'failed' // reuse 'failed' for cancelled-by-merchant/expired

      return {
        success: true,
        status: genericStatus,
        lastUpdateAt: (dist.transactionDate as string) ?? undefined,
        rawResponse: {
          ...dist, // includes transactionStatusHistory for audit/display
          mappedSubStatus: mapped.courierSubStatus,
          needsShipperAdvice: mapped.needsShipperAdvice,
          unrecognized: mapped.unrecognized,
        },
      }
    }

    return {
      success: false,
      error: json.statusMessage || `PostEx API returned statusCode ${json.statusCode}`,
      rawResponse: json,
    }
  }

  // ──────────────────────────────────────────────────────────────
  // 3. trackBulkShipments — GET v1/track-bulk-order
  // ──────────────────────────────────────────────────────────────

  async trackBulkShipments(trackingNumbers: string[]): Promise<TrackShipmentResult[]> {
    if (trackingNumbers.length === 0) return []

    // Chunk into groups of 50 (default — PostEx docs don't specify a limit,
    // but 50 is a reasonable batch size to avoid URL length issues)
    const CHUNK_SIZE = 50
    const results: TrackShipmentResult[] = []

    for (let i = 0; i < trackingNumbers.length; i += CHUNK_SIZE) {
      const chunk = trackingNumbers.slice(i, i + CHUNK_SIZE)

      // PostEx's bulk tracking API uses GET with query params.
      // The parameter name is "TrackingNumbers" (capital T, capital N)
      // — confirmed from the live API error message:
      // "Required List parameter 'TrackingNumbers' is not present"
      const queryString = chunk.map((t) => `TrackingNumbers=${encodeURIComponent(t)}`).join('&')

      const response = await fetch(
        `${POSTEX_BASE_URL}/v1/track-bulk-order?${queryString}`,
        {
          method: 'GET',
          headers: {
            token: this.token,
          },
        },
      )

      const json: PostExApiResponse<PostExBulkTrackItem[]> = await response.json()

      if (json.statusCode === 200 || json.statusCode === '200') {
        const dist = json.dist ?? []
        for (const item of dist) {
          if (!item.trackingResponse) {
            results.push({
              success: false,
              error: item.message || 'No tracking response for this number.',
              rawResponse: item,
            })
            continue
          }

          const postexStatus = item.trackingResponse.transactionStatus || 'Unbooked'
          const mapped = mapPostExStatus(postexStatus)

          let genericStatus: TrackShipmentResult['status'] = 'booked'
          if (mapped.triggerDelivered) genericStatus = 'delivered'
          else if (mapped.triggerRto) genericStatus = 'returned'
          else if (mapped.triggerDispatch) genericStatus = 'in_transit'
          else if (mapped.orderStatus === 'cancelled') genericStatus = 'failed' // cancelled-by-merchant/expired

          results.push({
            success: true,
            status: genericStatus,
            lastUpdateAt: (item.trackingResponse.transactionDate as string) ?? undefined,
            rawResponse: {
              ...item.trackingResponse,
              mappedSubStatus: mapped.courierSubStatus,
              needsShipperAdvice: mapped.needsShipperAdvice,
              unrecognized: mapped.unrecognized,
            },
          })
        }
      } else {
        // API error for this chunk — add error results for all tracking numbers in the chunk
        for (const _tn of chunk) {
          results.push({
            success: false,
            error: json.statusMessage || `PostEx bulk API returned statusCode ${json.statusCode}`,
            rawResponse: json,
          })
        }
      }
    }

    return results
  }

  // ──────────────────────────────────────────────────────────────
  // 4. cancelShipment — PUT v1/cancel-order
  // ──────────────────────────────────────────────────────────────

  async cancelShipment(trackingNumber: string): Promise<CancelShipmentResult> {
    // NOTE: Only meaningful while PostEx status is Unbooked or Booked (per
    // confirmed cancel-window rule). The CALLER is responsible for checking
    // this before invoking — this adapter is a thin API wrapper.
    const response = await fetch(`${POSTEX_BASE_URL}/v1/cancel-order`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        token: this.token,
      },
      body: JSON.stringify({ trackingNumber }),
    })

    if (response.status === 200) {
      return { success: true }
    }

    if (response.status === 404) {
      return { success: false, error: 'Order not found on PostEx.' }
    }

    let errorMessage = `PostEx cancel API returned HTTP ${response.status}`
    try {
      const json = await response.json()
      errorMessage = json.statusMessage || errorMessage
    } catch {
      // Response body not JSON — use the HTTP status message
    }

    return { success: false, error: errorMessage }
  }

  // ──────────────────────────────────────────────────────────────
  // 5. calculateRate — NOT SUPPORTED
  // ──────────────────────────────────────────────────────────────

  async calculateRate(_input: CalculateRateInput): Promise<CalculateRateResult> {
    throw new Error('PostEx does not provide a rate calculation API.')
  }

  // ──────────────────────────────────────────────────────────────
  // 6. parseStatusWebhook / verifyWebhookSignature — NOT SUPPORTED
  // ──────────────────────────────────────────────────────────────

  async parseStatusWebhook(_rawPayload: unknown): Promise<ParseStatusWebhookResult> {
    throw new Error('PostEx does not support webhooks — use polling instead.')
  }

  async verifyWebhookSignature(
    _rawBody: string,
    _signatureHeader: string | null,
    _webhookSecret: string,
  ): Promise<boolean> {
    throw new Error('PostEx does not support webhooks — use polling instead.')
  }

  // ──────────────────────────────────────────────────────────────
  // 7. fetchOperationalCities — GET v2/get-operational-city
  // ──────────────────────────────────────────────────────────────

  /**
   * Fetch ALL operational cities from PostEx.
   *
   * PostEx's v2/get-operational-city endpoint accepts an optional
   * `operationalCityType` query param (Pickup | Delivery | null), but in
   * practice PostEx's API returns errors ("statusCode undefined") when this
   * param is set. Only the unfiltered call (no param) works reliably.
   *
   * We make a SINGLE unfiltered call with a 30-second timeout. This returns
   * all cities with their isPickupCity/isDeliveryCity flags already set.
   */
  async fetchOperationalCities(): Promise<OperationalCity[]> {
    const url = `${POSTEX_BASE_URL}/v2/get-operational-city`

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { token: this.token },
        signal: controller.signal,
      })
      const json: PostExApiResponse<PostExOperationalCity[]> = await response.json()

      if (json.statusCode === 200 || json.statusCode === '200') {
        const dist = json.dist ?? []
        if (dist.length === 0) {
          throw new Error('PostEx cities API returned 0 cities. Check the integration token.')
        }
        return dist.map((c) => ({
          cityName: c.operationalCityName,
          cityId: undefined,
          isPickupCity: c.isPickupCity === true || c.isPickupCity === 'true',
          isDeliveryCity: c.isDeliveryCity === true || c.isDeliveryCity === 'true',
        }))
      }

      throw new Error(
        json.statusMessage || `PostEx cities API returned statusCode ${json.statusCode}`,
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  // ──────────────────────────────────────────────────────────────
  // 7b. pingConnection — read-only connectivity check (test route)
  // ──────────────────────────────────────────────────────────────

  /**
   * Lightweight read-only connectivity check used by the "Test Connection"
   * button. Calls fetchOperationalCities() — the cheapest read-only PostEx
   * endpoint that validates the integration token without making any
   * state-changing call.
   *
   * PostEx does NOT offer a dedicated "ping" endpoint, and calculateRate()
   * is unsupported (throws by design). The cities endpoint is the lightest
   * available read-only call. We don't need the full city list for a
   * connectivity check, but PostEx's API returns the full list regardless
   * of params, so we just verify the response is non-empty (a 0-city
   * response indicates an invalid token per PostEx's behavior).
   *
   * Returns { success: true } on a valid connection, { success: false, error }
   * with a user-facing message otherwise.
   */
  async pingConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const cities = await this.fetchOperationalCities()
      if (cities.length === 0) {
        return {
          success: false,
          error: 'PostEx accepted the token but returned 0 cities. The token may be valid but the account may have no cities enabled.',
        }
      }
      return { success: true }
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : 'PostEx connectivity check failed.',
      }
    }
  }

  // ──────────────────────────────────────────────────────────────
  // 8. createPickupAddress — POST v2/create-merchant-address
  // ──────────────────────────────────────────────────────────────

  async createPickupAddress(input: PickupAddressInput): Promise<PickupAddressResult> {
    const body = {
      address: input.address,
      addressTypeId: 2, // 2 = Pickup (1 = Return, but PostEx uses one address for both)
      cityName: input.cityName,
      contactPersonName: input.contactPersonName,
      phone1: input.phone1,
      phone2: input.phone2 ?? '',
      phone3: '', // optional
      wareHouseManagerName: '', // optional
    }

    const response = await fetch(
      `${POSTEX_BASE_URL}/v2/create-merchant-address`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          token: this.token,
        },
        body: JSON.stringify(body),
      },
    )

    const json: PostExApiResponse = await response.json()

    if (json.statusCode === 200 || json.statusCode === '200') {
      // PostEx's create-merchant-address API returns only statusCode + statusMessage.
      // It does NOT return an addressCode in the response. The addressCode is
      // obtained by subsequently calling fetchExistingPickupAddresses() and
      // matching by address/cityName. For now, return success without a code —
      // the caller (addPickupAddress server action) handles this by falling back
      // to a local ID or prompting the user to fetch existing addresses.
      return {
        success: true,
        providerAddressCode: undefined, // PostEx doesn't return it on creation
      }
    }

    return {
      success: false,
      error: json.statusMessage || `PostEx create-address API returned statusCode ${json.statusCode}`,
    }
  }

  // ──────────────────────────────────────────────────────────────
  // 9. fetchExistingPickupAddresses — GET v1/get-merchant-address
  // ──────────────────────────────────────────────────────────────

  async fetchExistingPickupAddresses(): Promise<Array<{
    providerAddressCode: string
    label?: string
    address: string
    cityName: string
    contactPersonName: string
    phone1: string
    phone2?: string
  }>> {
    const response = await fetch(
      `${POSTEX_BASE_URL}/v1/get-merchant-address`,
      {
        method: 'GET',
        headers: {
          token: this.token,
        },
      },
    )

    const json: PostExApiResponse<PostExMerchantAddress[]> = await response.json()

    if (json.statusCode === 200 || json.statusCode === '200') {
      const dist = json.dist ?? []
      return dist.map((a) => ({
        providerAddressCode: a.addressCode,
        label: a.address, // use the address as the label (PostEx doesn't return a label)
        address: a.address,
        cityName: a.cityName,
        contactPersonName: a.contactPersonName,
        phone1: a.phone1,
        phone2: a.phone2 || undefined,
      }))
    }

    throw new Error(
      json.statusMessage || `PostEx get-merchant-address API returned statusCode ${json.statusCode}`,
    )
  }

  // ──────────────────────────────────────────────────────────────
  // 10. generateLoadSheet — POST v2/generate-load-sheet
  // ──────────────────────────────────────────────────────────────

  async generateLoadSheet(
    trackingNumbers: string[],
    pickupAddress?: string,
  ): Promise<{ success: boolean; rawResponse?: unknown; error?: string }> {
    if (trackingNumbers.length === 0) {
      return { success: false, error: 'No tracking numbers provided.' }
    }

    const body = {
      pickupAddress: pickupAddress ?? '',
      trackingNumbers,
    }

    const response = await fetch(
      `${POSTEX_BASE_URL}/v2/generate-load-sheet`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          token: this.token,
        },
        body: JSON.stringify(body),
      },
    )

    // PostEx returns a PDF file for this endpoint, not JSON.
    if (response.status === 200) {
      // The response is a PDF binary — we can't parse it as JSON.
      // Return success with metadata about the response.
      return {
        success: true,
        rawResponse: {
          contentType: response.headers.get('content-type'),
          contentLength: response.headers.get('content-length'),
          status: response.status,
        },
      }
    }

    return {
      success: false,
      error: `PostEx load-sheet API returned HTTP ${response.status}`,
    }
  }

  // ──────────────────────────────────────────────────────────────
  // 11. fetchPaymentStatus — GET v1/payment-status/{trackingNumber}
  // ──────────────────────────────────────────────────────────────

  /**
   * Fetch the payment/settlement status for a tracking number.
   *
   * PostEx's Payment Status API response:
   *   { statusCode, statusMessage, dist: { orderRefNumber, trackingNumber,
   *     settle (boolean), settlementDate, upfrontPaymentDate,
   *     cprNumber_1, reservePaymentDate, cprNumber_2 } }
   *
   * IMPORTANT: PostEx's Payment Status API does NOT break out delivery charge
   * as a separate field. It only provides settlement status (boolean), dates,
   * and CPR numbers. The `actualDeliveryCharge` field on Order/exchange_shipments
   * CANNOT be auto-populated from this API — it would need to come from a
   * different source (e.g. manual entry or a reconciliation report).
   */
  async fetchPaymentStatus(trackingNumber: string): Promise<{
    success: boolean
    settled: boolean
    settlementDate: string | null
    upfrontPaymentDate: string | null
    cprNumber1: string | null
    cprNumber2: string | null
    error?: string
  }> {
    const response = await fetch(
      `${POSTEX_BASE_URL}/v1/payment-status/${encodeURIComponent(trackingNumber)}`,
      {
        method: 'GET',
        headers: {
          token: this.token,
        },
      },
    )

    if (response.status === 404) {
      return { success: false, settled: false, settlementDate: null, upfrontPaymentDate: null, cprNumber1: null, cprNumber2: null, error: 'Order not found on PostEx.' }
    }

    const json: PostExApiResponse<{
      orderRefNumber: string
      trackingNumber: string
      settle: boolean
      settlementDate: string
      upfrontPaymentDate: string
      cprNumber_1: string
      reservePaymentDate: string
      cprNumber_2: string
    }> = await response.json()

    if (json.statusCode === 200 || json.statusCode === '200') {
      const dist = json.dist
      return {
        success: true,
        settled: dist?.settle ?? false,
        settlementDate: dist?.settlementDate ?? null,
        upfrontPaymentDate: dist?.upfrontPaymentDate ?? null,
        cprNumber1: dist?.cprNumber_1 ?? null,
        cprNumber2: dist?.cprNumber_2 ?? null,
      }
    }

    return {
      success: false,
      settled: false,
      settlementDate: null,
      upfrontPaymentDate: null,
      cprNumber1: null,
      cprNumber2: null,
      error: json.statusMessage || `PostEx payment-status API returned statusCode ${json.statusCode}`,
    }
  }
}
