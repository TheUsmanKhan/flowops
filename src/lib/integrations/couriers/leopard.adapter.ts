import type {
  CourierAdapter,
  BookShipmentInput,
  BookShipmentResult,
  TrackShipmentResult,
  CancelShipmentResult,
  CalculateRateInput,
  CalculateRateResult,
  ParseStatusWebhookResult,
} from '../types'

/** Leopard Courier Adapter — STUB. See tcs.adapter.ts for pattern. */
export class LeopardAdapter implements CourierAdapter {
  constructor(private readonly credentials: Record<string, string>) {}

  private notImplemented(method: string): never {
    throw new Error(`Leopard adapter method '${method}' not yet implemented`)
  }

  async bookShipment(_input: BookShipmentInput): Promise<BookShipmentResult> {
    this.notImplemented('bookShipment')
  }
  async trackShipment(_trackingNumber: string): Promise<TrackShipmentResult> {
    this.notImplemented('trackShipment')
  }
  async cancelShipment(_trackingNumber: string): Promise<CancelShipmentResult> {
    this.notImplemented('cancelShipment')
  }
  async calculateRate(_input: CalculateRateInput): Promise<CalculateRateResult> {
    this.notImplemented('calculateRate')
  }
  async parseStatusWebhook(_rawPayload: unknown): Promise<ParseStatusWebhookResult> {
    this.notImplemented('parseStatusWebhook')
  }
  async verifyWebhookSignature(_rawBody: string, _signatureHeader: string | null, _webhookSecret: string): Promise<boolean> {
    return true
  }
}
