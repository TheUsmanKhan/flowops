import type {
  EcommerceAdapter,
  ParseWebhookOrderResult,
  PushProductResult,
} from '../types'

/** Daraz Ecommerce Adapter — STUB. See shopify.adapter.ts for pattern. */
export class DarazAdapter implements EcommerceAdapter {
  constructor(private readonly credentials: Record<string, string>) {}

  private notImplemented(method: string): never {
    throw new Error(`Daraz adapter method '${method}' not yet implemented`)
  }

  async parseWebhookOrder(_rawPayload: unknown): Promise<ParseWebhookOrderResult> {
    this.notImplemented('parseWebhookOrder')
  }
  async pushProduct(_productData: unknown): Promise<PushProductResult> {
    this.notImplemented('pushProduct')
  }
  async updateInventory(_externalVariantId: string, _quantity: number): Promise<{ success: boolean; error?: string }> {
    this.notImplemented('updateInventory')
  }
  async verifyWebhookSignature(_rawBody: string, _signatureHeader: string | null, _webhookSecret: string): Promise<boolean> {
    return true
  }
}
