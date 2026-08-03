-- ============================================================================
-- FlowOps — Exchange Shipments System (Parallel to Order, structurally separate)
-- ============================================================================
-- This migration builds the exchange_shipments table — a structurally separate
-- parallel to the Order system. Exchange fulfillment lives in its own table
-- with its own independent numbering (EXCH-{YYYY}-{NNNNN}), so exchange
-- shipments NEVER mix into revenue/order-count reporting.
--
-- Key design decisions:
--   1. INDEPENDENT NUMBERING: exchange_shipment_number_seq is a plain Postgres
--      sequence, completely independent from generate_order_number() (which
--      uses MAX+1 on the Order table). The two sequences share no counter
--      state, no code path, no logic.
--   2. STRUCTURALLY SEPARATE: exchange_shipments is its own table — NOT an
--      Order row with orderSource='exchange'. This means exchange shipments
--      never appear in Order list views, never affect updateCustomerStats(),
--      never count toward revenue metrics.
--   3. SAME INVENTORY GATEWAY: all stock operations go through the existing
--      processInventoryTransaction() function — tagged with
--      relatedEntityType='exchange_shipment' for audit purposes.
--   4. PRIORITY BACKORDER: ALL exchange shipments get isPriorityBackorder=true
--      and are fulfilled ahead of regular OrderItems in the FIFO queue.
--   5. CRM ADDRESS/PHONE FKs: shippingAddressId and shippingPhoneId are real
--      FKs into customer_addresses/customer_phones — NOT snapshot copies.
--      Editing a customer's address from their CRM profile updates all
--      historical exchange shipments referencing that address ID.
--
-- Existing historical exchange orders (Order rows with orderSource='exchange')
-- are NOT migrated — they remain as-is. Only NEW exchanges from this point
-- forward use this new system.
-- ============================================================================

BEGIN;

-- ============================================================================
-- PART 1: exchange_shipment_number_seq SEQUENCE
-- ============================================================================
-- Plain Postgres sequence (nextval-based), completely independent from
-- generate_order_number(). Scoped per-year via the format function, but the
-- sequence itself is global (like draft_order_number_seq).

CREATE SEQUENCE IF NOT EXISTS exchange_shipment_number_seq
  START WITH 1 INCREMENT BY 1 NO CYCLE;

-- Format function: EXCH-{YYYY}-{NNNNN} (zero-padded 5 digits, per-year scope).
-- The year is derived from the current date at call time — the sequence number
-- itself is global (not reset per year), but the format includes the year for
-- human readability. This mirrors how the draft numbering works.
CREATE OR REPLACE FUNCTION generate_exchange_shipment_number()
RETURNS TEXT LANGUAGE sql AS $$
  SELECT 'EXCH-' || EXTRACT(YEAR FROM NOW())::TEXT || '-' ||
         LPAD(nextval('exchange_shipment_number_seq')::TEXT, 5, '0');
$$;

-- ============================================================================
-- PART 2: exchange_shipments TABLE
-- ============================================================================
-- The structurally separate exchange fulfillment table. Each row is one
-- shipment of a new variant to a customer as part of an item exchange.

