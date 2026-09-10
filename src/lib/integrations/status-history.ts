/**
 * Courier Status History — shared utility for inserting audit-trail rows.
 *
 * Used by BOTH PostEx's polling and Leopard's webhook/polling paths.
 * Non-fatal: if the insert fails, the status update itself still succeeds.
 *
 * ORD-008 FIX: the previous version of this helper wrote fields that
 * DON'T EXIST on the Prisma schema (providerKey, rawStatus,
 * courierActivityDate, source, metadata) — so every insert silently
 * failed, leaving the courier_status_history table permanently empty.
 * This rewrite uses the ACTUAL schema fields:
 *   status, subStatus, rawResponse, orderId, exchangeShipmentId,
 *   trackingNumber, courierIntegrationId, organizationId, companyId
 *
 * Callers:
 *   - src/lib/actions/postex-status-poll.actions.ts (every status change)
 *   - src/lib/actions/leopard-webhook.actions.ts (every webhook received)
 *   - src/lib/actions/booking.actions.ts (on successful booking, status="Booked")
 */

import { db } from '@/lib/db'

export interface InsertStatusHistoryInput {
  /** 'order' (default) or 'exchange_shipment'. Stored on the row to enable
   *  polymorphic queries by entity type. */
  entityType?: 'order' | 'exchange_shipment'
  /** The id of the Order or ExchangeShipment row (kept on the polymorphic
   *  entityId column for index compatibility). */
  entityId: string
  /** Optional direct FK to Order (nullable on the schema). */
  orderId?: string | null
  /** Optional direct FK to ExchangeShipment (nullable on the schema). */
  exchangeShipmentId?: string | null
  /** The tracking number this status update pertains to. Nullable on schema,
   *  but always provided by callers (the courier tracking number). */
  trackingNumber?: string | null
  /** The CompanyIntegration this status came from. Nullable on schema. */
  courierIntegrationId?: string | null
  /** The canonical mapped status (e.g. 'delivered', 'in_transit', 'returned', 'Booked'). */
  status: string
  /** The finer-grained sub-status (e.g. 'cancelled_by_merchant', 'expired'). */
  subStatus?: string | null
  /** The full raw response from the courier (JSON-stringified). */
  rawResponse?: Record<string, unknown> | null
  organizationId: string
  companyId: string
}

/**
 * Insert a row into courier_status_history.
 * Non-fatal — if the insert fails, logs the error but doesn't throw.
 */
export async function insertCourierStatusHistory(
  input: InsertStatusHistoryInput,
): Promise<void> {
  try {
    await db.courierStatusHistory.create({
      data: {
        organizationId: input.organizationId,
        companyId: input.companyId,
        entityType: input.entityType ?? 'order',
        entityId: input.entityId,
        orderId: input.orderId ?? null,
        exchangeShipmentId: input.exchangeShipmentId ?? null,
        trackingNumber: input.trackingNumber ?? null,
        courierIntegrationId: input.courierIntegrationId ?? null,
        status: input.status,
        subStatus: input.subStatus ?? null,
        rawResponse: input.rawResponse
          ? JSON.stringify(input.rawResponse)
          : null,
      },
    })
  } catch (err) {
    console.error('[courier-status-history] Failed to insert:', err)
  }
}
