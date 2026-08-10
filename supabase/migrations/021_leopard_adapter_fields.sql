-- Migration 021: Leopard adapter schema additions
--
-- Adds fields needed for the real Leopard Courier adapter:
--   1. courier_operational_cities.shipmentTypes — Leopard returns each city's
--      allowed shipment_type as an array (e.g. ["overnight","overland"]).
--      Stored as TEXT (JSON array string) for simplicity — Prisma doesn't
--      support TEXT[] natively without a different column type.
--   2. courier_pickup_addresses.returnAddressOverride — Leopard allows an
--      optional return address override per shipper. JSONB: {address, cityName,
--      contactPersonName, phone}. NULL = use shipper's origin as return (default).
--   3. Order.courierSlipStoragePath + ExchangeShipment.courierSlipStoragePath —
--      stores our own copy of the courier's booking slip PDF (downloaded from
--      slip_link). Same "don't trust external URLs" principle as elsewhere.
--
-- See worklog Task 29 for the full context.

-- ── 1. courier_operational_cities: add shipmentTypes ──────────────────
ALTER TABLE courier_operational_cities
  ADD COLUMN IF NOT EXISTS "shipmentTypes" TEXT;

-- ── 2. courier_pickup_addresses: add returnAddressOverride ────────────
ALTER TABLE courier_pickup_addresses
  ADD COLUMN IF NOT EXISTS "returnAddressOverride" JSONB;

-- ── 3. Order + ExchangeShipment: add courierSlipStoragePath ──────────
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "courierSlipStoragePath" TEXT;

ALTER TABLE exchange_shipments
  ADD COLUMN IF NOT EXISTS "courierSlipStoragePath" TEXT;
