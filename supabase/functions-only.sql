-- ════════════════════════════════════════════════════════════════════
-- FlowOps ERP — SQL Functions, Sequences, and Triggers
-- ════════════════════════════════════════════════════════════════════
--
-- This file contains ONLY the CREATE FUNCTION, CREATE TRIGGER, and
-- CREATE SEQUENCE statements extracted from supabase/migrations/*.sql.
-- Tables, columns, and plain indexes are created by `prisma db push` —
-- this file does NOT contain any CREATE TABLE or ALTER TABLE.
--
-- Apply after `prisma db push` against a fresh local DB:
--   cat supabase/functions-only.sql | docker exec -i flowops-local-db psql -U flowops -d flowops_local
--
-- Or against any Postgres instance:
--   cat supabase/functions-only.sql | psql "$DATABASE_URL"
--
-- All statements are idempotent (CREATE OR REPLACE / IF NOT EXISTS /
-- DROP IF EXISTS before CREATE). Safe to re-run.
--
-- Ordering: sequences → functions (dependency-ordered) → triggers
-- (after their referenced trigger functions).
--
-- Source: migrations 001–008 (migrations 009–021 contain no
-- functions/triggers/sequences — only tables, columns, indexes, CHECKs).
-- ════════════════════════════════════════════════════════════════════

-- ─── SEQUENCES ──────────────────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS draft_order_number_seq
  START WITH 1
  INCREMENT BY 1
  NO CYCLE;

CREATE SEQUENCE IF NOT EXISTS exchange_shipment_number_seq
  START WITH 1 INCREMENT BY 1 NO CYCLE;

-- ─── FUNCTIONS: RLS helpers (no dependencies) ───────────────────────

CREATE OR REPLACE FUNCTION get_active_company_id()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.active_company_id', true), '')::TEXT;
$$;

CREATE OR REPLACE FUNCTION get_active_org_id()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.active_org_id', true), '')::TEXT;
$$;

CREATE OR REPLACE FUNCTION get_active_user_id()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::TEXT;
$$;

-- ─── FUNCTIONS: depend on get_active_user_id() ─────────────────────

CREATE OR REPLACE FUNCTION is_elevated_employee(p_company_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "Employee" e
    JOIN "Role" r ON e."roleId" = r.id
    WHERE e."companyId" = p_company_id
      AND e."userId" = get_active_user_id()
      AND e.status = 'active'
      AND r."roleTier" = 'elevated'
  );
$$;

CREATE OR REPLACE FUNCTION has_permission(p_company_id TEXT, p_permission_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "Employee" e
    JOIN "Role" r ON e."roleId" = r.id
    WHERE e."companyId" = p_company_id
      AND e."userId" = get_active_user_id()
      AND e.status = 'active'
      AND (
        r."roleTier" = 'elevated'
        OR EXISTS (
          SELECT 1
          FROM "RolePermission" rp
          WHERE rp."roleId" = r.id
            AND rp."permissionKey" = p_permission_key
        )
      )
  );
$$;

-- ─── FUNCTIONS: order number generation + status ───────────────────

CREATE OR REPLACE FUNCTION generate_order_number(p_company_id TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_year           INT := EXTRACT(YEAR FROM NOW());
  v_prefix         TEXT := 'ORD-' || v_year || '-';
  v_max_seq        INT;
  v_next_seq       INT;
  v_result         TEXT;
BEGIN
  SELECT COALESCE(MAX(
    CAST(
      SUBSTRING("flowopsOrderNumber" FROM LENGTH(v_prefix) + 1) AS INT
    )
  ), 0)
  INTO v_max_seq
  FROM "Order"
  WHERE "companyId" = p_company_id
    AND "flowopsOrderNumber" LIKE v_prefix || '%';

  v_next_seq := v_max_seq + 1;
  v_result := v_prefix || LPAD(v_next_seq::TEXT, 5, '0');

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION recompute_order_status(p_order_id TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_current_status   TEXT;
  v_has_backordered  BOOLEAN;
  v_result           TEXT;
BEGIN
  SELECT status INTO v_current_status FROM "Order" WHERE id = p_order_id;

  SELECT EXISTS (
    SELECT 1 FROM "OrderItem"
    WHERE "orderId" = p_order_id
      AND "fulfillmentStatus" = 'backordered'
  ) INTO v_has_backordered;

  IF v_has_backordered THEN
    v_result := 'partially_backordered';
  ELSE
    v_result := v_current_status;
  END IF;

  RETURN v_result;
END;
$$;

-- ─── FUNCTIONS: trigger functions (updatedAt pattern) ──────────────

CREATE OR REPLACE FUNCTION backfill_order_timestamps()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'dispatched' AND NEW."dispatchedAt" IS NOT NULL THEN
    IF OLD."confirmedAt" IS NULL AND NEW."confirmedAt" IS NULL THEN
      NEW."confirmedAt" := NEW."dispatchedAt";
      NEW."skippedConfirmation" := TRUE;
    END IF;
    IF OLD."packedAt" IS NULL AND NEW."packedAt" IS NULL THEN
      NEW."packedAt" := NEW."dispatchedAt";
      NEW."skippedPacking" := TRUE;
    END IF;
  END IF;

  NEW."updatedAt" := NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION update_customers_updatedAt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION update_company_order_settings_updatedAt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION update_order_items_updatedAt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION update_customer_addresses_updatedAt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION update_order_exchanges_updatedAt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION update_integration_providers_updatedAt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION update_company_integrations_updatedAt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION update_form_drafts_updatedAt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION update_courier_operational_cities_updatedAt()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION update_courier_pickup_addresses_updatedAt()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION update_exchange_shipments_updatedAt()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END; $$;

-- ─── FUNCTIONS: phone normalization (IMMUTABLE) ────────────────────

CREATE OR REPLACE FUNCTION normalize_phone(p_raw_phone TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_digits TEXT;
  v_len    INT;
  v_trimmed TEXT;
BEGIN
  IF p_raw_phone IS NULL OR BTRIM(p_raw_phone) = '' THEN
    RETURN NULL;
  END IF;

  v_trimmed := BTRIM(p_raw_phone);

  -- ── International pass-through (Phase: Country System) ──
  -- If the number starts with '+' and is NOT a Pakistani number (+92...),
  -- assume it's already in E.164 format (the TS layer's
  -- validateAndNormalizePhone() normalizes international numbers correctly
  -- via libphonenumber-js before calling this function). Pass it through
  -- unchanged — do NOT blindly prepend +92 (which silently mangles foreign
  -- numbers, e.g. +447911123456 → +92447911123456).
  -- Pakistani +92 numbers fall through to the digit-based logic below
  -- (which handles them correctly: 12 digits starting with 92 → +92...).
  IF v_trimmed LIKE '+%' AND v_trimmed NOT LIKE '+92%' THEN
    RETURN v_trimmed;
  END IF;

  v_digits := REGEXP_REPLACE(p_raw_phone, '[^0-9]', '', 'g');
  v_len    := LENGTH(v_digits);

  IF v_len = 0 THEN
    RETURN NULL;
  END IF;

  IF v_len = 12 AND v_digits LIKE '92%' THEN
    RETURN '+' || v_digits;
  END IF;

  IF v_len = 11 AND v_digits LIKE '0%' THEN
    RETURN '+92' || SUBSTRING(v_digits FROM 2);
  END IF;

  IF v_len = 10 THEN
    RETURN '+92' || v_digits;
  END IF;

  IF v_len BETWEEN 10 AND 13 THEN
    IF v_digits LIKE '0%' THEN
      v_digits := SUBSTRING(v_digits FROM 2);
    END IF;
    RETURN '+92' || v_digits;
  END IF;

  RETURN '+' || v_digits;
END;
$$;

-- ─── FUNCTIONS: customer matching (depends on normalize_phone) ─────

CREATE OR REPLACE FUNCTION match_or_create_customer(
  p_organization_id      TEXT,
  p_platform             TEXT,
  p_external_customer_id TEXT,
  p_phone                TEXT DEFAULT NULL,
  p_email                TEXT DEFAULT NULL,
  p_name                 TEXT DEFAULT NULL,
  -- p_country (Phase: Country System): optional ISO 3166-1 alpha-2 code
  -- (e.g. "PK", "GB"). The SQL function does NOT create a customer_addresses
  -- row (it lacks address/city, which are NOT NULL). The caller (e.g.
  -- createOrderFromShopifyWebhook) persists p_country onto the
  -- customer_addresses row it creates separately for newly-created customers.
  -- Accepted here so the param flows through the match API cleanly + is
  -- available for future SQL-level use (e.g. logging, defaulting).
  p_country              TEXT DEFAULT 'PK'
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_id      TEXT;
  v_normalized_phone TEXT;
  v_lock_key         BIGINT;
BEGIN
  SELECT cei."customerId" INTO v_customer_id
  FROM customer_external_identities cei
  WHERE cei."organizationId" = p_organization_id
    AND cei.platform = p_platform
    AND cei."externalCustomerId" = p_external_customer_id
  LIMIT 1;

  IF v_customer_id IS NOT NULL THEN
    RETURN v_customer_id;
  END IF;

  IF p_phone IS NOT NULL AND BTRIM(p_phone) <> '' THEN
    v_normalized_phone := normalize_phone(p_phone);
    IF v_normalized_phone IS NOT NULL THEN
      SELECT cp."customerId" INTO v_customer_id
      FROM customer_phones cp
      WHERE cp."organizationId" = p_organization_id
        AND cp."phoneNormalized" = v_normalized_phone
      LIMIT 1;

      IF v_customer_id IS NOT NULL THEN
        INSERT INTO customer_external_identities
          ("customerId", "organizationId", platform, "externalCustomerId", "matchedVia")
        VALUES
          (v_customer_id, p_organization_id, p_platform, p_external_customer_id, 'phone_match')
        ON CONFLICT ("organizationId", platform, "externalCustomerId") DO NOTHING;
        RETURN v_customer_id;
      END IF;
    END IF;
  END IF;

  IF p_email IS NOT NULL AND BTRIM(p_email) <> '' THEN
    SELECT c.id INTO v_customer_id
    FROM "Customer" c
    WHERE c."organizationId" = p_organization_id
      AND c.email = p_email
    LIMIT 1;

    IF v_customer_id IS NOT NULL THEN
      INSERT INTO customer_external_identities
        ("customerId", "organizationId", platform, "externalCustomerId", "matchedVia")
      VALUES
        (v_customer_id, p_organization_id, p_platform, p_external_customer_id, 'email_match')
      ON CONFLICT ("organizationId", platform, "externalCustomerId") DO NOTHING;
      RETURN v_customer_id;
    END IF;
  END IF;

  v_lock_key := hashtextextended(
    p_organization_id || ':' || p_platform || ':' || p_external_customer_id,
    0
  );
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT cei."customerId" INTO v_customer_id
  FROM customer_external_identities cei
  WHERE cei."organizationId" = p_organization_id
    AND cei.platform = p_platform
    AND cei."externalCustomerId" = p_external_customer_id
  LIMIT 1;

  IF v_customer_id IS NOT NULL THEN
    RETURN v_customer_id;
  END IF;

  INSERT INTO "Customer" ("organizationId", name, email)
  VALUES (p_organization_id, COALESCE(NULLIF(BTRIM(p_name), ''), 'Unknown Customer'), NULLIF(BTRIM(p_email), ''))
  RETURNING id INTO v_customer_id;

  IF p_phone IS NOT NULL AND BTRIM(p_phone) <> '' THEN
    v_normalized_phone := normalize_phone(p_phone);
    IF v_normalized_phone IS NOT NULL THEN
      INSERT INTO customer_phones
        ("customerId", "organizationId", "phoneRaw", "phoneNormalized", "isPrimary", label)
      VALUES
        (v_customer_id, p_organization_id, p_phone, v_normalized_phone, TRUE, 'Primary')
      ON CONFLICT ("organizationId", "phoneNormalized") DO NOTHING;
    END IF;
  END IF;

  INSERT INTO customer_external_identities
    ("customerId", "organizationId", platform, "externalCustomerId", "matchedVia")
  VALUES
    (v_customer_id, p_organization_id, p_platform, p_external_customer_id, 'exact_identity');

  RETURN v_customer_id;
END;
$$;

-- ─── FUNCTIONS: number generators (depend on sequences) ────────────

-- generate_self_fulfilled_reference: PER-COMPANY sequence for self-fulfilled
-- orders. Mirrors generate_order_number()'s MAX-based structure (NOT the
-- global exchange-shipment sequence pattern). Format: SF-{year}-{seq},
-- zero-padded 5 digits (e.g. SF-2026-00001). Scoped per-company via the
-- companyId filter on the MAX query.
CREATE OR REPLACE FUNCTION generate_self_fulfilled_reference(p_company_id TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_year           INT := EXTRACT(YEAR FROM NOW());
  v_prefix         TEXT := 'SF-' || v_year || '-';
  v_max_seq        INT;
  v_next_seq       INT;
  v_result         TEXT;
BEGIN
  -- Find the highest existing sequence number for this company + year
  SELECT COALESCE(MAX(
    CAST(
      SUBSTRING("selfFulfilledReferenceNumber" FROM LENGTH(v_prefix) + 1) AS INT
    )
  ), 0)
  INTO v_max_seq
  FROM "Order"
  WHERE "companyId" = p_company_id
    AND "selfFulfilledReferenceNumber" LIKE v_prefix || '%';

  v_next_seq := v_max_seq + 1;
  v_result := v_prefix || LPAD(v_next_seq::TEXT, 5, '0');

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION generate_draft_number()
RETURNS TEXT
LANGUAGE sql
AS $$
  SELECT 'DRAFT-' || LPAD(nextval('draft_order_number_seq')::TEXT, 5, '0');
$$;

CREATE OR REPLACE FUNCTION generate_exchange_shipment_number()
RETURNS TEXT LANGUAGE sql AS $$
  SELECT 'EXCH-' || EXTRACT(YEAR FROM NOW())::TEXT || '-' ||
         LPAD(nextval('exchange_shipment_number_seq')::TEXT, 5, '0');
$$;

-- ─── TRIGGERS (after their referenced trigger functions) ───────────

DROP TRIGGER IF EXISTS trg_backfill_order_timestamps ON "Order";
CREATE TRIGGER trg_backfill_order_timestamps
  BEFORE UPDATE ON "Order"
  FOR EACH ROW
  EXECUTE FUNCTION backfill_order_timestamps();

DROP TRIGGER IF EXISTS trg_customers_updatedAt ON "Customer";
CREATE TRIGGER trg_customers_updatedAt
  BEFORE UPDATE ON "Customer"
  FOR EACH ROW
  EXECUTE FUNCTION update_customers_updatedAt();

DROP TRIGGER IF EXISTS trg_company_order_settings_updatedAt ON "CompanyOrderSetting";
CREATE TRIGGER trg_company_order_settings_updatedAt
  BEFORE UPDATE ON "CompanyOrderSetting"
  FOR EACH ROW
  EXECUTE FUNCTION update_company_order_settings_updatedAt();

DROP TRIGGER IF EXISTS trg_order_items_updatedAt ON "OrderItem";
CREATE TRIGGER trg_order_items_updatedAt
  BEFORE UPDATE ON "OrderItem"
  FOR EACH ROW
  EXECUTE FUNCTION update_order_items_updatedAt();

DROP TRIGGER IF EXISTS trg_customer_addresses_updatedAt ON customer_addresses;
CREATE TRIGGER trg_customer_addresses_updatedAt
  BEFORE UPDATE ON customer_addresses
  FOR EACH ROW
  EXECUTE FUNCTION update_customer_addresses_updatedAt();

DROP TRIGGER IF EXISTS trg_order_exchanges_updatedAt ON order_exchanges;
CREATE TRIGGER trg_order_exchanges_updatedAt
  BEFORE UPDATE ON order_exchanges
  FOR EACH ROW
  EXECUTE FUNCTION update_order_exchanges_updatedAt();

DROP TRIGGER IF EXISTS trg_integration_providers_updatedAt ON integration_providers;
CREATE TRIGGER trg_integration_providers_updatedAt
  BEFORE UPDATE ON integration_providers
  FOR EACH ROW
  EXECUTE FUNCTION update_integration_providers_updatedAt();

DROP TRIGGER IF EXISTS trg_company_integrations_updatedAt ON company_integrations;
CREATE TRIGGER trg_company_integrations_updatedAt
  BEFORE UPDATE ON company_integrations
  FOR EACH ROW
  EXECUTE FUNCTION update_company_integrations_updatedAt();

DROP TRIGGER IF EXISTS trg_form_drafts_updatedAt ON form_drafts;
CREATE TRIGGER trg_form_drafts_updatedAt
  BEFORE UPDATE ON form_drafts
  FOR EACH ROW
  EXECUTE FUNCTION update_form_drafts_updatedAt();

DROP TRIGGER IF EXISTS trg_courier_operational_cities_updatedAt ON courier_operational_cities;
CREATE TRIGGER trg_courier_operational_cities_updatedAt
  BEFORE UPDATE ON courier_operational_cities
  FOR EACH ROW EXECUTE FUNCTION update_courier_operational_cities_updatedAt();

DROP TRIGGER IF EXISTS trg_courier_pickup_addresses_updatedAt ON courier_pickup_addresses;
CREATE TRIGGER trg_courier_pickup_addresses_updatedAt
  BEFORE UPDATE ON courier_pickup_addresses
  FOR EACH ROW EXECUTE FUNCTION update_courier_pickup_addresses_updatedAt();

DROP TRIGGER IF EXISTS trg_exchange_shipments_updatedAt ON exchange_shipments;
CREATE TRIGGER trg_exchange_shipments_updatedAt
  BEFORE UPDATE ON exchange_shipments
  FOR EACH ROW EXECUTE FUNCTION update_exchange_shipments_updatedAt();


-- ─────────────────────────────────────────────────────────────────────────────
-- Partial unique index: only one pending invitation per email per company.
-- Allows re-inviting after a prior invite expires or is cancelled/accepted.
-- Applied manually (Prisma doesn't support partial unique indexes in schema.prisma).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS invitation_pending_email_unique
  ON "Invitation" ("companyId", "invitedEmail")
  WHERE status = 'pending';

-- ─────────────────────────────────────────────────────────────────────────────
-- Partial unique index: exactly one isDefault=true Market per company.
-- Enforces the "one Default market per company" invariant at the DB level
-- (Prisma can't express conditional unique constraints in schema.prisma).
-- Follows the same precedent as invitation_pending_email_unique +
-- customer_phones_one_primary_idx + customer_addresses_one_default_idx.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS market_one_default_per_company
  ON "Market" ("companyId")
  WHERE "isDefault" = TRUE;
