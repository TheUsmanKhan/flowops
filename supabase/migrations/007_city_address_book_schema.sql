-- ============================================================================
-- FlowOps — City & Address Book System (Courier-Agnostic Foundation)
-- ============================================================================
-- This migration builds the foundational city caching/validation system and
-- pickup/return address book, both scoped per company-integration, to be used
-- by ALL courier adapters (PostEx now, TCS/Leopard later).
--
-- Three new tables:
--   1. courier_operational_cities — global, provider-level cache of which
--      cities each courier serves (not company-scoped — cities don't vary
--      per company).
--   2. courier_city_aliases — "city learning" fuzzy-match memory. When a
--      staff member manually confirms a suggested/corrected city, the mapping
--      is saved here so it auto-resolves next time.
--   3. courier_pickup_addresses — pickup/return address book per
--      company_integration. PostEx's API returns addressType="Pickup/Return
--      Address" (one address serves both), so we do NOT build separate
--      pickup vs return concepts.
--
-- Plus:
--   - Order.courierCityStatus — tracks city validation state per order.
--
-- Design follows the same conventions as migration 004:
--   - TEXT PKs with DEFAULT gen_random_uuid()::text
--   - lowercase table names (new SQL-managed tables)
--   - double-quoted camelCase columns
--   - RLS ENABLED (not FORCED) for defense-in-depth
-- ============================================================================

BEGIN;

-- ============================================================================
-- PART 1: courier_operational_cities TABLE
-- ============================================================================
-- Global, provider-level cache of which cities each courier serves.
-- NOT company-scoped — cities don't vary per company, so one merchant's
-- token is enough to fetch the shared city list for a provider.

CREATE TABLE IF NOT EXISTS courier_operational_cities (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "providerKey"         TEXT NOT NULL,
  -- e.g. 'postex', 'tcs', 'leopard' — matches integration_providers.providerKey

  "cityName"            TEXT NOT NULL,
  -- Human-readable city name as returned by the courier API (e.g. "Karachi")

  "cityId"              TEXT,
  -- Courier's own numeric/string city identifier if provided (e.g. PostEx's
  -- cityId). Nullable — not all couriers assign IDs. Stored as TEXT always,
  -- never assumed numeric.

  "isPickupCity"        BOOLEAN NOT NULL DEFAULT TRUE,
  "isDeliveryCity"      BOOLEAN NOT NULL DEFAULT TRUE,
  -- If a city is no longer in the fresh sync response, both are set to FALSE
  -- (not deleted — historical references aren't broken, but it stops being
  -- offered/matched going forward).

  "lastSyncedAt"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint on (providerKey, cityName)
CREATE UNIQUE INDEX IF NOT EXISTS courier_operational_cities_provider_city_idx
  ON courier_operational_cities ("providerKey", "cityName");

-- Index for fast lookup of delivery cities per provider
CREATE INDEX IF NOT EXISTS courier_operational_cities_provider_delivery_idx
  ON courier_operational_cities ("providerKey")
  WHERE "isDeliveryCity" = TRUE;

-- Trigger for updatedAt
CREATE OR REPLACE FUNCTION update_courier_operational_cities_updatedAt()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_courier_operational_cities_updatedAt ON courier_operational_cities;
CREATE TRIGGER trg_courier_operational_cities_updatedAt
  BEFORE UPDATE ON courier_operational_cities
  FOR EACH ROW EXECUTE FUNCTION update_courier_operational_cities_updatedAt();

-- ============================================================================
-- PART 2: courier_city_aliases TABLE
-- ============================================================================
-- "City learning" fuzzy-match memory. When a staff member manually confirms
-- a suggested/corrected city (e.g. "Karaci" → "Karachi"), the mapping is
-- saved here so it auto-resolves next time without re-asking.
--
-- companyId is nullable:
--   NULL = org-wide learned alias (applies to all companies)
--   set  = company-specific alias (takes priority over org-wide)

