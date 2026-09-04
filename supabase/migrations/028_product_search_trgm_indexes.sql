-- Migration 028: Product search performance — pg_trgm GIN indexes
--
-- Same pattern as migration 025 (customer search) — adds GIN trigram
-- indexes for fast LIKE '%query%' searches on product title + variant SKU.
-- Without these, product search does a sequential scan (degrades as
-- catalog grows).
--
-- pg_trgm extension already enabled in migration 025.
-- Idempotent — uses IF NOT EXISTS.

-- Product title search
CREATE INDEX IF NOT EXISTS "org_product_title_trgm_idx"
  ON "OrgProduct" USING gin (title gin_trgm_ops);

-- Product slug search (for URL lookups)
CREATE INDEX IF NOT EXISTS "org_product_slug_trgm_idx"
  ON "OrgProduct" USING gin (slug gin_trgm_ops);

-- Variant SKU search (for the variant picker / order-create search)
CREATE INDEX IF NOT EXISTS "org_product_variant_sku_trgm_idx"
  ON "OrgProductVariant" USING gin (sku gin_trgm_ops);

-- Variant barcode search
CREATE INDEX IF NOT EXISTS "org_product_variant_barcode_trgm_idx"
  ON "OrgProductVariant" USING gin (barcode gin_trgm_ops);
