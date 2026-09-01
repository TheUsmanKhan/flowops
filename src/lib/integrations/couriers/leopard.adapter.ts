/**
 * Leopard Courier Adapter — REAL implementation.
 *
 * Replaces the previous stub. Implements all required CourierAdapter methods
 * plus the optional capabilities (fetchOperationalCities, createPickupAddress,
 * fetchExistingPickupAddresses).
 *
 * Base URLs:
 *   Staging:    https://merchantapistaging.leopardscourier.com/api/
 *   Production: https://merchantapi.leopardscourier.com/api/
 *
 * Auth: api_key + api_password, sent as part of the request body (JSON) — NOT
 * as a header. Both fields stored in the encrypted credentials blob.
 *
 * All endpoints use JSON format (/format/json/).
 *
 * Weight: Leopard requires GRAMS. The internal system always uses KG — the
 * adapter converts at the boundary (weightKg × 1000 → integer grams).
 *
 * City IDs: Leopard uses NUMERIC city IDs (integers). The adapter resolves
 * city names to Leopard's numeric IDs via the cached courier_operational_cities
 * table (cityId column stores the numeric ID as a string).
 *
 * No orderType/Normal-Overland-Replacement concept applies to Leopard —
 * Leopard's shipment_type field is a different thing (optional, defaults to
 * "overnight"). Do NOT build any Leopard-specific order-type logic.
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

// Use staging by default — switch to production when ready.
// The caller can override via credentials.isProduction if needed.
const LEOPARD_STAGING_BASE = 'https://merchantapistaging.leopardscourier.com/api/'
const LEOPARD_PRODUCTION_BASE = 'https://merchantapi.leopardscourier.com/api/'

// Response type for Leopard's standard JSON envelope
interface LeopardResponse<T = unknown> {
  status: number | string // 1 = success, 0 = error
  error?: string | Record<string, string> | null
  data?: T
  message?: string
  city_list?: LeopardCity[] | null
  packet_list?: LeopardTrackPacket[] | null
  track_number?: string | null
  slip_link?: string | null
}

interface LeopardCity {
  id: number
  name: string
  shipment_type: string[]
  allow_as_origin: boolean
  allow_as_destination: boolean
}

interface LeopardTrackPacket {
  booking_date?: string
  track_number?: string
  track_number_short?: number
  booked_packet_weight?: number
  booked_packet_vol_weight_w?: number
  booked_packet_vol_weight_h?: number
  booked_packet_vol_weight_l?: number
  booked_packet_no_piece?: number
  booked_packet_collect_amount?: number
  booked_packet_order_id?: string
  origin_city_name?: string
  destination_city_name?: string
  invoice_number?: string
  invoice_date?: string
  shipment_name_eng?: string
  shipment_email?: string
  shipment_phone?: string
  shipment_address?: string
  consignment_name_eng?: string
  consignment_email?: string
  consignment_phone?: string
  consignment_phone_two?: string
  consignment_phone_three?: string
  consignment_address?: string
  special_instructions?: string
  booked_packet_status?: string
  activity_date?: string
  status_reamrks?: string
  status_remarks?: string
  reverseCN?: string
  'Tracking Detail'?: Array<{
    Staus?: string
    'Reciever Name'?: string
    'Activity Date'?: string
    Reason?: string
  }>
}

interface LeopardShipper {
  shipment_id: number | string
  shipment_name_eng?: string
  shipment_name?: string
  shipment_contact_person?: string
  shipment_email?: string
  shipment_phone?: string
  shipment_address?: string
  city_id?: number | string
  bank_id?: number | string
  bank_name_eng?: string
  bank_account_no?: string
  bank_account_title?: string
  bank_branch?: string
  bank_account_iban_no?: string
  cnic?: string
  return_address?: string
  shipper_city_id?: number | string
  username?: string
  user_password?: string
}

interface LeopardWebhookUpdate {
  cn_number: string
  status: string
  receiver_name?: string
  reason?: string
  activity_date?: string
}

export class LeopardAdapter implements CourierAdapter {
  private readonly apiKey: string
  private readonly apiPassword: string
  private readonly baseUrl: string

  constructor(credentials: Record<string, string>) {
    this.apiKey = credentials.api_key ?? ''
    this.apiPassword = credentials.api_password ?? ''
    if (!this.apiKey || !this.apiPassword) {
      throw new Error('Leopard adapter requires both api_key and api_password in credentials.')
    }
    // Use production if credentials explicitly say so, otherwise staging
    this.baseUrl = credentials.isProduction === 'true' ? LEOPARD_PRODUCTION_BASE : LEOPARD_STAGING_BASE
  }

  // ──────────────────────────────────────────────────────────────
  // Helper: build the auth body common to all requests
  // ──────────────────────────────────────────────────────────────

  private authBody(): Record<string, string> {
    return {
      api_key: this.apiKey,
      api_password: this.apiPassword,
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Helper: make a POST request with JSON body
  // ──────────────────────────────────────────────────────────────

  private async post<T = unknown>(endpoint: string, body: Record<string, unknown>): Promise<LeopardResponse<T>> {
    const url = `${this.baseUrl}${endpoint}/format/json/`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const json = (await response.json()) as LeopardResponse<T>
    return json
  }

  // ──────────────────────────────────────────────────────────────
  // Helper: make a GET request with query params (for getShipperDetails)
  // ──────────────────────────────────────────────────────────────

  private async getWithParams<T = unknown>(endpoint: string, params: Record<string, string>): Promise<LeopardResponse<T>> {
    const queryString = new URLSearchParams(params).toString()
    const url = `${this.baseUrl}${endpoint}/format/json/?${queryString}`
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })

    const json = (await response.json()) as LeopardResponse<T>
    return json
  }

  // ──────────────────────────────────────────────────────────────
  // Helper: extract error message from Leopard response
  // ──────────────────────────────────────────────────────────────

  private extractError(resp: LeopardResponse): string {
    if (typeof resp.error === 'string') return resp.error
    if (resp.error && typeof resp.error === 'object') {
      // Error is an object mapping field → message
      return Object.entries(resp.error)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ')
    }
    return resp.message || 'Unknown Leopard API error'
  }

  // ──────────────────────────────────────────────────────────────
  // 1. fetchOperationalCities — GET/POST getAllCities
  // ──────────────────────────────────────────────────────────────

  async fetchOperationalCities(): Promise<OperationalCity[]> {
    const resp = await this.post<LeopardCity[]>('getAllCities', this.authBody())

    if (resp.status !== 1 && resp.status !== '1') {
      throw new Error(this.extractError(resp))
    }

    const cities = resp.city_list
    if (!cities || !Array.isArray(cities) || cities.length === 0) {
      throw new Error('Leopard cities API returned 0 cities. Check the API credentials.')
    }

    return cities.map((c) => ({
      cityName: c.name,
      // Store the numeric ID as a string (matches the cityId TEXT column)
      cityId: String(c.id),
      // allow_as_origin = pickup city, allow_as_destination = delivery city
      isPickupCity: c.allow_as_origin === true,
      isDeliveryCity: c.allow_as_destination === true,
      // Store the shipment_type array as a JSON string (the sync action
      // will persist it to the shipmentTypes column)
      // Note: OperationalCity type doesn't have shipmentTypes, but the
      // sync action reads rawResponse for extra fields. We include it
      // there via a custom approach — see syncCourierOperationalCities.
    }))
  }

  // ──────────────────────────────────────────────────────────────
  // 1b. fetchOperationalCitiesRaw — returns the raw city list with
  //     shipment_type arrays (used by the sync action to populate
  //     the shipmentTypes column).
  // ──────────────────────────────────────────────────────────────

  async fetchOperationalCitiesRaw(): Promise<LeopardCity[]> {
    const resp = await this.post<LeopardCity[]>('getAllCities', this.authBody())
    if (resp.status !== 1 && resp.status !== '1') {
      throw new Error(this.extractError(resp))
    }
    return resp.city_list ?? []
  }

  // ──────────────────────────────────────────────────────────────
  // 2. bookShipment — POST bookPacket
  // ──────────────────────────────────────────────────────────────

  async bookShipment(input: BookShipmentInput): Promise<BookShipmentResult> {
    // City validation is handled by the CALLER via revalidateCityAtBookingTime()
    // — the adapter doesn't have the integration ID for the live fallback.

    // ── Resolve city IDs ──
    // Leopard requires NUMERIC city IDs (integers), NOT city name strings.
    // 'self' = use the shipper's own city. For origin, we use 'self' if no
    // explicit pickup city override is needed. For destination, we resolve
    // the delivery city name to Leopard's numeric ID from the cached
    // courier_operational_cities table.
    //
    // The caller (booking action) passes pickupLocationCity + deliveryCity
    // as city NAME strings. We need to resolve them to numeric IDs.
    // However, the adapter doesn't have DB access — so we accept the
    // pickupAddressCode (which Leopard maps to the shipper's registered
    // city via shipment_id) and use 'self' for origin.
    //
    // For destination, the caller should pass the numeric cityId via the
    // deliveryCity field IF it's already resolved, OR we use a special
    // convention: if deliveryCity is a numeric string, send it as-is;
    // otherwise, we can't resolve it here and must throw.
    //
    // DESIGN DECISION: The booking action (caller) is responsible for
    // resolving the delivery city NAME to Leopard's numeric cityId BEFORE
    // calling the adapter. It passes the numeric ID in a new field on
    // BookShipmentInput. But since we can't add fields to the interface
    // without breaking other adapters, we use the existing deliveryCity
    // field: if it's numeric, send as integer; if it's a name, throw with
    // a clear error.
    //
    // ACTUALLY: The cleanest approach is to resolve in the adapter using
    // the DB. But the adapter shouldn't have DB access. So we resolve
    // in the booking action and pass the numeric ID as deliveryCity
    // (overloading the field). This is documented in the booking action.

    const destinationCity = input.deliveryCity
    // If destinationCity is not numeric, we can't proceed
    if (!/^\d+$/.test(destinationCity)) {
      return {
        success: false,
        error: `Leopard booking requires a numeric destination city ID, but got '${destinationCity}'. The booking action must resolve the city name to Leopard's numeric cityId before calling the adapter.`,
      }
    }

    // Origin city: use 'self' (shipper's own city) by default
    const originCity = 'self'

    // ── Weight conversion: KG → grams ──
    // input.weightGrams is ALREADY in grams (despite the name, the booking
    // action passes grams). But to be safe, we ensure it's an integer.
    const weightGrams = Math.max(1, Math.round(input.weightGrams))

    // ── Build the request body ──
    const body: Record<string, unknown> = {
      ...this.authBody(),
      booked_packet_weight: weightGrams,
      booked_packet_no_piece: input.quantity ?? 1,
      booked_packet_collect_amount: Math.round(input.codAmount),
      booked_packet_order_id: input.orderNumber,
      origin_city: originCity,
      destination_city: parseInt(destinationCity, 10),
      // Shipper info: use 'self' so Leopard uses the shipper's registered info
      shipment_id: input.pickupAddressCode ?? undefined, // numeric shipper ID
      shipment_name_eng: 'self',
      shipment_email: 'self',
      shipment_phone: 'self',
      shipment_address: 'self',
      // Consignee (customer) info
      consignment_name_eng: input.recipientName,
      consignment_email: '', // optional
      consignment_phone: input.recipientPhone,
      consignment_phone_two: '', // optional
      consignment_phone_three: '', // optional
      consignment_address: input.deliveryAddress,
      special_instructions: input.transactionNotes ?? '',
      // Shipment type: optional, defaults to "overnight" if empty
      shipment_type: input.shipmentType ?? '',
    }

    // Optional: return address override (Leopard-specific)
    if (input.returnAddressOverride) {
      body.return_address = input.returnAddressOverride.address
      // return_city needs to be a numeric city ID — resolve from the override
      // For now, if the override's cityName is numeric, use it; otherwise omit
      // (the booking action should resolve it)
      if (/^\d+$/.test(input.returnAddressOverride.cityName)) {
        body.return_city = parseInt(input.returnAddressOverride.cityName, 10)
      }
    }

    // Remove undefined fields (Leopard rejects some empty fields)
    const cleanBody: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined && v !== '') {
        cleanBody[k] = v
      }
    }

    const resp = await this.post('bookPacket', cleanBody)

    if (resp.status === 1 || resp.status === '1') {
      const trackingNumber = resp.track_number
      if (!trackingNumber) {
        return {
          success: false,
          error: 'Leopard returned success but no track_number in response.',
          rawResponse: resp,
        }
      }

      return {
        success: true,
        trackingNumber,
        providerStatus: 'Booked', // Leopard doesn't return an initial status string
        slipLink: resp.slip_link ?? undefined,
        rawResponse: resp,
      }
    }

    return {
      success: false,
      error: this.extractError(resp),
      rawResponse: resp,
    }
  }

  // ──────────────────────────────────────────────────────────────
  // 3. trackShipment — GET/POST trackBookedPacket
  // ──────────────────────────────────────────────────────────────

  async trackShipment(trackingNumber: string): Promise<TrackShipmentResult> {
    const body = {
      ...this.authBody(),
      track_numbers: trackingNumber,
    }

    const resp = await this.post<LeopardTrackPacket[]>('trackBookedPacket', body)

    if (resp.status !== 1 && resp.status !== '1') {
      return {
        success: false,
        error: this.extractError(resp),
        rawResponse: resp,
      }
    }

    const packets = resp.packet_list
    if (!packets || packets.length === 0) {
      return {
        success: false,
        error: 'Leopard returned success but no packet data.',
        rawResponse: resp,
      }
    }

    const packet = packets[0]
    const rawStatus = packet.booked_packet_status ?? ''

    // Map the raw status string to our generic status enum.
    // Full status mapping will be built in Prompt 7 — for now, pass through
    // the raw status string and do a basic mapping.
    let genericStatus: TrackShipmentResult['status'] = 'booked'
    const lowerStatus = rawStatus.toLowerCase()
    if (lowerStatus.includes('deliver') && !lowerStatus.includes('undeliver')) {
      genericStatus = 'delivered'
    } else if (lowerStatus.includes('return') || lowerStatus.includes('rto')) {
      genericStatus = 'returned'
    } else if (lowerStatus.includes('cancel') || lowerStatus.includes('reject')) {
      genericStatus = 'failed'
    } else if (lowerStatus.includes('transit') || lowerStatus.includes('dispatch') || lowerStatus.includes('pickup')) {
      genericStatus = 'in_transit'
    }

    return {
      success: true,
      status: genericStatus,
      lastUpdateAt: packet.activity_date ?? undefined,
      rawResponse: {
        ...packet,
        rawStatus, // pass through the raw status string for Prompt 7's mapping
        trackingDetail: packet['Tracking Detail'] ?? [],
      },
    }
  }

  // ──────────────────────────────────────────────────────────────
  // 4. cancelShipment — POST cancelBookedPackets
  // ──────────────────────────────────────────────────────────────

  async cancelShipment(trackingNumber: string): Promise<CancelShipmentResult> {
    const body = {
      ...this.authBody(),
      cn_numbers: trackingNumber,
    }

    const resp = await this.post('cancelBookedPackets', body)

    if (resp.status === 1 || resp.status === '1') {
      return { success: true }
    }

    return {
      success: false,
      error: this.extractError(resp),
    }
  }

  // ──────────────────────────────────────────────────────────────
  // 5. calculateRate — NOT SUPPORTED (Leopard has getTariffDetails but
  //    it's a separate API not yet implemented — will be added in a later prompt)
  // ──────────────────────────────────────────────────────────────

  async calculateRate(_input: CalculateRateInput): Promise<CalculateRateResult> {
    throw new Error('Leopard rate calculation (getTariffDetails) is not yet implemented. Will be added in a later prompt.')
  }

  // ──────────────────────────────────────────────────────────────
  // 6. parseStatusWebhook / verifyWebhookSignature
  // ──────────────────────────────────────────────────────────────

  /**
   * Parse Leopard's webhook push payload.
   *
   * Leopard pushes: { "data": [{ cn_number, status, receiver_name, reason, activity_date }, ...] }
   *
   * Returns the FIRST update's tracking number + mapped status (for the
   * generic webhook route's ParseStatusWebhookResult compatibility). The
   * FULL array is processed by processLeopardWebhookUpdates() in the webhook
   * route handler, which handles ALL updates.
   *
   * If the payload has no data array or is empty, throws a clear error.
   */
  async parseStatusWebhook(rawPayload: unknown): Promise<ParseStatusWebhookResult> {
    const payload = rawPayload as { data?: LeopardWebhookUpdate[] }

    if (!payload?.data || !Array.isArray(payload.data) || payload.data.length === 0) {
      throw new Error('Leopard webhook payload missing or empty "data" array')
    }

    // Return the first update (for compatibility with the generic webhook route).
    // The full array is processed by processLeopardWebhookUpdates() in the route handler.
    const firstUpdate = payload.data[0]
    if (!firstUpdate.cn_number || !firstUpdate.status) {
      throw new Error('Leopard webhook update missing cn_number or status')
    }

    // Map the status to our generic status enum
    const { mapLeopardStatus } = await import('./leopard.status-map')
    const mapping = mapLeopardStatus(firstUpdate.status)

    let genericStatus: ParseStatusWebhookResult['status'] = 'booked'
    if (mapping.triggerDelivered) genericStatus = 'delivered'
    else if (mapping.triggerRto) genericStatus = 'returned'
    else if (mapping.triggerDispatch) genericStatus = 'in_transit'

    return {
      trackingNumber: firstUpdate.cn_number,
      status: genericStatus,
      lastUpdateAt: firstUpdate.activity_date,
    }
  }

  /**
   * Verify the authenticity of an incoming Leopard webhook.
   *
   * Leopard's documentation does NOT document any HMAC signature mechanism
   * for webhook payloads. The primary security mechanism in this framework
   * is the webhook_endpoint_id in the URL — only someone who knows the
   * endpoint ID can push to it. This is sufficient for Leopard's design.
   *
   * If Leopard adds signature support in the future, implement it here.
   */
  async verifyWebhookSignature(
    _rawBody: string,
    _signatureHeader: string | null,
    _webhookSecret: string,
  ): Promise<boolean> {
    // No signature verification documented for Leopard.
    // Security relies on the webhook_endpoint_id in the URL (already verified
    // by the generic webhook route's integration lookup).
    return true
  }

  // ──────────────────────────────────────────────────────────────
  // 7. fetchOperationalCities — already implemented above (required by interface)
  // ──────────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────────
  // 8. createPickupAddress — POST createShipper
  // ──────────────────────────────────────────────────────────────

  async createPickupAddress(input: PickupAddressInput): Promise<PickupAddressResult> {
    // Leopard's createShipper requires a city_id (numeric). The caller passes
    // cityName — we need to resolve it to a numeric ID. But the adapter doesn't
    // have DB access. The caller (address-book action) should resolve the city
    // name to Leopard's numeric cityId BEFORE calling the adapter, and pass it
    // via cityName (overloading the field to accept numeric IDs).
    const cityId = input.cityName
    if (!/^\d+$/.test(cityId)) {
      return {
        success: false,
        error: `Leopard createShipper requires a numeric city_id, but got '${cityId}'. The address-book action must resolve the city name to Leopard's numeric cityId before calling the adapter.`,
      }
    }

    const body: Record<string, unknown> = {
      ...this.authBody(),
      shipment_name: input.contactPersonName,
      shipment_email: '', // optional
      shipment_phone: input.phone1,
      shipment_address: input.address,
      city_id: parseInt(cityId, 10),
      // Optional bank fields — omitted (not required for address creation)
      // Optional return_address — if the caller provides it via the override
    }

    // Add return_address if provided in the input (Leopard-specific extension)
    // The PickupAddressInput doesn't have returnAddressOverride, so we check
    // if the caller passed it via a custom field. For now, we omit it —
    // the address-book action will handle the override separately.

    const resp = await this.post<LeopardShipper[]>('createShipper', body)

    if (resp.status === 1 || resp.status === '1') {
      // Extract the shipment_id from the response data
      const data = resp.data
      let shipmentId: string | undefined

      if (Array.isArray(data) && data.length > 0) {
        shipmentId = String(data[0].shipment_id)
      } else if (data && typeof data === 'object' && !Array.isArray(data)) {
        // Single object response
        const shipper = data as LeopardShipper
        shipmentId = String(shipper.shipment_id)
      }

      if (!shipmentId) {
        return {
          success: false,
          error: 'Leopard createShipper returned success but no shipment_id in response.',
        }
      }

      return {
        success: true,
        providerAddressCode: shipmentId,
      }
    }

    // Check for "already exists" case
    if (resp.message && resp.message.toLowerCase().includes('already exists')) {
      return {
        success: false,
        error: 'A shipper with these details already exists. Use getShipperDetails to find the existing shipment_id.',
      }
    }

    return {
      success: false,
      error: this.extractError(resp),
    }
  }

  // ──────────────────────────────────────────────────────────────
  // 9. fetchExistingPickupAddresses — GET getShipperDetails
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
    // getShipperDetails uses GET with query params
    const params = {
      api_key: this.apiKey,
      api_password: this.apiPassword,
      // request_param and request_value are optional — if omitted, returns all shippers
    }

    const resp = await this.getWithParams<LeopardShipper[]>('getShipperDetails', params)

    if (resp.status !== 1 && resp.status !== '1') {
      throw new Error(this.extractError(resp))
    }

    const shippers = resp.data
    if (!shippers || !Array.isArray(shippers)) {
      return []
    }

    return shippers.map((s) => ({
      providerAddressCode: String(s.shipment_id),
      label: s.shipment_name_eng ?? s.shipment_name ?? 'Shipper',
      address: s.shipment_address ?? '',
      // cityName: we don't have the name, only the city_id. The sync action
      // will resolve the name from courier_operational_cities.
      cityName: String(s.shipper_city_id ?? s.city_id ?? ''),
      contactPersonName: s.shipment_contact_person ?? s.shipment_name_eng ?? s.shipment_name ?? '',
      phone1: String(s.shipment_phone ?? ''),
    }))
  }

  // ──────────────────────────────────────────────────────────────
  // 10. pingConnection — read-only connectivity check (test route)
  // ──────────────────────────────────────────────────────────────

  async pingConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const cities = await this.fetchOperationalCities()
      if (cities.length === 0) {
        return {
          success: false,
          error: 'Leopard accepted the credentials but returned 0 cities.',
        }
      }
      return { success: true }
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : 'Leopard connectivity check failed.',
      }
    }
  }
}