CREATE TABLE IF NOT EXISTS courier_city_aliases (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "providerKey"         TEXT NOT NULL,

  "typedCityText"       TEXT NOT NULL,
  -- Lowercased/normalized text the user typed (e.g. "karaci")

  "resolvedCityName"    TEXT NOT NULL,
  -- The confirmed city name from courier_operational_cities (e.g. "Karachi")

  "companyId"           TEXT REFERENCES "Company"(id) ON DELETE CASCADE,
  -- NULL = org-wide; set = company-specific (priority)

  "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique on (providerKey, typedCityText, companyId) treating NULL companyId
-- as its own bucket. Postgres treats NULL as distinct in unique indexes by
-- default, so a standard unique index works here.
CREATE UNIQUE INDEX IF NOT EXISTS courier_city_aliases_provider_typed_company_idx
  ON courier_city_aliases ("providerKey", "typedCityText", "companyId");

-- Index for fast lookup by provider + typed text
CREATE INDEX IF NOT EXISTS courier_city_aliases_provider_typed_idx
  ON courier_city_aliases ("providerKey", "typedCityText");

-- ============================================================================
-- PART 3: courier_pickup_addresses TABLE
-- ============================================================================
-- Pickup/return address book per company_integration. PostEx's API returns
-- addressType="Pickup/Return Address" (one address serves both), so we do
-- NOT build separate pickup vs return concepts — one address book serves
-- both purposes for a given companyIntegration.

CREATE TABLE IF NOT EXISTS courier_pickup_addresses (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "companyIntegrationId" TEXT NOT NULL REFERENCES company_integrations(id) ON DELETE CASCADE,

  "providerAddressCode" TEXT NOT NULL,
  -- Courier's own address code (e.g. PostEx's addressCode). Stored as TEXT
  -- always, never assumed numeric.

  "label"               TEXT NOT NULL,
  -- User-defined friendly name (e.g. "Main Warehouse", "Office")

  "address"             TEXT NOT NULL,
  "cityName"            TEXT NOT NULL,

  "contactPersonName"   TEXT NOT NULL,
  "phone1"              TEXT NOT NULL,
  "phone2"              TEXT,

  "isDefault"           BOOLEAN NOT NULL DEFAULT FALSE,
  -- Only one row per companyIntegrationId may have isDefault=true.
  -- Enforced via application logic in the server action (not a DB constraint,
  -- to keep this simple — same pattern as setDefaultIntegration).

  "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS courier_pickup_addresses_integration_idx
  ON courier_pickup_addresses ("companyIntegrationId");

CREATE OR REPLACE FUNCTION update_courier_pickup_addresses_updatedAt()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_courier_pickup_addresses_updatedAt ON courier_pickup_addresses;
CREATE TRIGGER trg_courier_pickup_addresses_updatedAt
  BEFORE UPDATE ON courier_pickup_addresses
  FOR EACH ROW EXECUTE FUNCTION update_courier_pickup_addresses_updatedAt();

-- ============================================================================
-- PART 4: Order.courierCityStatus COLUMN
-- ============================================================================
-- Tracks city validation state per order. Added now but left unused until
-- Prompt 4/5 wire it up. Do not add business logic touching Order in this
-- prompt.

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "courierCityStatus" TEXT NOT NULL DEFAULT 'not_applicable'
    CHECK ("courierCityStatus" IN ('matched', 'unresolved', 'not_applicable'));

-- ============================================================================
-- PART 5: ROW LEVEL SECURITY
-- ============================================================================
-- Defense-in-depth RLS on top of the application-layer scoping.
-- RLS is ENABLED (not FORCED) so the postgres role (app connection) bypasses
-- RLS — the app keeps working. Supabase anon/authenticated roles are enforced.

-- ── courier_operational_cities ──
-- Global read-only catalog: SELECT for all authenticated users.
-- INSERT/UPDATE: denied by default (sync job uses SECURITY DEFINER or
-- postgres role). DELETE: denied (cities are soft-disabled, not deleted).
ALTER TABLE courier_operational_cities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS courier_operational_cities_select ON courier_operational_cities;
CREATE POLICY courier_operational_cities_select ON courier_operational_cities
  FOR SELECT USING (TRUE);
-- No INSERT/UPDATE/DELETE policies → denied by default for anon/authenticated.
-- The sync job runs through the app (postgres role bypasses RLS).

-- ── courier_city_aliases ──
-- SELECT: all authenticated users (aliases are shared knowledge).
-- INSERT/UPDATE/DELETE: denied by default (managed through server actions
-- using the postgres role).
ALTER TABLE courier_city_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS courier_city_aliases_select ON courier_city_aliases;
CREATE POLICY courier_city_aliases_select ON courier_city_aliases
  FOR SELECT USING (TRUE);

-- ── courier_pickup_addresses ──
-- SELECT: company match (via companyIntegrationId → company_integrations.companyId).
-- INSERT/UPDATE/DELETE: denied by default (managed through server actions
-- which do their own company-scoping via getWorkspace()).
ALTER TABLE courier_pickup_addresses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS courier_pickup_addresses_select ON courier_pickup_addresses;
CREATE POLICY courier_pickup_addresses_select ON courier_pickup_addresses
  FOR SELECT USING (
    "companyIntegrationId" IN (
      SELECT id FROM company_integrations WHERE "companyId" = get_active_company_id()
    )
  );

COMMIT;
