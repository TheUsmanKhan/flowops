import { db } from './db'
import { fireAndForget } from './fire-and-forget'

interface InsertMetricEventInput {
  companyId: string
  entityType: string // "employee" | "product" | "order" | "campaign" | ...
  entityId: string
  metricKey: string // e.g. "order.fulfilled", "ad.spend"
  numericValue: number
  currency?: string | null
  dimensions?: Record<string, unknown>
  recordedAt?: Date
}

/**
 * Insert a raw numeric metric event. Future KPI dashboards aggregate
 * from this table. Immutable (no update/delete exposed).
 *
 * FIRE-AND-FORGET (non-blocking):
 *   Returns `void` immediately. The DB write is scheduled on the event
 *   loop via `fireAndForget()` and completes AFTER the caller's response
 *   is sent. This removes the metric-event DB round-trip from the critical
 *   path of every mutation (~98 call sites).
 *
 *   See `insertAuditLog()` in src/lib/audit.ts for the full rationale.
 *   Same safety contract: internal try/catch + `fireAndForget()` `.catch()`
 *   defense-in-depth. No caller uses the return value.
 */
export function insertMetricEvent(input: InsertMetricEventInput): void {
  fireAndForget(
    (async () => {
      try {
        await db.metricEvent.create({
          data: {
            companyId: input.companyId,
            entityType: input.entityType,
            entityId: input.entityId,
            metricKey: input.metricKey,
            numericValue: input.numericValue,
            currency: input.currency ?? null,
            dimensions: input.dimensions ? JSON.stringify(input.dimensions) : '{}',
            recordedAt: input.recordedAt ?? new Date(),
          },
        })
      } catch (err) {
        console.error('[metrics] failed to insert metric event:', err)
      }
    })(),
  )
}
