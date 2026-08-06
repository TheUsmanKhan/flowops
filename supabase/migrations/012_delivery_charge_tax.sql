-- ============================================================================
-- FlowOps — Delivery Charge + Tax Tracking (Order + Exchange Shipments)
-- ============================================================================
-- Adds 4 fields to both Order and exchange_shipments tables:
--   estimatedDeliveryCharge — staff-entered or courier-default at booking time
--   actualDeliveryCharge    — populated later from courier's Payment Status API
--   taxAmount               — staff-entered at order creation (e.g. GST)
--   taxLabel                — free text (e.g. "GST 17%")
--
-- These are ADDITIVE — existing totalOrderValue calculation is:
--   subtotal + courierCharges - discountAmount
-- After this migration it becomes:
--   subtotal + courierCharges - discountAmount + estimatedDeliveryCharge + taxAmount
--
-- All fields are nullable — existing orders have NULL and are unaffected.
-- ============================================================================

BEGIN;

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "estimatedDeliveryCharge" DECIMAL(14,2),
  ADD COLUMN IF NOT EXISTS "actualDeliveryCharge" DECIMAL(14,2),
  ADD COLUMN IF NOT EXISTS "taxAmount" DECIMAL(14,2),
  ADD COLUMN IF NOT EXISTS "taxLabel" TEXT;

ALTER TABLE exchange_shipments
  ADD COLUMN IF NOT EXISTS "estimatedDeliveryCharge" DECIMAL(14,2),
  ADD COLUMN IF NOT EXISTS "actualDeliveryCharge" DECIMAL(14,2),
  ADD COLUMN IF NOT EXISTS "taxAmount" DECIMAL(14,2),
  ADD COLUMN IF NOT EXISTS "taxLabel" TEXT;

COMMIT;
