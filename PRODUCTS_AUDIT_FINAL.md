---
Task ID: PRODUCTS-MODULE-AUDIT
Agent: Explore (read-only audit subagent)
Mode: READ-ONLY — no source code, schema, or data was modified
Scope: Catalog & Products module — sidebar items (All Products, Add Product, Product Drafts, Returned Stock, Catalog Settings, Org Catalog) and every backend route + frontend component listed in the brief
Database: PostgreSQL @ Supabase (postgres.gobwxqkzfulbwhzbbsdj)

---

# PRODUCTS-MODULE-AUDIT — Final Investigation Report

## EXECUTIVE SUMMARY

| Metric | Count |
|---|---|
| API route files audited | 27 (`/api/products/**` 24 + `/api/returned-stitched/**` 3 + `/api/org/catalog` 1 + `/api/catalog/**` 10 + `/api/categories` + `/api/brands` + `/api/drafts`) |
| Frontend components audited | 13 (`products-view`, `product-create-view`, `product-detail-view`, `catalog-settings-view`, `returned-stitched-view`, `org-catalog-view`, `parent-child-variant-table`, `client-side-parent-child-variant-table`, `attribute-selector`, `returned-stock-banner`, `fulfillment-type-badge`, `product-scope-badge`, `variant-table-parts`) |
| Prisma models touched | 14 (OrgCategory, OrgBrand, OrgAttribute, OrgAttributeValue, AttributeValueRule, OrgProduct, OrgProductVariant, OrgProductImage, OrgProductBundle, SelectiveProductAccess, CompanyProductSetting, CompanyVariantPricing, ProductFulfillmentCost, ReturnedStitchedInventory, FormDraft) + 2 cross-module (InventoryPool, AvgCostHistory) |
| DB diagnostic SQL queries run | 17 (live against Supabase) |
| Critical bugs found | 4 |
| High-severity bugs found | 9 |
| Medium-severity issues | 8 |
| Low-severity / smell issues | 7 |

The Catalog & Products module is **architecturally the cleanest subsystem in FlowOps** (parent/child variant cascade, bidirectional attribute rules, per-company pricing + sync flags, one-way `trackInventory` flip, atomic `db.$transaction` on product create). However, four critical issues were identified:

1. **ReturnedStitchedInventory locationId mismatch** — the `[id]/route.ts` handler reads `record.locationId` and `record.orgVariantId` and feeds them to `processInventoryTransaction` / `recordStockLoss`, but the schema column-list returned by Supabase confirms **there is NO `locationId` column** on `ReturnedStitchedInventory`. The calls fail silently inside try/catch — **phantom stock** in the pool when items are marked sold / written off.
2. **POST /api/returned-stitched (old route) creates a ReturnedStitchedInventory record but NEVER creates the inventory_transaction** that the schema comment (lines 879-886) says it should. DB confirms all 2 rows have `inventoryTxnId IS NULL`. The newer `/api/inventory/receive-returned-stitched` route DOES create the txn, but the frontend `returned-stitched-view.tsx` still calls the OLD broken route.
3. **ProductDetailView's "Promote to Org" button is silently no-op** — it calls `PATCH /api/products/[id]` with `{ product_scope: scope }`, but `updateProductSchema` does NOT include `product_scope`, so Zod strips the key. The server returns success, the user sees a success toast, but the DB row's `productScope` never changes (and `promotedAt`/`promotedById` are never set, no selective-access rows are created). Bypasses the POST `/promote` route's "≥1 variant + ≥1 image" gate.
4. **Subscribe / Archive buttons are NOT in any frontend component** — `POST /api/products/[id]/subscribe` and `DELETE /api/products/[id]` (archive) endpoints exist and are unit-tested by the backend, but no UI surfaces them. The Org-Catalog view has Promote + Demote + Revoke-selective-access buttons, but the per-product detail page only has the broken Promote-to-Org dialog.

---

## PART A — MODULE RELATION MAP

### A.1 — `orgVariantId` / `org_variant_id` consumers (grep across `src/`)

**Models consuming `orgVariantId`:** InventoryPool, InventoryTransaction, AvgCostHistory, ReturnedStitchedInventory, ProductFulfillmentCost, CompanyVariantPricing, OrderItem, OrderExchange, ExchangeShipment, StockTransfer, StockLossRecord, CycleCountItem, ProductionOrder, SupplierReturn, PurchaseOrderItem, PurchaseOrderReceiptItem. (16 FK consumers — all reference `OrgProductVariant.id` correctly via Prisma `@relation`.)

**Routes consuming `orgVariantId` (write paths):**
- `/api/products/[id]/pricing` — UPSERTs CompanyVariantPricing keyed on `companyId_orgVariantId` ✓
- `/api/products/[id]/variants/[variantId]/override-price` + `resync-price` — same ✓
- `/api/products/[id]/variants/[variantId]/override-cost` + `resync-cost` — mutates OrgProductVariant directly (no CompanyVariantPricing FK) ✓
- `/api/products/[id]/variants/[variantId]/override-weight` + `resync-weight` — same ✓
- `/api/products/[id]/variant-groups/[parentValueId]/sale-price` — UPSERTs CompanyVariantPricing ✓
- `/api/products/[id]/variant-groups/[parentValueId]/cost` + `weight` — `updateMany WHERE id IN (...)` ✓
- `/api/products/[id]/demote` — counts ReturnedStitchedInventory by `orgVariantId IN (...)` ✓
- `/api/returned-stitched` (POST) — creates ReturnedStitchedInventory with `orgVariantId: d.org_variant_id` ✓
- `/api/returned-stitched/[id]` (POST mark_sold / write_off) — reads `record.orgVariantId` ✓ (but reads `record.locationId` which DOES NOT EXIST — see Critical bug PROD-001 below)
- `/api/inventory/receive-returned-stitched` (POST) — calls `processInventoryTransaction({orgVariantId: d.org_variant_id, locationId: d.location_id})` ✓
- `/api/inventory/opening-stock` (POST) — same ✓
- `/api/inventory/receive` (POST) — same ✓
- `/api/inventory/adjust` (POST) — same ✓
- `/api/inventory/transfers` (POST) — same ✓
- `/api/purchase-orders/[id]/receive` (POST) — same ✓
- `/api/cycle-counts/[id]` (POST) — same ✓
- `/api/exchanges` (POST) — uses `new_org_variant_id` ✓
- `/api/production-orders/[id]` — uses both `fabricVariantId` and `orgVariantId` ✓

**Consumers reading variant data via a stale/duplicated shape:** NONE found. Every consumer either uses the canonical Prisma `db.orgProductVariant.findUnique/findFirst/findMany` or the typed `processInventoryTransaction` helper. No code constructs a manual variant record from a stale cache.

**Flag:** VERIFIED OK — no stale shape readers. The only mismatch is the missing `locationId` column reference (Critical bug PROD-001), which is a schema-vs-code mismatch, not a shape duplication.

### A.2 — Deactivating a variant (`isActive=false`) and the order-create picker

**Trace:**

1. **Toggle route** `POST /api/products/[id]/variants/[variantId]/toggle` — sets `isActive: is_active` on `OrgProductVariant`. ✓
2. **GET /api/products** (lines 52 + 79-95) — reads `include_inactive_variants` query param. When `true`:
   - The variant-level `where` is set to `undefined` (returns ALL variants).
   - The `isActive` field is included in the select.
   - The product-level `isActive` filter and the `_count` aggregate are NOT affected.
3. **`order-create-view.tsx`** (line 507) — fetches `'/api/products?pageSize=100&include_inactive_variants=true'`. Maps variants to `variantOptions` with `isActive: v.isActive` (line 526). Renders the picker (lines 2019-2074): for each variant, if `v.isActive === false`, sets `gateReason = 'Not enabled for your company'`, marks the row as `variantDisabled`, renders it grayed-out with a "Not enabled" badge, and does NOT render the `+` add-to-cart button.

**VERIFIED OK — gate 1 of the 3-gate visibility system works correctly.** Inactive variants are visible-but-disabled in the order-create picker (not hidden), preserving the audit trail of which variants exist.

**Note (not a bug, but a gap):** Gate 2 ("company subscription active") is NOT enforced. The GET route returns products visible via `OR: [sourceCompanyId, organization, selective]` — a company whose `CompanyProductSetting.subscriptionStatus='revoked'` can still see and add the variants of any `organization`-scoped product to new orders. See PROD-013.

### A.3 — Promoting a product to `organization` scope — visibility to OTHER companies

**Trace:**

1. **POST /api/products/[id]/promote** (the canonical route):
   - Guard: `requirePermission(PRODUCTS_PROMOTE)` + caller must be elevated + product's `sourceCompanyId === companyId`.
   - Validates `≥1 active variant + ≥1 image`.
   - Sets `productScope: d.target_scope` + `promotedAt` + `promotedById`.
   - For `selective`: UPSERTs `SelectiveProductAccess` for each `selected_company_id`.
2. **GET /api/products** visibility filter (line 64-68):
   ```
   OR: [
     { sourceCompanyId: companyId },
     { productScope: 'organization' },            ← any company in the org
     { productScope: 'selective', selectiveAccess: { some: { companyId } } },
   ]
   ```
   So once promoted to `organization`, the product becomes visible to EVERY company in the org (any `organizationId` match). ✓ This is the intended behavior.
3. **Org-Catalog view** (`PromotableProductCard`, line 890) — correctly calls `api.post('/api/products/${product.id}/promote', ...)`.

**BUT** — see Critical bug **PROD-003** below: the **`ProductDetailView`'s "Promote to Org" button does NOT call the promote route**. It calls `PATCH /api/products/[id]` with `{ product_scope: scope }`, which `updateProductSchema` silently strips (Zod default = strip unknown keys), so the actual scope never changes in the DB.

**VERIFIED OK** for the Org-Catalog → promote-route flow. **CRITICAL BUG** for the product-detail-view → PATCH flow (PROD-003).

### A.4 — Product creation touching InventoryPool before opening stock is set

**Trace:** Grep of `inventoryPool` (case-sensitive) across `src/app/api/products/` returns **zero** matches. The POST `/api/products` route (lines 249-335) is wrapped in `db.$transaction` and creates only:
1. `tx.orgProduct.create`
2. `tx.orgProductVariant.create` (per variant)
3. `tx.companyVariantPricing.create` (per variant)
4. `tx.companyProductSetting.create`

The code comment at line 248 explicitly states: *"This is safe because product creation does NOT call processInventoryTransaction (which uses global db, not tx)."* The opening-stock step is a SEPARATE call to `/api/inventory/opening-stock` made AFTER the product is created (product-create-view.tsx lines 621-649), and that endpoint delegates to `processInventoryTransaction` — the SAME function every other inventory movement uses.

**VERIFIED OK — ZERO InventoryPool rows created during product creation.** Opening stock is a separate, optional, per-variant call.

### A.5 — Org Catalog view vs company-level Products view: same query path?

**Different paths.** They use completely different Prisma queries:

- **GET /api/products** (company-level) — paginated `db.orgProduct.findMany` filtered by `OR: [sourceCompanyId, organization, selective]` + active filter; returns variants + primary image + subscription + variantCount.
- **GET /api/org/catalog** (org-level) — TWO queries:
  1. `db.orgProduct.findMany({ where: { productScope: { in: ['organization', 'selective'] }, isActive: true } })` — shared catalog with `companySettings` + `sourceCompany` joined.
  2. `db.orgProduct.findMany({ where: { productScope: 'private', isActive: true } })` — promotable products across ALL companies in the org (includes `_count.variants` and `_count.images` for the `readyToPromote` gate).
  - Also returns the full company list for the selective-access picker.

