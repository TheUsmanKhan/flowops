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
}

export interface BookShipmentResult {
  success: boolean
  trackingNumber?: string
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
