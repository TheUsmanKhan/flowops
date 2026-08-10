/**
 * Integration Framework — adapter interfaces.
 *
 * These define the common contract that ALL provider-specific adapters
 * (TCS, Leopard, PostEx, Shopify, Daraz) must implement. The rest of the
 * application (OMS, dispatch logic, webhook handler) interacts ONLY with
 * these interfaces — never with provider-specific API details directly.
 *
 * This is the Adapter Pattern: each specific provider implements this
 * interface, and calling code is provider-agnostic.
 */

// ──────────────────────────────────────────────────────────────
// Courier Adapter Interface
// ──────────────────────────────────────────────────────────────

export interface BookShipmentInput {
  orderNumber: string
  recipientName: string
  recipientPhone: string
  deliveryAddress: string
  deliveryCity: string
  pickupLocationAddress: string
  pickupLocationCity: string
  weightGrams: number
  codAmount: number
  itemDescription: string

  // Extended fields for couriers that need additional booking parameters.
  // These are optional — couriers that don't use them simply ignore them.

  /** Courier-specific address code from the address book (e.g. PostEx's pickupAddressCode). */
  pickupAddressCode?: string

  /** Courier-specific order type (e.g. PostEx's "Normal" | "Replacement" | "Overland"). */
  orderType?: string

  /** Number of pieces/items in the shipment (for couriers that require an `items` field). */
  quantity?: number

  /** Additional notes for the courier (maps to PostEx's transactionNotes). */
  transactionNotes?: string

  /**
   * If true, automatically generate a load sheet after successful booking
   * (PostEx-specific). Default false — the caller decides whether to chain.
   */
  autoGenerateLoadSheet?: boolean
}

export interface BookShipmentResult {
  success: boolean
  trackingNumber?: string
  /** Courier's initial status string (e.g. PostEx returns "Unbooked"). */
  providerStatus?: string
  error?: string
  rawResponse?: unknown
}

export interface TrackShipmentResult {
  success: boolean
  status?: 'booked' | 'in_transit' | 'delivered' | 'returned' | 'failed'
  lastUpdateAt?: string
  error?: string
  rawResponse?: unknown
}

export interface CancelShipmentResult {
  success: boolean
  error?: string
}

export interface CalculateRateInput {
  fromCity: string
  toCity: string
  weightGrams: number
}

export interface CalculateRateResult {
  success: boolean
  rate?: number
  error?: string
}

export interface ParseStatusWebhookResult {
  trackingNumber: string
  status: 'booked' | 'in_transit' | 'delivered' | 'returned' | 'failed'
  lastUpdateAt?: string
}

// ──────────────────────────────────────────────────────────────
// Operational Cities (optional capability — Phase 2 of City & Address Book)
// ──────────────────────────────────────────────────────────────

export interface OperationalCity {
  cityName: string
  cityId?: string
  isPickupCity: boolean
  isDeliveryCity: boolean
}

export interface PickupAddressInput {
  label: string
  address: string
  cityName: string
  contactPersonName: string
  phone1: string
  phone2?: string
}

export interface PickupAddressResult {
  success: boolean
  providerAddressCode?: string
  error?: string
}

export interface CourierAdapter {
  bookShipment(input: BookShipmentInput): Promise<BookShipmentResult>
  trackShipment(trackingNumber: string): Promise<TrackShipmentResult>
  cancelShipment(trackingNumber: string): Promise<CancelShipmentResult>
  calculateRate(input: CalculateRateInput): Promise<CalculateRateResult>

  /**
   * Parse an incoming status-update webhook from this courier.
   * Used by the generic webhook receiver route to extract tracking number
   * + new status from the raw payload, so the OMS can update the order.
   */
  parseStatusWebhook(rawPayload: unknown): Promise<ParseStatusWebhookResult>

  /**
   * Verify the authenticity of an incoming webhook (HMAC signature etc.).
   * Stub adapters can return true for now; real adapters implement real
   * verification per the provider's documentation.
   */
  verifyWebhookSignature(rawBody: string, signatureHeader: string | null, webhookSecret: string): Promise<boolean>