**VERIFIED OK** — they serve different purposes (company browse vs. org-wide admin overview). No data duplication or drift; both read from the same `OrgProduct` source-of-truth.

---

## PART B — DATABASE LAYER (live SQL queries against Supabase)

### B.1 — OrgProducts with ZERO OrgProductVariant rows

```sql
SELECT p.id, p.title FROM "OrgProduct" p
LEFT JOIN "OrgProductVariant" v ON v."productId" = p.id
WHERE v.id IS NULL;
```

**Result:** `rowCount=1` — single orphan product: `cmry40xze0003pz2k7brq467s` titled `"OST Verify Product"`.

**Schema/grep check:** `POST /api/products` (route.ts line 249-335) is wrapped in `db.$transaction(async (tx) => { ... })` — atomic across product + variants + pricing + companyProductSetting. So a partial-failure mid-loop is impossible. The orphan product was likely created either:
- Before the `$transaction` wrapper was added (legacy data), OR
- By a manual DB insert during a smoke test (the title "OST Verify Product" suggests an Order/Stock Tracking verification test).

**Action recommended:** investigate the `cmry40xze0003pz2k7brq467s` row's `createdAt` against the git-blame date of the `$transaction` wrapper to determine whether it predates the fix.

### B.2 — OrgProductVariant SKU / barcode uniqueness at DB level

**Schema grep result (`@@unique`):**

```
sku            String   @unique         ← OrgProductVariant.sku_key (UNIQUE btree)
barcode        String?  @unique         ← OrgProductVariant_barcode_key (UNIQUE btree)
shopifyVariantId String? @unique        ← OrgProductVariant_shopifyVariantId_key
@@unique([organizationId, slug])        ← OrgProduct (NOT on variant)
@@unique([companyId, orgVariantId])    ← CompanyVariantPricing
@@unique([orgProductId, companyId])     ← SelectiveProductAccess
@@unique([companyId, orgProductId])     ← CompanyProductSetting
@@unique([bundleProductId, componentVariantId]) ← OrgProductBundle
@@unique([attributeId, value])          ← OrgAttributeValue
@@unique([organizationId, name])        ← OrgAttribute
@@unique([triggerAttributeValueId, forcesAttributeId]) ← AttributeValueRule
@@unique([organizationId, slug])        ← OrgCategory, OrgBrand
```

**Verified via `pg_indexes`** (live query):
- `OrgProductVariant_sku_key` → `CREATE UNIQUE INDEX ... USING btree (sku)` ✓
- `OrgProductVariant_barcode_key` → `CREATE UNIQUE INDEX ... USING btree (barcode)` ✓
- `OrgProductVariant_shopifyVariantId_key` → UNIQUE on `(shopifyVariantId)` ✓

**Important nuance:** `sku` and `barcode` uniqueness is **ORG-WIDE**, not company-scoped. Two companies in the same org cannot both create variants with the same SKU. This is by design (Shopify-sync compat) but worth flagging — a non-elevated user in Company B cannot tell whether an SKU is taken by Company A's private product until they hit the `ApiError(400, 'SKU "X" already exists')` in `POST /api/products` line 237-240.

**VERIFIED OK** — both DB-level + app-level pre-check present (POST /api/products lines 232-240 short-circuits with a friendly 400 before the raw P2002 surfaces).

### B.3 — OrgProductVariant.attributeValues never exceeds 3 keys

```sql
SELECT id, count(*) AS key_count FROM (
  SELECT id, jsonb_object_keys(("attributeValues"::jsonb)) AS key
  FROM "OrgProductVariant"
) s GROUP BY id HAVING count(*) > 3 LIMIT 50;
```

**Result:** `rowCount=0` — no variants violate the Shopify 3-key limit.

**App-layer enforcement:** `POST /api/products` (lines 220-226) + `POST /api/products/[id]/variants` (lines 69-73) + `POST /api/products/[id]/variants/generate` (lines 68-76) ALL explicitly check `Object.keys(attribute_values).length > 3` and throw `ApiError(400, ...)`.

**VERIFIED OK.**

### B.4 — trackInventory is one-way (TRUE → never back to FALSE)

Grep for `trackInventory:` across `src/`:

```
src/lib/inventory.ts:294:    select: { trackInventory: true, fulfillmentType: true },
src/lib/inventory.ts:300:          data: { trackInventory: true },         ← only ever set to TRUE
src/lib/inventory.ts:391:    select: { id: true, sku: true, fulfillmentType: true, trackInventory: true },
src/app/api/inventory/opening-stock/route.ts:91:        trackInventory: true,    ← only in select
src/app/api/inventory/receive/route.ts:66:          select: { fulfillmentType: true, trackInventory: true },
```

**NO write of `trackInventory: false` exists anywhere in `src/`.** The only mutation is `data: { trackInventory: true }` inside `processInventoryTransaction` (lines 296-301), guarded by:
```ts
if (variant && !variant.trackInventory && variant.fulfillmentType === 'made_to_order') {
  await db.orgProductVariant.update({ where: { id: orgVariantId }, data: { trackInventory: true } })
}
```

**DB confirmation (live query):**
```
fulfillmentType=made_to_order  trackInventory=true   count=52
fulfillmentType=stock_based    trackInventory=true   count=54
```

All 106 variants have `trackInventory=true`. (Made-to-order variants had it flipped after `opening_stock` or first `return_stitched_received`.) No false rows exist → no back-to-false mutation has ever run.

**VERIFIED OK — one-way invariant holds.**

### B.5 — costPriceSyncedWithParent / weightSyncedWithParent / salePriceSyncedParent consistency

DB sample (live):
- `OrgProductVariant` with `costPriceSyncedWithParent=true` — 3 sample rows returned: SKUs `SKU-1`, `SKU-5`, `TEST-FULL-1` — all show consistent costPrice=`100.00` and `weightSyncedWithParent=true`.
- `OrgProductVariant` with `weightSyncedWithParent=true` — same 3 sample rows: `weightKg=null` (expected — nullable until set), `costPriceSyncedWithParent=true`.
- `CompanyVariantPricing` with `salePriceSyncedWithParent=true` — 3 sample rows: SKUs `SKU-1` (salePrice=100), `SKU-5` (salePrice=500), `cmstjtjp20003lqy39xz08z7f` (salePrice=5000). All also have `comparePriceSyncedWithParent=true`.

**S1 (overrides check)** — `SELECT * FROM "OrgProductVariant" WHERE "costPriceSyncedWithParent" = false LIMIT 20;` → `rowCount=0`. **No overrides have ever been performed in the live DB.** The sync-flag model is sound in theory but unproven in production usage.

**VERIFIED OK** (consistency); flag: override/resync paths are untested in production data.

### B.6 — CompanyVariantPricing: exactly one active row per (companyId, orgVariantId)

```sql
SELECT "companyId", "orgVariantId", count(*) AS row_count
FROM "CompanyVariantPricing"
GROUP BY "companyId", "orgVariantId"
HAVING count(*) > 1 LIMIT 50;
```

**Result:** `rowCount=0` — no duplicates.

