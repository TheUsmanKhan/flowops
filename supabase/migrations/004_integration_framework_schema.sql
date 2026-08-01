-- ============================================================================
-- FlowOps — Universal Integration Framework Schema (Step 1: Schema + RLS only)
-- ============================================================================
-- This migration builds the foundational integration framework supporting
-- multiple courier providers (TCS, Leopard, PostEx) and ecommerce platforms
-- (Shopify, Daraz) via the Adapter Pattern. The rest of the app (OMS,
-- dispatch logic) interacts only with the common interface, never with
-- provider-specific API details directly.
--
-- Two-layer model:
--   Layer 1 (integration_providers): master catalog of WHICH providers exist
--     (platform-level, seeded/maintained, not company-specific).
--   Layer 2 (company_integrations): the ACTUAL connections a company has
--     made — encrypted credentials, connection status, webhook routing.
--
-- Plus:
--   - integration_action_logs: universal logging for every integration call
--   - orders.courier_company_integration_id: links orders to their booking
--   - company_order_settings extension: courier_booking_mode + default integration
--
-- ============================================================================
-- ADAPTATIONS FROM SPEC (necessary to integrate with the live schema)
-- ============================================================================
-- The spec uses UUID PKs + snake_case columns + lowercase table names. The
-- live FlowOps schema uses TEXT/cuid PKs + double-quoted camelCase columns
-- (Prisma convention). Adaptations (same pattern as migrations 002 + 003):
--   1. All PKs are TEXT with DEFAULT gen_random_uuid()::text.
--   2. All FK columns are TEXT referencing the existing PascalCase tables.
--   3. All camelCase columns are double-quoted to preserve casing.
--   4. The 3 new tables use lowercase names per the spec (integration_providers,
--      company_integrations, integration_action_logs) — they're new, not
--      Prisma-managed, so lowercase is fine.
--   5. RLS helpers get_active_company_id() / is_elevated_employee() take TEXT.
-- ============================================================================

BEGIN;

-- ============================================================================
-- PART 1: integration_providers TABLE (MASTER CATALOG)
-- ============================================================================
-- Platform-level catalog of WHICH providers exist (TCS, Leopard, PostEx,
-- Shopify, Daraz). Seeded/maintained by the platform, not by individual
-- companies. Each row defines the provider's category, auth type, webhook
-- support, and a JSONB config_schema describing the required credential
-- fields (so the settings UI in Step 3 can dynamically render the right form
-- fields per provider without hardcoding each one).

CREATE TABLE IF NOT EXISTS integration_providers (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "providerKey"         TEXT NOT NULL UNIQUE,
  -- e.g. 'tcs', 'leopard', 'postex', 'shopify', 'daraz'

  "providerName"        TEXT NOT NULL,
  -- e.g. "TCS Express", "Shopify"

  category              TEXT NOT NULL
                          CHECK (category IN ('courier','ecommerce','ads','payment')),
  -- schema supports all four categories generically, but ONLY courier and
  -- ecommerce providers are seeded/used in this build

  "logoUrl"             TEXT,

  "authType"            TEXT NOT NULL
                          CHECK ("authType" IN ('api_key','oauth2','basic_auth')),

  "supportsWebhook"     BOOLEAN NOT NULL DEFAULT FALSE,

  "configSchema"        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Array describing required credential fields for the settings UI:
  -- [{"key":"account_id","label":"Account ID","type":"text","required":true}, ...]

  capabilities          JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Array of supported actions: ["book_shipment","track_shipment", ...]

  "isActive"            BOOLEAN NOT NULL DEFAULT TRUE,

  "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_integration_providers_updatedAt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_integration_providers_updatedAt ON integration_providers;
CREATE TRIGGER trg_integration_providers_updatedAt
  BEFORE UPDATE ON integration_providers
  FOR EACH ROW
  EXECUTE FUNCTION update_integration_providers_updatedAt();

-- ── Seed initial courier + ecommerce providers (catalog entries only) ──
-- No actual adapter implementation code exists yet — that comes in future
-- prompts. These rows exist so the settings UI has something to list.
INSERT INTO integration_providers
  ("providerKey", "providerName", category, "authType", "supportsWebhook",
   "configSchema", capabilities) VALUES
('tcs', 'TCS Express', 'courier', 'api_key', true,
  '[{"key":"account_id","label":"Account ID","type":"text","required":true},
    {"key":"api_key","label":"API Key","type":"password","required":true}]'::jsonb,
  '["book_shipment","track_shipment","cancel_shipment","calculate_rate"]'::jsonb),
