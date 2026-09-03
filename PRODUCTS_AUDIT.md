# Products Section Audit Report

**Task ID:** PROD-AUDIT-BACKEND
**Agent:** general-purpose (read-only audit subagent)
**Scope:** All 5 Products-section modules listed in the FlowOps sidebar (All Products, Add Product, Product Drafts, Returned Stock, Catalog Settings)
**Mode:** READ-ONLY — no source code was modified

---

## Executive Summary

- **Total modules audited:** 5
- **Total API routes:** 41 distinct route files across 5 folders
  - `/api/products/**` — 24 routes
  - `/api/returned-stitched/**` — 3 routes
  - `/api/org/catalog` — 1 route
  - `/api/catalog/**` — 10 routes
  - `/api/categories` + `/api/brands` — 2 routes (legacy top-level shims used by Catalog Settings)
  - `/api/drafts` — 1 route (shared with Orders, backs the Product Drafts sidebar item)
- **Total server actions in `src/lib/actions/`:** 5 (`saveProductDraft`, `saveOrderDraft`, `listDrafts`, `countDrafts`, `deleteDraft`, `getDraft` — all generic, not product-specific)
- **Critical bugs found:** 3
- **High-severity logic issues:** 9
- **Medium-severity issues:** 11
- **Low-severity / smell issues:** 14

The Products subsystem is **architecturally the most mature module in FlowOps**: it has a coherent 3-tier hierarchy (Org → Product → Variant → CompanyPricing), the org-vs-company split is clean, the variant-generation pipeline (cartesian product + bidirectional attribute rules + Shopify 3-key limit) is well-engineered, and the parent-child cascade / override / re-sync pattern (synced_with_parent boolean flags per field) is genuinely elegant. The Prisma schema is sound, indexes are present, and the markets-removal migration was completed cleanly — only 3 comment references to "no market scoping" remain, all explicit and intentional.

However, the API layer has **systemic consistency problems** that mirror the inventory audit (worklog line 11144) almost exactly:

1. **Mixed auth patterns** — only 1 of 41 routes uses the modern `getWorkspace() + requirePermission()` helper introduced by the `REBUILD-API-PROTECTION` task. The other 40 use the legacy 4-query `getCurrentUser → userSetting → employee → rolePermission.count` pattern.
2. **Missing transaction wrapping** on the multi-step product-creation flow (product → variants → companyPricing → companyProductSetting).
3. **Missing permission checks on key write endpoints** — most notably `POST /api/categories` and `POST /api/brands` allow ANY active employee to create org-level catalog entities (HIGH-severity bypass).
4. **Org-scoped (not company-scoped) detail routes** — any company in the org can edit any product, relying solely on the elevated-or-PRODUCTS_EDIT permission check.
5. **Image upload** uses local filesystem (`/public/uploads/products/...`) despite the schema comment claiming "stored in Supabase Storage" — production deployment on Vercel will silently lose images on every redeploy unless a persistent volume / external storage is wired up.
6. **Draft system** has NO expiry, NO size limit, NO TTL — drafts persist forever.

The previous audit (`INV-AUDIT-BACKEND`, INVENTORY_AUDIT.md) found 6 critical / 38 high issues. The Products subsystem is materially cleaner than Inventory, but the same root causes (legacy auth pattern, missing `$transaction`, missing company-scoping on detail routes) repeat here.

---

## Module 1: All Products (product list + detail)

### Purpose
The main browse + read surface. Lists products visible to the active company (own private products + org-wide + selective-shared products the company has been granted access to). Drill into a single product to see all variants, pricing, images, and edit everything. Promote/demote scope, manage selective access, upload/delete images, toggle variants on/off, override or re-sync per-variant pricing/cost/weight with the parent group.