**Schema:** `@@unique([companyId, orgVariantId])` enforces this at the DB level. UPSERT paths in:
- POST /api/products (line 313: `tx.companyVariantPricing.create` — inside $transaction, can't double-create)
- POST /api/products/[id]/variants (line 119: `upsert` on `companyId_orgVariantId` key — idempotent)
- POST /api/products/[id]/pricing (line 57: `upsert` — idempotent)
- POST /api/products/[id]/variants/[variantId]/override-price (line 58: `upsert` — idempotent)
- POST /api/products/[id]/variant-groups/[parentValueId]/sale-price (line 96 + 101: `update` + `createMany` for missing rows — idempotent on the createMany)

**DB split:** `isActive=true → count=106`. All rows active. No `isActive=false` rows exist (so the `isActive` column is effectively unused in production today).

**VERIFIED OK.**

### B.7 — ReturnedStitchedInventory rows have valid inventoryTxnId links

```sql
SELECT count(*) AS total_rows,
       count(*) FILTER (WHERE "inventoryTxnId" IS NULL) AS null_txn,
       count(*) FILTER (WHERE "inventoryTxnId" IS NOT NULL) AS linked_txn
FROM "ReturnedStitchedInventory";
```

**Result:**
```
total_rows = 2
null_txn   = 2    ← ALL rows have NULL inventoryTxnId
linked_txn = 0
```

```sql
SELECT r.id, r."inventoryTxnId" FROM "ReturnedStitchedInventory" r
LEFT JOIN "InventoryTransaction" t ON t.id = r."inventoryTxnId"
WHERE r."inventoryTxnId" IS NOT NULL AND t.id IS NULL LIMIT 20;
```
**Result:** `rowCount=0` (no orphan FK links — but only because ALL rows are NULL).

**Schema comment (lines 879-886) explicitly says:**
> *"When a returned-stitched record is created, the route also creates an inventory_transaction (return_stitched_received) and stores its ID here. This makes the register and the pool stay in sync — every register row has a corresponding ledger entry."*

**Reality:** The POST `/api/returned-stitched` route (the one the frontend actually calls) creates only the ReturnedStitchedInventory record — **it does NOT create the inventory_transaction**, does NOT set `inventoryTxnId`, does NOT flip `trackInventory` on the variant. The newer `/api/inventory/receive-returned-stitched` route DOES create the txn — but no frontend component calls it.

**Schema column listing (live query confirmed):**
```
id, organizationId, companyId, orgVariantId, quantity, condition, totalCost,
suggestedResalePrice, originalOrderReference, returnReason, status, photos,
notes, receivedById, receivedAt, soldAt, soldOrderReference, writtenOffAt,
writtenOffById, writeOffReason, createdAt, updatedAt, inventoryTxnId
```

**NO `locationId` column exists** on ReturnedStitchedInventory. But `/api/returned-stitched/[id]/route.ts` lines 80 and 144 read `record.locationId` (and pass it to `processInventoryTransaction` and `recordStockLoss`). The `record.locationId` value will be `undefined`, both calls will fail with "locationId is required" or "InventoryLocation not found" — and the error is caught by the surrounding `try/catch` and only logged via `console.error`. The audit log records success. **Phantom stock.**

See Critical bug **PROD-001**.

---

## PART C — BACKEND / API LAYER AUDIT

For every route, I verified: (1) permission key enforced, (2) Zod validation present, (3) response shape, (4) business logic. Below is a compact matrix followed by specific-test deep dives.

### C.0 — Route-level permission/Zod matrix

| Route | Permission enforced? | Zod schema? | Notes |
|---|---|---|---|
| GET /api/products | ✓ `PRODUCTS_VIEW` via `getWorkspace+requirePermission` | n/a (query params) | Modern auth pattern |
| POST /api/products | ✓ `PRODUCTS_CREATE` (manual 4-query check) | `productSchema` | Has `Idempotency-Key`. Inside `db.$transaction`. SKU pre-check. |
| GET /api/products/[id] | ✗ NO `requirePermission`, only company-membership OR clause | n/a | Legacy 4-query auth. See PROD-011. |
| PATCH /api/products/[id] | ✓ `PRODUCTS_EDIT` (manual) | `updateProductSchema` | Silent-strips `product_scope` (PROD-003) |
| DELETE /api/products/[id] | ✓ `elevated` only (manual) | n/a | Soft-archives, never hard-deletes ✓ |
| POST /api/products/[id]/variants | ✓ `PRODUCTS_EDIT` (manual) | `variantSchema` per item | **NO $transaction** — see PROD-007 |
| POST /api/products/[id]/variants/generate | ✗ NO permission check | typed body, no Zod | Pure calc, no DB writes — low risk |
| POST /api/products/generate-stitched | ✗ NO permission check | `generateStitchedSchema` | Pure calc, no DB writes — low risk |
| POST /api/products/[id]/variants/[variantId]/toggle | ✓ `PRODUCTS_EDIT` (manual) | typed body | |
| PATCH /api/products/[id]/variants/[variantId] | ✓ `PRODUCTS_EDIT` (manual) | `updateVariantSchema` (local) | SKU dup-check at 409 |
| POST .../override-price | ✓ `PRODUCTS_PRICING` (manual) | typed body | Does NOT verify variantId belongs to productId — PROD-008 |
| POST .../resync-price | ✓ `PRODUCTS_PRICING` (manual) | typed body | Verifies variantId via `findFirst({ id: variantId, productId })` ✓ |
| POST .../override-cost | ✓ `PRODUCTS_EDIT` (manual) | typed body | Does NOT verify variantId belongs to productId — PROD-008 |
| POST .../resync-cost | ✓ `PRODUCTS_EDIT` (manual) | n/a | Verifies variantId ✓ |
| POST .../override-weight | ✓ `PRODUCTS_EDIT` (manual) | typed body | Does NOT verify variantId belongs to productId — PROD-008 |
| POST .../resync-weight | ✓ `PRODUCTS_EDIT` (manual) | n/a | Verifies variantId ✓ |
| GET /api/products/[id]/variant-groups | ✗ NO permission check (only company-membership) | n/a | See PROD-012 |
| POST .../variant-groups/[parentValueId]/sale-price | ✓ `PRODUCTS_PRICING` (manual) | typed body | URL param `parentValueId` IGNORED — uses body `parent_value` instead (PROD-009) |
| POST .../variant-groups/[parentValueId]/cost | ✓ `PRODUCTS_EDIT` (manual) | typed body | Same: URL param ignored (PROD-009) |
| POST .../variant-groups/[parentValueId]/weight | ✓ `PRODUCTS_EDIT` (manual) | typed body | Same |
| POST /api/products/[id]/images | ✓ `PRODUCTS_EDIT` (manual) | n/a (multipart) | Local filesystem storage — PROD-010 |
| DELETE /api/products/[id]/images | ✗ Only `isOwner || elevated` — MISSING `PRODUCTS_EDIT` check | n/a | See PROD-014 |
| POST /api/products/[id]/promote | ✓ `PRODUCTS_PROMOTE` + elevated + owner | `promoteProductSchema` | Validates ≥1 variant + ≥1 image ✓ |
| POST /api/products/[id]/demote | ✓ `PRODUCTS_PROMOTE` + elevated + owner | `demoteProductSchema` | Revokes non-source subscriptions; warnings surfaced ✓. Does NOT clear SelectiveProductAccess rows — PROD-005 |
| POST /api/products/[id]/selective-access | ✓ `elevated` + owner | `selectiveAccessSchema` | UPSERT — does NOT revoke previously-granted access not in the new list — PROD-006 |
| DELETE /api/products/[id]/selective-access | ✓ `elevated` + owner | n/a (query param) | |
| POST /api/products/[id]/subscribe | ✓ `PRODUCTS_SUBSCRIBE` (manual) | n/a | No frontend calls this — see PROD-004 |
| POST /api/products/[id]/pricing | ✓ `PRODUCTS_PRICING` (manual) | `setCompanyPricingSchema` | Does NOT validate variantId belongs to productId — PROD-015 |
| POST /api/products/drafts | ✓ implicit (via `saveProductDraft` action) | typed body | No TTL/expiry — PROD-016 |
| GET /api/org/catalog | ✓ `PRODUCTS_VIEW` + elevated | n/a | Modern auth pattern |
| GET /api/catalog/attributes | ✓ `PRODUCTS_VIEW` via `getWorkspace+requirePermission` | n/a | Modern auth |
| POST /api/catalog/attributes | ✓ `PRODUCTS_MANAGE_CATALOG` (manual) | `attributeSchema` | |
| PATCH /api/catalog/attributes/[id] | ✓ `PRODUCTS_MANAGE_CATALOG` (manual) | `attributeSchema.partial()` | |
| DELETE /api/catalog/attributes/[id] | ✓ `elevated` only (manual) | n/a | Cascade-deletes attribute values |
| GET /api/catalog/attributes/[id]/values | ✗ NO permission check | n/a | Low risk (read-only) |
| POST /api/catalog/attributes/[id]/values | ✓ `PRODUCTS_MANAGE_CATALOG` (manual) | `attributeValueSchema` | |
| PATCH /api/catalog/attribute-values/[id] | ✓ `PRODUCTS_MANAGE_CATALOG` (manual) | `attributeValueSchema.partial()` | |
| DELETE /api/catalog/attribute-values/[id] | ✓ `elevated` only (manual) | n/a | |
| GET /api/catalog/available-attributes | ✗ NO permission check | n/a | Low risk (read-only) |
| POST /api/catalog/inline-attribute | ✓ `PRODUCTS_MANAGE_CATALOG` (manual) | typed body | |
| POST /api/catalog/inline-value | ✓ `PRODUCTS_MANAGE_CATALOG` (manual) | typed body | |
| POST /api/catalog/seed-defaults | ✓ `elevated` only | n/a | One-time, idempotent |
| PATCH /api/catalog/categories/[id] | ✓ `PRODUCTS_MANAGE_CATALOG` (manual) | `categorySchema.partial()` | |
| DELETE /api/catalog/categories/[id] | ✓ `elevated` only (manual) | n/a | Reference check (409 if products use it) |
| PATCH /api/catalog/brands/[id] | ✓ `PRODUCTS_MANAGE_CATALOG` (manual) | `brandSchema.partial()` | |
| DELETE /api/catalog/brands/[id] | ✓ `elevated` only (manual) | n/a | Reference check |
| GET /api/categories | ✓ `PRODUCTS_VIEW` via `getWorkspace+requirePermission` | n/a | Modern auth |
| POST /api/categories | ✓ `PRODUCTS_MANAGE_CATALOG` via `getWorkspace+requirePermission` | typed body | Has `Idempotency-Key` |
| GET /api/brands | ✓ `PRODUCTS_VIEW` via `getWorkspace+requirePermission` | n/a | Modern auth |
| POST /api/brands | ✓ `PRODUCTS_MANAGE_CATALOG` via `getWorkspace+requirePermission` | typed body | Has `Idempotency-Key` |
| GET /api/returned-stitched | ✓ `INVENTORY_VIEW` via `getWorkspace+requirePermission` | n/a | |
| POST /api/returned-stitched | ✓ `INVENTORY_RECEIVE` OR `INVENTORY_REPORT_LOSS` (manual) | `returnedStitchedInventorySchema` | Has `Idempotency-Key`. **Does NOT create inventory_transaction** (PROD-002) |
| POST /api/returned-stitched/[id] | ✓ `INVENTORY_MANAGE_LOSS` (manual, per-action) | `markSoldSchema` / `writeOffSchema` | References `record.locationId` which doesn't exist on schema (PROD-001) |
| GET /api/returned-stitched/stats | ✓ `INVENTORY_VIEW` via `getWorkspace+requirePermission` | n/a | |

**Mixed auth pattern:** Only 8 of ~40 routes use the modern `getWorkspace() + requirePermission()` pattern (introduced by `REBUILD-API-PROTECTION`). The other ~32 still use the legacy 4-query `getCurrentUser → userSetting → employee → rolePermission.count` pattern. The modern helper caches the workspace context (0ms vs 4 round-trips per request). Performance gap: ~10-15ms × 32 routes on hot paths.

### C.1 — POST /api/products

- **Duplicate SKU handling:** ✓ Pre-check at lines 232-240 — `db.orgProductVariant.findMany({ where: { organizationId, sku: { in: skusToCheck } } })` then 400 with friendly message BEFORE the `db.$transaction` runs. The unique constraint `OrgProductVariant_sku_key` is the backstop.
- **Idempotency-Key:** ✓ Supported (lines 170, 364-385). Wrapped via `withIdempotency()` helper, key keyed on `(companyId, employeeId, 'product.create', key)`.
- **made_to_order variant cost computation:** The POST `/api/products` route (line 294) uses `cost_price: v.cost_price` directly — it does NOT auto-compute `cost_price = fabric_cost + stitching_charges` here. That computation lives ONLY in `POST /api/products/[id]/variants` (lines 89-92: `if (fulfillmentType === 'made_to_order' && parsed.fabric_cost !== undefined) { costPrice = parsed.fabric_cost + parsed.stitching_charges }`) and in `POST /api/products/generate-stitched` (line 87 + 101: `cost_price: d.base_fabric_cost + charge`). The wizard does this calculation client-side first, then sends `cost_price` directly to POST `/api/products` (which uses it as-is). Consistent, but the asymmetry between POST `/products` (no recomputation) and POST `/products/[id]/variants` (recomputes if `fabric_cost` is present) is confusing.
- **Atomicity:** ✓ Wrapped in `db.$transaction` since the fix documented in the inline comment (lines 242-248). The previous audit (`PROD-AUDIT-BACKEND`) had flagged the lack of transaction as Critical; this has been **fixed**.

### C.2 — POST /api/products/[id]/variants/generate

**AttributeValueRule bidirectional logic** — verified at lines 116-146:

```ts
for (const rule of rules) {
  const hasTrigger = combo.some((part) => part.value_id === rule.triggerAttributeValueId)
  const forcedPart = combo.find((part) => part.attribute_id === rule.forcesAttributeId)
  if (!forcedPart) continue

  if (hasTrigger) {
    // INCLUSION: trigger present → forced attribute MUST equal forced value
    if (forcedPart.value_id !== rule.forcesValueId) return false
  } else {
    // EXCLUSION: trigger absent → forced value must NOT appear (reserved)
    if (forcedPart.value_id === rule.forcesValueId) return false
  }
}
```

The bidirectional logic is correct:
- INCLUSION: "Unstitched → forces Size = One Size" → combo with `Piece Type=Unstitched + Size=M` is rejected (must be One Size).
- EXCLUSION: "Stitched + Size=One Size" is rejected (One Size reserved for Unstitched only).

**Permission check:** ✗ MISSING — line 55 only does `getCurrentUser()` + `await params` (the product is fetched only for the URL placeholder; the route is pure calculation). A non-elevated, non-permissioned user could call this endpoint to enumerate possible variant combinations. Low severity (no DB writes) but should at minimum require `PRODUCTS_VIEW`.

### C.3 — POST /api/products/[id]/promote — "≥1 active variant + ≥1 image" gate

Lines 60-65:

```ts
if (product._count.variants === 0) {
  throw new ApiError(400, 'Cannot promote: product has no active variants. Add at least one variant first.')
}
if (product._count.images === 0) {
  throw new ApiError(400, 'Cannot promote: product has no images. Upload at least one image first.')
}
```

The `_count` include (lines 40-46) filters variants with `where: { isActive: true }` — so the gate correctly counts only ACTIVE variants. ✓

**VERIFIED OK.**

### C.4 — POST /api/products/[id]/demote — subscription revocation + ReturnedStitchedInventory warning

**Subscription revocation** (lines 92-103): `updateMany` on `CompanyProductSetting` for non-source companies, setting `subscriptionStatus='revoked', isActive=false, revokedAt=now, revokedById=caller.id, revokeReason=d.reason`. ✓

**ReturnedStitchedInventory warning** (lines 65-76): non-blocking — counts available-status returned-stitched items tied to affected companies, and surfaces the count in the response as `warnings: string[]`. The frontend `DemoteDialog` keeps the dialog open and shows an Alert (org-catalog-view.tsx line 298-313). ✓

**Gap:** Lines 67 — nested await inside `in:` clause: `orgVariantId: { in: (await db.orgProductVariant.findMany({ where: { productId }, select: { id: true } })).map((v) => v.id) }`. Works but is brittle (PROD-017).

**Critical gap:** does NOT delete `SelectiveProductAccess` rows when demoting to `private`. If the product is later re-promoted to `selective`, the stale rows silently re-grant access (PROD-005).

### C.5 — Variant override/resync routes (6 routes) — sync flag handling

| Route | Sync flag set / cleared | Verifies variant belongs to productId? |
|---|---|---|
| `override-price` | Sets `salePriceSyncedWithParent=false` AND/OR `comparePriceSyncedWithParent=false` | ✗ NO |
| `resync-price` | Sets `salePriceSyncedWithParent=true` OR `comparePriceSyncedWithParent=true` | ✓ YES |
| `override-cost` | Sets `costPriceSyncedWithParent=false` | ✗ NO |
| `resync-cost` | Sets `costPriceSyncedWithParent=true` | ✓ YES |
| `override-weight` | Sets `weightSyncedWithParent=false` | ✗ NO |
| `resync-weight` | Sets `weightSyncedWithParent=true` | ✓ YES |

**Asymmetry:** The 3 `override-*` routes accept any `variantId` from the URL — they look up `company`/`orgId` only via the user's session, NOT via the product context. The lookup of `findFirst({ where: { id: variantId, productId } })` is performed in the `resync-*` routes (which need the variant's `attributeValues` to determine parent group) but NOT in the `override-*` routes (which just `db.orgProductVariant.update({ where: { id: variantId }, ... })` or `db.companyVariantPricing.upsert({ where: { companyId_orgVariantId: ... } })` directly).

