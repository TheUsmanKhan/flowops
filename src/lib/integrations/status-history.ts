/**
 * Courier Status History — shared utility for inserting audit-trail rows.
 *
 * Used by BOTH PostEx's polling and Leopard's webhook/polling paths.
 * Non-fatal: if the insert fails, the status update itself still succeeds.
 */

import { db } from '@/lib/db'

interface InsertStatusHistoryInput {
  entityType: 'order' | 'exchange_shipment'
  entityId: string
  companyId: string
  organizationId: string
  providerKey: string
  rawStatus: string | null
  courierSubStatus: string | null
  courierActivityDate?: Date | null
  source: 'webhook' | 'poll' | 'manual'
  metadata?: Record<string, unknown>
}

/**
 * Insert a row into courier_status_history.
 * Non-fatal — if the insert fails, logs the error but doesn't throw.
 */
export async function insertCourierStatusHistory(input: InsertStatusHistoryInput): Promise<void> {
  try {
    await db.courierStatusHistory.create({
      data: {
        organizationId: input.organizationId,
        companyId: input.companyId,
        entityType: input.entityType,
        entityId: input.entityId,
        providerKey: input.providerKey,
        rawStatus: input.rawStatus,
        courierSubStatus: input.courierSubStatus,
        courierActivityDate: input.courierActivityDate ?? null,
        source: input.source,
        metadata: JSON.stringify(input.metadata ?? {}),
      },
    })
  } catch (err) {
    console.error('[courier-status-history] Failed to insert:', err)
  }
}
