-- Migration 020: Load Sheets — courier-agnostic pickup manifest system
--
-- Creates the load_sheets table for storing generated load sheets (pickup
-- manifests) from any courier provider. Reuses PostEx's existing
-- generateLoadSheet() adapter method (and the generatePostExLoadSheet() action)
-- but stores the PDF in OUR file storage (not an external courier URL that
-- might expire — same principle as Proof of Delivery).
--
-- Orders AND exchange shipments can be combined into the same load sheet
-- (a courier rider physically picks up both types in one trip).
--
-- See worklog Task 28 for the full context.

-- ── load_sheets table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS load_sheets (
  id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId"        TEXT NOT NULL REFERENCES "Organization"(id),
  "companyId"             TEXT NOT NULL REFERENCES "Company"(id) ON DELETE CASCADE,

  -- Which courier provider generated this (e.g. 'postex', 'leopard', 'tcs')
  "providerKey"           TEXT NOT NULL,
  -- The specific company_integration used (tracks which credentials were used)
  "companyIntegrationId"  TEXT NOT NULL REFERENCES company_integrations(id) ON DELETE SET NULL,
  -- Which pickup address this load sheet is for (nullable — some couriers
  -- may not require it, but PostEx does)
  "pickupAddressId"       TEXT REFERENCES courier_pickup_addresses(id) ON DELETE SET NULL,

  -- The entities included in this load sheet (orders + exchange shipments mixed)
  -- JSONB array of: { entityType: 'order'|'exchange_shipment', entityId, trackingNumber }
  items                   JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Path to the stored PDF in our /uploads folder (e.g. /uploads/load-sheets/<companyId>/<filename>.pdf)
  -- We store our own copy, not an external courier URL that might expire.
  "pdfStoragePath"        TEXT,

  -- Who generated it and when
  "generatedBy"           TEXT REFERENCES "Employee"(id) ON DELETE SET NULL,
  "generatedAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS load_sheets_company_idx
  ON load_sheets ("companyId", "generatedAt" DESC);
CREATE INDEX IF NOT EXISTS load_sheets_integration_idx
  ON load_sheets ("companyIntegrationId");
CREATE INDEX IF NOT EXISTS load_sheets_provider_idx
  ON load_sheets ("providerKey");

-- ── Add loadSheetId FK to Order ──────────────────────────────────────
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "loadSheetId" TEXT REFERENCES load_sheets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS order_loadsheet_idx
  ON "Order" ("loadSheetId") WHERE "loadSheetId" IS NOT NULL;

-- ── Add loadSheetId FK to ExchangeShipment ───────────────────────────
ALTER TABLE exchange_shipments
  ADD COLUMN IF NOT EXISTS "loadSheetId" TEXT REFERENCES load_sheets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS exchange_shipments_loadsheet_idx
  ON exchange_shipments ("loadSheetId") WHERE "loadSheetId" IS NOT NULL;

-- ── RLS note ──────────────────────────────────────────────────────────
-- RLS is enforced in the application layer (company-scoping via getWorkspace)
-- matching the pattern used for all other tables in this codebase. The
-- load_sheets table is immutable once generated (no UPDATE/DELETE exposed
-- in the application — consistent with other audit-adjacent records like
-- inventory_transactions and scan_events).
