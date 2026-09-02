-- ============================================================================
-- FlowOps — Add lastPolledAt to Order + exchange_shipments
-- ============================================================================
-- Tracks when each record was last polled for courier status updates.
-- Used by pollPostExOrderStatuses() to avoid re-polling unchanged records
-- too frequently and to provide an audit trail of polling activity.
-- ============================================================================

BEGIN;

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "lastPolledAt" TIMESTAMPTZ;

ALTER TABLE exchange_shipments
  ADD COLUMN IF NOT EXISTS "lastPolledAt" TIMESTAMPTZ;

COMMIT;
