-- ============================================================================
-- FlowOps — Add courier tracking fields to Order table
-- ============================================================================
-- Adds courierSubStatus, needsShipperAdvice, unrecognizedCourierStatus to
-- the Order table — mirroring the same fields on exchange_shipments.
-- Used by the PostEx polling job to track courier status per order.
-- ============================================================================

BEGIN;

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "courierSubStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "needsShipperAdvice" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "unrecognizedCourierStatus" BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