**Impact:** A user with `PRODUCTS_EDIT` / `PRODUCTS_PRICING` permission can pass any `variantId` from a DIFFERENT product (within the same org) and the override is applied — cross-product permission bypass. See PROD-008.

### C.6 — Variant-group cascade routes (cost / weight / sale-price)

The 3 routes follow the same pattern (example: `cost/route.ts` lines 47-64):

```ts
const variants = await db.orgProductVariant.findMany({
  where: { productId, costPriceSyncedWithParent: true },
  select: { id: true, attributeValues: true },
})
const toUpdate = variants.filter((v) => {
  const attrs = JSON.parse(v.attributeValues) as Record<string, string>
  return attrs[body.parent_attribute_name!] === body.parent_value
})
const result = await db.orgProductVariant.updateMany({
  where: { id: { in: toUpdate.map((v) => v.id) } },
  data: { costPrice: body.cost_price },
})
```

**`updateMany` WHERE clause:** `id IN (filtered variant IDs)`. The filter is the cartesian of (a) `costPriceSyncedWithParent=true` (synced children only) + (b) JSON-parsed `attributeValues[parent_attribute_name] === parent_value`. ✓

**Gap:** The `parentValueId` URL parameter is parsed at line 28 but NEVER used — the actual parent value comes from `body.parent_value`. Misleading API design (PROD-009).

### C.7 — DELETE /api/products/[id] — never hard-deletes

Lines 239-242:

```ts
await db.orgProduct.update({
  where: { id },
  data: { productScope: 'archived', isActive: false },
})
```

**VERIFIED OK** — always sets `productScope='archived'` + `isActive=false`. Never calls `db.orgProduct.delete`. ✓ Audit log records the action as `product.archived`.

### C.8 — GET / POST / PATCH /api/returned-stitched

**GET** — lists per company, joined with variant + product. ✓ Returns `photos: JSON.parse(i.photos)`, `attributeValues: JSON.parse(...)`. Safe — wrapped in try/catch in the response mapper? No, it's not. If `i.photos` is invalid JSON, the route throws a 500. (Low risk — schema enforces default `'[]'`.)

**POST (receive)** — creates ReturnedStitchedInventory record only. Does NOT call `processInventoryTransaction` (PROD-002).

**POST /[id]** (mark_sold / write_off):
- Mark sold: sets `status='sold', soldAt, soldOrderReference`. Then attempts `processInventoryTransaction({ orgVariantId: record.orgVariantId, locationId: record.locationId, ... })` inside try/catch.
- Write off: sets `status='written_off', writtenOffAt, writtenOffById, writeOffReason`. Then attempts `recordStockLoss({ orgVariantId, locationId: record.locationId, ... })` inside try/catch.

**Critical bug:** `record.locationId` is `undefined` because the schema has no `locationId` column on `ReturnedStitchedInventory` (confirmed via live SQL in B.7). The `processInventoryTransaction` call will throw, the catch swallows the error to `console.error`, and the audit log records success. **The pool is NEVER decremented when a returned-stitched item is sold or written off → phantom stock.** See PROD-001.

### C.9 — Permission check coverage

40 routes total (excluding pure-GET /generate-stitched /generate /available-attributes /attribute-values which have no write but also no permission gate):

- **Modern auth (`getWorkspace + requirePermission`):** 8 routes
  - GET /api/products, POST /api/products (uses both modern + manual), GET /api/org/catalog, GET /api/categories, POST /api/categories, GET /api/brands, POST /api/brands, GET /api/returned-stitched, GET /api/returned-stitched/stats, GET /api/catalog/attributes, GET /api/returned-stitched
- **Legacy 4-query auth (manual):** 32 routes
- **NO permission check at all:** 5 routes
  - POST /api/products/[id]/variants/generate (PROD-018)
  - POST /api/products/generate-stitched (PROD-018)
  - GET /api/catalog/available-attributes (PROD-019)
  - GET /api/catalog/attributes/[id]/values (PROD-019)
  - GET /api/products/[id]/variant-groups (PROD-012)

---

## PART D — FRONTEND LAYER

### D.1 — `products-view.tsx` — desktop table vs mobile card list responsive behavior

- Desktop table (≥md): `<div className="hidden md:block rounded-md border">` containing `<ProductsTable>` with memoized rows (line 209-211). Memoized via `memo()` (line 227). Type column hidden below `lg`, Status column hidden below `xl`, Variants column hidden below `lg`, Tags column hidden below `xl` — progressive disclosure. ✓
- Mobile list (<md): `<div className="block md:hidden space-y-3">` rendering `<ProductMobileCard>` per product (line 214-218). Each card is memoized (line 385). Includes thumbnail, title, slug, badges, price range, variant count. ✓
- Empty state, loading skeleton, error state with retry button. ✓

**VERIFIED OK** — responsive behavior is correct, no hydration issues (no `Math.random()` / `Date.now()` in render path).

### D.2 — `product-create-view.tsx` — multi-step wizard, draft autosave, scroll, form guard

- **Multi-step wizard:** 3 steps (`Basic Details`, `Variants & Pricing`, `Scope & Confirm`). State isolated per step. ✓
- **Draft autosave:** `saveDraft` callback (lines 297-317) calls `POST /api/products/drafts`. **NOT auto-triggered** — only called via `useFormGuard({ onSaveDraft: saveDraft })` when the user attempts to navigate away with unsaved changes. No setInterval / debounced autosave. (This is "save on guard" not "autosave" — but the brief says "draft autosave" — flag as smell, not bug.)
- **Scroll behavior:** Lines 353-357 — `useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }) }, [step])` — scrolls to top on step change. ✓ (The comment notes the original bug: navigating to step 3 left the page scrolled to the bottom.)
- **Form guard:** `useFormGuard({ isDirty: hasChanges && !submitting, onSaveDraft: saveDraft })` (line 319-322). Returns `{ ConfirmModal, attemptNavigation: guardedNavigate }`. The "Back to products" button calls `guardedNavigate(onBack)` (line 708). ✓
- **Draft delete on success:** Line 689-692 — after product creation succeeds, calls `DELETE /api/drafts?id=${draftId}` to clean up. ✓

**VERIFIED OK** with the smell that "autosave" is actually "save-on-guard".

### D.3 — `catalog-settings-view.tsx` — 4 tabs CRUD, inline-create shortcuts

**Brief expectation:** 4 tabs CRUD.

**Actual:** 3 top-level tabs (Categories, Brands, Attributes) — confirmed at lines 170-180. The Attributes tab contains a nested `AttributeValuesPanel` (line 1799) that acts as the "4th" CRUD surface. The brief's expectation of 4 tabs is not matched — only 3 are top-level.

**Permission gate:** Line 159 — `if (!can('products.manage_catalog')) return <InsufficientPermissions />`. ✓ Elevated-only via the permission check, not via `elevated` tier check directly.

**Inline-create shortcuts:** Inside the variant builder (NOT in catalog settings), `attribute-selector.tsx` calls `/api/catalog/inline-attribute` and `/api/catalog/inline-value` to create new attributes/values without leaving the wizard. ✓ Within `catalog-settings-view.tsx` itself, attributes are created via the dialog form `AttributeFormDialog` — not "inline".

**CRUD coverage per tab:**
- Categories: ✓ Create / Read / Update / Delete (with product-reference guard)
- Brands: ✓ Create / Read / Update / Delete (with product-reference guard)
- Attributes: ✓ Create / Read / Update / Delete (cascade to attribute_values)
- Attribute Values: ✓ Create / Read / Update / Delete (nested in Attributes tab)

**VERIFIED OK** for functionality. The "4 tabs" mismatch with the brief is a UI-design choice, not a bug.

### D.4 — `returned-stitched-view.tsx` — mark_sold / write_off UI actions

- **Mark Sold:** Dialog (lines 500-512) collects `sold_order_reference` string. Mutation calls `POST /api/returned-stitched/${id}` with `{ action: 'sold', sold_order_reference }`. ✓ On success → toast.success + invalidate queries. ✓
- **Write Off:** Dialog (lines 514-525) collects `reason` string. Mutation calls `POST /api/returned-stitched/${id}` with `{ action: 'write_off', reason }`. ✓
- **Row actions:** `ReturnedRow` component (line 605) renders the two action buttons ONLY when `item.status === 'available'` (line 656). Sold / written_off rows show "—" in the actions column. ✓
- **Stats:** `availableCount`, `totalValue`, `writtenOffThisMonth` displayed in a 3-card grid. ✓

**VERIFIED OK** at the UI layer. The underlying backend bug (PROD-001) means the pool decrement silently fails, but the UI correctly reports success because the backend returns success.

### D.5 — `org-catalog-view.tsx` — elevated-only guard

Lines 1062-1063 + 1108:
```ts
const isForbidden = isError && error instanceof FetchError && error.status === 403
// ...
{isForbidden ? <PermissionMessage /> : <Tabs>...</Tabs>}
```

The `PermissionMessage` card (line 167) shows: *"The Org Catalog is only available to elevated employees (admins / managers)."* ✓

**Mechanism:** The backend `GET /api/org/catalog` route returns 403 if the caller is not elevated (lines 27-29 of that route). The frontend catches the FetchError and renders the gate. ✓

**VERIFIED OK.**

### D.6 — Permission-gated buttons (Promote, Archive, Subscribe) — hidden vs disabled

- **Promote (org-catalog-view):** `PromotableProductCard` (line 890) — `canPromote = can(PRODUCTS_PROMOTE)`. Three render paths:
  - `canPromote && readyToPromote` → green Promote button (enabled)
  - `canPromote && !readyToPromote` → disabled Promote button + tooltip "Not ready to promote"
  - `!canPromote` → button is **hidden** (renders `null`)

- **Demote (org-catalog-view):** the Demote button is in the `SharedProductCard` component; verified that the entire SharedProductCard is only rendered to elevated users (the route returns 403 for non-elevated, which triggers the PermissionMessage gate at the page level).

