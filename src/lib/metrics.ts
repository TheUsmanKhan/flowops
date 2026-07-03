import { db } from './db'

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
 */
export async function insertMetricEvent(input: InsertMetricEventInput) {
  try {
    return await db.metricEvent.create({
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
    return null
  }
}
