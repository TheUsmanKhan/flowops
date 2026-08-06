import { db } from '@/lib/db'

/**
 * Universal action-logging wrapper for ALL integration calls.
 *
 * Every adapter call anywhere in this framework MUST go through this
 * function — never call an adapter method directly without this logging
 * wrapper. This ensures every external API call (book shipment, track,
 * receive webhook, push product) is logged to integration_action_logs
 * for debugging and audit.
 *
 * Behavior:
 *   - Records start time, calls fn()
 *   - On success: inserts a log row (status='success', response_payload,
 *     duration_ms) and returns the result
 *   - On failure: inserts a log row (status='failed', error_message) and
 *     RE-THROWS the error so the caller handles it normally
 *   - Log insertion failures are non-fatal (logged to console, don't
 *     break the parent operation)
 */

interface ExecuteLoggedParams {
  companyIntegrationId: string
  organizationId: string
  actionType: string
  direction: 'outbound' | 'inbound'
  relatedEntityType?: 'order' | 'product' | 'exchange_shipment'
  relatedEntityId?: string
  /** The function to execute (the actual adapter call) */
  fn: () => Promise<unknown>
}

/**
 * Execute an integration action with universal logging.
 *
 * Returns the result of fn() on success, re-throws on failure.
 * The log row is inserted regardless of success/failure.
 */
export async function executeLoggedIntegrationAction<T>(
  params: ExecuteLoggedParams,
): Promise<T> {
  const startTime = Date.now()
  let result: T
  let success = true
  let errorMessage: string | undefined
  let responsePayload: unknown

  try {
    result = (await params.fn()) as T
    responsePayload = result
    return result
  } catch (err) {
    success = false
    errorMessage = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    const durationMs = Date.now() - startTime

    // Insert the log row — non-fatal if this fails (don't break the parent
    // operation just because logging failed)
    try {
      await db.integrationActionLog.create({
        data: {
          companyIntegrationId: params.companyIntegrationId,
          organizationId: params.organizationId,
          actionType: params.actionType,
          direction: params.direction,
          requestPayload: null, // caller can pre-log request if needed
          responsePayload: responsePayload ? JSON.stringify(responsePayload) : null,
          status: success ? 'success' : 'failed',
          errorMessage: errorMessage ?? null,
          relatedEntityType: params.relatedEntityType ?? null,
          relatedEntityId: params.relatedEntityId ?? null,
          durationMs,
        },
      })
    } catch (logErr) {
      console.error('[integrations] failed to insert action log:', logErr)
    }
  }
}
