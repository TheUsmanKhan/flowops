import crypto from 'crypto'
import type {
  EcommerceAdapter,
  ParseWebhookOrderResult,
  PushProductResult,
  ParsedWebhookOrder,
} from '../types'
import { shopifyOrderWebhookSchema } from '@/lib/validations/order.schemas'

/**
 * Shopify Ecommerce Adapter — REAL (connection + webhook ingestion).
 *
 * This prompt (Shopify Adapter Foundation) implements:
 *   - verifyWebhookSignature: REAL HMAC-SHA256 (Shopify's documented algorithm)
 *   - parseWebhookOrder: validates the raw Shopify payload against
 *     `shopifyOrderWebhookSchema` and maps to the generic
 *     `ParsedWebhookOrder` shape (used by the generic ecommerce path /
 *     customer matching).
 *
 * The actual order CREATION from a webhook is handled by
 * `createOrderFromShopifyWebhook()` in `order.actions.ts`, which the webhook
 * route calls directly with the RAW payload (it needs the full Shopify shape
 * — including `financial_status` — to map payment status itself). This
 * adapter's `parseWebhookOrder` is NOT in that critical path; it exists to
 * satisfy the EcommerceAdapter contract and support generic uses.
 *
 * Stays as throwing stubs (out of scope for this prompt — later prompts):
 *   - pushProduct    (product sync)
 *   - updateInventory (stock sync + reconciliation)
 *
 * CONNECTION MODEL: private-app (not OAuth). The merchant creates a Shopify
 * custom/private app, grants Admin API access, and pastes the access token
 * into FlowOps. Credentials are stored encrypted in CompanyIntegration
 * (AES-256-GCM via INTEGRATION_ENCRYPTION_KEY). The webhook signing secret
 * lives in the separate `webhookSecret` column (not in the encrypted
 * credentials blob) — Shopify signs webhooks with it, and this adapter
 * verifies with it.
 *
 * EXPECTED CREDENTIALS (decrypted `credentials`):
 *   - shopUrl:      the myshopify.com domain, e.g. "acme-store.myshopify.com"
 *                   (no protocol, no trailing slash). Used for outbound
 *                   Admin API calls (later prompts).
 *   - accessToken:  Admin API access token, starts with "shpat_" for private
 *                   apps. Used for outbound Admin API calls (later prompts).
 *
 * WEBHOOK VERIFICATION (Shopify docs):
 *   Shopify sends `X-Shopify-Hmac-Sha256` containing base64(HMAC_SHA256(
 *   shared_secret, raw_body)). To verify, recompute the digest from the
 *   RAW request body using the shared secret and compare in constant time.
 *   The shared secret is `webhookSecret` (CompanyIntegration.webhookSecret),
 *   which the merchant configured on BOTH sides when creating the webhook
 *   subscription.
 */
export class ShopifyAdapter implements EcommerceAdapter {
  constructor(private readonly credentials: Record<string, string>) {}

  // ──────────────────────────────────────────────────────────────
  // Webhook signature verification (REAL — security-critical)
  // ──────────────────────────────────────────────────────────────

