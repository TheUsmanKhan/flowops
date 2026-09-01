-- Migration 022: Leopard-specific order/shipment fields
--
-- Adds:
--   1. Order.returnAddressOverrideId — nullable FK to courier_pickup_addresses.
--      When set, the booking uses this address's returnAddressOverride JSONB
--      as the return address for Leopard bookings (instead of the shipper's
--      default origin). NULL = use shipper's origin (Leopard default).
--   2. Order.shipmentType — optional Leopard shipment type (e.g. "overnight",
--      "overland"). Empty = Leopard applies its own default.
--   3. ExchangeShipment.returnAddressOverrideId — same as Order.
--   4. ExchangeShipment.shipmentType — same as Order.
--
-- See worklog Task 31 for the full context.

-- ── Order fields ──────────────────────────────────────────────────────
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "returnAddressOverrideId" TEXT REFERENCES courier_pickup_addresses(id) ON DELETE SET NULL;

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "shipmentType" TEXT;

-- ── ExchangeShipment fields ───────────────────────────────────────────
ALTER TABLE exchange_shipments
  ADD COLUMN IF NOT EXISTS "returnAddressOverrideId" TEXT REFERENCES courier_pickup_addresses(id) ON DELETE SET NULL;

ALTER TABLE exchange_shipments
  ADD COLUMN IF NOT EXISTS "shipmentType" TEXT;