- **Promote (product-detail-view):** the "Promote to Org" button (line 242) is gated by `product.isOwner` — NOT by `can('products.promote')`. A non-elevated owner without the `products.promote` permission sees the button. Worse — clicking it calls the broken PATCH route (PROD-003). See PROD-020.

- **Archive / Subscribe buttons:** NOT implemented in any frontend component. The endpoints `DELETE /api/products/[id]` and `POST /api/products/[id]/subscribe` are reachable only via direct API call. See PROD-004.

### D.7 — Hydration issues / React warnings

- `attribute-selector.tsx` line 1015: uses `id: 'r' + Date.now()` for row IDs — but only inside `addRow` event handler (not in render path), so no SSR/CSR mismatch. ✓
- `catalog-settings-view.tsx` line 1813: uses `useRef<string>(crypto.randomUUID())` for the Idempotency-Key — `crypto.randomUUID()` is server-safe in Node 19+ and browsers; `useRef` ensures it's stable across re-renders. No hydration issue. ✓
- `products-view.tsx`: no Date.now / Math.random in render path. ✓
- `product-create-view.tsx`: no unstable IDs in render. ✓
- `parent-child-variant-table.tsx`: `crypto.randomUUID()` for Idempotency-Key refs (line 1114 area) — same pattern as above. ✓
- `client-side-parent-child-variant-table.tsx`: stable. ✓
- `returned-stitched-view.tsx`: stable. ✓
- `org-catalog-view.tsx`: stable. ✓
- `product-detail-view.tsx`: stable. ✓

**VERIFIED OK** — no hydration issues detected.

---

## PART E — CROSS-MODULE TRIGGER VERIFICATION

### E.1 — Product creation → variant creation → ZERO InventoryPool rows

Grep for `inventoryPool` (case-sensitive) across `src/app/api/products/` returns **zero** matches. POST `/api/products` is wrapped in `db.$transaction` (lines 249-335) and only creates: `orgProduct`, `orgProductVariant`, `companyVariantPricing`, `companyProductSetting`. The opening-stock step (lines 621-649 of `product-create-view.tsx`) is a SEPARATE call to `POST /api/inventory/opening-stock` made AFTER the product is created, and only for variants where `has_opening_stock && qty > 0 && location_id`. ✓

**VERIFIED OK — product creation does NOT touch InventoryPool.**

### E.2 — Opening stock → one InventoryPool + one AvgCostHistory

**Trace:**
1. `POST /api/inventory/opening-stock` (route.ts) → calls `processInventoryTransaction({ transactionType: 'opening_stock', ... })`.
2. `processInventoryTransaction` (`src/lib/inventory.ts`):
   - Line 130-148: `findUnique` on `orgVariantId_locationId`. If not found → `create` with zeros (one row).
   - Line 280-283: `update` on the (now-existing) pool row — only ONE pool row touched.
   - Line 288-303: For `opening_stock`, if `variant.trackInventory === false && fulfillmentType === 'made_to_order'` → ONE `orgProductVariant.update` to flip trackInventory to true (one-way).
   - Line 309-327: ONE `inventoryTransaction.create`.
   - Line 330-345: If `avgCostChanged` (only when the new cost differs from old) → ONE `avgCostHistory.create`.

**Edge cases:**
- If the variant already has a pool row (e.g. re-opening stock after a sale): the `findUnique` hits, no `create` — only an `update` + a new `inventoryTransaction` + (conditionally) a new `avgCostHistory`.
- If `costPerUnit === oldAvgCost`: `avgCostChanged = false`, no `avgCostHistory` row created (correct optimization).

**Expected behavior:** ONE InventoryPool row per (orgVariantId, locationId), ONE InventoryTransaction, ZERO-or-ONE AvgCostHistory. ✓

**DB confirmation (live query B4):**
```
fulfillmentType=made_to_order  trackInventory=true  pool_rows=5
fulfillmentType=stock_based    trackInventory=true  pool_rows=35
```

5 MTO variants have pools (correct — they were opened via opening-stock or first return). 35 stock_based variants have pools. No duplicate pool rows (enforced by `@@unique([orgVariantId, locationId])`).

**VERIFIED OK.**

### E.3 — Toggle variant inactive → effect on order-create picker

**Trace:**
1. `POST /api/products/[id]/variants/[variantId]/toggle` sets `OrgProductVariant.isActive = is_active`.
2. `GET /api/products?include_inactive_variants=true` returns the variant with `isActive: false` in the response.
3. `order-create-view.tsx` line 526 — maps `isActive: v.isActive` to the variantOption.
4. Line 2025 — `if (v.isActive === false) gateReason = 'Not enabled for your company'`.
5. Line 2028 — `variantDisabled = gateReason !== null`.
6. Lines 2030-2070 — disabled variants render with `opacity-60`, `cursor-not-allowed`, no `+` button. The user CANNOT add them to the cart.

**VERIFIED OK** — the toggle takes effect on the order picker (gate 1 of the 3-gate visibility system).

### E.4 — Promote product → switch company → visibility (trace GET /api/products filter)

**Trace:**
1. Company A (source) calls `POST /api/products/[id]/promote` with `target_scope='organization'`. Backend sets `productScope='organization'`, `promotedAt=now`, `promotedById=A`. (Does NOT create SelectiveProductAccess rows.)
2. Company B (same org, different company) signs in. The workspace switcher calls `/api/workspace/switch` to set `activeCompanyId=B`.
3. Company B's `GET /api/products` runs with `companyId = B`. The where clause (line 56-69):
   ```
   OR: [
     { sourceCompanyId: B },                              ← false (source is A)
     { productScope: 'organization' },                    ← TRUE → match
     { productScope: 'selective', selectiveAccess: ... }, ← n/a
   ]
   ```
4. Company B sees the promoted product. ✓

**Re-promote to selective:** Company A calls promote with `target_scope='selective', selected_company_ids=[B, C]`. The route UPSERTs SelectiveProductAccess for B and C. Company D (in same org) now sees the product? `productScope='selective'` + `selectiveAccess.some({ companyId: D })` — D is NOT in the access list, so the `OR` clause fails → D does NOT see the product. ✓

**VERIFIED OK** for the canonical promote flow. (PROD-003 documents the broken detail-view Promote button which bypasses this route.)

---

## BUGS FOUND

```
BUG-ID: PROD-001
Layer: DB | API
Severity: Critical
Location: src/app/api/returned-stitched/[id]/route.ts (lines 80, 144) + prisma/schema.prisma (ReturnedStitchedInventory model, lines 846-893)
Description: The mark_sold and write_off handlers reference `record.locationId` and `record.orgVariantId` and pass them to processInventoryTransaction / recordStockLoss. The schema column-list returned by Supabase confirms `ReturnedStitchedInventory` has NO `locationId` column — only `orgVariantId`. `record.locationId` evaluates to `undefined`. Both helper calls fail with "locationId is required" or "InventoryLocation not found" inside the surrounding try/catch (lines 76-93 and 138-157). The error is swallowed to `console.error`, the audit log records success, and the response returns `{ success: true, status: 'sold' }`.
Expected: When a returned-stitched item is marked sold/written_off, the inventory pool must be decremented (via processInventoryTransaction type='sale_dispatched' for sold, or via recordStockLoss with createInventoryTransaction=true for write_off). Without this, the pool shows phantom stock that no longer physically exists.
Actual: Pool is never decremented. The ReturnedStitchedInventory register shows the item as 'sold'/'written_off', but the InventoryPool.onHand stays inflated forever. Every future "available stock" calculation overstates real stock by N (where N = count of sold/written-off returned-stitched items).
Repro Steps:
  1. Create a made_to_order variant.
  2. Receive a returned-stitched item via POST /api/returned-stitched (creates ReturnedStitchedInventory row, status='available').
  3. (Note: this old route does NOT create an inventory_transaction — see PROD-002. So the pool is NOT incremented on receive. To properly test, manually call /api/inventory/receive-returned-stitched instead, which DOES increment the pool.)
  4. Mark the item as sold via POST /api/returned-stitched/{id} with `{ action: 'sold', sold_order_reference: 'TEST' }`.
  5. Observe the server console: `[returned-stitched] Failed to create sale_dispatched txn for ...: locationId is required` (or similar).
  6. Query `SELECT "onHand" FROM "InventoryPool" WHERE "orgVariantId" = ...` — value unchanged.
  7. Query `SELECT status FROM "ReturnedStitchedInventory" WHERE id = ...` — value 'sold'.
  8. The pool shows phantom stock; the register shows sold. Inconsistent state.
Suspected Root Cause: The ReturnedStitchedInventory model was designed WITHOUT a locationId column (the schema comment says it links via inventoryTxnId, not locationId). The mark_sold / write_off handlers were copy-pasted from a different route that DID have locationId on the record. The try/catch pattern hides the error. The handler should either: (a) look up the InventoryPool row via the inventoryTxnId link, or (b) require a `location_id` in the request body of the mark_sold / write_off call, or (c) store locationId on ReturnedStitchedInventory at receive time.
```

```
BUG-ID: PROD-002
Layer: API
Severity: Critical
Location: src/app/api/returned-stitched/route.ts (POST handler, lines 78-185)
Description: The POST /api/returned-stitched route creates ONLY a ReturnedStitchedInventory record. It does NOT call processInventoryTransaction, does NOT set inventoryTxnId, does NOT flip trackInventory on the variant. The Prisma schema comment (lines 879-886) explicitly states "When a returned-stitched record is created, the route also creates an inventory_transaction (return_stitched_received) and stores its ID here." This contract is violated. The newer /api/inventory/receive-returned-stitched route DOES create the txn, but the frontend returned-stitched-view.tsx (line 313) calls the OLD broken route.
Expected: A returned-stitched receive should: (1) create ReturnedStitchedInventory row, (2) create an inventory_transaction of type 'return_stitched_received' that increments the pool, (3) store the txn ID in ReturnedStitchedInventory.inventoryTxnId, (4) flip trackInventory FALSE→TRUE for made_to_order variants.
Actual: Only step (1) happens. The pool is never incremented, inventoryTxnId stays NULL (DB confirms 2/2 rows have NULL), trackInventory stays at its prior value. The returned item is "registered" but has no stock presence.
Repro Steps:
  1. POST /api/returned-stitched with `{ org_variant_id: '...', quantity: 1, condition: 'perfect', total_cost: 100, return_reason: 'test' }`.
  2. Query: `SELECT "inventoryTxnId" FROM "ReturnedStitchedInventory" ORDER BY "receivedAt" DESC LIMIT 1;` → NULL.
  3. Query: `SELECT * FROM "InventoryTransaction" WHERE "transactionType" = 'return_stitched_received' ORDER BY "recordedAt" DESC LIMIT 1;` → 0 rows.
  4. The item is in the register but not in the pool.
Suspected Root Cause: Code drift. The route was written before the inventory-ledger integration; the newer /api/inventory/receive-returned-stitched route was added but the frontend was never migrated to call it. The schema comment was updated to describe the new contract, but the old route's behavior was never aligned.
```

