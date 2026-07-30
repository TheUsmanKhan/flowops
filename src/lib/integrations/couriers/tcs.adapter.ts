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

/**
 * TCS Courier Adapter — STUB.
 *
 * This is a placeholder that satisfies the CourierAdapter interface but
 * returns "not yet implemented" errors for all methods. It proves the
 * adapter registry/selection mechanism works end-to-end without requiring
 * real TCS API credentials.
 *
 * The real implementation (future work) will replace these stubs with
 * actual TCS API calls using the provided credentials.
 */
export class TcsAdapter implements CourierAdapter {
  constructor(private readonly credentials: Record<string, string>) {}

  private notImplemented(method: string): never {
    throw new Error(`TCS adapter method '${method}' not yet implemented`)
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
    // Stub: skip verification until real implementation
    return true
  }
}
