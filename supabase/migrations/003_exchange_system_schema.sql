-- ============================================================================
-- FlowOps — Item Exchange System Schema (Step 1: Schema + RLS only)
-- ============================================================================
-- This migration adds the order_exchanges table — the core of the Item
-- Exchange System. It extends the existing OMS (orders, order_items) and
-- integrates with the Customer Management System (customer flagging) and the
-- Inventory system (receiveReturnedStitchedItem / receiveReturn are called
-- by Step 2's server actions once the old item is manually verified — NOT
-- reimplemented here).
--
-- ============================================================================
-- ADAPTATIONS FROM SPEC (necessary to integrate with the live schema)
-- ============================================================================
-- The spec was written in idealized PostgreSQL terms (UUID PKs, snake_case
-- columns, lowercase table name `order_exchanges`). The live FlowOps schema
-- uses the opposite conventions because it was built with Prisma:
--   - All IDs are TEXT (cuid). UUID FK columns could not reference the
--     TEXT id columns of "Order", "OrderItem", "Organization", "Company",
--     "Employee", "OrgProductVariant", "InventoryTransaction",
--     "StockLossRecord". So every FK column here is TEXT.
--   - The PK uses DEFAULT gen_random_uuid()::text so raw-SQL inserts (from
--     future server actions) get a DB-generated id, while Prisma client
--     inserts override with a cuid (same pattern as migration 002).
--   - All camelCase columns are double-quoted to preserve casing (matching
--     the existing "Order", "OrderItem", "Customer" tables). The table name
--     itself is lowercase `order_exchanges` per the spec — it's a new table,
--     not Prisma-managed, so lowercase is fine and matches the spec.
--   - RLS helper functions get_active_company_id() / has_permission() return
--     TEXT — so the policies compare TEXT to TEXT (no cast needed).
--
-- All other semantics — the two exchange methods with their distinct state
-- sequences, the nullable new_order_id/new_order_item_id (late-populated for
-- customer_self_return), the price-difference tracking, the
-- "customer_did_not_return" terminal outcome, the GENERATED price_difference
-- column — follow the spec exactly.
-- ============================================================================

BEGIN;