  /**
   * Verify a Shopify webhook's HMAC-SHA256 signature.
   *
   * CRITICAL: This is the ONLY thing standing between a forged webhook and
   * a fake order being created in the system. It MUST fail closed on any
   * missing input and use a constant-time comparison — never return `true`
   * without a real check.
   *
   * Algorithm (per Shopify's webhook verification docs):
   *   1. Compute HMAC-SHA256 over `rawBody` (UTF-8) keyed by `webhookSecret`.
   *   2. Base64-encode the digest.
   *   3. Compare to `signatureHeader` (the `X-Shopify-Hmac-Sha256` value)
   *      in constant time.
   *
   * `rawBody` MUST be the exact bytes Shopify signed. The webhook route
   * reads it via `await req.text()` BEFORE JSON.parse, which preserves the
   * original bytes. Any re-serialization (e.g. JSON.stringify(parsed)) would
   * produce a different signature and MUST NOT be used here.
   *
   * SECURITY NOTES:
   *   - Returns `false` (not throw) on missing header/secret/body so the
   *     route can treat verification failure uniformly.
   *   - Length check before `timingSafeEqual` (it throws on length mismatch).
   *   - The comparison is over the base64 STRINGS (as UTF-8 byte buffers),
   *     which is equivalent to comparing the underlying digests and avoids
   *     any base64-decode ambiguity.
   */
  async verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string | null,
    webhookSecret: string,
  ): Promise<boolean> {
    // Fail closed — never default to "valid" on missing inputs.
    if (!rawBody || !signatureHeader || !webhookSecret) {
      return false
    }

    const computed = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody, 'utf8')
      .digest('base64')

    // Constant-time comparison to prevent timing side-channels.
    try {
      const a = Buffer.from(computed, 'utf8')
      const b = Buffer.from(signatureHeader, 'utf8')
      if (a.length !== b.length) return false
      return crypto.timingSafeEqual(a, b)
    } catch {
      return false
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Webhook order parsing
  // ──────────────────────────────────────────────────────────────

  /**
   * Validate a raw Shopify order-webhook payload and map it to the generic
   * `ParsedWebhookOrder` shape (the EcommerceAdapter contract).
   *
   * Validates against `shopifyOrderWebhookSchema` first (the raw Shopify
   * webhook shape), then maps the fields. `financial_status` is normalized
   * to the `ParsedWebhookOrder.financialStatus` subset
   * ('paid' | 'partially_paid' | 'pending' | 'refunded') — a LOSSY collapse
   * (authorized→pending, partially_refunded/voided→refunded). The FULL
   * payment-status mapping (Shopify financial_status → FlowOps paymentStatus
   * enum) happens INSIDE `createOrderFromShopifyWebhook()`, not here.
   *
   * NOTE: For order CREATION, the webhook route passes the RAW payload to
   * `createOrderFromShopifyWebhook()` (which needs the full Shopify shape).
   * This method is for the generic ecommerce path / customer matching and
   * for any future provider that consumes the normalized shape.
   */
  async parseWebhookOrder(rawPayload: unknown): Promise<ParseWebhookOrderResult> {
    const parsed = shopifyOrderWebhookSchema.safeParse(rawPayload)
    if (!parsed.success) {
      return {
        success: false,
        error: `Invalid Shopify webhook payload: ${
          parsed.error.issues[0]?.message ?? 'validation failed'
        }`,
      }
    }
    const d = parsed.data

    const customerName =
      `${d.customer.first_name ?? ''} ${d.customer.last_name ?? ''}`.trim() ||
      'Unknown Shopify Customer'

    // Normalize Shopify financial_status → ParsedWebhookOrder.financialStatus
    // (lossy subset for the generic interface). The real mapping to the
    // FlowOps paymentStatus enum is done inside createOrderFromShopifyWebhook.
    let financialStatus: ParsedWebhookOrder['financialStatus']
    switch (d.financial_status) {
      case 'paid':
        financialStatus = 'paid'
        break
      case 'partially_paid':
        financialStatus = 'partially_paid'
        break
      case 'refunded':
      case 'partially_refunded':
      case 'voided':
        financialStatus = 'refunded'
        break
      case 'pending':
      case 'authorized':
      default:
        financialStatus = 'pending'
        break
    }

    const lineItems: ParsedWebhookOrder['lineItems'] = d.line_items.map((li) => ({
      externalVariantId: String(li.id),
      sku: li.sku ?? undefined,
      quantity: li.quantity,
      price: parseFloat(li.price),
    }))

    const parsedOrder: ParsedWebhookOrder = {
      externalOrderId: String(d.id),
      externalOrderReference: d.name,
      customerName,
      customerPhone: d.customer.phone ?? undefined,
      customerEmail: d.customer.email ?? undefined,
      deliveryAddress: d.customer.default_address?.address1 ?? '',
      deliveryCity: d.customer.default_address?.city ?? '',
      financialStatus,
      lineItems,
    }

    return { success: true, parsedOrder }
  }

  // ──────────────────────────────────────────────────────────────
  // Out of scope for this prompt — throwing stubs
  // ──────────────────────────────────────────────────────────────

  /**
   * Push a product to Shopify. OUT OF SCOPE for this prompt — stays a
   * throwing stub. Product sync will be implemented in a later prompt.
   */
  async pushProduct(_productData: unknown): Promise<PushProductResult> {
    throw new Error(
      "Shopify adapter method 'pushProduct' not yet implemented " +
        '(out of scope: product sync is a later prompt)',
    )
  }

  /**
   * Update inventory level for a Shopify variant. OUT OF SCOPE for this
   * prompt — stays a throwing stub. Stock sync + reconciliation will be
   * implemented in later prompts.
   */
  async updateInventory(
    _externalVariantId: string,
    _quantity: number,
  ): Promise<{ success: boolean; error?: string }> {
    throw new Error(
      "Shopify adapter method 'updateInventory' not yet implemented " +
        '(out of scope: stock sync is a later prompt)',
    )
  }
}
