-- Migration 026: Atomic per-org sequence counter (race-free PO/order number generation)
--
-- PROBLEM (from INVENTORY_AUDIT.md):
--   generatePoNumber() in src/lib/inventory.ts uses count+1 which races under
--   concurrency — two simultaneous PO creations generate the same number,
--   causing a unique-constraint 500 error. The generate_order_number() SQL
--   function uses MAX+1 which has the same race (less likely but still possible).
--
-- SOLUTION: a dedicated counter table with INSERT ... ON CONFLICT DO UPDATE
--   ... RETURNING — a single atomic SQL statement that Postgres guarantees
--   returns a unique incrementing number per (org, type, year) even under
--   concurrent access. This is the standard pattern for multi-tenant systems.
--
-- The table is generic — supports PO numbers, order numbers, self-fulfilled
-- references, exchange shipment numbers, and any future sequence type.

CREATE TABLE IF NOT EXISTS "number_sequences" (
  "id"              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "organizationId"  TEXT NOT NULL,
  "type"            TEXT NOT NULL,  -- 'po_number' | 'order_number' | 'sf_number' | 'exchange_number' | ...
  "year"            INT NOT NULL,
  "nextNumber"      INT NOT NULL DEFAULT 1,
  "createdAt"       TIMESTAMP DEFAULT NOW(),
  "updatedAt"       TIMESTAMP DEFAULT NOW(),
  CONSTRAINT "number_sequences_org_type_year_key" UNIQUE ("organizationId", "type", "year")
);

-- Index for the unique lookup
CREATE INDEX IF NOT EXISTS "number_sequences_org_type_year_idx"
  ON "number_sequences" ("organizationId", "type", "year");

-- Atomic "get next number" function — INSERT ... ON CONFLICT DO UPDATE
--   ... RETURNING is a single atomic statement in Postgres.
--   Two concurrent calls will each get a DIFFERENT number (one gets N,
--   the other gets N+1) — guaranteed by Postgres's row-level locking.
CREATE OR REPLACE FUNCTION get_next_sequence_number(
  p_org_id TEXT,
  p_type TEXT,
  p_year INT DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_year INT := COALESCE(p_year, EXTRACT(YEAR FROM NOW())::INT);
  v_next INT;
BEGIN
  INSERT INTO "number_sequences" ("organizationId", "type", "year", "nextNumber")
  VALUES (p_org_id, p_type, v_year, 1)
  ON CONFLICT ("organizationId", "type", "year")
  DO UPDATE SET "nextNumber" = "number_sequences"."nextNumber" + 1,
                "updatedAt" = NOW()
  RETURNING "number_sequences"."nextNumber"
  INTO v_next;

  RETURN v_next;
END;
$$;