```
BUG-ID: PROD-003
Layer: Frontend | API
Severity: Critical
Location: src/components/products/product-detail-view.tsx (line 182: `api.patch('/api/products/${productId}', { product_scope: scope })`) + src/lib/validations/product.ts (updateProductSchema lines 130-142 — no `product_scope` field)
Description: The "Promote to Org" button on the product detail page calls PATCH /api/products/[id] with `{ product_scope: scope }`. But updateProductSchema does NOT include `product_scope` — Zod's default behavior is to strip unknown keys, so the field is silently dropped during `safeParse`. The PATCH handler then updates ZERO fields (the `data: { ... }` object is empty), returns `Response.json({ id: updated.id })` (200 OK), and the frontend shows a success toast "Product scope set to Organization." The actual DB row's productScope NEVER changes. No promotedAt / promotedById is set. No SelectiveProductAccess rows are created for selective scope.
Expected: Clicking "Promote to Org" should call POST /api/products/[id]/promote with `{ target_scope: scope, selected_company_ids: [...] }`. That route enforces elevated + owner + ≥1 variant + ≥1 image, sets productScope + promotedAt + promotedById, and creates SelectiveProductAccess rows for selective scope.
Actual: The PATCH route silently strips the unknown key. The DB row is unchanged. The user sees a success toast but nothing happened. Bypasses the promote route's gate (≥1 active variant + ≥1 image) entirely.
Repro Steps:
  1. As owner of a private product, open the product detail page.
  2. Click "Promote to Org" → dialog opens.
  3. Select "Organization" → click Promote.
  4. Observe success toast: "Product scope set to Organization."
  5. Refresh the page — the scope badge still shows "Private".
  6. Query DB: `SELECT "productScope", "promotedAt", "promotedById" FROM "OrgProduct" WHERE id = '...';` → unchanged.
Suspected Root Cause: The PromoteDialog component was wired to the wrong endpoint. The PATCH route is for editing product fields (title, brand, etc.), not scope transitions. The promote route exists at POST /api/products/[id]/promote but was never wired into the detail-view dialog.
```

```
BUG-ID: PROD-004
Layer: Frontend
Severity: Critical
Location: src/components/products/product-detail-view.tsx (header actions, lines 239-247) + src/components/products/org-catalog-view.tsx (entire file)
Description: The Subscribe and Archive buttons are NOT rendered anywhere in the frontend. The endpoints POST /api/products/[id]/subscribe and DELETE /api/products/[id] exist and are functional, but no UI surface exposes them. A user can only subscribe via direct API call; can only archive via the Org-Catalog view's demote flow (which is different from archive — demote sets scope to private, archive sets scope to 'archived'). The detail-view header has only one button: "Promote to Org" (which is broken — see PROD-003).
Expected: The product detail page should expose Promote / Demote / Archive / Subscribe buttons gated by the appropriate permissions (products.promote, products.subscribe, elevated for archive). Each should call the correct endpoint.
Actual: Only Promote is rendered (broken). Subscribe + Archive are completely missing.
Repro Steps:
  1. Open any product detail page.
  2. Observe header actions: only "Promote to Org" button (and only if isOwner).
  3. No Subscribe button (for non-source companies on org-scoped products).
  4. No Archive button.
  5. The endpoints are unreachable from the UI.
Suspected Root Cause: Incomplete UI implementation. The detail-view was built before the promote/demote/subscribe endpoints were finalized; the Org-Catalog view was added later to centralize these actions, but the detail-view's Promote button was never updated to call the new endpoint, and Subscribe/Archive were never added.
```

```
BUG-ID: PROD-005
Layer: API
Severity: High
Location: src/app/api/products/[id]/demote/route.ts (lines 81-103) + src/app/api/products/[id]/promote/route.ts (lines 88-101)
Description: When a product is demoted from 'selective' or 'organization' to 'private' or 'selective', the demote route updates productScope and revokes CompanyProductSetting rows for non-source companies, but does NOT delete the SelectiveProductAccess rows. If the product is later re-promoted to 'selective' (with a different company list), the OLD SelectiveProductAccess rows silently re-grant access to companies that were previously revoked. Similarly, the promote route UPSERTs new SelectiveProductAccess rows for the new company list but does NOT revoke (delete) rows for companies NOT in the new list — so previously-granted access persists silently.
Expected: On demote-to-private: delete ALL SelectiveProductAccess rows for this product (the access list is meaningless while scope is private, and a fresh promote should start clean). On promote-to-selective: delete SelectiveProductAccess rows for companies NOT in the new selected_company_ids list.
Actual: Stale SelectiveProductAccess rows accumulate. Re-promoting after a demote silently restores the OLD access list.
Repro Steps:
  1. Promote product P to 'selective' with companies [B, C].
  2. Demote P to 'private'. (Subscriptions for B, C are revoked; SelectiveProductAccess rows for B, C REMAIN in DB.)
  3. Re-promote P to 'selective' with companies [D] only.
  4. Company B queries GET /api/products — the OR clause `{ productScope: 'selective', selectiveAccess: { some: { companyId: B } } }` returns TRUE (stale row). B sees the product even though the user only granted access to D.
Suspected Root Cause: The demote route was written before selective scope was fully designed; the cleanup of SelectiveProductAccess was missed. The promote route's UPSERT-with-empty-update pattern doesn't revoke.
```

```
BUG-ID: PROD-006
Layer: API
Severity: High
Location: src/app/api/products/[id]/selective-access/route.ts (POST handler, lines 50-59)
Description: The selective-access POST route UPSERTs a single SelectiveProductAccess row for the requested company_id. It does NOT revoke access for companies NOT in the request. The frontend (org-catalog-view) calls this per-company when granting access via the picker, but there's no "revoke all not in this list" batch endpoint. The DELETE handler does revoke per-company. But the promote route (POST /api/products/[id]/promote) DOES batch-upsert for selected_company_ids. The two paths (selective-access POST vs promote POST) have inconsistent semantics — promote adds without revoking, selective-access POST adds without revoking.
Expected: Either: (a) a single "set selective access list" endpoint that revokes rows not in the new list, OR (b) the promote route should also revoke rows not in selected_company_ids.
Actual: Both endpoints only add; neither revokes. To revoke, the user must manually click "Revoke" per company in the UI (which calls DELETE /api/products/[id]/selective-access?company_id=X). For a 50-company org where the user wants to switch from [B, C, D] to [B, E], the user must: (1) grant E, (2) manually revoke C and D. No batch operation.
Repro Steps:
  1. Promote product to selective with companies [B, C, D] via POST /promote.
  2. Grant access to E via POST /selective-access `{ company_id: E }`.
  3. C and D still have access. To remove them, must call DELETE /selective-access?company_id=C and DELETE /selective-access?company_id=D separately.
Suspected Root Cause: API design oversight. The selective-access endpoint was designed as a per-company toggle, but the promote endpoint was designed as a batch-set. The two should align.
```

```
BUG-ID: PROD-007
Layer: API
Severity: High
Location: src/app/api/products/[id]/variants/route.ts (POST handler, lines 77-143)
Description: The "add variants to existing product" route loops over `variants` array, calling `db.orgProductVariant.create` + `db.companyVariantPricing.upsert` per variant, then a final `db.companyProductSetting.upsert`. These are NOT wrapped in `db.$transaction`. If variant #3 of 5 fails (e.g. SKU unique constraint violation), variants 1-2 are committed (with their pricing rows), variant 3 throws, variants 4-5 never run, and the companyProductSetting.upsert never runs. The product is left with partial variants and no companyProductSetting. Compare to POST /api/products (the create-product route) which IS wrapped in $transaction (line 249).
Expected: All variant creates + pricing upserts + companyProductSetting upsert should be atomic. If any fails, all roll back.
Actual: Partial commit on mid-loop failure. Orphan variants with no subscription. User must manually clean up.
Repro Steps:
  1. Call POST /api/products/{existingProductId}/variants with 3 variants where variant #3 has a duplicate SKU.
  2. Variants #1 and #2 are created (committed). Variant #3 throws PrismaClientKnownRequestError P2002 (sku_key).
  3. The route returns 500.
  4. The product now has 2 phantom variants and no companyProductSetting row was upserted (line 133 never reached).
Suspected Root Cause: The $transaction wrapper was added to POST /api/products during the prior audit's critical-bug fix, but the same pattern was not applied to this sibling route.
```

```
BUG-ID: PROD-008
Layer: API
Severity: High
Location: src/app/api/products/[id]/variants/[variantId]/override-price/route.ts (line 58-70), override-cost/route.ts (line 46-49), override-weight/route.ts (line 47-50)
Description: The 3 override-* routes do NOT verify that `variantId` (from the URL) belongs to `productId` (from the URL). They look up `company`/`orgId` from the session and directly `update` / `upsert` on `variantId`. A user with PRODUCTS_EDIT or PRODUCTS_PRICING permission can pass any variantId from a DIFFERENT product (within the same org) and the override is applied — cross-product permission bypass within the org. Compare to the resync-* routes which DO verify via `findFirst({ where: { id: variantId, productId } })`.
Expected: All 6 variant-level routes (3 override + 3 resync) should verify `variantId` belongs to `productId` via `findFirst({ where: { id: variantId, productId, organizationId: orgId } })` before mutating.
Actual: 3 of 6 routes are missing the ownership check. A user can override the cost/weight/price of a variant belonging to a product they shouldn't be editing (as long as they have the right permission and the product is in their org).
Repro Steps:
  1. As a user with PRODUCTS_EDIT permission, get the variantId V1 of product P1 (owned by your company).
  2. Get the variantId V2 of product P2 (different product, same org, owned by another company OR even by your company).
  3. Call POST /api/products/{P1}/variants/{V2}/override-cost with `{ cost_price: 1 }`.
  4. The route updates V2's costPrice — even though V2 belongs to P2, not P1.
  5. The URL `/api/products/{P1}/...` is misleading; the actual update is on V2.
Suspected Root Cause: Copy-paste of the route scaffolding; the `findFirst({ id: variantId, productId })` was added to the resync-* routes (which need it for the parent-group lookup) but missed on the override-* routes.
```

```
BUG-ID: PROD-009
Layer: API
Severity: Medium
Location: src/app/api/products/[id]/variant-groups/[parentValueId]/cost/route.ts (line 28), weight/route.ts (line 29), sale-price/route.ts (line 29)
Description: The `parentValueId` URL parameter is destructured from `params` but NEVER used. The actual parent value is taken from `body.parent_value` and `body.parent_attribute_name`. This is misleading — the URL implies the route is keyed on the parent value ID, but the body is what actually drives the cascade. A user could pass any string as `parentValueId` and the route behaves identically.
Expected: Either use `parentValueId` to look up the parent attribute + value (cleaner REST design), OR remove it from the URL and make the route `/api/products/[id]/variant-groups/cascade-cost` (honest about what it does).
Actual: The URL parameter is decorative. The route is functionally a body-driven cascade.
Repro Steps:
  1. Call POST /api/products/{id}/variant-groups/ANY_STRING_HERE/cost with `{ cost_price: 100, parent_attribute_name: 'Size', parent_value: 'M' }`.
  2. The route succeeds regardless of `ANY_STRING_HERE`.
Suspected Root Cause: REST design drift. The URL was originally designed to be RESTful (parentValueId as a path param), but the implementation shifted to body-driven without updating the URL.
```

```
BUG-ID: PROD-010
Layer: API
Severity: Medium
Location: src/app/api/products/[id]/images/route.ts (POST handler, lines 60-97)
Description: Image uploads are stored on the local filesystem under `/public/uploads/products/{orgId}/{productId}/`. The Prisma schema comment for OrgProductImage (line 724) says "Images stored in Supabase Storage, shared across all subscribing companies." This is FALSE — they're stored locally. On Vercel or any ephemeral-container deployment, `/public/uploads` is wiped on every redeploy. Existing product images silently 404. The `publicUrl` field stores `/uploads/products/...` which is served by Next.js's static file middleware from the local `/public` folder — which is empty after a redeploy.
Expected: Either: (a) use Supabase Storage as the schema comment claims, OR (b) update the schema comment to reflect local-storage reality, OR (c) use a persistent volume mount (Docker) and document the requirement.
Actual: Images are lost on every redeploy on Vercel. The DB rows persist (with `publicUrl` pointing to a 404), so the product detail page shows broken-image icons. The `isPrimary` flag still points to a dead image.
Repro Steps:
  1. Upload an image to a product on a Vercel deployment.
  2. Trigger a redeploy (push to main, or `vercel --prod`).
  3. Open the product detail page — the image is broken (404).
  4. The DB row still exists with `publicUrl = /uploads/products/.../image.jpg`.
Suspected Root Cause: Local filesystem was used during dev for simplicity; the migration to Supabase Storage was planned (schema comment) but never executed.
```