-- ============================================================================
-- PART 1: order_exchanges TABLE
-- ============================================================================
-- Tracks a single item exchange: the OLD item being exchanged away, the NEW
-- variant being sent in its place, the exchange method (courier_replacement
-- vs customer_self_return), the full state machine, the old-item verification
-- metadata, the price-difference settlement, and the "did not return"
-- recovery case.
--
-- CRITICAL SEQUENCING (enforced by Step 2's server actions, not the DB):
--   courier_replacement:    approve → dispatch new item → (courier collects old)
--                           → await return → manually verify old → complete
--   customer_self_return:   approve → await customer to ship → customer
--                           confirmed shipped → await physical arrival →
--                           manually verify old → create+dispatch new order
--                           → complete
--
-- The DB only enforces: (a) status is one of the allowed values, (b)
-- marked_as_not_returned=true implies status='customer_did_not_return', (c)
-- price_difference is GENERATED from new-old. The state-machine transitions
-- are enforced at the application layer (Step 2) where the business rules
-- about sequencing live.

CREATE TABLE IF NOT EXISTS order_exchanges (
  id                            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId"              TEXT NOT NULL REFERENCES "Organization"(id),
  "companyId"                   TEXT NOT NULL REFERENCES "Company"(id),

  -- The OLD item being exchanged away (the original order_item).
  "originalOrderId"             TEXT NOT NULL REFERENCES "Order"(id),
  "originalOrderItemId"         TEXT NOT NULL REFERENCES "OrderItem"(id),

  -- The NEW variant being sent in its place. newOrgVariantId is known at
  -- request time (the customer wants THIS variant). newOrderId /
  -- newOrderItemId are populated only once the linked exchange order is
  -- created — which for customer_self_return happens LATE (after old item
  -- verification), not at request time. Hence nullable.
  "newOrgVariantId"             TEXT NOT NULL REFERENCES "OrgProductVariant"(id),
  "newOrderId"                  TEXT REFERENCES "Order"(id),
  "newOrderItemId"              TEXT REFERENCES "OrderItem"(id),

  -- Two distinct exchange methods with different sequencing (see business
  -- context point 2 in the spec).
  "exchangeMethod"              TEXT NOT NULL
                                  CHECK ("exchangeMethod" IN
                                    ('courier_replacement','customer_self_return')),

  -- The state machine. Statuses grouped by which path uses them:
  --   shared start:          'requested'
  --   courier_replacement:   'new_item_dispatched' → 'awaiting_old_item_return'
  --   customer_self_return:  'awaiting_customer_to_ship_old_item'
  --                          → 'customer_confirmed_shipped'
  --   shared verification:   'old_item_manually_verified'
  --   shared terminal:       'completed', 'customer_did_not_return', 'cancelled'
  "status"                      TEXT NOT NULL DEFAULT 'requested'
                                  CHECK ("status" IN (
                                    'requested',
                                    'new_item_dispatched',
                                    'awaiting_old_item_return',
                                    'awaiting_customer_to_ship_old_item',
                                    'customer_confirmed_shipped',
                                    'old_item_manually_verified',
                                    'completed',
                                    'customer_did_not_return',
                                    'cancelled'
                                  )),

  -- ── Old item verification (manual — see business context point 3) ──
  -- No courier API confirms old item arrival. A warehouse employee
  -- physically opens/inspects the returned parcel and records the condition
  -- + evidence. This is the ONLY signal that triggers the inventory
  -- receiveReturnedStitchedItem()/receiveReturn() calls (Step 2).
  "oldItemCondition"            TEXT
                                  CHECK ("oldItemCondition" IN
                                    ('perfect','good','open_box','damaged')),
  "oldItemVerifiedAt"           TIMESTAMPTZ,
  "oldItemVerifiedBy"           TEXT REFERENCES "Employee"(id),
  "oldItemEvidenceUrls"         JSONB NOT NULL DEFAULT '[]'::jsonb,
  "oldItemNotes"                TEXT,

  -- Links to the inventory transaction + optional stock_loss record created
  -- when the old item is received back. oldItemStockLossId is populated only
  -- if oldItemCondition = 'damaged' (the item can't be resold).
  "oldItemInventoryTxnId"       TEXT REFERENCES "InventoryTransaction"(id),
  "oldItemStockLossId"          TEXT REFERENCES "StockLossRecord"(id),

  -- ── Customer self-return specific fields (business context point 4) ──
  -- The customer arranges their own return shipment. These fields track
  -- their provided tracking info + the "customer confirmed they shipped it"
  -- checkpoint (set by an employee after phone/WhatsApp contact), which is
  -- SEPARATE FROM and PRIOR TO actual physical arrival/verification.
  "customerReturnTrackingNumber" TEXT,
  "customerReturnCourier"        TEXT,
  "customerConfirmedShippedAt"   TIMESTAMPTZ,
  "customerConfirmedShippedBy"   TEXT REFERENCES "Employee"(id),

  -- ── Price difference (business context point 5) ──
  -- price_difference = new - old. If positive, customer owes; if negative,
  -- refund due. This is a DISTINCT financial event from the original order's
  -- payment — tracked here, not merged into the order.
  "oldItemPrice"                NUMERIC(12,2) NOT NULL,
  "newItemPrice"                NUMERIC(12,2) NOT NULL,
  "priceDifference"             NUMERIC(12,2) GENERATED ALWAYS AS
                                  ("newItemPrice" - "oldItemPrice") STORED,
  "priceDifferenceStatus"       TEXT NOT NULL DEFAULT 'unsettled'
                                  CHECK ("priceDifferenceStatus" IN
                                    ('unsettled','customer_owes','refund_due','settled')),
  "priceDifferenceSettledAmount" NUMERIC(12,2),
  "priceDifferenceSettledAt"    TIMESTAMPTZ,
  "priceDifferenceSettledBy"    TEXT REFERENCES "Employee"(id),

  -- ── "Customer did not return" outcome (business context point 6) ──
  -- For customer_self_return where the customer never ships the old item
  -- back, OR a courier_replacement pickup that fails and isn't followed up.
  -- Converts the situation into a financial loss/recovery case. The value
  -- of the never-returned old item becomes a recoverable amount against the
  -- customer (potentially collected via an amount adjustment on a future
  -- order, or written off). Step 2 will call the existing flagCustomer()
  -- action with reason "Exchange item not returned" when this happens.
  "markedAsNotReturned"         BOOLEAN NOT NULL DEFAULT FALSE,
  "notReturnedReason"           TEXT,
  "notReturnedRecoveryStatus"   TEXT
                                  CHECK ("notReturnedRecoveryStatus" IN
                                    ('pending','recovered','written_off')),
  "notReturnedRecoveryAmount"   NUMERIC(12,2),

  -- Why the customer wants to exchange (size issue, color, defect, etc.)
  "reason"                      TEXT NOT NULL,

  "requestedBy"                 TEXT NOT NULL REFERENCES "Employee"(id),
  "requestedAt"                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "completedAt"                 TIMESTAMPTZ,
  "cancelledAt"                 TIMESTAMPTZ,
  "cancellationReason"          TEXT,

  "updatedAt"                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Consistency constraint: marked_as_not_returned=true implies status is
  -- the terminal 'customer_did_not_return'. This catches application bugs
  -- that set the flag without transitioning the status (or vice versa).
  CONSTRAINT order_exchanges_not_returned_implies_status
    CHECK (
      ("markedAsNotReturned" = FALSE) OR
      ("status" = 'customer_did_not_return')
    )
);

-- ── Indexes (per spec) ──
CREATE INDEX IF NOT EXISTS order_exchanges_company_status_idx
  ON order_exchanges ("companyId", "status");
CREATE INDEX IF NOT EXISTS order_exchanges_original_order_idx
  ON order_exchanges ("originalOrderId");
CREATE INDEX IF NOT EXISTS order_exchanges_method_status_idx
  ON order_exchanges ("exchangeMethod", "status");

-- Additional useful indexes for the detail-page "exchanges for this order_item"
-- lookup and the "exchanges created by this employee" audit view.
CREATE INDEX IF NOT EXISTS order_exchanges_original_order_item_idx
  ON order_exchanges ("originalOrderItemId");
CREATE INDEX IF NOT EXISTS order_exchanges_requested_by_idx
  ON order_exchanges ("requestedBy");

-- ============================================================================
-- PART 2: updatedAt TRIGGER
-- ============================================================================
-- Keep "updatedAt" fresh on every UPDATE. Matches the pattern used by
-- "Customer" and customer_addresses (migration 002).

CREATE OR REPLACE FUNCTION update_order_exchanges_updatedAt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_order_exchanges_updatedAt ON order_exchanges;
CREATE TRIGGER trg_order_exchanges_updatedAt
  BEFORE UPDATE ON order_exchanges
  FOR EACH ROW
  EXECUTE FUNCTION update_order_exchanges_updatedAt();

-- ============================================================================
-- PART 3: ROW LEVEL SECURITY
-- ============================================================================
-- Defense-in-depth RLS on top of the application-layer scoping
-- (getWorkspace/requirePermission in src/lib/workspace.ts).
--
-- Permission model (per spec):
--   SELECT: companyId = get_active_company_id()
--   INSERT: companyId = get_active_company_id() AND has_permission('orders.manage')
--   UPDATE: companyId = get_active_company_id() AND has_permission('orders.manage')
--   DELETE: DISABLED (use status = 'cancelled')
--
-- RLS is ENABLED (not FORCED) so the `postgres` role (which the Prisma app
-- connects as) bypasses RLS — the app keeps working without GUC-setting
-- middleware. Supabase anon/authenticated roles ARE subject to these
-- policies (defense-in-depth for any future direct API access).

ALTER TABLE order_exchanges ENABLE ROW LEVEL SECURITY;

-- ── SELECT ──
DROP POLICY IF EXISTS order_exchanges_select ON order_exchanges;
CREATE POLICY order_exchanges_select ON order_exchanges
  FOR SELECT
  USING ("companyId" = get_active_company_id());

-- ── INSERT ──
DROP POLICY IF EXISTS order_exchanges_insert ON order_exchanges;
CREATE POLICY order_exchanges_insert ON order_exchanges
  FOR INSERT
  WITH CHECK (
    "companyId" = get_active_company_id()
    AND has_permission(get_active_company_id(), 'orders.manage') IS TRUE
  );

-- ── UPDATE ──
DROP POLICY IF EXISTS order_exchanges_update ON order_exchanges;
CREATE POLICY order_exchanges_update ON order_exchanges
  FOR UPDATE
  USING (
    "companyId" = get_active_company_id()
    AND has_permission(get_active_company_id(), 'orders.manage') IS TRUE
  )
  WITH CHECK (
    "companyId" = get_active_company_id()
    AND has_permission(get_active_company_id(), 'orders.manage') IS TRUE
  );

-- No DELETE policy → DELETE denied by default (use status = 'cancelled').

COMMIT;

-- ============================================================================
-- END OF MIGRATION 003
-- ============================================================================
-- Summary:
--
--   NEW TABLE:
--     order_exchanges — the core exchange record. TEXT PK (cuid/uuid-text),
--       TEXT FKs to "Order", "OrderItem", "OrgProductVariant", "Company",
--       "Organization", "Employee", "InventoryTransaction",
--       "StockLossRecord". GENERATED priceDifference column. CHECK
--       constraints on exchangeMethod, status, oldItemCondition,
--       priceDifferenceStatus, notReturnedRecoveryStatus. Consistency
--       CHECK: markedAsNotReturned=true ⇒ status='customer_did_not_return'.
--
--   INDEXES (4):
--     (companyId, status) — the main exchanges list view
--     (originalOrderId) — "exchanges for this order" lookup
--     (exchangeMethod, status) — method-filtered queues
--     (originalOrderItemId) — "exchanges for this order_item" lookup
--     (requestedBy) — audit view per employee
--
--   TRIGGER:
--     trg_order_exchanges_updatedAt — BEFORE UPDATE sets updatedAt=NOW()
--
--   RLS:
--     ENABLED on order_exchanges
--     SELECT  : companyId = get_active_company_id()
--     INSERT  : companyId check + has_permission('orders.manage')
--     UPDATE  : companyId check + has_permission('orders.manage')
--     DELETE  : denied (use status='cancelled')
--
-- NEXT STEPS (Step 2 — NOT in this migration):
--   - Server actions: createExchangeRequest, approveExchange,
--     markCustomerConfirmedShipped, verifyOldItemReceived (calls
--     receiveReturnedStitchedItem/receiveReturn + creates stock_loss if
--     damaged), createExchangeReplacementOrder (creates the new
--     order_source='exchange' order + order_item), settlePriceDifference,
--     markAsNotReturned (calls flagCustomer with "Exchange item not
--     returned"), cancelExchange.
--   - State-machine enforcement for the two exchange methods' distinct
--     sequencing (courier_replacement vs customer_self_return).
--   - Frontend: exchanges list view, exchange detail page, "Request Exchange"
--     action on delivered order_items.
-- ============================================================================