CREATE TABLE IF NOT EXISTS exchange_shipments (
  id                            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "exchangeShipmentNumber"      TEXT NOT NULL UNIQUE,
  -- Format: EXCH-{YYYY}-{NNNNN} from generate_exchange_shipment_number()

  "organizationId"              TEXT NOT NULL REFERENCES "Organization"(id),
  "companyId"                   TEXT NOT NULL REFERENCES "Company"(id) ON DELETE CASCADE,

  -- Links back to the parent exchange request (order_exchanges table).
  -- Every shipment MUST link to its parent exchange.
  "orderExchangeId"             TEXT NOT NULL REFERENCES order_exchanges(id) ON DELETE CASCADE,

  -- The new variant being shipped (same as order_exchanges.newOrgVariantId,
  -- copied here for the shipment's own self-contained record).
  "newOrgVariantId"             TEXT NOT NULL REFERENCES "OrgProductVariant"(id),

  "quantity"                    INT NOT NULL DEFAULT 1,

  -- Snapshot of variant's fulfillmentType at creation time (same pattern as
  -- OrderItem.fulfillmentTypeSnapshot — future variant changes don't affect
  -- existing shipments).
  "fulfillmentTypeSnapshot"     TEXT NOT NULL DEFAULT 'stock_based',

  -- Customer reference (always an existing, already-resolved customer from
  -- the original order — createCustomer() is NEVER called by this system).
  "customerId"                  TEXT NOT NULL REFERENCES "Customer"(id),

  -- CRM address/phone FKs (NOT snapshot copies). These are real FKs into
  -- customer_addresses/customer_phones. If the customer's address is later
  -- edited from their CRM profile, historical exchange shipments referencing
  -- that address ID will reflect the update — mirrors how the address book
  -- "last used" tracking already treats addresses as living CRM records.
  "shippingAddressId"           TEXT REFERENCES customer_addresses(id) ON DELETE SET NULL,
  "shippingPhoneId"             TEXT REFERENCES customer_phones(id) ON DELETE SET NULL,

  -- Optional override: only used if staff needs to type/select a city that
  -- differs from the selected address's city (e.g. for courier city-matching).
  "shippingCityOverride"        TEXT,

  -- Simplified lifecycle (vs Order's 9 states — packing/processing steps
  -- don't apply to exchange shipments).
  "status"                      TEXT NOT NULL DEFAULT 'confirmed'
                                  CHECK ("status" IN (
                                    'pending',
                                    'confirmed',
                                    'backordered',
                                    'dispatched',
                                    'delivered',
                                    'cancelled'
                                  )),

  -- ALL exchange shipments get priority in the backorder FIFO queue.
  "isPriorityBackorder"         BOOLEAN NOT NULL DEFAULT TRUE,
  "backorderedAt"               TIMESTAMPTZ,

  -- Invoice amount: defaults to priceDifference from order_exchanges if
  -- customer_owes, else 0. MUST be editable by staff before dispatch.
  "invoiceAmount"               DECIMAL(14,2) NOT NULL DEFAULT 0,

  -- Courier integration (nullable until courier chosen in Prompt 5).
  "courierCompanyIntegrationId" TEXT REFERENCES company_integrations(id) ON DELETE SET NULL,
  "trackingNumber"              TEXT,
  "courierSubStatus"            TEXT,
  "needsShipperAdvice"          BOOLEAN NOT NULL DEFAULT FALSE,
  "unrecognizedCourierStatus"   BOOLEAN NOT NULL DEFAULT FALSE,
  "courierCityStatus"           TEXT NOT NULL DEFAULT 'not_applicable'
                                  CHECK ("courierCityStatus" IN ('matched','unresolved','not_applicable')),

  -- Lifecycle timestamps
  "confirmedAt"                 TIMESTAMPTZ,
  "dispatchedAt"                TIMESTAMPTZ,
  "deliveredAt"                 TIMESTAMPTZ,
  "cancelledAt"                 TIMESTAMPTZ,

  "createdBy"                   TEXT REFERENCES "Employee"(id) ON DELETE SET NULL,
  "createdAt"                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS exchange_shipments_company_status_idx
  ON exchange_shipments ("companyId", "status");
CREATE INDEX IF NOT EXISTS exchange_shipments_exchange_idx
  ON exchange_shipments ("orderExchangeId");
CREATE INDEX IF NOT EXISTS exchange_shipments_variant_backorder_idx
  ON exchange_shipments ("newOrgVariantId")
  WHERE "status" = 'backordered';
CREATE INDEX IF NOT EXISTS exchange_shipments_courier_integration_idx
  ON exchange_shipments ("courierCompanyIntegrationId")
  WHERE "courierCompanyIntegrationId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS exchange_shipments_tracking_idx
  ON exchange_shipments ("trackingNumber")
  WHERE "trackingNumber" IS NOT NULL;

-- Trigger for updatedAt
CREATE OR REPLACE FUNCTION update_exchange_shipments_updatedAt()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_exchange_shipments_updatedAt ON exchange_shipments;
CREATE TRIGGER trg_exchange_shipments_updatedAt
  BEFORE UPDATE ON exchange_shipments
  FOR EACH ROW EXECUTE FUNCTION update_exchange_shipments_updatedAt();

-- ============================================================================
-- PART 3: order_exchanges → exchange_shipments RELATION
-- ============================================================================
-- The relation goes through exchange_shipments.orderExchangeId (FK → order_exchanges).
-- An exchange can have multiple shipments over its lifecycle (e.g. if the first
-- is cancelled and a new one is created), so this is a 1-N relation.
-- The legacy order_exchanges.newOrderId column remains populated only on old,
-- pre-migration historical exchange records — NEW exchanges are linked via
-- exchange_shipments.orderExchangeId instead.

-- (No schema change needed on order_exchanges itself — the FK lives on
--  exchange_shipments.orderExchangeId which was created in PART 2 above.)

-- ============================================================================
-- PART 4: ROW LEVEL SECURITY
-- ============================================================================
-- Mirrors the Order table's RLS pattern exactly:
--   SELECT by company match
--   INSERT/UPDATE by company match + orders.manage permission
--   DELETE denied (use status='cancelled')
-- Reuses the existing orders.manage permission key (no new permission created).

ALTER TABLE exchange_shipments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS exchange_shipments_select ON exchange_shipments;
CREATE POLICY exchange_shipments_select ON exchange_shipments
  FOR SELECT
  USING ("companyId" = get_active_company_id());

DROP POLICY IF EXISTS exchange_shipments_insert ON exchange_shipments;
CREATE POLICY exchange_shipments_insert ON exchange_shipments
  FOR INSERT
  WITH CHECK (
    "companyId" = get_active_company_id()
    AND has_permission(get_active_company_id(), 'orders.manage') IS TRUE
  );

DROP POLICY IF EXISTS exchange_shipments_update ON exchange_shipments;
CREATE POLICY exchange_shipments_update ON exchange_shipments
  FOR UPDATE
  USING (
    "companyId" = get_active_company_id()
    AND has_permission(get_active_company_id(), 'orders.manage') IS TRUE
  )
  WITH CHECK (
    "companyId" = get_active_company_id()
    AND has_permission(get_active_company_id(), 'orders.manage') IS TRUE
  );

-- No DELETE policy → DELETE is denied by default (use status='cancelled').

COMMIT;
