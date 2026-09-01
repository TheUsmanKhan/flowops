-- Migration 023: Proof of Delivery + Courier Status History
--
-- 1. Order.proofOfDeliveryData JSONB? — shape: { signatureUrl, photoUrl,
--    recipientName, deliveredAt, rawResponse }. Stores our OWN file paths
--    (downloaded copies), not Leopard's external URLs.
-- 2. ExchangeShipment.proofOfDeliveryData JSONB? — same shape.
-- 3. courier_status_history table — append-only audit trail of every courier
--    status update processed (both PostEx polling + Leopard webhook/polling).
--
-- See worklog Task 34 for the full context.

-- ── 1. proofOfDeliveryData on Order + ExchangeShipment ────────────────
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "proofOfDeliveryData" JSONB;

ALTER TABLE exchange_shipments
  ADD COLUMN IF NOT EXISTS "proofOfDeliveryData" JSONB;

-- ── 2. courier_status_history table ───────────────────────────────────
CREATE TABLE IF NOT EXISTS courier_status_history (
  id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId"        TEXT NOT NULL REFERENCES "Organization"(id),
  "companyId"             TEXT NOT NULL REFERENCES "Company"(id) ON DELETE CASCADE,

  -- Which entity this status update applies to
  "entityType"            TEXT NOT NULL,  -- 'order' | 'exchange_shipment'
  "entityId"              TEXT NOT NULL,  -- FK to Order or ExchangeShipment (no hard FK — polymorphic)

  -- Which courier provider reported this status
  "providerKey"           TEXT NOT NULL,  -- 'postex' | 'leopard' | 'tcs'

  -- The raw status string from the courier API/webhook
  "rawStatus"             TEXT,

  -- Our mapped canonical courierSubStatus value
  "courierSubStatus"      TEXT,

  -- When the courier reported this status (from the API response) + when we received it
  "courierActivityDate"   TIMESTAMPTZ,
  "receivedAt"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- How we received this update
  "source"                TEXT NOT NULL DEFAULT 'poll',  -- 'webhook' | 'poll' | 'manual'

  -- Additional context (receiver name, reason, etc. — from webhook payloads)
  "metadata"              JSONB DEFAULT '{}'::jsonb,

  "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS courier_status_history_entity_idx
  ON courier_status_history ("entityType", "entityId", "receivedAt" DESC);
CREATE INDEX IF NOT EXISTS courier_status_history_company_idx
  ON courier_status_history ("companyId", "receivedAt" DESC);
