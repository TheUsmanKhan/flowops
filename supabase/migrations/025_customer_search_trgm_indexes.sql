-- Migration 025: Customer search performance — pg_trgm GIN indexes
--
-- Enables fast LIKE '%query%' searches on customer name + phone columns
-- by using the pg_trgm extension's GIN trigram index.
--
-- Problem (from CUSTOMER_SEARCH_AUDIT.md):
--   LIKE '%query%' cannot use a B-tree index → sequential scan on every
--   customer search (~283ms now, degrades as customers grow).
--
-- Solution:
--   pg_trgm GIN indexes support trigram-based matching for LIKE/ILIKE,
--   bringing search latency down to ~5-20ms and future-proofing the
--   search as the customer base grows.
--
-- IMPORTANT: This project's DB uses camelCase column + table names
-- (Prisma's @map was NOT used — the columns are literally "phoneRaw",
-- "phoneNormalized", "organizationId", etc.). The table is "Customer"
-- (capital C) and "customer_phones" (lowercase, from @@@map).
--
-- This migration is IDEMPOTENT — safe to run multiple times.

-- 1. Enable the pg_trgm extension (idempotent)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. GIN trigram index on "Customer".name (for name search)
--    Supports: WHERE name ILIKE '%query%'
CREATE INDEX IF NOT EXISTS "customer_name_trgm_idx"
  ON "Customer"
  USING gin (name gin_trgm_ops);

-- 3. GIN trigram index on "Customer".email (for email search)
--    Supports: WHERE email ILIKE '%query%'
CREATE INDEX IF NOT EXISTS "customer_email_trgm_idx"
  ON "Customer"
  USING gin (email gin_trgm_ops);

-- 4. GIN trigram index on customer_phones.phoneRaw (for partial phone search)
--    Supports: WHERE "phoneRaw" ILIKE '%query%'
CREATE INDEX IF NOT EXISTS "customer_phones_phone_raw_trgm_idx"
  ON customer_phones
  USING gin ("phoneRaw" gin_trgm_ops);

-- 5. GIN trigram index on customer_phones.phoneNormalized (for partial normalized search)
--    Supports: WHERE "phoneNormalized" ILIKE '%query%'
CREATE INDEX IF NOT EXISTS "customer_phones_phone_normalized_trgm_idx"
  ON customer_phones
  USING gin ("phoneNormalized" gin_trgm_ops);

-- 6. B-tree composite index on customer_phones (organizationId, phoneNormalized)
--    for exact phone match (used by the fast-path in searchCustomersDetailed).
--    This already exists from Prisma's @@index, but CREATE IF NOT EXISTS
--    is safe in case of partial migrations.
CREATE INDEX IF NOT EXISTS "customer_phones_org_phone_normalized_idx"
  ON customer_phones ("organizationId", "phoneNormalized");

-- Note: Postgres automatically uses these GIN indexes for ILIKE/contains
-- queries when the planner determines they're faster than a seq scan.
-- No application code changes needed — Prisma's `mode: 'insensitive'`
-- generates ILIKE which is supported by pg_trgm.