```
BUG-ID: PROD-011
Layer: API
Severity: Medium
Location: src/app/api/products/[id]/route.ts (GET handler, lines 14-50)
Description: GET /api/products/[id] uses the legacy 4-query auth pattern (getCurrentUser → userSetting → employee → rolePermission). It does NOT call `requirePermission(PRODUCTS_VIEW)`. The only authorization is the `OR` clause in the `findFirst` query (line 31-35): `{ sourceCompanyId: companyId } OR { productScope: 'organization' } OR { productScope: 'selective', selectiveAccess: { some: { companyId } } }`. This means any active employee of the company — even one without `products.view` permission — can fetch any product detail the company has visibility into. The route returns the full product (variants, pricing, images, subscription).
Expected: Should call `requirePermission(ctx, PERMISSIONS.PRODUCTS_VIEW)` at the top, like GET /api/products does.
Actual: No permission check beyond company membership. A role with zero permissions can still read product details.
Repro Steps:
  1. Create a role with no permissions.
  2. Assign an employee to that role.
  3. As that employee, call GET /api/products/{anyVisibleProductId}.
  4. The route returns 200 with full product data.
Suspected Root Cause: Legacy auth pattern. The route predates the `requirePermission` helper.
```

```
BUG-ID: PROD-012
Layer: API
Severity: Medium
Location: src/app/api/products/[id]/variant-groups/route.ts (GET handler, lines 25-130)
Description: The variant-groups GET route has NO permission check — it only checks `getCurrentUser` + `userSetting.activeOrgId`. Any active employee can fetch the full variant-grouping structure (including per-company pricing) for any product in their org, regardless of whether they have `products.view` permission or whether the product is private to another company. The `findFirst` (line 39) filters by `{ id: productId, organizationId: orgId }` — so a private product owned by Company A is readable by Company B in the same org via this endpoint, even though the main GET /api/products list would hide it.
Expected: Should call `requirePermission(ctx, PERMISSIONS.PRODUCTS_VIEW)` AND apply the same `OR: [sourceCompanyId, organization, selective]` visibility filter as GET /api/products.
Actual: Any company in the org can fetch the variant structure of any other company's private product. Cross-company data leak within the org.
Repro Steps:
  1. Company A creates a private product P (sourceCompanyId = A, productScope = 'private').
  2. Company B (same org) calls GET /api/products/{P_id}/variant-groups.
  3. The route returns 200 with the full variant + pricing data — even though GET /api/products would NOT list P for Company B.
Suspected Root Cause: The variant-groups endpoint was designed for the product-detail-page table, assuming the user had already passed the detail-page visibility check. But the endpoint itself has no independent check.
```

```
BUG-ID: PROD-013
Layer: API | Cross-Module
Severity: Medium
Location: src/app/api/products/route.ts (GET handler, lines 56-69) + src/components/orders/order-create-view.tsx (variant picker, line 526)
Description: The GET /api/products visibility filter (OR clause) does NOT check `CompanyProductSetting.subscriptionStatus` or `CompanyProductSetting.isActive`. A company whose subscription to an org-scoped product was revoked (via demote) — `subscriptionStatus='revoked', isActive=false` — still sees the product in the list (because `productScope='organization'` matches the OR clause). Worse: the order-create picker uses this same endpoint, so a revoked company can still add the product's variants to new orders. The subscriptionStatus is included in the response (line 150-152) but the frontend does NOT gate on it.
Expected: The GET /api/products route should EXCLUDE products where `companySettings.subscriptionStatus = 'revoked'` for non-source companies. OR the order-create picker should check `subscriptionStatus` and disable variants of revoked-subscription products.
Actual: Revoked companies can still create orders against the product. The demote action's intent (revoke access) is partially defeated.
Repro Steps:
  1. Company A owns product P, promotes to organization scope.
  2. Company B subscribes (creates CompanyProductSetting with isActive=false until pricing is set, then isActive=true after pricing).
  3. Company A demotes P to private — B's CompanyProductSetting is set to subscriptionStatus='revoked', isActive=false. Product P is now private (sourceCompanyId=A only), so B no longer sees P. ✓
  4. Company A re-promotes P to organization scope.
  5. Company B's CompanyProductSetting still has subscriptionStatus='revoked' (the demote didn't delete it, just revoked it).
  6. Company B calls GET /api/products — sees P (because productScope='organization' matches).
  7. Company B can add P's variants to new orders — even though its subscription is revoked.
Suspected Root Cause: The visibility filter was designed around productScope, not around subscription state. The re-promote flow doesn't re-validate subscriptions.
```

```
BUG-ID: PROD-014
Layer: API
Severity: Medium
Location: src/app/api/products/[id]/images/route.ts (DELETE handler, lines 148-157)
Description: The DELETE image handler checks `isOwner || elevated` but OMITS the `PRODUCTS_EDIT` permission check that the POST upload handler (line 53-58) includes. A user with `products.edit` permission can upload images but cannot delete them — split-brain permission model. The user must be elevated or the source company to delete.
Expected: Both upload and delete should use the same permission gate: `isOwner || elevated || has(PRODUCTS_EDIT)`.
Actual: Upload allows PRODUCTS_EDIT holders; delete does not.
Repro Steps:
  1. As a user with `products.edit` permission (not elevated, not owner), upload an image — succeeds.
  2. Try to delete the same image — fails with 403 "Only the source company can delete images."
Suspected Root Cause: Inconsistent copy-paste of the permission gate.
```

```
BUG-ID: PROD-015
Layer: API
Severity: Medium
Location: src/app/api/products/[id]/pricing/route.ts (POST handler, lines 56-76)
Description: The bulk-set-pricing route UPSERTs CompanyVariantPricing for each `p.org_variant_id` in the payload. It does NOT validate that `p.org_variant_id` belongs to `productId` (from the URL). A user with PRODUCTS_PRICING permission can pass variant IDs from a DIFFERENT product and activate their subscription with phantom pricing rows for variants they don't own.
Expected: Should validate each `org_variant_id` belongs to `productId` via a `findFirst({ where: { id: org_variant_id, productId } })` before UPSERTing.
Actual: Cross-product pricing injection. A user could set pricing for variants of a product they shouldn't be pricing, as long as they have PRODUCTS_PRICING permission.
Repro Steps:
  1. Get variantId V1 from product P1 (owned by your company).
  2. Get variantId V2 from product P2 (different product).
  3. Call POST /api/products/{P1}/pricing with `{ pricing: [{ org_variant_id: V2, sale_price: 100 }] }`.
  4. The route creates a CompanyVariantPricing row for V2 — even though V2 belongs to P2, not P1.
Suspected Root Cause: Same as PROD-008 — the variantId-in-URL pattern is inconsistently enforced.
```

```
BUG-ID: PROD-016
Layer: API | DB
Severity: Low
Location: src/app/api/products/drafts/route.ts + prisma/schema.prisma FormDraft model (lines 1884-1904)
Description: Product drafts (FormDraft where draftType='product') have NO expiry, NO size limit, NO TTL. They persist forever in the DB. The `draftData` JSON column can grow unbounded (a product wizard with 100+ variants × full attribute_values × opening_stock fields can exceed 100KB per draft). No cleanup cron exists. DB confirmed: drafts table is small today (2 rows in audit log), but in production with many users, it will accumulate indefinitely.
Expected: Either: (a) a TTL on FormDraft rows (e.g. delete after 30 days), OR (b) a max-drafts-per-user limit (e.g. 10), OR (c) a size cap on draftData enforced at the API layer.
Actual: Drafts accumulate forever. Storage cost grows linearly with user activity.
Repro Steps:
  1. Create 1000 product drafts for one user.
  2. The DB now has 1000 FormDraft rows, each potentially 100KB+.
  3. No automatic cleanup.
Suspected Root Cause: The draft system was designed as a convenience feature without lifecycle management.
```

```
BUG-ID: PROD-017
Layer: API
Severity: Low
Location: src/app/api/products/[id]/demote/route.ts (lines 65-71)
Description: The returnedCount query nests an `await` inside the `in:` clause:
  `orgVariantId: { in: (await db.orgProductVariant.findMany({ where: { productId }, select: { id: true } })).map((v) => v.id) }`.
JavaScript evaluates the inner await first (fetching all variant IDs), then passes the resulting array to the outer `count`. This works but is brittle: if the inner await throws (e.g. DB connection error), the count() call surfaces a confusing error. Also, the pattern is hard to read — two queries that could be one.
Expected: Split into two statements: `const variantIds = (await db.orgProductVariant.findMany(...)).map(v => v.id);` then `const returnedCount = await db.returnedStitchedInventory.count({ where: { orgVariantId: { in: variantIds }, ... } });`
Actual: Works but is hard to maintain.
Repro Steps: n/a — code smell.
Suspected Root Cause: Inline-await shorthand pattern; common in JS but error-prone.
```

```
BUG-ID: PROD-018
Layer: API
Severity: Low
Location: src/app/api/products/[id]/variants/generate/route.ts (POST, lines 50-57) + src/app/api/products/generate-stitched/route.ts (POST, lines 23-32)
Description: Both generate-* routes have NO permission check — they only verify the user is authenticated (`getCurrentUser`). Any authenticated employee, even one with zero permissions, can call these endpoints to enumerate possible variant combinations and stitching costs. No DB writes happen, but the routes expose internal catalog structure (attribute rules, stitching pricing logic) to unauthorized users.
Expected: Should call `requirePermission(ctx, PERMISSIONS.PRODUCTS_VIEW)` or `PRODUCTS_CREATE`.
Actual: No permission gate. Information disclosure to any authenticated user.
Repro Steps:
  1. Create an employee with zero permissions.
  2. Call POST /api/products/{anyId}/variants/generate with `{ selected_attributes: [...] }`.
  3. The route returns the full cartesian-product combinations + SKU suggestions.
Suspected Root Cause: Pure-calculation routes were assumed to be low-risk; the permission gate was omitted.
```

```
BUG-ID: PROD-019
Layer: API
Severity: Low
Location: src/app/api/catalog/available-attributes/route.ts (GET, lines 12-18) + src/app/api/catalog/attributes/[id]/values/route.ts (GET, lines 14-23)
Description: Both GET routes have NO permission check — they verify the user is authenticated and has an activeOrgId, but do NOT call `requirePermission(PRODUCTS_VIEW)`. Any authenticated employee can enumerate all attributes + values + rules for their org.
Expected: Should call `requirePermission(ctx, PERMISSIONS.PRODUCTS_VIEW)`.
Actual: No permission gate. Information disclosure (low severity since attributes are typically not sensitive).
Repro Steps:
  1. Create an employee with zero permissions.
  2. Call GET /api/catalog/available-attributes.
  3. The route returns all attributes + values + rules for the org.
Suspected Root Cause: Read-only routes assumed low-risk.
```