('leopard', 'Leopard Courier', 'courier', 'api_key', true,
  '[{"key":"api_key","label":"API Key","type":"password","required":true},
    {"key":"api_password","label":"API Password","type":"password","required":true}]'::jsonb,
  '["book_shipment","track_shipment","cancel_shipment"]'::jsonb),
('postex', 'PostEx', 'courier', 'api_key', true,
  '[{"key":"api_token","label":"API Token","type":"password","required":true}]'::jsonb,
  '["book_shipment","track_shipment","cancel_shipment","calculate_rate"]'::jsonb),
('shopify', 'Shopify', 'ecommerce', 'oauth2', true,
  '[{"key":"store_url","label":"Store URL","type":"text","required":true},
    {"key":"access_token","label":"Admin API Access Token","type":"password","required":true}]'::jsonb,
  '["receive_order","push_product","update_inventory"]'::jsonb),
('daraz', 'Daraz', 'ecommerce', 'oauth2', true,
  '[{"key":"seller_id","label":"Seller ID","type":"text","required":true},
    {"key":"access_token","label":"Access Token","type":"password","required":true}]'::jsonb,
  '["receive_order","push_product","update_inventory"]'::jsonb)
ON CONFLICT ("providerKey") DO NOTHING;

-- ============================================================================
-- PART 2: company_integrations TABLE
-- ============================================================================
-- The ACTUAL connections a specific company has made. A company can connect
-- multiple providers in the same category (e.g. TCS + Leopard as couriers).
-- One is marked is_default per category (enforced via app logic in Step 2
-- since category comes from the joined provider row).
--
-- credentials_encrypted is a TEXT column holding an encrypted string —
-- actual encrypt/decrypt happens in Step 2's application code, NOT in SQL.
-- Never store plain JSON here.

