-- Migration 024: Shipper Advice tracking fields
--
-- Adds fields to track when shipper advice was last submitted for an entity
-- (Leopard-specific capability — PostEx uses read-only flagging only).
--
-- See worklog Task 35 for the full context.

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "lastShipperAdviceSubmittedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "lastShipperAdviceType" TEXT;

ALTER TABLE exchange_shipments
  ADD COLUMN IF NOT EXISTS "lastShipperAdviceSubmittedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "lastShipperAdviceType" TEXT;
