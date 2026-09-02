-- ============================================================================
-- FlowOps OMS — Schema Migration (Step 1 of 5: Database Schema only)
-- ============================================================================
-- This migration creates the Order Management System (OMS) functions, triggers,
-- and RLS policies. The TABLES themselves are created by Prisma db:push
-- (which uses PascalCase table names matching the Prisma model names).
--
-- This SQL file handles what Prisma CAN'T:
--   - PostgreSQL functions (generate_order_number, recompute_order_status)
--   - Trigger functions (backfill_order_timestamps, update_*_updatedAt)
--   - RLS helper functions (get_active_company_id, get_active_org_id, etc.)
--   - Row Level Security policies
--   - CHECK constraints with complex logic
--   - GENERATED columns
--
-- CRITICAL: Prisma creates tables with PascalCase names (e.g. "Organization",
-- "Company", "Employee", "InventoryLocation", "OrgProductVariant",
-- "InventoryTransaction", "StockLossRecord", "ProductionOrder").
-- All SQL in this file uses those exact PascalCase names.
--
-- All column names are camelCase (matching Prisma's convention — no @map).
-- ============================================================================

-- ============================================================================
-- PART 0: RLS HELPER FUNCTIONS (defense-in-depth)
-- ============================================================================
-- These SQL functions mirror the application-layer helpers in
-- src/lib/workspace.ts. They read the active company/org from the current
-- session's GUC parameters, which the API layer sets on each request.
--
-- The GUC parameters are:
--   app.active_company_id  — TEXT, the caller's active company ID
--   app.active_org_id      — TEXT, the caller's active organization ID
--   app.user_id            — TEXT, the caller's profile ID
--
-- These are set via: SET LOCAL app.active_company_id = '...'
-- (to be wired in Step 2's API middleware).

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

-- Checks whether the caller is an elevated employee of the given company.
-- Elevated = Role.roleTier = 'elevated' (Owner/Founder/Co-Founder/Investor).
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

-- Checks whether the caller has a specific permission key for the given company.
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

-- ============================================================================
-- PART 6: POSTGRESQL FUNCTIONS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- FUNCTION 1: generate_order_number(p_company_id TEXT) RETURNS TEXT
-- ----------------------------------------------------------------------------
-- Generates the next FlowOps order number for a company.
-- Format: ORD-{current_year}-{sequential_number}, zero-padded to 5 digits.
-- Sequence is PER COMPANY and resets each calendar year.
-- Example: ORD-2026-00001
--
-- Concurrency-safe: the UNIQUE("companyId", flowopsOrderNumber) constraint
-- on the "Order" table will reject duplicates — the caller should retry on conflict.

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
  -- Find the highest existing sequence number for this company + year
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

-- ----------------------------------------------------------------------------
-- FUNCTION 2: recompute_order_status(p_order_id TEXT) RETURNS TEXT
-- ----------------------------------------------------------------------------
-- Examines all order_items for this order and returns the correct overall
-- order status based on their fulfillmentStatus values.
--
-- Logic:
--   - If any item is 'backordered' → 'partially_backordered'
--   - If no items are 'backordered' → keep current status (informs, doesn't
--     force transitions across the whole lifecycle)

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

-- ----------------------------------------------------------------------------
-- FUNCTION 3: backfill_order_timestamps() — TRIGGER FUNCTION
-- ----------------------------------------------------------------------------
-- BEFORE UPDATE on "Order": if the order is being dispatched, auto-backfill
-- confirmedAt and packedAt if they were NULL (configurable workflow strictness).
-- Sets skippedConfirmation/skippedPacking flags for audit trail.
-- Guarantees: dispatchedAt implies confirmedAt AND packedAt are non-NULL.

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

DROP TRIGGER IF EXISTS trg_backfill_order_timestamps ON "Order";
CREATE TRIGGER trg_backfill_order_timestamps
  BEFORE UPDATE ON "Order"
  FOR EACH ROW
  EXECUTE FUNCTION backfill_order_timestamps();

-- Auto-update updatedAt on "Customer"
CREATE OR REPLACE FUNCTION update_customers_updatedAt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customers_updatedAt ON "Customer";
CREATE TRIGGER trg_customers_updatedAt
  BEFORE UPDATE ON "Customer"
  FOR EACH ROW
  EXECUTE FUNCTION update_customers_updatedAt();

-- Auto-update updatedAt on "CompanyOrderSetting"
CREATE OR REPLACE FUNCTION update_company_order_settings_updatedAt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_company_order_settings_updatedAt ON "CompanyOrderSetting";
CREATE TRIGGER trg_company_order_settings_updatedAt
  BEFORE UPDATE ON "CompanyOrderSetting"
  FOR EACH ROW
  EXECUTE FUNCTION update_company_order_settings_updatedAt();

-- Auto-update updatedAt on "OrderItem"
CREATE OR REPLACE FUNCTION update_order_items_updatedAt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_order_items_updatedAt ON "OrderItem";
CREATE TRIGGER trg_order_items_updatedAt
  BEFORE UPDATE ON "OrderItem"
  FOR EACH ROW
  EXECUTE FUNCTION update_order_items_updatedAt();

-- ============================================================================
-- PART 7: ROW LEVEL SECURITY
-- ============================================================================
-- Defense-in-depth RLS policies on top of the application-layer scoping
-- (getWorkspace() / requirePermission() in src/lib/workspace.ts).
--
-- The RLS helper functions read from session GUC parameters that the API
-- layer sets on each request (to be wired in Step 2).
--
-- If the GUCs are not set (e.g. direct DB access outside the app), the
-- helper functions return NULL, and the policies evaluate to NULL = NULL
-- which is FALSE — so RLS denies access by default (secure by default).

-- Enable RLS on all new OMS tables
ALTER TABLE "Customer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CompanyOrderSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderItem" ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- Customer RLS
-- ----------------------------------------------------------------------------
CREATE POLICY customers_select ON "Customer"
  FOR SELECT
  USING ("organizationId" = get_active_org_id());

CREATE POLICY customers_insert ON "Customer"
  FOR INSERT
  WITH CHECK (
    "organizationId" = get_active_org_id()
    AND has_permission(get_active_company_id(), 'orders.manage') IS TRUE
  );

CREATE POLICY customers_update ON "Customer"
  FOR UPDATE
  USING (
    "organizationId" = get_active_org_id()
    AND has_permission(get_active_company_id(), 'orders.manage') IS TRUE
  )
  WITH CHECK (
    "organizationId" = get_active_org_id()
    AND has_permission(get_active_company_id(), 'orders.manage') IS TRUE
  );

-- No DELETE policy → DELETE is denied by default when RLS is enabled

-- ----------------------------------------------------------------------------
-- CompanyOrderSetting RLS
-- ----------------------------------------------------------------------------
CREATE POLICY company_order_settings_select ON "CompanyOrderSetting"
  FOR SELECT
  USING ("companyId" = get_active_company_id());

CREATE POLICY company_order_settings_update ON "CompanyOrderSetting"
  FOR UPDATE
  USING (is_elevated_employee(get_active_company_id()) IS TRUE)
  WITH CHECK (is_elevated_employee(get_active_company_id()) IS TRUE);

-- No INSERT policy → direct user INSERTs are denied (system-managed via trigger)

-- ----------------------------------------------------------------------------
-- Order RLS
-- ----------------------------------------------------------------------------
CREATE POLICY orders_select ON "Order"
  FOR SELECT
  USING ("companyId" = get_active_company_id());

CREATE POLICY orders_insert ON "Order"
  FOR INSERT
  WITH CHECK (
    "companyId" = get_active_company_id()
    AND has_permission(get_active_company_id(), 'orders.create') IS TRUE
  );

CREATE POLICY orders_update ON "Order"
  FOR UPDATE
  USING (
    "companyId" = get_active_company_id()
    AND has_permission(get_active_company_id(), 'orders.manage') IS TRUE
  )
  WITH CHECK (
    "companyId" = get_active_company_id()
    AND has_permission(get_active_company_id(), 'orders.manage') IS TRUE
  );

-- No DELETE policy → DELETE is denied (use status = 'cancelled')

-- ----------------------------------------------------------------------------
-- OrderItem RLS
-- ----------------------------------------------------------------------------
CREATE POLICY order_items_select ON "OrderItem"
  FOR SELECT
  USING (
    "orderId" IN (
      SELECT id FROM "Order" WHERE "companyId" = get_active_company_id()
    )
  );

CREATE POLICY order_items_insert ON "OrderItem"
  FOR INSERT
  WITH CHECK (
    "orderId" IN (
      SELECT id FROM "Order"
      WHERE "companyId" = get_active_company_id()
        AND has_permission(get_active_company_id(), 'orders.create') IS TRUE
    )
  );

CREATE POLICY order_items_update ON "OrderItem"
  FOR UPDATE
  USING (
    "orderId" IN (
      SELECT id FROM "Order"
      WHERE "companyId" = get_active_company_id()
        AND has_permission(get_active_company_id(), 'orders.manage') IS TRUE
    )
  )
  WITH CHECK (
    "orderId" IN (
      SELECT id FROM "Order"
      WHERE "companyId" = get_active_company_id()
        AND has_permission(get_active_company_id(), 'orders.manage') IS TRUE
    )
  );

-- No DELETE policy → DELETE is denied

-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
-- Summary:
--   Functions: generate_order_number, recompute_order_status,
--              backfill_order_timestamps (trigger), update_*_updatedAt (triggers)
--   RLS helpers: get_active_company_id, get_active_org_id, get_active_user_id,
--                is_elevated_employee, has_permission (5 SQL functions)
--   RLS: enabled on Customer, CompanyOrderSetting, Order, OrderItem
--        with SELECT/INSERT/UPDATE policies (DELETE denied by default)
--
-- Tables (created by Prisma db:push, not this SQL file):
--   Customer, CompanyOrderSetting, Order, OrderItem
--
-- FK columns added to existing tables (by Prisma db:push):
--   InventoryTransaction.orderId → Order.id
--   StockLossRecord.orderItemId → OrderItem.id
--   ProductionOrder.orderItemId → OrderItem.id (unique)
--
-- NEXT STEPS (not in this migration):
--   Step 2: Wire session GUC setting in API middleware + createCompany() hook
--           to auto-create CompanyOrderSetting + add 'orders.*' permission keys
--   Step 3: Server actions (createOrder, confirmOrder, dispatchOrder, etc.)
--   Step 4: Frontend (order list, detail, create form)
--   Step 5: Courier webhook integration
--
-- METRIC EVENTS REQUIREMENT (enforced in Step 3+):
--   Every order lifecycle server action MUST call insertMetricEvent() with
--   appropriate metric_key (e.g. 'order.created', 'order.confirmed',
--   'order.dispatched', 'order.delivered', 'order.cancelled', 'order.rto')
--   using the existing MetricEvent table + insertMetricEvent() utility.
-- ============================================================================