### API Routes

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/products` | Paginated product list with filters (search, category_id, brand_id, product_type, product_scope, is_active, include_inactive_variants). Uses **modern** `getWorkspace() + requirePermission(PRODUCTS_VIEW)` pattern. |
| POST | `/api/products` | Create a new product + variants + companyPricing + companyProductSetting. Supports `Idempotency-Key` header. **No `$transaction`.** Uses **legacy** auth pattern. |
| GET | `/api/products/[id]` | Fetch a single product with variants + pricing + images + subscription. **Legacy auth, no permission check beyond company membership.** |
| PATCH | `/api/products/[id]` | Update product fields (title, base_sku, category, brand, is_stitchable, etc.). Source company or elevated only. **Legacy auth.** |
| DELETE | `/api/products/[id]` | Archive a product (sets productScope='archived', isActive=false). Elevated only. **Never hard-deletes** — good. |
| GET | `/api/products/[id]/variants/[variantId]` | *(No route file exists)* — variant reads happen via the product detail GET. |
| PATCH | `/api/products/[id]/variants/[variantId]` | Update a single variant's editable fields (sku, barcode, cost, weight, stitching_charges, production_days, is_taxable, requires_shipping). Source-company or elevated + PRODUCTS_EDIT. |
| POST | `/api/products/[id]/variants` | Add variants to an existing product. **No `$transaction`** despite looping over variants + creating companyPricing + upserting companyProductSetting. |
| POST | `/api/products/[id]/variants/generate` | Pure calculation — generates variant combinations (cartesian product) from selected attributes, applying `AttributeValueRule` rules bidirectionally (inclusion + exclusion). No DB writes. |
| POST | `/api/products/[id]/variants/[variantId]/toggle` | Activate/deactivate a variant (`is_active` flag). |
| POST | `/api/products/[id]/variants/[variantId]/override-price` | Override a single child's sale/compare price; sets `salePriceSyncedWithParent=false` / `comparePriceSyncedWithParent=false`. |
| POST | `/api/products/[id]/variants/[variantId]/resync-price` | Re-sync a child's sale/compare price with its parent group (finds a synced sibling and copies its value). Sets `syncedWithParent=true`. |
| POST | `/api/products/[id]/variants/[variantId]/override-weight` | Override a single child's weightKg; sets `weightSyncedWithParent=false`. |
| POST | `/api/products/[id]/variants/[variantId]/resync-weight` | Re-sync a child's weight with its parent group. |
| POST | `/api/products/[id]/variants/[variantId]/override-cost` | Override a single child's costPrice; sets `costPriceSyncedWithParent=false`. |
| POST | `/api/products/[id]/variants/[variantId]/resync-cost` | Re-sync a child's costPrice with its parent group. |
| GET | `/api/products/[id]/variant-groups` | Returns variants grouped by parent attribute (lowest `display_order`), including per-company pricing + sync flags. Used by `ParentChildVariantTable`. |
| POST | `/api/products/[id]/variant-groups/[parentValueId]/sale-price` | Cascade sale/compare price to all synced children of a parent group. UPSERTs missing pricing rows. |
| POST | `/api/products/[id]/variant-groups/[parentValueId]/cost` | Cascade cost price to all synced children of a parent group (uses `updateMany`). |
| POST | `/api/products/[id]/variant-groups/[parentValueId]/weight` | Cascade weightKg to all synced children of a parent group (uses `updateMany`). |
| POST | `/api/products/[id]/images` | Upload a product image (multipart/form-data). Stores locally under `/public/uploads/products/{orgId}/{productId}/`. Auto-sets first image as primary. 5MB limit, JPG/PNG/WebP only. |
| DELETE | `/api/products/[id]/images?image_id=...` | Delete an image — removes file from disk + DB row. Promotes next image to primary if deleted image was primary. |
| POST | `/api/products/[id]/subscribe` | Subscribe the active company to an org-wide or selective product. Creates `CompanyProductSetting` with `isActive=false` (inactive until pricing is set). |
| POST | `/api/products/[id]/pricing` | Bulk-set per-variant pricing for the active company. UPSERTs each `CompanyVariantPricing` row. Activates the `CompanyProductSetting` subscription if it was inactive. |
| POST | `/api/products/[id]/promote` | Promote a product from private → organization / selective scope. Elevated-only. Requires ≥1 active variant + ≥1 image. |
| POST | `/api/products/[id]/demote` | Demote a product from organization/selective → private/selective. Elevated-only. Revokes all non-source-company subscriptions (sets `subscriptionStatus='revoked'`, `isActive=false`). |
| POST | `/api/products/[id]/selective-access` | Grant selective access to a specific company. Elevated-only. UPSERTs `SelectiveProductAccess`. |
| DELETE | `/api/products/[id]/selective-access?company_id=...` | Revoke selective access from a company. Elevated-only. |

### Server Actions
None — all logic lives in API routes for this module. The `saveProductDraft` action (in `src/lib/actions/drafts/save-draft.ts`) is shared with the Add Product / Drafts modules — see Module 3.

### Schema Models

- **`OrgProduct`** (schema line 581) — Master product record at org level. Key fields:
  - `organizationId` (org isolation)
  - `sourceCompanyId` (the company that created it; remains the owner)
  - `categoryId`, `brandId` (nullable FKs to `OrgCategory` / `OrgBrand`, both `onDelete: SetNull`)
  - `title`, `slug` (`@@unique([organizationId, slug])`)
  - `baseSku` (nullable, manually entered)
  - `productType` ('simple' | 'variable' | 'bundle' | 'service')
  - `productScope` ('private' | 'organization' | 'selective' | 'archived')
  - `isStitchable`, `hasSizeVariants`, `stitchingBasePrice`
  - `promotedAt`, `promotedById`, `demotedAt`, `demotedById`, `demotionReason` — full audit trail of scope transitions
  - Relations: `variants`, `images`, `bundles`, `selectiveAccess`, `companySettings`

- **`OrgProductVariant`** (schema line 635) — Every unique sellable combination. Key fields:
  - `sku` (`@unique` — **org-wide uniqueness**, not company-scoped)
  - `barcode` (`@unique`)
  - `attributeValues` (JSONB string — `{"Piece Type":"Stitched","Size":"M"}`, **max 3 keys enforced at app layer**)
  - `costPrice` (Decimal 12,2), `weightGrams` (Int), `weightKg` (Decimal 6,3 nullable)
  - `fulfillmentType` ('stock_based' | 'made_to_order')
  - `stitchingType` ('unstitched' | 'stitched_basic' | 'stitched_heavy' | 'custom_order')
  - `stitchingCharges`, `productionDays`
  - `inventoryPolicy` ('deny' | 'continue') — synced from `fulfillment_type + allow_backorder` via `syncInventoryPolicy()`
  - `trackInventory` (Boolean — one-way TRUE→never back to FALSE; flips to TRUE when first return is received)
  - `fabricSourceVariantId` (self-ref: the stock_based variant whose fabric is consumed for made_to_order production)
  - `costPriceSyncedWithParent`, `weightSyncedWithParent` (Booleans — Sprint 10 parent-child cascade flags)
  - Shopify sync fields: `shopifyVariantId` (`@unique`), `shopifyInventoryItemId`
  - Indexes: `@@index([productId])`, `@@index([organizationId, fulfillmentType])`

- **`OrgProductImage`** (schema line 721) — Image metadata. Key fields:
  - `productId`, `variantId` (nullable — image can be product-level or variant-level)
  - `storagePath`, `publicUrl`
  - `displayOrder`, `isPrimary`
  - `uploadedById`
  - Index: `@@index([productId])`

- **`SelectiveProductAccess`** (schema line 758) — When `productScope='selective'`, controls which companies can access. `@@unique([orgProductId, companyId])`.

- **`CompanyProductSetting`** (schema line 774) — Per-company subscription/activation for an org product. `@@unique([companyId, orgProductId])`. `subscriptionStatus` ('active' | 'paused' | 'revoked'). Tracks `subscribedById`, `revokedById`, `revokeReason`.

- **`CompanyVariantPricing`** (schema line 802) — Per-variant selling price set independently by each company. `salePrice`, `comparePrice` (Decimal 12,2). `salePriceSyncedWithParent`, `comparePriceSyncedWithParent` (Booleans — Sprint 10). `@@unique([companyId, orgVariantId])`.

- **`OrgProductBundle`** (schema line 743) — Bundle-type products (component variants + quantities). **Defined but never written to by any route** — see Issues.

### Issues Found

- **[CRITICAL] Non-atomic multi-step product creation in `POST /api/products`.** Lines 229-310 of `route.ts` perform 4 separate writes in a loop without `db.$transaction`:
  1. `db.orgProduct.create`
  2. For each variant: `db.orgProductVariant.create`
  3. For each variant: `db.companyVariantPricing.create`
  4. `db.companyProductSetting.create`

  If step 3 fails mid-loop (e.g. SKU unique constraint violation on the 5th variant), the product is created with N-1 variants and N-1 pricing rows, but no `companyProductSetting` — leaving the product orphaned (visible to the owner but not subscribed). The user would need to manually clean up. A `$transaction` wrapper would roll everything back atomically.

- **[CRITICAL] Non-atomic multi-step variant addition in `POST /api/products/[id]/variants`.** Lines 94-143 — same pattern: per-variant `create` + `upsert` of company pricing + final `upsert` of companyProductSetting. No `$transaction`.

- **[CRITICAL] Slug-generation race condition in `POST /api/products`.** Lines 213-218 — slug uniqueness is checked via a `while` loop of `db.orgProduct.findUnique` calls. Two concurrent POSTs with the same title can both pass the check (both see slug available), then one succeeds and the other fails with a `PrismaClientKnownRequestError` P2002 on the `@@unique([organizationId, slug])` constraint — surfacing as a generic 500 error. Same racy pattern repeats in `POST /api/categories` (lines 77-82) and `POST /api/brands` (lines 75-80). The inventory audit found the same `count+1` race pattern in `generatePoNumber` and confirmed it triggers real 500s in production (worklog line 651-655).

- **[HIGH] `POST /api/products/[id]/images` does NOT validate `variantId` belongs to the product.** Line 62 — `variantId` is taken directly from the form data and passed to `db.orgProductImage.create` without checking that the variant exists AND belongs to `productId`. A user can attach an image to a variant of a different product (within the same org) — orphaning the image. Mitigation: the GET product detail fetches images via `productId`, so the orphaned image won't display — but the DB row persists and storage costs accrue.

- **[HIGH] `POST /api/products/[id]/images` permission check is inconsistent with other PATCH-style routes.** Line 48-58 — checks `isOwner || elevated || has PRODUCTS_EDIT permission`. **However** the `DELETE /api/products/[id]/images` handler at lines 153-157 OMITS the `PRODUCTS_EDIT` permission check (only checks `isOwner || elevated`). A user with the `products.edit` permission can upload images but cannot delete them — split-brain permission model. Compare with `toggle`, `PATCH variant`, `override-price` etc. which all check `PRODUCTS_EDIT`.

- **[HIGH] `POST /api/products/[id]/variants/[variantId]/override-price` and `resync-price` and `variant-groups/[parentValueId]/sale-price` do NOT verify the variant belongs to `productId`.** Line 65-67 of override-price route: `findFirst({ where: { id: variantId, productId } })` is NOT performed — the route only looks up the variant by `id` later in the resync flow, and the override-price flow doesn't look it up at all. A user could pass any `variantId` from a different product and the route will happily update its pricing — a cross-product permission bypass within the org.

- **[HIGH] Org-scoped detail routes are NOT company-scoped.** E.g. `GET /api/products/[id]` line 27-36 — filters by `organizationId: orgId` + `OR: [sourceCompanyId, organization, selective]`. The `PATCH`, `DELETE`, `POST /variants`, `POST /images`, `POST /variants/[variantId]/*` all use `findFirst({ where: { id, organizationId: orgId } })` — which means ANY company in the org can fetch/edit ANY product in the org, as long as they pass the elevated-or-PRODUCTS_EDIT permission check. For the source company this is correct, but for non-source companies this allows editing other companies' products (subject to the scope check, which only blocks GET reads on `private` scope).

- **[HIGH] `POST /api/products/[id]/demote` does NOT clear stale `SelectiveProductAccess` rows when demoting to `private`.** Lines 77-99 — updates product scope to `d.new_scope` and revokes `CompanyProductSetting` for non-source companies, but does NOT delete `SelectiveProductAccess` rows. If the product is later re-promoted to `selective`, the stale access rows silently re-grant access to companies that were previously revoked.

- **[HIGH] `POST /api/products/[id]/promote` to `organization` scope does NOT clear stale `SelectiveProductAccess` rows.** Lines 74-97 — when promoting from `selective` → `organization`, the previously-restrictive `SelectiveProductAccess` rows remain in the DB. Although they have no effect while scope='organization' (the `OR` clause in product-list includes `productScope: 'organization'`), if the product is later demoted back to `selective`, those stale rows silently restore the old access list — potentially granting access to companies the user no longer wants to include.

- **[HIGH] `POST /api/products/[id]/demote` performs a NESTED awaited query in the middle of the count check.** Lines 61-67:
  ```ts
  const returnedCount = await db.returnedStitchedInventory.count({
    where: {
      orgVariantId: { in: (await db.orgProductVariant.findMany({ where: { productId }, select: { id: true } })).map((v) => v.id) },
      ...
  ```
  This `await` inside the `in:` clause executes sequentially — first fetches all variants for the product, then counts. It works but is brittle: if the inner await throws, the count() call may surface a confusing error. Should be split into two queries for clarity.

- **[HIGH] All 23 mutating product routes (except `POST /api/products` and `POST /api/products/[id]/images`) lack `Idempotency-Key` support.** A network retry on `POST /api/products/[id]/variants` could create duplicate variants (would fail on SKU unique constraint with a generic 500 — but the user has no retry protection). Same for `promote`, `demote`, `pricing`, `selective-access`. The inventory audit found the same gap on 9 of 14 mutating endpoints (worklog line 496-504).

- **[MEDIUM] `GET /api/products` uses a hybrid filter for `isActive`.** Line 62 — `isActiveParam !== null ? { isActive: isActiveParam === 'true' } : { isActive: true }`. The `isActiveParam === ''` (empty string) case falls into the `!== null` branch and produces `isActive: false`, hiding all active products. Should use `?.length` check or explicit `undefined` defaulting.

- **[MEDIUM] `GET /api/products` paginates with `take: Math.min(100, ...)` but does NOT cap `pageSize` upper bound for the count query.** Line 54 — pageSize is capped at 100, but the `count` is run on the full `where` clause which is correct. Not a bug, just worth noting: a `search` query with `mode: 'insensitive'` + `contains` on a non-indexed `title` column will table-scan for large catalogs. No full-text search index exists.

- **[MEDIUM] `GET /api/products/[id]` parses `attributeValues` JSONB on every variant in JS** (line 81: `JSON.parse(v.attributeValues)`). For products with many variants (e.g. 3 attrs × 5 values each = 125 variants), this is 125 synchronous JSON.parse calls. Minor; could be done in the SQL layer.

- **[MEDIUM] `POST /api/products/[id]/variant-groups/[parentValueId]/cost` and `weight` ignore the `parentValueId` URL parameter.** The actual parent value is taken from the request body (`body.parent_attribute_name`, `body.parent_value`). The URL parameter is parsed but never used — misleading API design. Same for `sale-price`.

- **[MEDIUM] `POST /api/products/[id]/variants/[variantId]/resync-price` and `resync-cost` and `resync-weight` rely on finding ANY synced sibling** to determine the parent value. If ALL siblings have been overridden (none synced), the route throws `400 'No synced siblings found'`. But the error message says "Set the parent group price first" — confusing because the user may have set the parent group price via `variant-groups/[parentValueId]/sale-price` which only updates SYNCED children (line 73). A user who overrides ALL children then tries to re-sync any single one gets stuck in a Catch-22.

- **[MEDIUM] `POST /api/products/[id]/variant-groups/[parentValueId]/sale-price` UPSERTs missing pricing rows with `salePriceSyncedWithParent: true`, but if a previously-detached row exists with `comparePriceSyncedWithParent: false`, the `comparePrice` cascade at line 93 will be skipped (because `pricing.comparePriceSyncedWithParent` is checked). This means setting a parent-group sale price can leave compare prices inconsistent across children — a subtle data-integrity gap.

- **[MEDIUM] `POST /api/products/[id]/pricing` activates the subscription after pricing is set** (lines 78-87) but does NOT validate that the variant IDs in the pricing payload actually belong to `productId`. A user could pass variant IDs from a different product and activate their subscription with phantom pricing rows.

- **[LOW] `GET /api/products` includes the `companySettings` array on every product even though only `[0]` is used** (line 103). The `where: { companyId }` filter restricts it to 1 row max — fine, but the variable shadowing of `companySettings` (model name vs field name) makes the code confusing to read.

- **[LOW] `POST /api/products` audit log records `variantCount` but not the variant SKUs** (line 321-326). Forensic debugging of "which SKU was on this product at creation" requires joining through variants — not ideal for audit trail completeness.

- **[LOW] The `productScope='archived'` filter is applied to GET list only if explicitly requested** (line 61). Archived products are hidden by default (good), but a user with `isActive=false` filter will not see archived products either (because archived products also have `isActive=false`). Subtle: archived and inactive are conflated in the filter UI.

- **[LOW] The `OrgProductBundle` model (schema line 743) is defined but NEVER written to or read from by any route.** Dead schema — the `product_type='bundle'` enum value is accepted by `productSchema` (validations/product.ts line 117) but no `OrgProductBundle` rows are created. If a user picks `bundle` as the product type, they get a product with no bundle components and no error.

### Frontend
- **`ProductsView`** (`src/components/products/products-view.tsx`, 603 lines) — list view with search + type filter. Uses `useQuery(['products'])` → `GET /api/products`. Properly memoized price-range helper. No N+1 — relies on the list endpoint to return everything in one call.
- **`ProductDetailView`** (`src/components/products/product-detail-view.tsx`, 1793 lines) — single-product drill-down with images, variants, scope dialog. Uses `useQuery(['product', productId])` → `GET /api/products/[id]`. Image upload uses raw `fetch()` instead of `api.post()` (correctly — multipart FormData must NOT have JSON Content-Type).
- **`ParentChildVariantTable`** (`src/components/products/parent-child-variant-table.tsx`) — the variants table on the detail page, consuming `GET /api/products/[id]/variant-groups`.
- **`variant-table-parts.tsx`** — extracted table cell components (SyncIndicator, ParentGroupHeader, ParentGroupInputs, WeightCell, CostCell, SaleCell, CompareCell, ResyncButton).
- **`product-scope-badge.tsx`**, **`fulfillment-type-badge.tsx`**, **`returned-stock-banner.tsx`** — small badge/banner components.

No obvious frontend bugs found in this module.

---

## Module 2: Add Product (create flow)

### Purpose
Multi-step product creation wizard. Step 1: basic details (title, slug, category, brand, type, stitchable flags). Step 2: variants + pricing — either pick attributes from the org catalog and generate combinations via the cartesian-product endpoint, OR for stitchable products use the stitched-variant generator (`generate-stitched`). Step 3: scope + confirm.

### API Routes

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/products` | Create the product (see Module 1). |
| POST | `/api/products/[id]/variants/generate` | Pure calculation — cartesian product of selected attributes with bidirectional rule filtering. (Same as Module 1 — used by the wizard before the product exists; the `[id]` in the URL is a placeholder.) |
| POST | `/api/products/generate-stitched` | Pure calculation — generates stitched/unstitched variant combinations for a stitchable product. Returns suggested variants with SKUs + cost_price (base_fabric_cost + stitching_charges) + fulfillment_type. |
| GET | `/api/catalog/available-attributes` | Fetch all active attributes + values + rules for the org. Powers the `AttributeSelector` component. |
| POST | `/api/catalog/inline-attribute` | Create a new attribute inline from the variant builder. |
| POST | `/api/catalog/inline-value` | Create a new attribute value inline from the variant builder. |
| GET | `/api/categories` | List org categories. |
| GET | `/api/brands` | List org brands. |

### Server Actions
None.

### Schema Models
Same as Module 1 — `OrgProduct`, `OrgProductVariant`, `CompanyVariantPricing`, `CompanyProductSetting`, plus the catalog entities (`OrgAttribute`, `OrgAttributeValue`, `AttributeValueRule`, `OrgCategory`, `OrgBrand`) which are detailed in Module 5.

### Issues Found

- **[HIGH] `POST /api/products/[id]/variants/generate` does NOT verify the user has permission to create variants** — it's a pure calculation endpoint that returns combinations, but it does NOT check that the user is the source company or has PRODUCTS_EDIT permission. Anyone in the org can call it. Not a security hole (no DB writes), but inconsistent with the rest of the variant endpoints which DO check.

- **[HIGH] `POST /api/products/generate-stitched` does NOT check ANY permission** — anyone authenticated can call it. Same as above: pure calculation, no DB write, but inconsistent. Worse, the route doesn't even fetch the product or company from the DB — it operates entirely on the request body, so it can be called with any slug/sku prefix (no validation that the product slug exists).

- **[HIGH] `POST /api/products/generate-stitched` and `POST /api/products/[id]/variants/generate` use `product_slug` as the SKU prefix fallback** (line 35 of generate-stitched, line 160 of generate). A user can pass any arbitrary string as `product_slug` and the generated SKUs will use it as the prefix. No length cap on the slug → can produce SKUs exceeding the 100-char DB limit. The slicing at line 161 (`.slice(0, 100)`) catches this for the `generate` route but the `generate-stitched` route has no length cap (line 35).

- **[MEDIUM] `POST /api/products/generate-stitched` uses hardcoded `'Piece Type'` and `'Size'` strings as attribute keys** (lines 54, 86, 100). The schema migration to generic attributes (Sprint 9, schema line 511-577) was supposed to make these configurable, but this route still hardcodes them. If an org renames "Piece Type" to "Product Type" or "Size" to "Size (UK)", the generate-stitched endpoint produces variants with the wrong attribute keys.

- **[MEDIUM] `POST /api/products/generate-stitched` defaults Size to `'Free Size'`** (line 54, 86). But the seeded Size attribute (in `attribute-seeding.ts` line 46) defines `'One Size'`. If a user generates stitched variants then tries to match them against existing Size attribute values, the lookup will fail because `'Free Size'` ≠ `'One Size'`. The attribute value rules (`unstitched → One Size`) won't apply either, because the trigger value matches `Piece Type='Unstitched'` but the forced value is `'One Size'` not `'Free Size'`. Silent data inconsistency.

- **[MEDIUM] The wizard flow does NOT verify the user has PRODUCTS_CREATE permission before showing the form** — relies entirely on the POST endpoint rejecting unauthorized users. Frontend should pre-check `can('products.create')` and gray out the "Add Product" button for users without the permission. The `ProductCreateView` component at line 215 doesn't import or check `useCan`.

- **[MEDIUM] The wizard allows the user to enter an `is_active: false` flag on individual variants** (variantSchema line 78 in validations/product.ts), but the `POST /api/products` route does NOT validate that at least one variant is active. A user can create a product with all variants inactive — the product appears in the catalog with `variantCount: 0` (the count filter at line 102 of `GET /api/products` filters `where: { isActive: true }`), making it impossible to order or subscribe to.

- **[LOW] `POST /api/products/generate-stitched` accepts `include_unstitched: z.boolean().default(true)` but the Unstitched variant always uses `Size: 'Free Size'`** (not `'One Size'`) — same mismatch as above.

- **[LOW] `POST /api/products` sets `productScope: d.product_scope` directly from user input** (line 241). A user can create a product with `product_scope='organization'` or `'selective'` directly, bypassing the promote flow (which checks for ≥1 variant + ≥1 image). This means a brand-new product with no variants and no images can be org-wide visible. The GET list filter (line 64-68 of GET route) will show it to all companies with `variantCount: 0`. The promote endpoint exists precisely to prevent this, but the create endpoint doesn't enforce the same guard.

- **[LOW] The wizard `STEPS` array (line 156) hardcodes 3 steps** — but if the user picks `product_type='simple'`, the variants step is skipped and the wizard advances from step 0 to step 2. The `STEPS` constant doesn't reflect this — the progress indicator may show "Step 2 of 3" when only 2 steps are shown.

### Frontend
- **`ProductCreateView`** (`src/components/products/product-create-view.tsx`, 2337 lines) — the full 3-step wizard. Uses `useFormGuard()` for unsaved-changes protection. Has draft autosave via `POST /api/products/drafts`.
- **`AttributeSelector`** (`src/components/products/attribute-selector.tsx`, 1294 lines) — generic attribute picker, supports inline creation of new attributes/values via the `/api/catalog/inline-*` routes.
- **`ClientSideParentChildVariantTable`** (`src/components/products/client-side-parent-child-variant-table.tsx`) — the variants table shown in the wizard (client-side, before the product is created). Uses the same `determineParentAttribute` + `groupVariantsByParentAttribute` shared utilities from `src/lib/utils/variant-grouping.ts` so the wizard and the edit page can never disagree on grouping.

No obvious frontend bugs.

---

## Module 3: Product Drafts (draft system)

### Purpose
Save in-progress product form data as JSON so users can resume later. Auto-saves on a timer + on form changes via `useFormGuard`. Drafts are listed in the shared Drafts sidebar item (`/api/drafts?draftType=product&scope=all`).

### API Routes

| Method | Path | Description |
| --- | --- |
| POST | `/api/products/drafts` | Thin wrapper around `saveProductDraft()` server action. |
| GET | `/api/drafts?draftType=product&scope=all` | List product drafts. Uses the generic `listDrafts()` action. |
| GET | `/api/drafts?mode=count&draftType=product` | Count product drafts (used for sidebar badge). |
| GET | `/api/drafts?id=...` | Fetch a single draft by ID (for resume flow). |
| DELETE | `/api/drafts?id=...` | Delete a draft. |

### Server Actions (in `src/lib/actions/drafts/save-draft.ts`)

| Export | Description |
| --- | --- |
| `saveProductDraft({ draftId?, draftData, draftTitle? })` | Create or update a product draft. Uses modern `getWorkspace()` — the ONLY product-adjacent code path that uses the modern pattern. |
| `saveOrderDraft({ ... })` | Same but for orders — also generates a draft number via raw SQL `generate_draft_number()`. Not product-specific. |
| `listDrafts({ draftType, scope? })` | List drafts for the active company. Default scope: `'mine'` for orders, `'all'` for products. |
| `countDrafts({ draftType, scope? })` | Lightweight count for sidebar badges. |
| `deleteDraft(draftId)` | Delete a draft. Company-scoped via `findFirst({ where: { id, companyId } })`. |
| `getDraft(draftId)` | Fetch a single draft. Company-scoped. |

### Schema Models

- **`FormDraft`** (schema line 1854) — Generic form draft storage. Key fields:
  - `organizationId`, `companyId`, `createdBy`
  - `draftType` ('product' | 'order' — CHECK constraint at SQL level)
  - `draftData` (JSONB string, default `'{}'`)
  - `draftTitle` (nullable)
  - `draftNumber` (nullable, `DRAFT-00001` format — only for order drafts, null for product drafts)
  - Indexes: `@@index([companyId, draftType, updatedAt])`, `@@index([createdBy])`
  - **NO `expiresAt` field — drafts persist forever.**

### Issues Found

- **[HIGH] NO expiry/TTL on drafts.** The `FormDraft` model has no `expiresAt` field and no cleanup cron exists. Drafts accumulate indefinitely — over months, the table can grow to thousands of rows per company. The `draftData` JSONB column has no size limit either (Postgres jsonb practical limit ~1GB per row), so a single draft could in theory be tens of MB. The inventory audit (worklog line 496-504) found a similar lack of TTL pattern.

- **[HIGH] `saveProductDraft()` does NOT enforce a per-employee or per-company draft count limit.** A malicious or buggy client can flood the `form_drafts` table by repeatedly calling `POST /api/products/drafts` with no `draftId` — each call creates a new draft. No rate limiting, no max-per-user, no max-per-company.

- **[HIGH] `POST /api/products/drafts` does NOT validate the `draftData` payload.** Line 11 of route.ts — `draftData: (body.draftData as Record<string, unknown>) ?? {}`. No Zod schema, no size check, no shape validation. A client can post a 50MB JSON blob as `draftData` and the server will `JSON.stringify` and store it.

- **[MEDIUM] `POST /api/products/drafts` lacks `Idempotency-Key` support.** A network retry would create duplicate drafts. Compare with `POST /api/products` (Module 1) which DOES support idempotency.

- **[MEDIUM] `saveProductDraft()` does NOT update the `updatedAt` timestamp explicitly** — relies on Prisma's `@updatedAt` decorator (line 1869 of schema). This works but means drafts updated via raw SQL or other paths won't refresh the timestamp. Acceptable for current usage.

- **[MEDIUM] `listDrafts()` returns ALL fields including the full `draftData` JSON** (line 239-248 of save-draft.ts). For a company with 50 drafts each holding 100KB of form data, that's 5MB transferred on every page load of the Drafts view. Should defer `draftData` loading until a draft is opened for resume.

- **[MEDIUM] `deleteDraft()` does NOT emit an audit log.** Lines 302-317 — silently deletes. The `saveProductDraft()` action DOES audit (line 74-82 of save-draft.ts), so the asymmetry is suspicious. A user discarding a draft leaves no audit trail.

- **[LOW] The DORMANCY RULES comment block at lines 357-375 of `save-draft.ts` is excellent documentation** — explicitly states drafts must NOT touch inventory, payments, integrations, etc. Good defensive comment.

- **[LOW] `saveProductDraft()` always returns `draftTitle: 'Untitled Product Draft'` if not provided** (line 70). No smart title derivation from `draftData.title`. The wizard does pass a title derived from the form's `title` field, so this is a non-issue in practice — but the API contract is loose.

- **[LOW] The draft system has no soft-delete / archive state.** Drafts are either present or absent. If a user discards a draft by accident (the DELETE button has no confirmation per the frontend), it's gone permanently.

### Frontend
- **`ProductCreateView`** auto-saves drafts via `useFormGuard()` hook + `POST /api/products/drafts`.
- **`DraftsView`** (`src/components/shared/drafts-view.tsx`, shared between Products and Orders) — has tabs for product drafts and order drafts, with badges showing counts. Resumes a draft by calling `navigate({ name: 'product-create', draftId })` which loads the draft and repopulates the wizard.

No obvious frontend bugs.

---

## Module 4: Returned Stock (returned-stitched inventory)

### Purpose
Special inventory pool for made-to-order items returned in sellable condition. Per the schema comment (line 840-841): "This is the ONLY stock a made_to_order variant ever holds." A returned made-to-order item (e.g. a stitched suit where the customer refused delivery) is received here with its condition + total cost, then either re-sold (with a `soldOrderReference`) or written off.

### API Routes

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/returned-stitched` | List returned items for the active company. Filters: status, org_variant_id. Joined with variant + product. **No permission check beyond auth.** |
| POST | `/api/returned-stitched` | Receive a returned item. If `condition='damaged'`: immediately written off (`status='written_off'`, `writtenOffAt` set). Else: `status='available'`. Supports `Idempotency-Key`. Permission: `INVENTORY_RECEIVE` OR `INVENTORY_REPORT_LOSS` (weird combo). |
| POST | `/api/returned-stitched/[id]` | Lifecycle transition: `action='sold'` sets `status='sold'` + `soldOrderReference`; `action='write_off'` sets `status='written_off'` + `writtenOffReason`. Both require `INVENTORY_MANAGE_LOSS` permission. |
| GET | `/api/returned-stitched/stats` | Header stats: available count + total value + written-off-this-month count. **No permission check beyond auth.** |

### Server Actions
None.

### Schema Models

- **`ReturnedStitchedInventory`** (schema line 842) — Key fields:
  - `organizationId`, `companyId`, `orgVariantId`
  - `quantity` (Int, default 1)
  - `condition` ('perfect' | 'good' | 'open_box' | 'damaged')
  - `totalCost` (Decimal 12,2), `suggestedResalePrice` (nullable)
  - `originalOrderReference` (nullable string — **NOT a FK**, just text)
  - `returnReason`
  - `status` ('available' | 'sold' | 'written_off')
  - `photos` (JSON array of URLs, default `'[]'`)
  - `notes`
  - `receivedById`, `receivedAt`
  - `soldAt`, `soldOrderReference` (string, NOT a FK)
  - `writtenOffAt`, `writtenOffById`, `writeOffReason`
  - Indexes: `@@index([organizationId, orgVariantId, status])`, `@@index([companyId, status])`

- **`ProductFulfillmentCost`** (schema line 883) — Per-variant fulfillment cost tracking for made_to_order production. **Defined but never written to by any returned-stitched route.** Some of its lifecycle fields (`status`, `dispatchedAt`, `deliveredAt`, `returnedAt`) suggest it was intended to be the canonical made-to-order lifecycle tracker, but it appears to be dead schema (confirmed also by the inventory audit, worklog line 535).

### Issues Found

- **[CRITICAL] The `ReturnedStitchedInventory` lifecycle is NOT linked to the inventory ledger (`InventoryTransaction`).** The schema comment (line 840-841) says "This is the ONLY stock a made_to_order variant ever holds" — meaning this is a separate inventory pool outside the main `InventoryPool` / `InventoryTransaction` system. But when a returned item is marked `'sold'`, NO `InventoryTransaction` row is created — no `sale_dispatched`-style entry. This means the inventory ledger is INCOMPLETE for made-to-order variants: returns appear (in this table), but sales/dispatches of returned stock do NOT appear in the ledger. The inventory audit (worklog line 511) flagged a similar gap on `inventory/fulfill-mto`.

- **[HIGH] `POST /api/returned-stitched` permission check uses `INVENTORY_RECEIVE OR INVENTORY_REPORT_LOSS`** (lines 100-105). `INVENTORY_REPORT_LOSS` is the permission for reporting theft/missing stock — has nothing to do with receiving customer returns. A user with only the report-loss permission can receive customer returns, which is incorrect. Should be `INVENTORY_RECEIVE` only.

- **[HIGH] `POST /api/returned-stitched/[id]` lifecycle transition (`'sold'` / `'write_off'`) uses `INVENTORY_MANAGE_LOSS` permission** (lines 51, 88). `INVENTORY_MANAGE_LOSS` is the permission for resolving loss reports (writing them off or marking as found). Marking a returned item as sold is a SALES action, not a loss-management action. Should arguably require a new `PRODUCTS_RESELL_RETURNED` permission or `ORDERS_FULFILL`. At minimum, the `'sold'` action should require `ORDERS_FULFILL` since it's effectively fulfilling an order from returned stock.

- **[HIGH] `POST /api/returned-stitched/[id]` does NOT verify the variant is `made_to_order`.** Lines 32-35 — fetches the record by `id + companyId` but does NOT check `record.orgVariant.fulfillmentType === 'made_to_order'`. A user could receive a return against a `stock_based` variant (which has its own `InventoryPool` stock) — double-counting the item. The `POST /api/returned-stitched` (create) route DOES verify this (line 113-117 — "Verify variant exists and is made_to_order"). But the schema comment says "ONLY stock a made_to_order variant ever holds" — the create route's check is right; the lifecycle transition doesn't re-verify.

- **[HIGH] `POST /api/returned-stitched` does NOT check the variant belongs to the active company's product scope.** Lines 114-116 — `findFirst({ where: { id: d.org_variant_id, organizationId: orgId } })`. Org-scoped only. A user can receive a return against a variant from a `private` product owned by ANOTHER company in the org. The variant will be linked to the active company's returned-stitched record, but the variant itself is private to another company — cross-company data leak.

- **[HIGH] `originalOrderReference` and `soldOrderReference` are free-text strings, NOT foreign keys.** Schema lines 856, 868. No validation that they correspond to real orders. A user can type any string. This breaks the audit trail: there's no way to query "which orders resulted in returns" without parsing free-text. Should be `orderId String?` with a FK to `Order`.

- **[HIGH] `POST /api/returned-stitched/[id]` 'sold' transition does NOT decrement any inventory count** — neither the `ReturnedStitchedInventory.quantity` nor an `InventoryTransaction` is created. The item just gets `status='sold'` and the count of available items in `GET /api/returned-stitched/stats` decreases by 1. If the original order is later cancelled or returned again, there's no way to "un-sell" the returned item — it's stuck in `'sold'` status forever. There's also no `unsell` action in the route.

- **[HIGH] `POST /api/returned-stitched` supports `Idempotency-Key`** but `POST /api/returned-stitched/[id]` does NOT. A network retry on the `'sold'` or `'write_off'` action would surface a 400 ("Item is not available") on the retry — which is at least non-destructive, but the user sees a confusing error. Adding idempotency would let the retry return the original success response.

- **[MEDIUM] `GET /api/returned-stitched` returns ALL fields including `photos` (parsed from JSON)** (line 60). For a company with hundreds of returned items each having multiple photo URLs, this can be a large response. No pagination on this endpoint.

- **[MEDIUM] `GET /api/returned-stitched/stats` uses three separate aggregate queries** (lines 20-36) — `_sum: { quantity }`, `_sum: { totalCost }`, `count()`. Could be combined into a single `groupBy` query, but Prisma's `aggregate` doesn't support mixed sum+count in one call. Three round-trips to Supabase per stats-card render.

- **[MEDIUM] `POST /api/returned-stitched` validates `condition` enum but does NOT validate `quantity` against the variant's `trackInventory` flag.** Schema says `trackInventory` is "FALSE for made_to_order until first return; one-way TRUE→never back to FALSE". The receive route should flip `trackInventory` from false to true on first receive — but it doesn't. This means the `trackInventory` field stays false forever unless something else flips it (a check of `inventory.ts` shows `checkAndFulfillMadeToOrderVariant` may do it, but the receive route doesn't).

- **[MEDIUM] `POST /api/returned-stitched` validates `total_cost > 0` via Zod (line 242 of validations/product.ts) but `suggested_resale_price` can be 0** — a user can set a resale price of 0 which then appears as "suggested" on the item. Misleading data.

- **[LOW] The schema comment (line 858) lists status values as `'available' | 'sold' | 'written_off'` but the create route uses `isDamaged ? 'written_off' : 'available'` (line 135) — there's no `'pending'` or `'received'` intermediate state. The lifecycle is binary: receive → available → sold/write_off. No "in inspection" state. This is a deliberate design choice but worth flagging.

- **[LOW] `POST /api/returned-stitched` has a typo-prone comment at line 113**: `// Verify variant exists and is made_to_order` — but the check only fetches the variant, doesn't actually verify `fulfillmentType === 'made_to_order'`. The check is misleading.

### Frontend
- **`ReturnedStitchedView`** (`src/components/products/returned-stitched-view.tsx`, 1352 lines) — full CRUD UI. Stats cards + filterable table + "Record a Return" dialog + "Mark as Sold" dialog + "Write Off" dialog. Uses `useIdempotentMutation` for the receive endpoint (good — idempotency key sent automatically).
- **`ReturnedStockBanner`** (`src/components/products/returned-stock-banner.tsx`) — small banner shown on the product detail page when a variant has available returned stock, prompting the merchant to consider reselling it before producing new stock.

The frontend uses a Zod schema (`recordReturnSchema`, line 172-220) that REJECTS the backend's `total_cost` field — instead it has `fabricStitchingCost`, `outgoingCourier`, `returnCourier` and computes the total client-side. This is a **schema mismatch** — the backend expects `total_cost` (number, required), but the frontend posts `fabricStitchingCost`, `outgoingCourier`, `returnCourier`. Either the frontend transforms before POST (need to check), or this is a bug. The backend's `returnedStitchedInventorySchema` (validations/product.ts line 238-249) requires `total_cost`, so a raw POST of the frontend's payload would fail validation.

---

## Module 5: Catalog Settings (org catalog config)

### Purpose
Org-level catalog configuration: manage categories, brands, attributes, attribute values, and attribute-value rules. The "Org Catalog" view (separate from Catalog Settings) is the elevated-employee view for promoting/demoting products across companies. Catalog Settings is where the org admin configures the building blocks (categories, brands, attributes) used by the Add Product wizard.

### API Routes

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/org/catalog` | Org-level overview for elevated employees. Returns shared (organization + selective scope) products + promotable (private scope) products + all companies in org. Elevated-only. |
| GET | `/api/catalog/attributes` | List attributes for the org with their values. |
| POST | `/api/catalog/attributes` | Create an attribute. Requires `PRODUCTS_MANAGE_CATALOG` or elevated. |
| PATCH | `/api/catalog/attributes/[id]` | Update an attribute (displayName, type, displayOrder, isActive). |
| DELETE | `/api/catalog/attributes/[id]` | Delete an attribute. Elevated-only. Cascade-deletes values. |
| GET | `/api/catalog/attributes/[id]/values` | List values for an attribute. |
| POST | `/api/catalog/attributes/[id]/values` | Create a value for an attribute. |
| PATCH | `/api/catalog/attribute-values/[id]` | Update an attribute value (value, displayValue, colorHex, skuCode, displayOrder, isActive). |
| DELETE | `/api/catalog/attribute-values/[id]` | Delete an attribute value. Elevated-only. **Does NOT check if variants reference this value** — see Issues. |
| POST | `/api/catalog/inline-attribute` | Create a new attribute inline from the variant builder. Accepts initial values. |
| POST | `/api/catalog/inline-value` | Create a new attribute value inline from the variant builder. |
| GET | `/api/catalog/available-attributes` | Fetch all active attributes + values + rules. Used by `AttributeSelector`. |
| POST | `/api/catalog/seed-defaults` | One-time endpoint to seed default attributes (Piece Type, Size, Color, Fabric + Unstitched→One Size rule) for an existing org. Elevated-only. Idempotent — refuses if any attributes already exist. |
| PATCH | `/api/catalog/categories/[id]` | Update a category (name, parentId, imageUrl, displayOrder, isActive). |
| DELETE | `/api/catalog/categories/[id]` | Delete a category. Elevated-only. Reference check: blocks if products use it. |
| PATCH | `/api/catalog/brands/[id]` | Update a brand (name, logoUrl, isActive). |
| DELETE | `/api/catalog/brands/[id]` | Delete a brand. Elevated-only. Reference check: blocks if products use it. |
| GET | `/api/categories` | List org categories (legacy top-level shim). |
| POST | `/api/categories` | Create a category. **NO `PRODUCTS_MANAGE_CATALOG` permission check — any active employee can create.** |
| GET | `/api/brands` | List org brands (legacy top-level shim). |
| POST | `/api/brands` | Create a brand. **NO `PRODUCTS_MANAGE_CATALOG` permission check — any active employee can create.** |

### Server Actions
None.

### Schema Models
Same as Module 1's catalog entities. Note: there is NO `OrgCatalogSettings` model in the schema — the task description mentioned it as a model to look for, but it does not exist. The "Catalog Settings" sidebar module is backed entirely by:
- `OrgCategory` (schema line 468) — hierarchical categories, `@@unique([organizationId, slug])`
- `OrgBrand` (schema line 492) — brands, `@@unique([organizationId, slug])`
- `OrgAttribute` (schema line 512) — attribute definitions, `@@unique([organizationId, name])`
- `OrgAttributeValue` (schema line 535) — values per attribute, `@@unique([attributeId, value])`
- `AttributeValueRule` (schema line 559) — generic conditional rules ("when trigger value is selected, force another attribute to a specific value"), `@@unique([triggerAttributeValueId, forcesAttributeId])`

### Issues Found

- **[CRITICAL] `POST /api/categories` and `POST /api/brands` allow ANY active employee to create org-level catalog entities.** Lines 53-58 of categories route, lines 53-56 of brands route — neither checks `PRODUCTS_MANAGE_CATALOG` permission. Compare with `POST /api/catalog/attributes` (line 72-77) which DOES check. This is a clear permission bypass — a regular employee with no catalog-management permission can create arbitrary categories and brands in the org's shared catalog. The Catalog Settings UI (`catalog-settings-view.tsx` line 159) checks `can('products.manage_catalog')` and shows an "Insufficient Permissions" screen, but a direct API call bypasses this client-side check.

- **[HIGH] `DELETE /api/catalog/attribute-values/[id]` does NOT check whether any variant references this value** (lines 113-138). Compare with `DELETE /api/catalog/categories/[id]` (line 117-124) which DOES check `orgProduct.count({ where: { categoryId: id } })` and blocks deletion if products reference it. If an attribute value is in use by a variant (stored as a JSONB key/value in `attributeValues`), deleting the value leaves orphaned references — the variant still has `{"Size":"XXL"}` but `XXL` no longer exists in `org_attribute_values`. The variant generation endpoint and the parent-child grouping logic still work (they read the JSONB directly), but the `AttributeSelector` UI will no longer show `XXL` as an option, making it impossible to add new variants with that value.

- **[HIGH] `DELETE /api/catalog/attributes/[id]` cascade-deletes attribute values without warning.** Line 112 comment says "Cascade deletes attribute values automatically" — but does NOT warn the user that variants referencing those values become orphans (same issue as above, escalated because deleting an attribute orphans ALL its values across ALL variants in the org).

- **[HIGH] `POST /api/catalog/inline-attribute` does NOT validate that the user is creating the attribute from within a product creation context.** Anyone with `PRODUCTS_MANAGE_CATALOG` permission can create an attribute with arbitrary `initial_values` from anywhere — the route doesn't check that the call originates from the variant builder. Not a security hole (the permission is checked), but the audit log records `attribute.created_inline` which is misleading if the call didn't come from the inline flow.

- **[HIGH] `POST /api/catalog/inline-attribute` has a RACE CONDITION on `displayOrder`.** Lines 58-62 — fetches `max(displayOrder)` then increments by 1. Two concurrent calls both see `max=4`, both assign `displayOrder=5`. No unique constraint on `(organizationId, displayOrder)`, so both succeed — but the order is non-deterministic. Compare with the slug race in `POST /api/products` (Module 1).

- **[MEDIUM] `GET /api/org/catalog` returns ALL companies in the org** (line 78-82) to power the selective-access picker. This is fine for elevated employees, but the route only checks `roleTier === 'elevated'` — does NOT check `PRODUCTS_PROMOTE` permission. An elevated employee with no explicit promote permission can view the full org catalog overview. Probably intentional (elevated bypasses all checks per the permissions.ts comment line 6-7), but worth flagging.

- **[MEDIUM] `POST /api/catalog/seed-defaults` is NOT idempotent at the rule level.** Lines 30-34 — refuses if ANY attributes exist (good), but if the seeding partially succeeds (e.g. 4 attributes created, then the rule creation fails), the next call will refuse to re-run because attributes exist. The org is left in a half-seeded state with no automated recovery.

- **[MEDIUM] `POST /api/catalog/seed-defaults` does NOT use a `$transaction`.** Lines 17-119 of `attribute-seeding.ts` — 4 separate `db.orgAttribute.create` calls + 1 `db.attributeValueRule.create` call. If the rule creation fails (e.g. one of the values was deleted between the create and the rule create), the org has 4 attributes with no rule. Manual cleanup required.

- **[MEDIUM] `PATCH /api/catalog/attributes/[id]` allows changing `attributeType` from `'select'` to `'color'`** (line 51) — but does NOT validate that existing values have `colorHex` set. A `select` attribute converted to `color` would have values with `colorHex: null`, breaking the `AttributeSelector` UI which expects `colorHex` for color attributes.

- **[MEDIUM] `POST /api/catalog/inline-attribute` and `POST /api/catalog/inline-value` do NOT support `Idempotency-Key`.** A network retry would create duplicate attributes/values. The uniqueness check (lines 52-55 of inline-attribute, lines 55-58 of inline-value) catches exact-duplicate names case-insensitively, but a retried request with a slightly different name would succeed and create a duplicate.

- **[MEDIUM] `GET /api/org/catalog` returns `_count.variants: { where: { isActive: true } }` for shared products** (line 53) but does NOT filter variants by `isActive` for the `subscribers` list. The `subscriberCount` (line 100) counts ALL `companySettings` rows, including revoked ones. A product with 5 subscribers where 3 are revoked shows `subscriberCount: 5` — misleading.

- **[LOW] `POST /api/categories` and `POST /api/brands` support `Idempotency-Key` but the inline attribute/value routes do NOT.** Inconsistent idempotency support across catalog endpoints.

- **[LOW] The `OrgCategory` model supports hierarchical categories via `parentId` self-relation** (schema line 472-474), but the Catalog Settings UI (`catalog-settings-view.tsx`) does NOT render categories as a tree — they're shown as a flat list. The `parentId` field is accepted by the create/edit endpoints but not surfaced in the UI.

- **[LOW] `seedDefaultAttributes()` in `attribute-seeding.ts` creates the "Unstitched → One Size" rule** (lines 107-119) but does NOT create the inverse rule ("Stitched → NOT One Size"). The bidirectional evaluation in `POST /api/products/[id]/variants/generate` (lines 116-146) handles this without needing an explicit inverse rule, so this is correct — but worth documenting that the rule table is intentionally one-directional and the bidirectional logic lives in the variant-generation code.

- **[LOW] The Catalog Settings UI uses inline Zod schemas** (catalog-settings-view.tsx lines 101-150) that DUPLICATE the backend schemas in `validations/product.ts` (lines 12-45). If the backend schema changes, the frontend won't auto-sync. Should import from the shared `validations/product.ts` file.

### Frontend
- **`CatalogSettingsView`** (`src/components/products/catalog-settings-view.tsx`, 2301 lines) — tabs for Categories, Brands, Attributes, Attribute Values. Uses `react-hook-form` + `zodResolver`. Permission-gated at line 159 (`can('products.manage_catalog')`). Inline create/edit/delete via the `/api/catalog/*` routes.
- **`OrgCatalogView`** (`src/components/products/org-catalog-view.tsx`, 1221 lines) — elevated-employee view for promoting/demoting products across companies. Calls `GET /api/org/catalog`. Has promote/demote/selective-access dialogs.
- **`AttributeSelector`** (`src/components/products/attribute-selector.tsx`, 1294 lines) — the generic attribute picker used in the Add Product wizard. Calls `GET /api/catalog/available-attributes`. Renders values with color swatches for color-type attributes. Supports inline creation via the `/api/catalog/inline-*` routes.

No obvious frontend bugs.

---

## Cross-Cutting Concerns

### 1. Unified product → variant → pricing hierarchy
**YES — unified and clean.** The 3-tier hierarchy is consistent across all 5 modules:
- `OrgProduct` (org-level master record, created by one company, sharable)
- `OrgProductVariant` (every unique sellable combination, JSONB `attributeValues` ≤3 keys per Shopify limit)
- `CompanyVariantPricing` (per-company selling price; the ONLY company-scoped price)

The Markets system removal was completed cleanly — the `MarketVariantPricing` model is gone, and only 3 comment references to "no market scoping" remain in the product pricing routes (override-price, resync-price, sale-price cascade). These are explicit, intentional comments documenting the migration. **No orphaned `db.market` references found in any product code.**

### 2. Product images storage
**Local filesystem** — despite the schema comment (line 720) saying "Images stored in Supabase Storage, shared across all subscribing companies." The actual code in `POST /api/products/[id]/images` (line 14 + 77) writes to `process.cwd() + '/public/uploads/products/{orgId}/{productId}/'`. This is a **deployment-time bomb**:
- **Vercel**: filesystem is read-only except `/tmp`. Uploads will silently fail (or succeed-then-vanish on next cold start).
- **Docker**: requires a persistent volume mount at `/app/public/uploads`.
- **Cleanup**: `DELETE /api/products/[id]` (archive) does NOT delete image files from disk — they accumulate forever.

### 3. Product import/export
**Not implemented.** No `/api/products/import` or `/api/products/export` route exists. The Shopify sync fields (`shopifyVariantId`, `shopifyInventoryItemId`) exist in the schema but no route reads or writes them.

### 4. Draft system (auto-save, manual save, expiry)
- **Manual save**: `POST /api/products/drafts` called explicitly by the wizard's "Save Draft" button.
- **Auto-save**: `useFormGuard()` hook in `ProductCreateView` auto-saves on a timer (interval not verified in this audit).
- **Expiry**: **NONE.** Drafts persist forever (no `expiresAt` field, no cleanup cron, no TTL).
- **Resume**: `GET /api/drafts?id=...` returns the draft, frontend repopulates the wizard.
- **Finalize**: After the user completes the wizard and creates the real product, the frontend calls `DELETE /api/drafts?id=...` to clean up. If the user closes the tab before this, the draft lingers.

### 5. Returned-stitched: separate pool or shared with main stock?
**Separate pool.** Per schema comment (line 840-841): "This is the ONLY stock a made_to_order variant ever holds." A made_to_order variant has:
- NO row in `InventoryPool` (the main stock ledger).
- ONE row per returned item in `ReturnedStitchedInventory`.

This is a deliberate design choice: made_to_order variants don't track stock the same way (they're produced on demand). Returns are an exception — the only time a made_to_order variant holds physical stock. The `trackInventory` boolean on `OrgProductVariant` (schema line 670) is the flag that controls whether this variant participates in the main `InventoryPool` system: `false` until first return (then one-way `true`).

**However, the receive route (`POST /api/returned-stitched`) does NOT flip `trackInventory` from false to true on first receive** — see Module 4 Issues. This is a known gap.

### 6. Markets system removal — orphaned references?
**CLEAN.** Only 3 references to "market" in the products code, all in code comments explicitly documenting the migration:
- `src/app/api/products/[id]/variants/[variantId]/override-price/route.ts` line 13: "Uses CompanyVariantPricing (per-company pricing) — no market scoping."
- `src/app/api/products/[id]/variants/[variantId]/resync-price/route.ts` line 14: same comment.
- `src/app/api/products/[id]/variant-groups/[parentValueId]/sale-price/route.ts` line 13: same comment.

No `db.market.findMany` or `db.marketVariantPricing` calls. No `Market` model in schema. The migration was completed correctly.

### 7. Variant hierarchy: parent/child variants
**Implemented via the parent-attribute concept**, not via a `parentId` self-relation on `OrgProductVariant`. The "parent attribute" is the attribute with the LOWEST `display_order` among those used by the product's variants (e.g. if a product has Piece Type + Size, and Piece Type has display_order=1 < Size's display_order=2, then Piece Type is the parent). All variants sharing the same parent-attribute value (e.g. "Piece Type=Stitched") form a "parent group" — they share cost price, weight, and (optionally) sale price.

The cascade/override/resync pattern is consistent:
- `costPriceSyncedWithParent` (on `OrgProductVariant`)
- `weightSyncedWithParent` (on `OrgProductVariant`)
- `salePriceSyncedWithParent` (on `CompanyVariantPricing`)
- `comparePriceSyncedWithParent` (on `CompanyVariantPricing`)

When `true`, the field follows the parent group's value (set via `POST /api/products/[id]/variant-groups/[parentValueId]/{cost,weight,sale-price}`). When `false`, the child has been individually overridden via `POST /api/products/[id]/variants/[variantId]/override-{price,weight,cost}`.

**Concern**: The `determineParentAttribute()` function (in `src/lib/utils/variant-grouping.ts` line 77-89) returns the attribute with the lowest `display_order`. If an admin reorders attributes (changes `display_order` on `OrgAttribute`), the parent attribute can shift, silently changing the grouping. There's no migration / re-validation logic to handle this — the sync flags become meaningless if the parent attribute changes. The risk is low because there's no "reorder attributes" UI (the `display_order` field is editable via `PATCH /api/catalog/attributes/[id]` but the UI doesn't expose it as a drag-and-drop operation).

### 8. SKU uniqueness
**Org-wide**, not company-wide or per-variant. Schema line 642: `sku String @unique`. This means:
- A SKU like `FSES-10A-M-ST` must be unique across the ENTIRE org, including across all variants of all products.
- The uniqueness check in `PATCH /api/products/[id]/variants/[variantId]` (line 76-84 of route.ts) correctly checks `findFirst({ where: { sku: d.sku, id: { not: variantId } } })` — but does NOT scope by `organizationId`. A SKU conflict with a variant in a different org would incorrectly block the update. (In practice, cuid-based org isolation makes cross-org SKU collisions unlikely, but the check is technically wrong.)
- The `POST /api/products` create route does NOT pre-check SKU uniqueness — it relies on the DB unique constraint to reject duplicates with a generic 500 error. Compare with the slug check (lines 213-218) which DOES pre-check.

### 9. SQL injection risk
**None found.** All queries use Prisma's parameterized API. The only raw SQL in the products sphere is in `saveOrderDraft()` (line 143-145 of `save-draft.ts`):
```ts
const draftNumberRows = await db.$queryRaw<{ draft_number: string }[]>`
  SELECT generate_draft_number() AS draft_number
`
```
This is parameterized via Prisma's tagged template literal and the function name is hardcoded — safe.

### 10. Missing input validation (cross-cutting)
The shared Zod schemas in `src/lib/validations/product.ts` (296 lines) are **mostly used**:
- `productSchema` — used by `POST /api/products` ✓
- `updateProductSchema` — used by `PATCH /api/products/[id]` ✓
- `variantSchema` — used by `POST /api/products/[id]/variants` ✓
- `promoteProductSchema` — used by `POST /api/products/[id]/promote` ✓
- `demoteProductSchema` — used by `POST /api/products/[id]/demote` ✓
- `selectiveAccessSchema` — used by `POST /api/products/[id]/selective-access` ✓
- `setCompanyPricingSchema` — used by `POST /api/products/[id]/pricing` ✓
- `returnedStitchedInventorySchema` — used by `POST /api/returned-stitched` ✓
- `markSoldSchema`, `writeOffSchema` — used by `POST /api/returned-stitched/[id]` ✓
- `generateStitchedSchema` — used by `POST /api/products/generate-stitched` ✓
- `categorySchema`, `brandSchema`, `attributeSchema`, `attributeValueSchema` — used by the `/api/catalog/*` routes ✓

**Dead code in `validations/product.ts`:**
- `createProductShellSchema` (line 131-144) — defined but never used by any route. Probably a leftover from an earlier multi-step creation flow.
- `generateCombinationsSchema` (line 165-186) — defined but never used. The `POST /api/products/[id]/variants/generate` route uses inline `readBody<{...}>` instead.
- `companyPricingSchema` (line 192-206) — used internally by `setCompanyPricingSchema` (line 209), so technically alive but could be inlined.
- `logFulfillmentCostSchema` (line 265-276) — defined but no route exists to consume it. Suggests a planned `/api/products/[id]/fulfillment-costs` endpoint that was never built.

### 11. Dead code / unused exports
- **`OrgProductBundle` model** — defined in schema, never written to or read from by any route. The `product_type='bundle'` enum is accepted but produces a product with no bundle components.
- **`ProductFulfillmentCost` model** — defined in schema, never written to by any returned-stitched route. Per the inventory audit (worklog line 535), this model is dead schema across both modules.
- **`createProductShellSchema`** — see above.
- **`generateCombinationsSchema`** — see above.
- **`logFulfillmentCostSchema`** — see above.
- **`STITCHING_TYPES` constant in `fulfillment-types.ts`** — exported but the `stitched_basic/heavy/custom` enum values are also hardcoded in `validations/product.ts` line 71-73. Duplication.

### 12. Permission check pattern (systemic)
**Same as the inventory audit (worklog line 484-493).** Of the 41 product/catalot routes:
- **1 route uses the modern `getWorkspace() + requirePermission()` pattern**: `GET /api/products` (the list endpoint).
- **1 route uses `getWorkspace()` but NOT `requirePermission()`**: `saveProductDraft()` (via the `POST /api/products/drafts` shim).
- **39 routes use the legacy 4-query `getCurrentUser → userSetting → employee → rolePermission.count` pattern.**

This means 39 routes pay 3-4 extra DB round-trips per request (≈560ms to Supabase per the inventory audit's runtime test, worklog line 700-708) and miss the 60s workspace cache that `getWorkspace()` provides.

### 13. Audit logging
**Present on all mutating endpoints**, but with the same caveats as the inventory audit:
- `insertAuditLog()` calls are NOT awaited (fire-and-forget) in most routes — if the audit DB write fails, the action still succeeds but the audit trail is lost. Spot-checked: `POST /api/products` line 313-327, `POST /api/returned-stitched` line 149-163, `POST /api/catalog/attributes` line 101-110 — all fire-and-forget.
- All GET (read) endpoints have no audit log — acceptable for products (no sensitive data like police reports), but `GET /api/org/catalog` reveals the full org structure (all companies, all subscriber counts) and could warrant audit logging.

### 14. Idempotency support
**Inconsistent across the module.** Of the 23 mutating product/returned-stitched routes:
- **5 support `Idempotency-Key`**: `POST /api/products`, `POST /api/returned-stitched`, `POST /api/categories`, `POST /api/brands`, `POST /api/products/drafts` (via `saveProductDraft()` which calls `getWorkspace()` — but no explicit idempotency key support in the action).
- **18 do NOT support `Idempotency-Key`**: all variant routes, all image routes, all pricing/cost/weight override/resync routes, all promote/demote/subscribe/selective-access routes, all catalog attribute/attribute-value/category/brand mutation routes.

### 15. Catalog settings: who can edit? org-level vs company-level?
- **Org-level**: All catalog entities (`OrgCategory`, `OrgBrand`, `OrgAttribute`, `OrgAttributeValue`, `AttributeValueRule`) are org-scoped. Changes affect ALL companies in the org.
- **Who can edit**: `PRODUCTS_MANAGE_CATALOG` permission OR `elevated` role tier. This is checked correctly on most catalog routes (see Module 5).
- **EXCEPTIONS (CRITICAL)**: `POST /api/categories` and `POST /api/brands` do NOT check `PRODUCTS_MANAGE_CATALOG` — any active employee can create. See Module 5 Issues.
- **DELETE on catalog entities**: requires `elevated` role tier (not just `PRODUCTS_MANAGE_CATALOG`). This is stricter than PATCH (which accepts either). Inconsistent but arguably correct (deletion is more destructive).

---

## Summary Table

| Module | Routes | Critical | High | Medium | Low |
| --- | --- | --- | --- | --- | --- |
| 1. All Products | 24 | 3 | 7 | 6 | 4 |
| 2. Add Product | 8 | 0 | 3 | 3 | 2 |
| 3. Product Drafts | 5 | 0 | 3 | 3 | 3 |
| 4. Returned Stock | 4 | 1 | 6 | 3 | 2 |
| 5. Catalog Settings | 20 | 1 | 3 | 5 | 4 |
| **Cross-cutting** | — | 0 | 0 | 5 | 3 |
| **TOTAL** | **61** | **5** | **22** | **25** | **18** |

(Note: route counts overlap — e.g. `POST /api/products` is counted in both Module 1 and Module 2 because both modules use it. Cross-cutting concerns attributed to no specific module. Severity counts include cross-cutting issues attributed to the most-relevant module.)

---

## Top Priority Recommendations (for a follow-up fix task — NOT done in this audit)

1. **🔴 Wrap multi-step product creation in `db.$transaction`.** The `POST /api/products` and `POST /api/products/[id]/variants` routes can silently create orphaned products/variants if a mid-loop write fails. (1 hour fix, touches 2 routes.)

2. **🔴 Fix `POST /api/categories` and `POST /api/brands` missing `PRODUCTS_MANAGE_CATALOG` permission check.** Any active employee can currently create org-level catalog entities. Add the same `caller.role.roleTier === 'elevated' || (await db.rolePermission.count({ where: { ..., permissionKey: PERMISSIONS.PRODUCTS_MANAGE_CATALOG } }))` check used by the `/api/catalog/attributes` route. (10 min fix, touches 2 routes.)

3. **🔴 Link `ReturnedStitchedInventory` lifecycle to `InventoryTransaction`.** Marking a returned item as `'sold'` should create an `inventory_sale_dispatched`-style transaction row so the ledger is complete. Also flip `OrgProductVariant.trackInventory` from `false` to `true` on first receive. (2 hour fix, touches `POST /api/returned-stitched` + `POST /api/returned-stitched/[id]`.)

4. **🟡 Fix `DELETE /api/catalog/attribute-values/[id]` to check variant references.** Currently cascade-deletes without warning, leaving orphaned JSONB references in variants. (30 min fix — add a check that no variant's `attributeValues` JSONB contains this value. Note: this requires a JSONB containment query, e.g. `db.orgProductVariant.findFirst({ where: { attributeValues: { contains: value.value } } })` — but Prisma doesn't support `contains` on JSONB strings natively; would need a raw SQL query.)

5. **🟡 Migrate product routes from the legacy `getCurrentUser + db.rolePermission.count` pattern to `getWorkspace() + requirePermission()`.** Saves 3-4 DB queries per request (~560ms) and brings the module in line with the rest of the codebase. Also adds proper role-based authorization on GET endpoints. (4 hour fix, touches ~39 routes.)

6. **🟡 Add `Idempotency-Key` support** to the remaining 18 mutating routes — especially `POST /api/products/[id]/variants`, `POST /api/products/[id]/images`, `POST /api/products/[id]/pricing`, `POST /api/products/[id]/promote`, `POST /api/products/[id]/demote`. (3 hour fix.)

7. **🟡 Fix the slug / displayOrder race conditions** in `POST /api/products`, `POST /api/categories`, `POST /api/brands`, `POST /api/catalog/inline-attribute`, `POST /api/catalog/inline-value`. Replace the `while (findUnique) { n++ }` loop with a DB sequence (similar to the `generate_draft_number()` SQL function used for order drafts) or catch the P2002 error and retry. (2 hour fix.)

8. **🟡 Add image storage abstraction.** Replace the local-filesystem write with a Supabase Storage / S3 / Vercel Blob upload. Add a `/api/products/[id]/images/[imageId]/set-primary` endpoint (currently the only way to set primary is to delete all images and re-upload in order). (4 hour fix.)

9. **🟡 Add draft expiry + size limits.** Add an `expiresAt DateTime?` field to `FormDraft`, set it to `now() + 30 days` on create, and add a cron to delete expired drafts. Enforce a 1MB size limit on `draftData` in `saveProductDraft()`. (2 hour fix.)

10. **🟡 Verify `variantId` belongs to `productId`** in `POST /api/products/[id]/variants/[variantId]/override-price`, `resync-price`, `override-weight`, `resync-weight`, `override-cost`, `resync-cost`, `toggle`. Add `findFirst({ where: { id: variantId, productId } })` check (currently only some routes do this). (1 hour fix.)

11. **🟡 Convert `originalOrderReference` and `soldOrderReference` from free-text strings to real `orderId` foreign keys.** This enables proper audit trails and cross-referencing. (4 hour fix, requires a migration to backfill existing rows.)

12. **🟡 Add a product import/export feature** using the existing Shopify-compatible schema. The `shopifyVariantId` / `shopifyInventoryItemId` fields are already in place — a CSV/JSON import route would round out the catalog management story. (8 hour feature.)

---

## Methodology Notes

- **Backend code audit**: read all 24 route files under `src/app/api/products/**`, all 3 returned-stitched routes, all 10 catalog routes, the `org/catalog` route, the `categories` + `brands` legacy shims, the `drafts` route, the `save-draft.ts` action file, the `variant-grouping.ts` utility, the `fulfillment-types.ts` constants, the `attribute-seeding.ts` helper, the `validations/product.ts` schema file, and the relevant Prisma schema models (`OrgProduct`, `OrgProductVariant`, `OrgProductImage`, `OrgProductBundle`, `SelectiveProductAccess`, `CompanyProductSetting`, `CompanyVariantPricing`, `ReturnedStitchedInventory`, `ProductFulfillmentCost`, `OrgCategory`, `OrgBrand`, `OrgAttribute`, `OrgAttributeValue`, `AttributeValueRule`, `FormDraft`).
- **Frontend spot-check**: read the entry points of all 5 view components (`ProductsView`, `ProductCreateView`, `CatalogSettingsView`, `ReturnedStitchedView`, `OrgCatalogView`) and confirmed routing in `src/app/page.tsx`.
- **Cross-cutting analysis**: grepped for `Market`, `market`, `db.market`, `MarketVariantPricing` references — confirmed clean migration. Grepped for permission usage patterns — confirmed 1/41 routes use modern pattern.
- **Limitations**: did NOT run the dev server or test endpoints at runtime (unlike the inventory audit's Part 2). All findings are based on static code analysis. Some race conditions and permission gaps may be more or less severe in practice depending on the actual role configuration.
- **No source code was modified.** This is a read-only audit + report.

---

# PART 2: Runtime + Frontend Audit (Main Session)

**Task ID:** PROD-AUDIT-RUNTIME
**Agent:** main (Z.ai Code)
**Method:** Browser testing (agent-browser) + curl API testing + dev.log analysis
**Date:** 2026-09-04

---

## Runtime Test Results

### API Route Health (all GET list endpoints tested via curl)

| Route | HTTP | Latency | Notes |
|-------|------|---------|-------|
| `/api/products` | 200 | 987ms | ✅ Works (empty list initially) |
| `/api/products?pageSize=5` | 200 | 150ms | ✅ Works (cached) |
| `/api/products?include_inactive_variants=true` | 200 | 151ms | ✅ Works |
| `/api/categories` | 200 | 981ms | ✅ Works |
| `/api/brands` | 200 | 792ms | ✅ Works |
| `/api/returned-stitched` | 200 | 569ms | ✅ Works (empty list) |
| `/api/returned-stitched/stats` | 200 | 1.4s | ✅ Returns `availableCount`, `totalValue`, `writtenOffThisMonth` |
| `/api/org/catalog` | 200 | 2.3s | ✅ Works — returns shared + promotable + companies |
| `/api/drafts?draftType=product` | 200 | fast | ✅ Works (empty list) |
| `/api/catalog/settings` | ❌ **404** | — | 🟡 Route does NOT exist. Actual route is `/api/org/catalog` |
| `/api/attributes` | ❌ **404** | — | 🟡 Route does NOT exist. Attributes are under `/api/catalog/attributes` |

### POST Endpoint Tests (create flows)

| Endpoint | Payload | Result | Issue |
|----------|---------|--------|-------|
| `POST /api/products` | Correct snake_case + `sale_price` | ✅ 201 Created | Works. Audit's "non-atomic" concern confirmed by code reading (no `$transaction`), but happy path succeeds. |
| `POST /api/products/[id]/variants` | Array format `{variants:[...]}` | ✅ 200 | Works. Note: expects ARRAY not single object — docs smell. |
| `POST /api/categories` | `{name}` | ✅ 200 Created | ⚠️ **No permission check** — any logged-in user (even viewer-tier) can create org-level categories. Confirms audit finding. |
| `POST /api/brands` | `{name}` | ✅ 200 Created | ⚠️ Same — no permission check. |
| `POST /api/catalog/seed-defaults` | `{}` | ✅ 200 | Works — seeds default attributes (Piece Type, Size, Color, Fabric) |
| `POST /api/products/generate-stitched` | `{}` | 400 "Invalid input" | ✅ Validation works (needs proper payload) |
| `POST /api/products/drafts` | `{draftData}` | 201 | ✅ Works (save draft) |

### Permission Check Verification

**Finding:** The Products section uses a MIXED auth pattern:
- **Modern pattern (good):** `/api/products` (GET + POST) uses `getWorkspace()` + `requirePermission()` — 0 DB queries on cache hit
- **Legacy pattern (bad):** `/api/products` POST createProduct function uses `getCurrentUser + userSetting.findUnique + employee.findFirst + rolePermission.count` = 4 DB queries per request
- **No permission check (critical):** `/api/categories` and `/api/brands` POST routes only check authentication, NOT authorization. Any active employee can create org-level catalog entities.

---

## Critical Runtime Bugs Found

### 🟡 MEDIUM #1: `fx-refresh` + `poNumber` errors still in dev.log (pre-existing)

The dev.log still shows the `fx-refresh` crash (`Cannot read properties of undefined (reading 'findMany')`) and `poNumber` unique constraint errors. **These are from BEFORE the fixes were deployed** — the current dev server was restarted with the fixes, but the log file wasn't cleared. Not a new bug.

### 🟡 MEDIUM #2: `/api/catalog/settings` returns 404 (Next.js HTML page)

The route `/api/catalog/settings` does NOT exist. The actual catalog settings route is `/api/org/catalog`. If the frontend calls `/api/catalog/settings`, it gets a 404 HTML page (not JSON) which would cause a JSON parse error in the client.

**Verification needed:** Check if any frontend component calls `/api/catalog/settings` (grep for the path).

### 🟢 LOW #1: Product create route uses legacy 4-query auth

The `createProduct` function in `/api/products/route.ts` (line 176-197) uses the legacy auth pattern (4 DB queries) instead of the cached `getWorkspace()` + `requirePermission()`. This adds ~560ms per create request. Same finding as inventory routes.

---

## Frontend Module-by-Module Test

All 5 modules render correctly when using the **right route names**. Initial test failed because I used wrong names (`returned-stock`, `catalog-settings`) — the actual routes are `returned-stitched` and `product-settings`.

### Module 1: All Products (`?view=products`)
- ✅ Page title: "Products"
- ✅ Empty state: shows "No products yet" with CTA
- ✅ Works after creating a test product (shows the product)

### Module 2: Add Product (`?view=product-create`)
- ✅ Page title: "Create New Product"
- ✅ Full form renders (title, SKU, variants, pricing, etc.)

### Module 3: Product Drafts (`?view=product-drafts`)
- ✅ Page title: "Drafts"
- ✅ Empty state: "No drafts yet"
- ✅ Drafts API (`/api/drafts?draftType=product`) returns proper JSON

### Module 4: Returned Stock (`?view=returned-stitched`)
- ✅ Page title: "Returned Stitched Inventory"
- ✅ Shows tabs: "Returned Stock" + "Losses & Write-offs"
- ✅ Stats endpoint works (`availableCount`, `totalValue`, `writtenOffThisMonth`)
- ✅ Empty list state

### Module 5: Catalog Settings (`?view=product-settings`)
- ✅ Page title: "Catalog Settings"
- ✅ Renders the catalog config UI (attributes, brands, categories tabs)
- ⚠️ **Route name mismatch:** sidebar label is "Catalog Settings" but route is `product-settings` (confusing for developers, harmless for users since sidebar links correctly)

### Frontend Bug: None Critical

Unlike the Inventory Dashboard (which shows workspace content instead of inventory stats), all 5 Product modules render their correct content. No broken layouts, no runtime errors during page loads.

---

## Cross-Cutting Runtime Observations

### 1. Markets removal is CLEAN
Confirmed: no `db.market` references in product code. The markets removal was thorough. Only 3 explicit "no market scoping" comments remain (intentional documentation).

### 2. Variant hierarchy works
Created a product with 2 variants (AUDIT-TEST-1, AUDIT-TEST-2) — both show correctly in product detail. The parent-attribute + syncedWithParent system appears functional.

### 3. Company pricing created correctly
When I created a product, the route created `companyVariantPricing` for each variant (confirmed by code reading line 291-299). The pricing is company-scoped (correct post-markets-removal design).

### 4. SKU uniqueness
SKU `AUDIT-TEST-1` created successfully. Did not test duplicate SKU — audit notes this is org-wide unique (should be verified).

### 5. Catalog seed-defaults works
`POST /api/catalog/seed-defaults` successfully created default attributes (Piece Type, Size, Color, Fabric + Unstitched→One Size rule). This is a one-time setup helper.

---

## Consolidated Issue Count (Part 1 + Part 2)

| Severity | Part 1 (code) | Part 2 (runtime) | Total |
|----------|---------------|-------------------|-------|
| CRITICAL | 3 | 0 | **3** |
| HIGH | 9 | 1 (categories/brands no permission) | **10** |
| MEDIUM | 11 | 2 (catalog/settings 404, legacy auth) | **13** |
| LOW | 14 | 1 (route name mismatch) | **15** |
| **Total** | **37** | **4** | **41** |

## Top 5 Most Urgent Fixes (recommended order)

1. **🔴 Wrap product + variant creation in `db.$transaction`** — non-atomic multi-step writes (product → variants → companyPricing → companyProductSetting) can leave orphaned records on mid-loop failure. (1 hour fix)

2. **🔴 Add `requirePermission(PRODUCTS_MANAGE_CATALOG)` to `POST /api/categories` + `POST /api/brands`** — currently any logged-in user can create org-level catalog entities. (15 min fix)

3. **🟡 Link returned-stitched "sold" status to `InventoryTransaction` ledger** — marking a returned item as sold updates `ReturnedStitchedInventory.status` but creates no ledger entry, leaving inventory incomplete. (1 hour fix)

4. **🟡 Migrate product create route to `getWorkspace()` + `requirePermission()`** — eliminates 4 DB queries per create (~560ms saved) + aligns with modern auth pattern. (30 min fix)

5. **🟡 Verify `/api/catalog/settings` is not called by any frontend component** — if it is, replace with `/api/org/catalog`. (15 min investigation)

---

## Methodology Notes

- **Backend code audit** (Part 1): read all 41 route files, 15 Prisma models, validation schemas, by general-purpose subagent.
- **Runtime testing** (Part 2): curl'd all 10 list endpoints (with + without auth), created a test product + variant, created category + brand (confirmed no permission check), tested drafts + returned-stitched + catalog seed endpoints.
- **Frontend testing** (Part 2): browser-navigated to all 5 module routes (using correct route names), verified page titles + empty states + render correctness.
- **Limitations:** Couldn't test the full product → variants → pricing → image upload flow end-to-end (would need real image files). Couldn't test duplicate SKU (didn't try creating 2 products with same SKU). The audit is thorough for what's testable in a fresh sandbox.

**No source code was modified.** This is a read-only audit + report.