```
BUG-ID: PROD-020
Layer: Frontend
Severity: Medium
Location: src/components/products/product-detail-view.tsx (header, lines 241-245)
Description: The "Promote to Org" button is gated by `product.isOwner` — NOT by `can('products.promote')`. A non-elevated owner without the `products.promote` permission sees the button. Worse — clicking it calls the PATCH route (PROD-003) which silently no-ops. Even if the PATCH route were fixed to actually update productScope, the button would still bypass the elevated-only check that the canonical POST /api/products/[id]/promote route enforces (line 55-57 of promote/route.ts).
Expected: The button should be gated by `can('products.promote') && product.isOwner` AND should call POST /api/products/[id]/promote (not PATCH).
Actual: Visible to any owner (regardless of permission), and calls the wrong endpoint.
Repro Steps:
  1. As a non-elevated owner with `products.edit` but NOT `products.promote`, open the product detail page.
  2. The "Promote to Org" button is visible.
  3. Click it — silently no-ops (PROD-003).
Suspected Root Cause: The button was added before the permission system was finalized; the gate was never updated.
```

```
BUG-ID: PROD-021
Layer: API
Severity: Low
Location: src/app/api/products/route.ts (GET, line 62) — `isActiveParam !== null ? { isActive: isActiveParam === 'true' } : { isActive: true }`
Description: The hybrid isActive filter has an edge case: if `is_active=` (empty string) is passed, `isActiveParam !== null` is TRUE, and `isActiveParam === 'true'` is FALSE, so the filter becomes `{ isActive: false }` — hiding all active products. Should use `isActiveParam !== null && isActiveParam !== ''` or default to `undefined` when empty.
Expected: `is_active=` (empty) should be treated as "no filter" (same as omitting the param).
Actual: `is_active=` hides all active products.
Repro Steps:
  1. Call GET /api/products?is_active= (empty value).
  2. Response: `{ products: [], total: 0 }` — no products returned.
  3. Call GET /api/products?is_active=true → active products returned.
Suspected Root Cause: Loose null-check; didn't account for empty string from URL parsing.
```

```
BUG-ID: PROD-022
Layer: API
Severity: Low
Location: prisma/schema.prisma OrgProductBundle model (lines 747-759)
Description: The OrgProductBundle model is defined (for bundle-type products) but NEVER written to or read from by any route. DB confirms: `SELECT count(*) FROM "OrgProductBundle"; → 0`. The `product_type='bundle'` enum value is accepted by productSchema (validations/product.ts line 117) but no OrgProductBundle rows are created. If a user picks 'bundle' as the product type, they get a product with no bundle components and no error.
Expected: Either: (a) implement bundle component management (CRUD for OrgProductBundle rows), OR (b) remove the 'bundle' enum value from productSchema until the feature is built.
Actual: Dead schema. Users can create a "bundle" product that has no bundle behavior.
Repro Steps:
  1. POST /api/products with `{ product_type: 'bundle', ... }`.
  2. Product is created with productType='bundle'.
  3. No bundle components can be added (no endpoint exists).
  4. The product behaves like a simple product with a misleading type label.
Suspected Root Cause: Schema was designed ahead of implementation; the bundle feature was never built.
```

---

## ADDITIONAL FINDINGS (no specific BUG-ID — informational)

### F.1 — Mixed auth pattern (modern vs legacy)

Only 8 of ~40 routes use the modern `getWorkspace() + requirePermission()` helper introduced by the `REBUILD-API-PROTECTION` task. The other ~32 use the legacy 4-query pattern (`getCurrentUser → userSetting.findUnique → employee.findFirst → rolePermission.count`). The modern helper caches the workspace context (0ms vs 4 round-trips). On hot paths (GET /api/products, GET /api/products/[id], GET /api/products/[id]/variant-groups), this adds ~10-15ms per request. Not a bug, but a tech-debt item.

### F.2 — Idempotency-Key coverage

Supported on: POST /api/products, POST /api/categories, POST /api/brands, POST /api/returned-stitched, POST /api/inventory/opening-stock, POST /api/inventory/receive-returned-stitched. NOT supported on: POST /api/products/[id]/variants, POST /api/products/[id]/promote, POST /api/products/[id]/demote, POST /api/products/[id]/selective-access, POST /api/products/[id]/subscribe, POST /api/products/[id]/pricing, POST /api/products/[id]/images, all 6 override/resync routes, all 3 variant-groups cascade routes, all catalog/attributes/brands/categories CRUD routes. A network retry on any of these could create duplicate data (caught by unique constraints in some cases, but not all).

### F.3 — DB-level orphan product (B.1)

One orphan OrgProduct (`cmry40xze0003pz2k7brq467s` — "OST Verify Product") exists with zero variants. The POST /api/products route is now wrapped in `db.$transaction`, so this orphan likely predates the fix or was created by a manual DB insert during smoke testing. Recommend investigating the createdAt timestamp against the git-blame date of the $transaction wrapper.

### F.4 — DB-level: OrgProductBundle table is empty

`SELECT count(*) FROM "OrgProductBundle"; → 0`. The bundle feature is dead schema. See PROD-022.

### F.5 — DB-level: SelectiveProductAccess has 1 row total

Only 1 selective access row exists in production. The selective-scope feature is minimally exercised. The bugs PROD-005 and PROD-006 are theoretical for now but will become real as selective-scope usage grows.

### F.6 — DB-level: 0 variants have costPriceSyncedWithParent=false

No overrides have ever been performed in production. The entire parent-child cascade / override / resync pattern is untested in real usage. The bugs PROD-008 (override-* missing ownership check) are dormant.

### F.7 — DB-level: ReturnedStitchedInventory has 2 rows, both with inventoryTxnId=NULL

Confirms PROD-002: the POST /api/returned-stitched route never creates the inventory_transaction. Both existing rows were created via the broken old route.

---

## SUMMARY OF VERIFIED-OK ITEMS

- **A.1** — No stale/duplicated shape readers of `orgVariantId`.
- **A.2** — Variant isActive=false correctly grays-out (not hides) variants in the order-create picker (gate 1).
- **A.3** — Promote (via POST /api/products/[id]/promote from org-catalog-view) correctly switches visibility for other companies.
- **A.4** — Product creation does NOT touch InventoryPool (zero grep matches in src/app/api/products/).
- **A.5** — Org Catalog view and company-level Products view use intentionally different query paths; no drift.
- **B.1** — POST /api/products is wrapped in `db.$transaction` (verified at route.ts line 249).
- **B.2** — OrgProductVariant.sku and .barcode have DB-level UNIQUE indexes (OrgProductVariant_sku_key, OrgProductVariant_barcode_key).
- **B.3** — Zero variants exceed 3 attributeValues keys (DB-confirmed).
- **B.4** — trackInventory is one-way (only ever set to TRUE; no FALSE write exists in src/).
- **B.5** — Sync flags (costPriceSyncedWithParent, weightSyncedWithParent, salePriceSyncedWithParent) are consistent in DB sample.
- **B.6** — CompanyVariantPricing has exactly one row per (companyId, orgVariantId) — DB UNIQUE constraint + zero duplicates in live query.
- **C.1** — POST /api/products handles duplicate SKUs with friendly 400 (pre-check at lines 232-240) + supports Idempotency-Key + made_to_order cost computation exists in variant-add and generate-stitched routes.
- **C.2** — POST /api/products/[id]/variants/generate correctly implements AttributeValueRule bidirectional logic (INCLUSION + EXCLUSION).
- **C.3** — POST /api/products/[id]/promote enforces ≥1 active variant + ≥1 image gate.
- **C.4** — POST /api/products/[id]/demote revokes subscriptions + surfaces ReturnedStitchedInventory warnings (non-blocking).
- **C.7** — DELETE /api/products/[id] NEVER hard-deletes — always sets productScope='archived', isActive=false.
- **D.1** — products-view.tsx responsive desktop-table / mobile-card behavior is correct.
- **D.2** — product-create-view.tsx multi-step wizard + form guard + scroll-to-top on step change + draft delete on success.
- **D.3** — catalog-settings-view.tsx has 3 top-level tabs (Categories, Brands, Attributes) with a nested AttributeValuesPanel acting as the 4th CRUD surface; permission gate on `products.manage_catalog`.
- **D.4** — returned-stitched-view.tsx mark_sold / write_off UI actions correctly call POST /api/returned-stitched/[id] with action='sold'/'write_off'.
- **D.5** — org-catalog-view.tsx elevated-only guard correctly catches 403 from the backend and renders PermissionMessage.
- **D.7** — No hydration issues / React warnings detected in any frontend component.
- **E.1** — Product creation → ZERO InventoryPool rows (confirmed via grep).
- **E.2** — Opening stock → exactly ONE InventoryPool row + ONE InventoryTransaction + conditionally ONE AvgCostHistory (confirmed via processInventoryTransaction trace + DB query B4).
- **E.3** — Toggle variant inactive → correctly grays-out + disables in order-create picker (gate 1).
- **E.4** — Promote (via canonical POST route) → product becomes visible to other companies in same org via the OR clause.

---

## NEXT ACTIONS (recommended, in priority order — DO NOT implement, this is read-only audit)

1. **PROD-001 (Critical)** — Fix `record.locationId` reference in `/api/returned-stitched/[id]/route.ts`. Either: (a) require `location_id` in the mark_sold / write_off request body, OR (b) add `locationId` column to ReturnedStitchedInventory schema (set at receive time), OR (c) look up the pool via the `inventoryTxnId` link.
2. **PROD-002 (Critical)** — Either: (a) migrate the frontend `returned-stitched-view.tsx` (line 313) to call `/api/inventory/receive-returned-stitched` instead of `/api/returned-stitched`, OR (b) add the `processInventoryTransaction` call + `inventoryTxnId` linkage to the POST `/api/returned-stitched` route. Option (a) is cleaner (single source of truth).
3. **PROD-003 (Critical)** — Fix `ProductDetailView.changeScope` to call `POST /api/products/[id]/promote` with `{ target_scope, selected_company_ids }` instead of `PATCH /api/products/[id]` with `{ product_scope }`.
4. **PROD-004 (Critical)** — Add Subscribe + Archive buttons to `product-detail-view.tsx` header, gated by `can('products.subscribe')` and `elevated` respectively.
5. **PROD-005, PROD-006 (High)** — Add SelectiveProductAccess cleanup to demote (delete all rows when demoting to private) and promote (delete rows not in selected_company_ids).
6. **PROD-007 (High)** — Wrap POST /api/products/[id]/variants in `db.$transaction` (same pattern as POST /api/products).
7. **PROD-008, PROD-015 (High)** — Add `findFirst({ where: { id: variantId, productId } })` ownership check to the 3 override-* routes and the pricing route.
8. **PROD-010 (Medium)** — Migrate image storage to Supabase Storage (or document the local-filesystem requirement + persistent-volume mount).
9. **PROD-011, PROD-012, PROD-018, PROD-019 (Medium/Low)** — Add `requirePermission(PRODUCTS_VIEW)` to the routes missing it.
10. **PROD-013 (Medium)** — Add subscription-status filter to GET /api/products OR add gate-2 check in order-create picker.
11. **PROD-014 (Medium)** — Add PRODUCTS_EDIT permission check to DELETE /api/products/[id]/images.
12. **PROD-020 (Medium)** — Gate the detail-view Promote button on `can('products.promote') && product.isOwner` AND fix the endpoint (PROD-003).
13. **PROD-016, PROD-017, PROD-021, PROD-022 (Low)** — Tech-debt cleanups.

---

## READ-ONLY CONFIRMATION

- No source code was modified during this audit.
- No schema was modified.
- No DB writes were performed — all SQL queries were SELECT / information_schema reads.
- Two diagnostic scripts were created (`scripts/products-audit-queries.js`, `scripts/products-audit-queries2.js`) — these are read-only query runners and do not modify state. They can be deleted or kept for future audits.

---