CREATE TABLE IF NOT EXISTS company_integrations (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "companyId"           TEXT NOT NULL REFERENCES "Company"(id) ON DELETE CASCADE,
  "organizationId"      TEXT NOT NULL REFERENCES "Organization"(id),
  "providerId"          TEXT NOT NULL REFERENCES integration_providers(id),

  "connectionName"      TEXT NOT NULL,
  -- e.g. "TCS - Main Account", "TCS - Karachi Branch"

  "credentialsEncrypted" TEXT,
  -- encrypted blob (application-layer encryption in Step 2) — never plain JSON

  "webhookEndpointId"   TEXT UNIQUE,
  -- random unguessable token, only populated if provider supports webhooks

  "webhookSecret"       TEXT,
  -- for verifying webhook authenticity (HMAC signatures etc.)

  "isActive"            BOOLEAN NOT NULL DEFAULT TRUE,
  "isDefault"           BOOLEAN NOT NULL DEFAULT FALSE,
  -- one default per company PER CATEGORY (enforced via app logic in Step 2)

  "connectionStatus"    TEXT NOT NULL DEFAULT 'pending'
                          CHECK ("connectionStatus" IN
                            ('pending','connected','error','expired')),
  "lastSyncAt"          TIMESTAMPTZ,
  "lastError"           TEXT,

  "createdBy"           TEXT REFERENCES "Employee"(id),
  "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS company_integrations_company_active_idx
  ON company_integrations ("companyId", "isActive");

CREATE UNIQUE INDEX IF NOT EXISTS company_integrations_webhook_endpoint_idx
  ON company_integrations ("webhookEndpointId")
  WHERE "webhookEndpointId" IS NOT NULL;

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_company_integrations_updatedAt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_company_integrations_updatedAt ON company_integrations;
CREATE TRIGGER trg_company_integrations_updatedAt
  BEFORE UPDATE ON company_integrations
  FOR EACH ROW
  EXECUTE FUNCTION update_company_integrations_updatedAt();

-- ============================================================================
-- PART 3: integration_action_logs TABLE
-- ============================================================================
-- Universal logging for EVERY integration call — the single source of truth
-- for debugging "why did this courier booking fail" or "did this Shopify
-- webhook get processed," regardless of which provider was involved.
-- Immutable: no UPDATE or DELETE policies under any role.

CREATE TABLE IF NOT EXISTS integration_action_logs (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "companyIntegrationId" TEXT NOT NULL REFERENCES company_integrations(id) ON DELETE CASCADE,
  "organizationId"      TEXT NOT NULL REFERENCES "Organization"(id),

  "actionType"          TEXT NOT NULL,
  -- e.g. 'book_shipment','track_shipment','receive_order','push_product'

  direction             TEXT NOT NULL
                          CHECK (direction IN ('outbound','inbound')),

  "requestPayload"      JSONB,
  "responsePayload"     JSONB,

  status                TEXT NOT NULL
                          CHECK (status IN ('success','failed')),
  "errorMessage"        TEXT,

  "relatedEntityType"   TEXT
                          CHECK ("relatedEntityType" IS NULL OR "relatedEntityType" IN ('order','product')),
  "relatedEntityId"     TEXT,

  "durationMs"          INT,

  "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS integration_action_logs_integration_created_idx
  ON integration_action_logs ("companyIntegrationId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS integration_action_logs_entity_idx
  ON integration_action_logs ("relatedEntityType", "relatedEntityId")
  WHERE "relatedEntityType" IS NOT NULL;

CREATE INDEX IF NOT EXISTS integration_action_logs_status_created_idx
  ON integration_action_logs (status, "createdAt" DESC);

-- ============================================================================
-- PART 4: LINK ORDERS TABLE
-- ============================================================================
-- Adds a reference to WHICH company_integrations row was used to book this
-- order's shipment. Distinct from the existing courierName text field (which
-- remains for display/legacy) — this is the authoritative link for tracing
-- back to the actual integration used (e.g. for cancelling/re-tracking via
-- the correct adapter/credentials).

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "courierCompanyIntegrationId" TEXT
    REFERENCES company_integrations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "Order_courierCompanyIntegrationId_idx"
  ON "Order" ("courierCompanyIntegrationId")
  WHERE "courierCompanyIntegrationId" IS NOT NULL;

-- ============================================================================
-- PART 5: EXTEND company_order_settings TABLE
-- ============================================================================
-- Adds courier_booking_mode (automatic vs semi_manual) + a pointer to the
-- default courier integration for automatic booking. Keeps the old
-- defaultCourier text column for display/manual-entry fallback.
--
-- Business rule for future implementation (NOT implemented in schema):
--   courier_booking_mode only applies to orders where order_source = 'manual'.
--   Orders from external platforms ALWAYS require manual courier booking
--   regardless of this setting, no exceptions.

ALTER TABLE "CompanyOrderSetting"
  ADD COLUMN IF NOT EXISTS "courierBookingMode" TEXT NOT NULL DEFAULT 'semi_manual'
    CHECK ("courierBookingMode" IN ('automatic','semi_manual'));

ALTER TABLE "CompanyOrderSetting"
  ADD COLUMN IF NOT EXISTS "defaultCourierCompanyIntegrationId" TEXT
    REFERENCES company_integrations(id) ON DELETE SET NULL;

-- ============================================================================
-- PART 6: ROW LEVEL SECURITY
-- ============================================================================
-- Defense-in-depth RLS on top of the application-layer scoping.
-- RLS is ENABLED (not FORCED) so the postgres role (app connection) bypasses
-- RLS — the app keeps working. Supabase anon/authenticated roles are enforced.

-- ── integration_providers ──
-- SELECT: all authenticated users (global read-only catalog)
-- INSERT/UPDATE/DELETE: DISABLED (platform-level, managed outside normal ops)
ALTER TABLE integration_providers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS integration_providers_select ON integration_providers;
CREATE POLICY integration_providers_select ON integration_providers
  FOR SELECT
  USING (TRUE);
-- No INSERT/UPDATE/DELETE policies → denied by default.

-- ── company_integrations ──
-- SELECT: company_id = get_active_company_id()
-- INSERT/UPDATE: is_elevated_employee(get_active_company_id())
-- DELETE: DISABLED (use is_active = FALSE)
ALTER TABLE company_integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS company_integrations_select ON company_integrations;
CREATE POLICY company_integrations_select ON company_integrations
  FOR SELECT
  USING ("companyId" = get_active_company_id());

DROP POLICY IF EXISTS company_integrations_insert ON company_integrations;
CREATE POLICY company_integrations_insert ON company_integrations
  FOR INSERT
  WITH CHECK (
    "companyId" = get_active_company_id()
    AND is_elevated_employee(get_active_company_id()) IS TRUE
  );

DROP POLICY IF EXISTS company_integrations_update ON company_integrations;
CREATE POLICY company_integrations_update ON company_integrations
  FOR UPDATE
  USING (
    "companyId" = get_active_company_id()
    AND is_elevated_employee(get_active_company_id()) IS TRUE
  )
  WITH CHECK (
    "companyId" = get_active_company_id()
    AND is_elevated_employee(get_active_company_id()) IS TRUE
  );
-- No DELETE policy → denied (use is_active = FALSE).

-- ── integration_action_logs ──
-- SELECT: organization_id = get_active_org_id() AND is_elevated_employee
-- INSERT: system-only (service-role/SECURITY DEFINER context from server actions)
-- UPDATE/DELETE: DISABLED (immutable audit log)
ALTER TABLE integration_action_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS integration_action_logs_select ON integration_action_logs;
CREATE POLICY integration_action_logs_select ON integration_action_logs
  FOR SELECT
  USING (
    "organizationId" = get_active_org_id()
    AND is_elevated_employee(get_active_company_id()) IS TRUE
  );
-- No INSERT/UPDATE/DELETE policies → denied for direct client access.
-- INSERT happens via SECURITY DEFINER server actions (Step 2) which bypass RLS.

COMMIT;

-- ============================================================================
-- END OF MIGRATION 004
-- ============================================================================
-- Summary:
--
--   NEW TABLES (3):
--     integration_providers — master catalog (seeded with 5 providers)
--     company_integrations — company-specific connections (encrypted creds)
--     integration_action_logs — universal call logging (immutable)
--
--   ALTERED TABLES (2):
--     Order + courierCompanyIntegrationId (links to booking integration)
--     CompanyOrderSetting + courierBookingMode + defaultCourierCompanyIntegrationId
--
--   SEEDED DATA:
--     5 providers: tcs, leopard, postex (courier) + shopify, daraz (ecommerce)
--
--   INDEXES (6):
--     integration_providers: providerKey UNIQUE
--     company_integrations: (companyId, isActive), webhookEndpointId UNIQUE partial
--     integration_action_logs: (companyIntegrationId, createdAt DESC),
--       (relatedEntityType, relatedEntityId) partial, (status, createdAt DESC)
--     Order: courierCompanyIntegrationId partial
--
--   TRIGGERS (2):
--     trg_integration_providers_updatedAt, trg_company_integrations_updatedAt
--
--   RLS:
--     integration_providers: SELECT all; no mutation (platform-managed)
--     company_integrations: SELECT by company; INSERT/UPDATE elevated-only; no DELETE
--     integration_action_logs: SELECT by org+elevated; no direct mutation (immutable)
--
-- NEXT STEPS (Step 2 — NOT in this migration):
--   - Encryption utility for credentials_encrypted (Supabase Vault or app-level key)
--   - Adapter interface + base adapter class
--   - Server actions: connectIntegration, testConnection, disconnectIntegration
--   - Webhook route handler using webhook_endpoint_id for routing
--   - Integration action logging helper (called from every adapter method)
--   - Courier booking flow (bookShipment, trackShipment, cancelShipment)
--   - Ecommerce sync (receiveOrder, pushProduct, updateInventory)
-- ============================================================================