  /**
   * OPTIONAL: Fetch the list of operational cities this courier serves.
   * Only implemented by adapters whose provider exposes a cities endpoint
   * (e.g. PostEx). Adapters that don't support this simply omit the method
   * — the sync job checks for its existence before calling.
   *
   * Used by syncCourierOperationalCities() to populate the global
   * courier_operational_cities cache.
   */
  fetchOperationalCities?(): Promise<OperationalCity[]>

  /**
   * OPTIONAL: Create a pickup/return address on the courier's side.
   * Returns the courier's own addressCode which we store locally.
   * Only implemented by adapters whose provider supports address creation
   * (e.g. PostEx's Create Pickup Address API).
   */
  createPickupAddress?(input: PickupAddressInput): Promise<PickupAddressResult>

  /**
   * OPTIONAL: Fetch existing pickup addresses already on the courier's side.
   * Used by adapters whose provider requires addresses to pre-exist (fetch-only
   * model) rather than supporting creation.
   */
  fetchExistingPickupAddresses?(): Promise<Array<{
    providerAddressCode: string
    label?: string
    address: string
    cityName: string
    contactPersonName: string
    phone1: string
    phone2?: string
  }>>

  /**
   * OPTIONAL: Track multiple shipments in a single bulk API call.
   * Used by the polling job (Phase 4) for couriers that support bulk tracking
   * (e.g. PostEx's track-bulk-order API). Returns one result per tracking number.
   */
  trackBulkShipments?(trackingNumbers: string[]): Promise<Array<TrackShipmentResult>>

  /**
   * OPTIONAL: Generate a load sheet (pickup manifest) for a batch of tracking numbers.
   * Used by couriers that require a load sheet before pickup (e.g. PostEx).
   * Returns the raw response + pdfBase64 (the PDF binary encoded as base64,
   * so the caller can store it in our own file storage — not an external
   * courier URL that might expire).
   */
  generateLoadSheet?(trackingNumbers: string[], pickupAddress?: string): Promise<{ success: boolean; rawResponse?: unknown; error?: string; pdfBase64?: string }>

  /**
   * OPTIONAL: Lightweight read-only connectivity check.
   *
   * Used by testIntegrationConnection() to verify credentials work without
   * making any state-changing call. Implementations should use the cheapest
   * read-only endpoint the provider offers (e.g. PostEx: fetchOperationalCities;
   * Leopard: getAllCities; TCS: a cities/list endpoint).
   *
   * Adapters that don't implement this fall back to calculateRate() (which is
   * the historical test method, but unsupported by PostEx and other couriers
   * that don't expose rate endpoints). Adapters that support neither
   * pingConnection() nor calculateRate() will surface a clear "not supported"
   * error to the user.
   *
   * MUST be read-only — no booking, no address creation, no manifest generation.
   */
  pingConnection?(): Promise<{ success: boolean; error?: string }>
}

// ──────────────────────────────────────────────────────────────
// Ecommerce Adapter Interface
// ──────────────────────────────────────────────────────────────

export interface ParsedWebhookOrder {
  externalOrderId: string
  externalOrderReference: string
  customerName: string
  customerPhone?: string
  customerEmail?: string
  deliveryAddress: string
  deliveryCity: string
  financialStatus: 'paid' | 'partially_paid' | 'pending' | 'refunded'
  lineItems: Array<{
    externalVariantId: string
    sku?: string
    quantity: number
    price: number
  }>
}

export interface ParseWebhookOrderResult {
  success: boolean
  parsedOrder?: ParsedWebhookOrder
  error?: string
}

export interface PushProductResult {
  success: boolean
  externalProductId?: string
  error?: string
}

export interface EcommerceAdapter {
  parseWebhookOrder(rawPayload: unknown): Promise<ParseWebhookOrderResult>
  pushProduct(productData: unknown): Promise<PushProductResult>
  updateInventory(externalVariantId: string, quantity: number): Promise<{ success: boolean; error?: string }>

  /**
   * Verify the authenticity of an incoming webhook.
   * Same pattern as CourierAdapter.verifyWebhookSignature.
   */
  verifyWebhookSignature(rawBody: string, signatureHeader: string | null, webhookSecret: string): Promise<boolean>
}
