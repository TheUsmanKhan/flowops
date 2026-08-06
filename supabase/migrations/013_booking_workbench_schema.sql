-- ============================================================================
-- FlowOps — Booking Workbench Schema Additions
-- ============================================================================
-- Adds courierBookingStatus + recommendedCourierCompanyIntegrationId to both
-- Order and exchange_shipments tables.
--
-- courierBookingStatus tracks the booking lifecycle explicitly:
--   'not_booked' — default, no booking attempted yet
--   'booked' — booking succeeded, tracking number assigned
--   'failed' — booking attempted but failed (can retry)
--
-- recommendedCourierCompanyIntegrationId stores the staff's pre-selected
-- courier intent at order/shipment creation time (before actual booking).
-- ============================================================================

BEGIN;

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "courierBookingStatus" TEXT NOT NULL DEFAULT 'not_booked'
    CHECK ("courierBookingStatus" IN ('not_booked', 'booked', 'failed')),
  ADD COLUMN IF NOT EXISTS "recommendedCourierCompanyIntegrationId" TEXT
    REFERENCES company_integrations(id) ON DELETE SET NULL;

ALTER TABLE exchange_shipments
  ADD COLUMN IF NOT EXISTS "courierBookingStatus" TEXT NOT NULL DEFAULT 'not_booked'
    CHECK ("courierBookingStatus" IN ('not_booked', 'booked', 'failed')),
  ADD COLUMN IF NOT EXISTS "recommendedCourierCompanyIntegrationId" TEXT
    REFERENCES company_integrations(id) ON DELETE SET NULL;

-- Index for efficient Workbench queries
CREATE INDEX IF NOT EXISTS "Order_booking_status_idx"
  ON "Order" ("courierBookingStatus")
  WHERE "courierBookingStatus" != 'booked';

CREATE INDEX IF NOT EXISTS exchange_shipments_booking_status_idx
  ON exchange_shipments ("courierBookingStatus")
  WHERE "courierBookingStatus" != 'booked';

COMMIT;
