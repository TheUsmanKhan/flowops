# FlowOps — Internal API Guide

> **Comprehensive reference for every API route under `src/app/api/`.**
>
> **Audience**: developers onboarding to FlowOps, AI assistants generating code that calls or extends these endpoints, and engineers debugging client-side request failures.
>
> **Companion documents**:
> - `DATABASE_GUIDE.md` — full Prisma schema + migration history
> - `FRONTEND_GUIDE.md` — Zustand store, route table, view components
> - `FLOWOPS_BRIEFING.md` — high-level architecture
> - `PRODUCTION_DEPLOYMENT_GUIDE.md` — golden rules for the live environment
>
> **Last updated**: September 2026 (DOCS-API-DB-FRONTEND task)

---

## Conventions

Every FlowOps API route lives under `src/app/api/...` (Next.js 16 App Router). The shared conventions below apply across the entire API surface; route entries below describe only what's unique.

### Runtime

```ts
export const runtime = 'nodejs'       // every route opts out of Edge (uses Prisma + node-only deps)
export const dynamic = 'force-dynamic' // every route is non-cacheable
```

### Authentication & authorization

Two patterns coexist (modern is preferred; legacy routes are being migrated):

**Modern pattern** (uses `src/lib/workspace.ts`):
```ts
const ctx = await getWorkspace()                  // throws 401 if unauthenticated
await requirePermission(ctx, PERMISSIONS.ORDERS_VIEW) // throws 403 on missing permission
```
`getWorkspace()` reads the session cookie OR the `Authorization: Bearer <token>` header, resolves the active `Profile` + `UserSetting` + `Company` + `Employee` + `Role` + `RolePermission[]` in ONE query (cached for 60s via `src/lib/workspace-cache.ts`). It returns a `WorkspaceContext` with the shape `{ user, employee, company, organization, role, permissions, isElevated }`.

**Legacy pattern** (still used by ~13 routes — products, inventory, etc.):
```ts
const user = await getCurrentUser()
const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
const caller = await db.employee.findFirst({ where: { companyId, userId: user.id }, include: { role: true } })
const allowed = caller.role.roleTier === 'elevated' || (await db.rolePermission.count({...})) > 0
```

The 30 permission keys are defined in `src/lib/permissions.ts` (`PERMISSIONS` constant). Elevated roles (`owner`, `founder`, `co_founder`, `investor` — system-role keys) bypass every check.

### Idempotency

Creation routes accept an optional `Idempotency-Key` HTTP header. When present, the route wraps its insert in `withIdempotency()` (`src/lib/idempotency.ts`) — a single row in the `IdempotencyKey` table guarantees only one successful creation per key. Failed attempts can be retried with the same key. Currently applied to: `customer.create`, `product.create`, `order.create`, `exchange.create`, `payroll_run.create`, `integration.connect`, `supplier-return.create`.

### Error shape

```ts
class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
// handleError(err) → Response.json({ error: message }, { status })
```

Successful responses use `Response.json({...})` (HTTP 200 by default, 201 on creation).

### Audit + metric events

Most mutating routes fire-and-forget two side effects (NON-transactional — they happen AFTER the main write succeeds):

- `insertAuditLog({...})` — appends a row to `AuditLog` (entity type, entity id, old/new values, user/employee attribution).
- `insertMetricEvent({...})` — appends a numeric event to `MetricEvent` (used by future KPI dashboards).

### DB writes — transaction strategy

The codebase uses three patterns:

1. **Single-write** — most routes (UPDATE or INSERT only). No transaction wrapper.
2. **`db.$transaction()`** — used by `product.create`, `customer.create` (when multi-row inserts must be atomic), PO receive.
3. **Multi-step without transaction** — dispatch, RTO, exchange verification. **Known tech debt** (see `ORDERS_AUDIT.md`): if any mid-flow step fails, earlier writes are NOT rolled back.

### Permission scoping for orders

`Role.ordersDataScope` (`'all'` | `'own'`) is enforced at the query layer:
- `'all'` (default) — sees every order in the company.
- `'own'` — sees only orders where `salesEmployeeId === ctx.employee.id`.

The helper `getOrdersDataScope(ctx)` resolves this; `resolveOrderScope()` / `resolveOrderItemScope()` (`src/lib/order-scope.ts`) wrap the filter for queue routes.

---

## Section 1 — Auth APIs

All auth routes live under `src/app/api/auth/`. They are the only public routes; everything else requires authentication.

### 1.1 `POST /api/auth/login`

| Field | Value |
|---|---|
| Purpose | Verify email + password, create an HMAC session token, return the full session payload (user, active company, employee, permissions) + `sessionToken` in the JSON body so the frontend can also use it as a Bearer token (works in iframes / cross-origin). |
| Auth | None |
| Request body | `{ email: string, password: string }` (validated by `loginSchema`) |
| Response | `{ user, activeCompany, companies: [], employee, sessionToken }` — same shape as `/api/auth/me` plus `sessionToken` |
| DB Impact | Reads `Profile` by email. Writes `AuditLog` (`auth.login`). Sets `flowops_session` HTTP cookie. |
| Used by | `LoginForm` (`src/components/auth/login-form.tsx`) |
| Key logic | Compares password via `verifyPassword()` (`src/lib/auth.ts`). Cookie attributes: `httpOnly: true, sameSite: 'none', secure: false` (permissive — works in cross-origin iframe previews). |

### 1.2 `POST /api/auth/register`

| Field | Value |
|---|---|
| Purpose | Create a new `Profile` + `UserSetting`, set session cookie, return session payload. |
| Auth | None |
| Request body | `{ fullName, email, password }` (validated by `registerSchema`) |
| Response | `{ user, activeCompany: null, companies: [], employee: null, sessionToken }` |
| DB Impact | INSERT `Profile` (passwordHash via `hashPassword()`). INSERT `UserSetting` (theme='system', language='en'). INSERT `AuditLog` (`auth.registered`). |
| Used by | `RegisterForm` (`src/components/auth/register-form.tsx`) |
| Key logic | 409 if email already exists. The new user is NOT auto-onboarded — `isOnboarded` defaults to false; the frontend routes them through the onboarding flow. |

### 1.3 `GET /api/auth/me`

| Field | Value |
|---|---|
| Purpose | Hydrate the frontend on app boot — returns the current session payload. |
| Auth | None required, but returns `{ user: null, ... }` if no session cookie. |
| Response | `{ user: UserPublic | null, activeCompany: CompanyPublic | null, companies: CompanyPublic[], employee: { id, roleTier, roleName, systemRoleKey, permissions[], isElevated, ordersDataScope } | null }` |
| DB Impact | READ `Profile` + `UserSetting` + `Employee` + `Company` + `Organization` + `Role` + `RolePermission` (one JOIN via `buildSessionPayload()`). |
| Used by | `Page` (`src/app/page.tsx`) — fires a TanStack Query (`sessionQuery`) on mount with `refetchOnWindowFocus: true`. |
| Key logic | Cached at the workspace layer (60s in-memory Map). Background refetches silently update the Zustand store only when session data actually changes. |

### 1.4 `POST /api/auth/logout`

| Field | Value |
|---|---|
| Purpose | Delete the session cookie, clear workspace caches. |
| Auth | Optional — audits `auth.logout` if a session exists. |
| Response | `{ success: true }` |
| DB Impact | INSERT `AuditLog` (`auth.logout`). Clears in-memory workspace cache via `clearAllCaches()` so the next login starts fresh. |
| Used by | `UserMenu` (logout button in navbar) |

### 1.5 `POST /api/auth/forgot-password`

| Field | Value |
|---|---|
| Purpose | Password recovery request. **In the sandbox this is a no-op** — no outbound SMTP, but returns success so the UI shows "check your email". Production would call `supabase.auth.resetPasswordForEmail`. |
| Auth | None |
| Request body | `{ email?: string }` |
| Response | `{ ok: true }` (always — does NOT leak whether email exists) |
| DB Impact | READ `Profile` by email (no row written) |
| Used by | `ForgotPasswordForm` |

### 1.6 `POST /api/auth/reset-password`

| Field | Value |
|---|---|
| Purpose | Reset password for the currently-authenticated user (recovery flow — user clicks email link, lands here with valid session, sets new password). |
| Auth | Requires an active session (NOT an OTP token in the sandbox). |
| Request body | `{ password: string }` (min 8 chars) |
| Response | `{ ok: true }` or `{ error: 'Password must be at least 8 characters.' }` (400) |
| DB Impact | UPDATE `Profile.passwordHash`. INSERT `AuditLog` (`auth.password_reset`). |
| Used by | `ResetPasswordForm` |

---

## Section 2 — Customer APIs

All routes under `src/app/api/customers/`. The Customer Management System (migration 002) introduced a normalized schema: `Customer` (with denormalized stat caches for fast list views) + `CustomerPhone` (one or more phones per customer) + `CustomerAddress` (one or more addresses) + `CustomerExternalIdentity` (Shopify/Daraz/Instagram ID mappings).

### 2.1 `GET /api/customers`

| Field | Value |
|---|---|
| Purpose | List customers in the active organization with filters. Each row includes the primary phone + default address summary. |
| Auth | Legacy pattern — caller must be authenticated. No explicit permission check (read access is implied by organization membership). |
| Query params | `search` (matches customer name OR any phone — case-insensitive, uses trigram GIN indexes from migration 025), `is_flagged` (`true`/`false`), `date_from`/`date_to` (ISO), `limit` (max 100, default 50), `offset`. Special: `detailed=1` + `search` returns the FULL customer record (phones + addresses) via `searchCustomersDetailed()` — a single optimized query (was 8 queries before). |
| Response | `{ customers: [{ id, name, email, phones: [{ phoneRaw, isPrimary }], addresses: [{ address, city, isDefault }], totalOrdersCount, totalOrderValue, totalRtoCount, isFlagged, flaggedReason, flaggedAt, createdAt }] }` (or `{ found: false }` in detailed mode when no match). |
| DB Impact | READ `Customer` + `CustomerPhone` + `CustomerAddress` filtered by `organizationId`. |
| Used by | `CustomersView`, `CustomerSearchAutocomplete` (which uses `detailed=1` for live search). |

### 2.2 `POST /api/customers`

| Field | Value |
|---|---|
| Purpose | **Two distinct payloads** on the same endpoint: (1) flag/unflag an existing customer, (2) create a new customer. |
| Auth | Legacy pattern. |
| Request body | **Flag flow**: `{ customer_id, action: 'flag' | 'unflag', reason? }` (reason min 3 chars required for flag). **Create flow**: `{ name, email?, phones: [{ phone, label?, is_primary }], addresses: [{ label?, address, city, is_default }] }` (validated by `createCustomerSchema` — exactly one primary phone, exactly one default address). |
| Response | Flag flow: `{ ok: true }`. Create flow: `{ customerId, customer: {...} }` (201). |
| DB Impact | Flag flow: UPDATE `Customer.{isFlagged, flaggedReason, flaggedAt, flaggedBy}`. Create flow: INSERT `Customer` + `CustomerPhone[]` + `CustomerAddress[]` in `db.$transaction` (atomic). Phones normalized via `normalizePhone()` (`src/lib/phone-validation.ts`) — `phoneNormalized` is E.164. |
| Used by | `CustomerSearchAutocomplete` (calls create flow when user expands the inline create form), `CustomersView` (calls flag flow), `customers-view.tsx`. |
| Key logic | Supports `Idempotency-Key` header. Org-wide uniqueness on `phoneNormalized` prevents duplicate customer creation. |

### 2.3 `GET /api/customers/[id]`

| Field | Value |
|---|---|
| Purpose | Full customer detail — all phones (primary first), all addresses (default first, then by `lastUsedAt` desc), external identities, recent order history. |
| Auth | Legacy pattern. |
| Response | `{ customer: {...full record + phones + addresses + externalIdentities + recentOrders} }` (404 if not found in active org). |
| DB Impact | READ `Customer` + phones + addresses + `CustomerExternalIdentity` + recent `Order[]`. |
| Used by | `CustomerDetailView` (`src/components/orders/customer-detail-view.tsx`). |

### 2.4 `PATCH /api/customers/[id]`

| Field | Value |
|---|---|
| Purpose | Update customer name/email only. Phones and addresses are managed via their own sub-routes. |
| Auth | Legacy pattern. |
| Request body | `{ name?: string, email?: string }` |
| Response | `{ customer: {...updated} }` |
| DB Impact | UPDATE `Customer`. |

### 2.5 `POST /api/customers/[id]/addresses` & `PATCH` / `DELETE /api/customers/[id]/addresses/[addressId]`

| Field | Value |
|---|---|
| Purpose | Add / update / remove a delivery address. Updates enforce the "one default per customer" rule (partial unique index `customer_addresses_one_default_idx` from migration 002). |
| Auth | Legacy pattern. |
| Request body | `{ label?, address, city, is_default }` (POST/PATCH). DELETE takes no body. |
| Response | Address object (201 for POST). |
| DB Impact | INSERT/UPDATE/DELETE `CustomerAddress`. The partial unique index means setting `is_default=true` on a new address auto-clears the previous default. |
| Used by | `AddressSelector` (`src/components/customers/AddressSelector.tsx`), `CustomerDetailView`. |
| Key logic | Addresses are intentionally `address + city` only (no province field — per product decision). A `country` field (alpha-2 code, default 'PK') was added in a later migration. |

### 2.6 `POST /api/customers/[id]/phones` & `DELETE /api/customers/[id]/phones/[phoneId]`

| Field | Value |
|---|---|
| Purpose | Add / remove a phone number. The "one primary per customer" rule is enforced by a partial unique index `customer_phones_one_primary_idx`. |
| Auth | Legacy pattern. |
| Request body | `{ phone, label?, is_primary }` |
| Response | Phone object (201 for POST). |
| DB Impact | INSERT/DELETE `CustomerPhone`. `phoneNormalized` is computed via `normalizePhone()` and is unique per organization (`@@unique([organizationId, phoneNormalized])`). |
| Used by | `CustomerDetailView`, `CustomerSearchAutocomplete`. |

### 2.7 `POST /api/customers/backfill-stats`

| Field | Value |
|---|---|
| Purpose | One-time backfill: iterates all customers in the active organization, recomputes their cached stats (`totalOrdersCount`, `totalOrderValue`, `totalRtoCount`) via `updateCustomerStats()`. |
| Auth | Modern pattern — `ORDERS_MANAGE` permission. |
| Response | `{ success, processed, updated, errors: [{ customerId, error }] }` |
| DB Impact | UPDATE `Customer` stats per row. |
| Used by | Admin utility — triggered manually from the Customers view when stats drift. |

---

## Section 3 — Product APIs

All routes under `src/app/api/products/`. The Product Catalog System uses a two-tier model: **org-level master records** (`OrgProduct`, `OrgProductVariant`, `OrgProductImage`) shared across companies in the org, plus **company-level pricing/subscription** (`CompanyVariantPricing`, `CompanyProductSetting`) which is per-company.

### 3.1 `GET /api/products`

| Field | Value |
|---|---|
| Purpose | List products visible to the active company. Visibility rules: `private` (own only), `organization` (any company in org), `selective` (in selective access list), `archived` (only owner or elevated). |
| Auth | Modern pattern — `PRODUCTS_VIEW` permission. |
| Query params | `search`, `category_id`, `brand_id`, `product_type`, `product_scope`, `is_active`, `include_inactive_variants=true` (returns ALL variants with isActive flag for the order-create picker's gate-1 visibility check), `page` (default 1), `pageSize` (default 20, max 100). |
| Response | `{ products: [{ id, title, slug, productType, productScope, isStitchable, isFeatured, isActive, category, brand, primaryImage, variantCount, variants: [{id, sku, costPrice, fulfillmentType, stitchingType, isDefault, attributeValues, salePrice, comparePrice, isActive?}], isOwner, subscription: {isActive, status} }], total, page, pageSize }` |
| DB Impact | READ `OrgProduct` + `OrgProductVariant` + `OrgProductImage` + `CompanyProductSetting` + `CompanyVariantPricing` + `OrgCategory` + `OrgBrand`. Uses `pg_trgm` GIN index (migration 028) for `title LIKE '%search%'`. |
| Used by | `ProductsView` (`src/components/products/products-view.tsx`), `OrderCreateView` (variant picker). |

### 3.2 `POST /api/products`

| Field | Value |
|---|---|
| Purpose | Create a product + variants + company pricing + company subscription (atomic via `db.$transaction`). |
| Auth | Modern pattern — `PRODUCTS_CREATE` permission. |
| Request body | `productSchema`-validated: `{ title, slug?, base_sku?, description?, short_description?, product_type, product_scope, is_stitchable, has_size_variants, stitching_base_price, is_active, is_featured, category_id?, brand_id?, variants: [{ sku, barcode?, attribute_values (max 3 keys — Shopify limit), cost_price, weight_grams, weight_kg?, fulfillment_type, stitching_type?, stitching_charges, production_days, is_taxable, requires_shipping, allow_backorder, is_default, is_active, fabric_source_variant_id?, sale_price, compare_price? }] }` |
| Response | `{ id, slug, title, variantIds }` (201) |
| DB Impact | INSERT `OrgProduct` + `OrgProductVariant[]` + `CompanyVariantPricing[]` + `CompanyProductSetting` (atomic). INSERT `AuditLog` (`product.created`). INSERT `MetricEvent` (`product.created`). |
| Used by | `ProductCreateView`. |
| Key logic | Slug auto-generated from title, deduplicated via `findUnique` loop. SKU pre-check (`orgVariantId` is org-wide unique) returns 400 with the duplicate SKU instead of 500 from Prisma. `syncInventoryPolicy()` (from `src/lib/constants/fulfillment-types.ts`) coerces `fulfillment_type` ↔ `inventory_policy` (`made_to_order` → `continue`; `stock_based` + `allow_backorder=false` → `deny`). Supports `Idempotency-Key` header. |

### 3.3 `GET /api/products/[id]`

| Field | Value |
|---|---|
| Purpose | Full product detail with variants, pricing, images. |
| Auth | Legacy pattern. |
| Response | `{ product: {...full record, variants: [{ id, sku, barcode, attributeValues (parsed JSON), costPrice, weightGrams, weightKg?, weightSyncedWithParent, fulfillmentType, stitchingType, stitchingCharges, productionDays, isTaxable, requiresShipping, inventoryPolicy, isDefault, isActive, salePrice, comparePrice, pricingId }], images, subscription: {id, status, isActive} | null } }` |
| DB Impact | READ `OrgProduct` + variants + images + `CompanyProductSetting` + `CompanyVariantPricing` + `OrgCategory` + `OrgBrand`. |
| Used by | `ProductDetailView` (`src/components/products/product-detail-view.tsx`). |

### 3.4 `PATCH /api/products/[id]`

| Field | Value |
|---|---|
| Purpose | Update product fields (source company OR elevated only). |
| Auth | Legacy pattern + source-company-or-elevated guard + `PRODUCTS_EDIT` permission. |
| Request body | `updateProductSchema`-validated: `{ title?, base_sku?, description?, short_description?, category_id?, brand_id?, is_stitchable?, stitching_base_price?, has_size_variants?, is_active?, is_featured? }` |
| DB Impact | UPDATE `OrgProduct`. INSERT `AuditLog` (`product.updated`). INSERT `MetricEvent`. |

### 3.5 `DELETE /api/products/[id]`

| Field | Value |
|---|---|
| Purpose | Archive a product (NEVER hard-delete). Sets `productScope='archived'`, `isActive=false`. |
| Auth | Legacy pattern — elevated-only (regardless of role permissions). |
| Response | `{ ok: true }` |
| DB Impact | UPDATE `OrgProduct.{productScope, isActive}`. INSERT `AuditLog` (`product.archived`). |

### 3.6 `POST /api/products/[id]/variants`

| Field | Value |
|---|---|
| Purpose | Add one or more variants to an existing product. Validates each via `variantSchema`, syncs `fulfillment_type` ↔ `inventory_policy`, for `made_to_order`: `cost_price = fabric_cost + stitching_charges`. |
| Auth | Source-company-or-elevated + `PRODUCTS_EDIT`. |
| Request body | `{ variants: [{ sku, barcode?, attribute_values (max 3), cost_price, weight_grams, weight_kg?, fulfillment_type, stitching_type?, stitching_charges, production_days, is_taxable, requires_shipping, allow_backorder, is_default, is_active, fabric_source_variant_id?, sale_price, compare_price? }] }` |
| Response | `{ success: true, variant_ids: string[] }` (201) |
| DB Impact | INSERT `OrgProductVariant[]` + UPSERT `CompanyVariantPricing[]` + UPSERT `CompanyProductSetting`. |
| Used by | `ProductCreateView` (after variant generation), `ProductDetailView` (add variant form). |

### 3.7 `POST /api/products/[id]/variants/generate`

| Field | Value |
|---|---|
| Purpose | Generate variant combinations from selected attributes (pure calculation — NO DB write). Applies `AttributeValueRule` bidirectionally during generation (prevention, not post-filter): if "Unstitched" forces "Size = One Size", then Stitched + One Size is also invalid. SKU concatenation follows each attribute's `display_order` ascending. |
| Auth | Authenticated user only (no permission check — pure calc). |
| Request body | `{ product_slug, base_sku?, selected_attributes: [{ attribute_id, attribute_name, display_order, selected_values: [{ value_id, value, display_value, sku_code? }] }] }` (max 3 attributes). |
| Response | `{ combinations: [{ attribute_values: Record<string,string>, suggested_sku, suggested_fulfillment_type }] }` or `{ error: 'MAX_3_ATTRIBUTES_EXCEEDED' }` (400). |
| Used by | `ProductCreateView` (variant generator wizard). |

### 3.8 `PATCH /api/products/[id]/variants/[variantId]`

| Field | Value |
|---|---|
| Purpose | Update editable variant fields (`sku`, `barcode`, `cost_price`, `weight_grams`, `weight_kg`, `stitching_charges`, `production_days`, `is_taxable`, `requires_shipping`). |
| Auth | Source-company-or-elevated + `PRODUCTS_EDIT`. |
| DB Impact | UPDATE `OrgProductVariant`. |

### 3.9 `POST /api/products/[id]/variants/[variantId]/toggle`

| Field | Value |
|---|---|
| Purpose | Activate/deactivate a variant (sets `isActive`). |
| Auth | Source-company-or-elevated + `PRODUCTS_EDIT`. |
| Used by | `ProductDetailView` (variant table toggle). |

### 3.10 Variant parent-group override/resync routes

Sprint 10 introduced parent-child variant grouping: variants are grouped by the lowest-`display_order` attribute ("parent attribute"); each child variant's `costPriceSyncedWithParent` / `weightSyncedWithParent` / `salePriceSyncedWithParent` flags track whether the field follows the parent group's value.

| Route | Purpose |
|---|---|
| `POST /api/products/[id]/variants/[variantId]/override-price` | Override a single child's sale/compare price (sets `salePriceSyncedWithParent=false`). |
| `POST /api/products/[id]/variants/[variantId]/override-cost` | Override a single child's cost price (sets `costPriceSyncedWithParent=false`). |
| `POST /api/products/[id]/variants/[variantId]/override-weight` | Override a single child's weight in kg (sets `weightSyncedWithParent=false`). |
| `POST /api/products/[id]/variants/[variantId]/resync-price` | Re-sync the child's price with its parent group (re-clears the override flag). |
| `POST /api/products/[id]/variants/[variantId]/resync-cost` | Re-sync the child's cost with parent group. |
| `POST /api/products/[id]/variants/[variantId]/resync-weight` | Re-sync the child's weight with parent group. |

All require `PRODUCTS_PRICING` permission and use `determineParentAttribute()` from `src/lib/utils/variant-grouping.ts`.

### 3.11 `GET /api/products/[id]/variant-groups`

| Field | Value |
|---|---|
| Purpose | Group variants by parent attribute (lowest `display_order` among used attributes). Returns the grouped structure for the `ParentChildVariantTable` component. Uses the shared `groupVariantsByParentAttribute()` so the edit page and creation wizard can never disagree. |
| Response | `{ groups: [{ parentValueId, parentValue, parentAttribute, variants: [...] }] }` |

### 3.12 `POST /api/products/[id]/variant-groups/[parentValueId]/{cost,sale-price,weight}`

| Field | Value |
|---|---|
| Purpose | Set a price/cost/weight for an entire parent group — cascades to children whose `*SyncedWithParent` flag is `true` only. Children with overrides are skipped. |
| Auth | `PRODUCTS_PRICING` permission. |
| DB Impact | UPDATE multiple `OrgProductVariant` rows (cost/weight) or `CompanyVariantPricing` rows (sale-price) in a single `updateMany`. |

### 3.13 `POST /api/products/[id]/pricing`

| Field | Value |
|---|---|
| Purpose | Set per-variant pricing for the active company. UPSERTs `CompanyVariantPricing` for each variant. If this is the first pricing set, activates the `CompanyProductSetting` (subscription). |
| Auth | `PRODUCTS_PRICING` permission. |
| Request body | `{ pricing: [{ org_variant_id, sale_price, compare_price? }] }` |

### 3.14 `POST /api/products/[id]/images`

| Field | Value |
|---|---|
| Purpose | Upload a product image (multipart form-data: `file=...`, `variant_id?=...`). Stores locally under `/public/uploads/products/{orgId}/{productId}/`. First image auto-set as primary. Max 5 MB, allowed types: `image/jpeg`, `image/png`, `image/webp`. |
| Auth | Source-company-or-elevated. |
| Response | `{ id, publicUrl, isPrimary, displayOrder }` (201) |
| DB Impact | INSERT `OrgProductImage`. |
| Used by | `ProductCreateView` (image upload step), `ProductDetailView`. |
| Key logic | Local filesystem storage — **Vercel deployment bomb** (won't persist on serverless). |

### 3.15 `POST /api/products/[id]/promote`

| Field | Value |
|---|---|
| Purpose | Promote a product to `organization` or `selective` scope. Requires ≥1 active variant + ≥1 image. |
| Auth | Elevated-only. |
| Request body | `promoteProductSchema` — `{ new_scope: 'organization' | 'selective', ... }` |
| DB Impact | UPDATE `OrgProduct.{productScope, promotedAt, promotedById}`. INSERT `AuditLog` (`product.promoted`). |

### 3.16 `POST /api/products/[id]/demote`

| Field | Value |
|---|---|
| Purpose | Demote a product (`organization`/`selective` → `private`/`selective`). Revokes all non-source-company subscriptions. Non-blocking warning if `ReturnedStitchedInventory` has available items for affected companies. |
| Auth | Elevated-only. |
| DB Impact | UPDATE `OrgProduct.{productScope, demotedAt, demotedById, demotionReason}`. UPDATE/DELETE `SelectiveProductAccess[]` for non-source companies. |

### 3.17 `POST /api/products/[id]/selective-access`

| Field | Value |
|---|---|
| Purpose | Grant selective access to a specific company (UPSERT in `SelectiveProductAccess`). |
| Auth | Elevated-only. |
| Request body | `selectiveAccessSchema` — `{ company_id: string }` |

### 3.18 `POST /api/products/[id]/subscribe`

| Field | Value |
|---|---|
| Purpose | Subscribe the active company to an org-wide or selectively-shared product. Creates `CompanyProductSetting` (inactive until pricing is set). |
| Auth | `PRODUCTS_SUBSCRIBE` permission. |
| Used by | `ProductsView` ("Subscribe" button for non-owned products). |

### 3.19 `POST /api/products/drafts` & `POST /api/orders/drafts` & `GET /api/drafts`

See section 17 — Admin / Drafts.

### 3.20 `POST /api/products/generate-stitched`

| Field | Value |
|---|---|
| Purpose | Generate stitched/unstitched variant combinations for a stitchable product — returns preview array (no DB write). If `include_unstitched`: 1 unstitched variant (stock_based, no stitching). For each size × stitching_type: a `made_to_order` variant. SKU pattern: `{slug}-{size}-{type_short}` or `{slug}-UN`. |
| Auth | Authenticated user only. |
| Used by | `ProductCreateView` (stitchable product flow). |

---

## Section 4 — Inventory APIs

All routes under `src/app/api/inventory/` and `/api/inventory-locations/` and `/api/suppliers/` and `/api/purchase-orders/` and `/api/production-orders/`. The Inventory System (Sprint 6) introduced `InventoryPool` (single source of truth for stock — one row per variant per location) + `InventoryTransaction` (append-only ledger) + `AvgCostHistory` (audit trail of every WAC change) + `StockTransfer` + `Supplier` + `PurchaseOrder[Item|Receipt|ReceiptItem]` + `StockLossRecord` + `CycleCount[Item]` + `ProductionOrder`.

### 4.1 `GET /api/inventory/dashboard`

| Field | Value |
|---|---|
| Purpose | Inventory dashboard stats: total stock value, low-stock count, out-of-stock count, dead stock value, stock movement summary (this month), recent transactions. |
| Auth | Legacy pattern. |
| Response | `{ stats: {...}, movements: [...], recentTransactions: [...] }` |
| DB Impact | READ `InventoryPool` (org-scoped) + `InventoryTransaction`. |
| Used by | `InventoryDashboardView`. |

### 4.2 `GET /api/inventory/summary?product_id=xxx`

| Field | Value |
|---|---|
| Purpose | Inventory summary for a single product. Per-variant: total on_hand/reserved/available across all locations, per-location breakdown, total stock value, `trackInventory` flag. |
| Auth | Legacy pattern. |
| Used by | `ProductDetailView` (inventory panel). |

### 4.3 `GET /api/inventory-locations` & `POST` & `GET/PATCH/DELETE /api/inventory-locations/[id]`

| Field | Value |
|---|---|
| Purpose | CRUD for warehouse/dispatch/retail/transit/damaged-hold locations. Org-level shared (`companyId=null`) + company-level. |
| Auth | `INVENTORY_MANAGE_LOCATIONS` permission for write ops. |
| DB Impact | READ/INSERT/UPDATE/DELETE `InventoryLocation`. |
| Used by | `LocationsView`, `LocationDetailView`. |

### 4.4 `GET /api/suppliers` & `POST` & `GET/PATCH/DELETE /api/suppliers/[id]`

| Field | Value |
|---|---|
| Purpose | CRUD for suppliers. Org-level shared (`companyId=null`) + company-level. Tracks `paymentTerms`, `creditBalance` (running credit owed BY supplier TO us). |
| Auth | `INVENTORY_MANAGE_SUPPLIERS` for writes. |
| DB Impact | READ/INSERT/UPDATE/DELETE `Supplier`. |
| Used by | `SuppliersView`, `SupplierDetailView`. |

### 4.5 `POST /api/inventory/receive`

| Field | Value |
|---|---|
| Purpose | Receive stock directly (NOT against a PO). For each item: `opening_stock` if first-ever transaction for the variant+location, else `purchase_received`. Recalculates WAC (weighted-average cost). |
| Auth | `INVENTORY_RECEIVE` permission. |
| Request body | `receiveStockSchema` — `{ items: [{ org_variant_id, location_id, quantity, cost_per_unit, notes? }] }` |
| DB Impact | INSERT `InventoryTransaction` per item. UPDATE `InventoryPool.{onHand, avgCost, lastReceivedAt}`. INSERT `AvgCostHistory`. INSERT `AuditLog` (`inventory.received`). |
| Key logic | Supports `Idempotency-Key` header. |

### 4.6 `POST /api/inventory/opening-stock`

| Field | Value |
|---|---|
| Purpose | Thin wrapper around `processInventoryTransaction()` for a SINGLE variant — used by the product-creation wizard and product-edit page when filling in per-variant "Opening Stock" (qty + cost + location). |
| Auth | `INVENTORY_RECEIVE` permission. |
| DB Impact | Same as `/api/inventory/receive` (single-item variant). |

### 4.7 `POST /api/inventory/adjust`

| Field | Value |
|---|---|
| Purpose | Manual stock adjustment (positive or negative). Uses `cycle_count_adjust` txn type with `reference_type='manual'`. Negative quantity removes stock, positive adds stock. |
| Auth | `INVENTORY_ADJUST` permission. |
| Request body | `adjustStockSchema` — `{ org_variant_id, location_id, quantity (signed), reason }` |
| DB Impact | INSERT `InventoryTransaction`. UPDATE `InventoryPool.onHand`. INSERT `AuditLog` (`inventory.adjusted`). |
| Key logic | Negative adjustments that bring on_hand below reserved quantity are rejected with a 400. |

### 4.8 `POST /api/inventory/transfers`

| Field | Value |
|---|---|
| Purpose | Create a stock transfer between two locations. Produces TWO `InventoryTransaction` rows: `transfer_out` (from) + `transfer_in` (to). Logistics cost tracked separately — NEVER merged into WAC. |
| Auth | `INVENTORY_TRANSFER` permission. |
| Request body | `{ org_variant_id, from_location_id, to_location_id, quantity, cost_per_unit_at_transfer?, logistics_cost?, notes? }` |
| DB Impact | INSERT `StockTransfer` + 2× `InventoryTransaction`. UPDATE 2× `InventoryPool` (decrement from, increment to). UPDATE `AvgCostHistory` (destination inherits sender's WAC, modified by logistics if applicable). |

### 4.9 `POST /api/inventory/receive-returned-stitched`

| Field | Value |
|---|---|
| Purpose | Receive a returned made-to-order stitched item. If `condition='damaged'`: does NOT add to stock — creates a `StockLossRecord` directly with `loss_type='damaged'`, `resolution='written_off'`. Otherwise: creates `ReturnedStitchedInventory` row + `inventory_transaction` (`return_stitched_received`) and links them via `inventoryTxnId`. |
| Auth | `INVENTORY_REPORT_LOSS` permission. |
| DB Impact | INSERT `ReturnedStitchedInventory` + `InventoryTransaction` (+ `StockLossRecord` if damaged). UPDATE `InventoryPool` (if not damaged). |

### 4.10 `POST /api/inventory/fulfill-mto`

| Field | Value |
|---|---|
| Purpose | Check and fulfill a made-to-order variant. The central decision function: (1) checks if returned stock is available → uses existing stock; (2) if not → creates a production order + consumes fabric. |
| Auth | Legacy pattern. |
| Used by | Called internally by the order-create/dispatch flows; not directly wired to a UI button. |

### 4.11 `GET /api/purchase-orders` & `POST`

| Field | Value |
|---|---|
| Purpose | List + create purchase orders. Each PO has `poNumber` (`PO-{year}-{seq}` via `get_next_sequence_number()` atomic counter — migration 026). Status flow: `draft` → `ordered` → `partially_received` → `received` (or `cancelled`). |
| Auth | `INVENTORY_MANAGE_PURCHASE_ORDERS` for writes; GET requires auth. |
| Request body (POST) | `createPoSchema` — `{ supplier_id, delivery_location_id, expected_delivery_date?, advance_payment=0, payment_method?, notes?, items: [{ org_variant_id, ordered_quantity, cost_per_unit }], status='draft' }` |
| Response (GET) | `{ orders: [{ id, poNumber, status, supplier, deliveryLocation, orderDate, expectedDeliveryDate, advancePayment, itemCount, totalItemsValue, receivedValue, balanceDue }] }` |
| DB Impact (POST) | INSERT `PurchaseOrder` + `PurchaseOrderItem[]`. INSERT `AuditLog` (`po.created`). INSERT `MetricEvent`. |
| Used by | `PurchaseOrdersView`, `PoCreateView`, `PoDetailView`. |

### 4.12 `GET /api/purchase-orders/[id]`

| Field | Value |
|---|---|
| Purpose | Single PO detail with items + receipts. |
| Response | `{ purchaseOrder: {...full record, items: [{...orderedQuantity, receivedQuantity, costPerUnit}], receipts: [{...items: [...]}] } }` |

### 4.13 `POST /api/purchase-orders/[id]/confirm`

| Field | Value |
|---|---|
| Purpose | Confirm a draft PO → status `ordered`. Increments `incoming` on each affected `InventoryPool` (so the dashboard can show expected deliveries). |
| Auth | `INVENTORY_MANAGE_PURCHASE_ORDERS`. |
| DB Impact | UPDATE `PurchaseOrder.status='ordered'`. UPDATE `InventoryPool.incoming` per item. |

### 4.14 `POST /api/purchase-orders/[id]/cancel`

| Field | Value |
|---|---|
| Purpose | Cancel a PO (only if `status IN ('draft', 'ordered')` — cannot cancel after partial receipt). Decrements `incoming` on affected `InventoryPool`s. |
| DB Impact | UPDATE `PurchaseOrder.{status, cancelledAt, cancelledById, cancellationReason}`. UPDATE `InventoryPool.incoming` (decrement). |

### 4.15 `POST /api/purchase-orders/[id]/receive`

| Field | Value |
|---|---|
| Purpose | Receive goods against a PO. Creates a `PurchaseOrderReceipt` + `PurchaseOrderReceiptItem[]`, then processes `inventory_transactions` (`purchase_received`) which recalculates WAC. Supports partial deliveries, quantity discrepancies (`shortage_quantity`), and price differences (`actual_cost_per_unit` may differ from `cost_per_unit`). |
| Auth | `INVENTORY_RECEIVE` permission. |
| Request body | `receiveSchema` — `{ notes?, items: [{ purchase_order_item_id, org_variant_id, received_quantity, actual_cost_per_unit, shortage_quantity=0, shortage_reason? }] }` |
| DB Impact | INSERT `PurchaseOrderReceipt` + `PurchaseOrderReceiptItem[]` + `InventoryTransaction[]` (with `referenceType='purchase_order'`). UPDATE `PurchaseOrderItem.receivedQuantity`. UPDATE `PurchaseOrder.status` (→ `partially_received` or `received` based on completion). UPDATE `InventoryPool.{onHand, incoming, avgCost}`. INSERT `AvgCostHistory`. |
| Key logic | Each receipt item links to its `inventoryTxnId` (1:1). Refuses if PO is `cancelled` or already fully `received`. |

### 4.16 `GET /api/production-orders` & `POST` & `GET/PATCH /api/production-orders/[id]`

| Field | Value |
|---|---|
| Purpose | CRUD for production orders (made-to-order fabric tracking). Each PO links a `stitchedVariantId` + `fabricVariantId` + `fabricLocationId`. Status flow: `pending` → `fabric_reserved` → `in_production` → `completed` → `dispatched` (or `cancelled`). |
| Auth | `INVENTORY_MANAGE_PRODUCTION` for writes. |
| Request body (POST) | `createProductionOrderSchema` — `{ stitched_variant_id, fabric_variant_id, fabric_location_id, quantity=1, stitching_cost=0, assigned_tailor?, estimated_completion_date?, notes? }` |
| DB Impact (POST) | INSERT `ProductionOrder`. Consumes fabric via `processInventoryTransaction` (`fabric_consumed_for_stitching`). UPDATE `InventoryPool` (decrement fabric onHand). |
| Key logic | Cancel reverses the fabric consumption (creates a `return_resellable`-style transaction restoring the fabric). Links to `OrderItem` via `orderItemId` (1:1 unique). |

### 4.17 `GET /api/returned-stitched` & `POST` & `GET/PATCH /api/returned-stitched/[id]` & `GET /api/returned-stitched/stats`

| Field | Value |
|---|---|
| Purpose | Manage the returned-stitched inventory register — the special pool for made-to-order items returned in sellable condition (the ONLY stock an MTO variant ever holds). POST creates a new row; `[id]` PATCH supports `mark_sold` and `write_off` actions. |
| Auth | `INVENTORY_RECEIVE` for POST; `INVENTORY_MANAGE_LOSS` for write-off. |
| DB Impact | INSERT/UPDATE `ReturnedStitchedInventory`. INSERT `InventoryTransaction` (linked via `inventoryTxnId`). |
| Used by | `ReturnedStitchedView`. |

---

## Section 5 — Order APIs

All routes under `src/app/api/orders/`. The Order Management System (Sprint 7+) is the largest module — `Order` has 50+ fields, `OrderItem` tracks per-line fulfillment independently of the variant's `fulfillmentType`. See `ORDERS_AUDIT.md` for full audit findings.

### 5.1 `GET /api/orders`

| Field | Value |
|---|---|
| Purpose | List orders for the active company with extensive filtering. |
| Auth | Modern pattern — `ORDERS_VIEW`. Applies `ordersDataScope` filter ('own' sees only `salesEmployeeId=ctx.employee.id`). |
| Query params | Multi-select (comma-separated OR repeated): `statuses`, `payment_types`, `payment_statuses`, `order_sources`, `courier_names`. Single-value (backward compat): `status`, `payment_type`, `payment_status`, `order_source`, `courier_name`. Range: `amount_min`/`amount_max` (numbers — `totalOrderValue >= / <=`), `date_from`/`date_to` (ISO). Scalar: `customer_id`, `org_variant_id`, `delivery_city`, `search`, `limit`, `offset`. |
| Response | `{ orders: [{ id, flowopsOrderNumber, status, paymentType, paymentStatus, totalOrderValue, customer: {...}, items: [...], createdAt, ... }], total, ... }` |
| DB Impact | READ `Order` + `Customer` + `OrderItem` + `OrgProductVariant` + `OrgProduct` + `InventoryLocation` + `Employee` (salesEmployee). Uses trigram indexes for `search`. |
| Used by | `OrdersView`, `CustomersView` (orders tab), `OrderDetailView` (related orders), etc. |

### 5.2 `POST /api/orders`

| Field | Value |
|---|---|
| Purpose | Create a manual order. Wraps `createManualOrder()` server action (`src/lib/actions/order.actions.ts`). |
| Auth | Modern pattern — `ORDERS_CREATE`. |
| Request body | `createManualOrderSchema` (validated) — `{ customer_id?, recipient_name?, customer: {name, phones: [...], addresses: [...]}, items: [{org_variant_id, quantity, unit_price?, discount_type?, discount_value?}], payment_type='full_cod', advance_amount?, payment_method?, payment_reference?, payment_screenshot_url?, delivery_address, delivery_city, delivery_country='PK', used_customer_address_id?, used_customer_phone_id?, sales_employee_id?, courier_name?, notes_for_courier?, order_ref_number?, order_detail?, pickup_address_id?, estimated_delivery_charge?, tax_amount?, tax_label?, subtotal, discount_amount?, discount_reason?, courier_charges?, total_order_value }` |
| Response | `{ order: {...full order}, orderId: string }` (201) |
| DB Impact | INSERT `Order` + `OrderItem[]` + `Customer`/`CustomerPhone`/`CustomerAddress` (if new) + `InventoryTransaction` (reservations if auto-confirm) — all in `createManualOrder()`. INSERT `AuditLog` (`order.created`). INSERT `MetricEvent`. |
| Used by | `OrderCreateView`. |
| Key logic | Supports `Idempotency-Key`. Per-item discount refine validation in zod schema. Order number generated via `get_next_sequence_number()` (atomic — migration 026). Auto-confirms if `CompanyOrderSetting.requireOrderConfirmation=false`. Auto-books if `courierBookingMode='automatic'`. Per-item discount clamped at 0 minimum (per-item `unitPrice = originalUnitPrice - discount`). |

### 5.3 `GET /api/orders/[id]`

| Field | Value |
|---|---|
| Purpose | Full order detail with customer, items, dispatch location, sales employee attribution, payment / timeline fields. |
| Auth | Modern pattern — `ORDERS_VIEW` + `ordersDataScope='own'` scoping. |
| Response | `{ order: { id, flowopsOrderNumber, externalOrderReference, externalOrderId, orderSource, status, paymentType, paymentStatus, paymentSource, subtotal, discountAmount, discountReason, courierCharges, totalOrderValue, estimatedDeliveryCharge, actualDeliveryCharge, taxAmount, taxLabel, advanceAmount, advancePaymentMethod, advancePaymentReference, advancePaymentScreenshotUrl, advancePaidAt, remainingCodAmount, codCollected, codCollectedAmount, codCollectedAt, convertedBy, convertedAt, deliveryAddress, deliveryCity, deliveryCountry, courierName, trackingNumber, courierCompanyIntegrationId, courierBookingStatus, courierBookingFailureReason, pickupAddressId, recommendedCourierCompanyIntegrationId, courierCityStatus, courierSubStatus, needsShipperAdvice, unrecognizedCourierStatus, dispatchLocationId, notesForCourier, orderRefNumber, orderDetail, skippedConfirmation, skippedPacking, confirmedAt, packedAt, dispatchedAt, deliveredAt, cancelledAt, cancellationReason, returnedAt, salesEmployeeId, customer: {...with phones}, items: [{...with orgVariant, productionOrder}], dispatchLocation: {...}, salesEmployee: {...}, }` |
| DB Impact | READ `Order` + `Customer` + `OrderItem` + `OrgProductVariant` + `OrgProduct` + `ProductionOrder` + `InventoryLocation` + `Employee`. |

### 5.4 `POST /api/orders/[id]/confirm`

| Field | Value |
|---|---|
| Purpose | Confirm a pending order. Triggers stock reservation via `reserveOrderStock()` — for each `OrderItem`, finds an `InventoryPool` with sufficient on_hand, decrements on_hand + increments reserved, creates an `order_reserved` `InventoryTransaction`. Sets `confirmedAt`. |
| Auth | Modern pattern — `ORDERS_FULFILL` or `ORDERS_MANAGE`. |
| DB Impact | UPDATE `Order.{status, confirmedAt}`. INSERT `InventoryTransaction[]` (one per item). UPDATE `InventoryPool.{onHand, reserved}` per item. |
| Key logic | If insufficient stock for stock_based items: sets the item's `fulfillmentStatus='backordered'` and the order's `status='partially_backordered'`. Made-to-order items always reserve (production is implicit). |

### 5.5 `POST /api/orders/[id]/convert-payment`

| Field | Value |
|---|---|
| Purpose | Convert a COD order's payment status to `partial_advance` or `fully_prepaid`. **Payment conversion acts as a confirmation signal for pending orders** — if the order was `pending`, it gets auto-confirmed. |
| Auth | Modern pattern — `ORDERS_MANAGE`. |
| Request body | `convertPaymentSchema` — `{ payment_type: 'partial_advance'|'fully_prepaid', advance_amount?, payment_method?, payment_reference?, payment_screenshot_url?, payment_source='manual_conversion' }` |
| DB Impact | UPDATE `Order.{paymentType, paymentStatus, paymentSource, advanceAmount, advancePaymentMethod, advancePaymentReference, advancePaymentScreenshotUrl, advancePaidAt, convertedById, convertedAt, status='confirmed', confirmedAt}`. |

### 5.6 `POST /api/orders/[id]/payment-proof`

| Field | Value |
|---|---|
| Purpose | Attach (or clear) a payment proof screenshot URL on an existing order. Two use cases: (1) after order creation, (2) when updating an existing order's payment proof. |
| Auth | Modern pattern. |
| Request body | `updatePaymentScreenshotSchema` — `{ payment_screenshot_url?: string | null }` |
| DB Impact | UPDATE `Order.advancePaymentScreenshotUrl`. |

### 5.7 `POST /api/orders/[id]/cancel`

| Field | Value |
|---|---|
| Purpose | Cancel an order. Releases any reserved stock (`order_unreserved` transactions). Calls `cancelCourierBooking()` if the order has a courier booking (deletes the booking on the courier side + sets `courierBookingStatus='cancelled'`). |
| Auth | Modern pattern — `ORDERS_CANCEL`. |
| Request body | `{ cancellation_reason?: string }` |
| DB Impact | UPDATE `Order.{status='cancelled', cancelledAt, cancellationReason, courierBookingStatus='cancelled'}`. INSERT `InventoryTransaction[]` (`order_unreserved` for each reserved item). UPDATE `InventoryPool.{onHand, reserved}` (release). |
| Key logic | If cancelled from `processing`/`dispatched` status, sets `physicalUnpackRequired=true` (a physical parcel exists — needs to be taken apart before stock is returned). |

### 5.8 `POST /api/orders/[id]/un-cancel`

| Field | Value |
|---|---|
| Purpose | Reverse a cancellation — restores the order to its pre-cancel status (`confirmed` or `pending`), re-reserves stock, clears cancellation fields. Does NOT re-book the courier. |
| Auth | Modern pattern. |
| DB Impact | UPDATE `Order.{status='confirmed'|'pending', cancelledAt=null, cancellationReason=null, physicalUnpackRequired=false}`. INSERT `InventoryTransaction[]` (re-reserve). UPDATE `InventoryPool`. |

### 5.9 `POST /api/orders/[id]/processing`

| Field | Value |
|---|---|
| Purpose | Mark a `confirmed` order as `processing` (warehouse is packing). |
| Auth | Modern pattern. |
| DB Impact | UPDATE `Order.{status='processing'}`. |

### 5.10 `POST /api/orders/[id]/packed`

| Field | Value |
|---|---|
| Purpose | Mark a `confirmed`/`processing` order as `packed` (parcel is sealed). **Note**: `markOrderPacked` transitions to `status='processing'` (a known smell from ORDERS_AUDIT.md — both `processing` and `packed` actions land in the same status). The `packedAt` timestamp is what differentiates them. |
| DB Impact | UPDATE `Order.{status='processing', packedAt}`. |

### 5.11 `POST /api/orders/[id]/dispatch`

| Field | Value |
|---|---|
| Purpose | Dispatch an order. Deducts stock (`sale_dispatched` transactions), sets tracking info. **Blocks if any items are still backordered** (returns 400). |
| Auth | Modern pattern — `ORDERS_FULFILL`. |
| Request body | `{ tracking_number, courier_name?, courier_company_integration_id?, dispatch_location_id?, pickup_address_id?, cod_amount?, order_ref_number?, order_detail?, estimated_delivery_charge? }` |
| DB Impact | UPDATE `Order.{status='dispatched', dispatchedAt, trackingNumber, courierName, courierCompanyIntegrationId, dispatchLocationId, ...}`. INSERT `InventoryTransaction[]` (`sale_dispatched` for each item). UPDATE `InventoryPool.{onHand}` (decrement). UPDATE `OrderItem.{fulfillmentStatus='dispatched', fulfilledAt}`. |
| Used by | `OrdersReadyToDispatchView`, `OrderDetailView`, Booking Workbench (auto-dispatch via `performOrderDispatch()` shared function with idempotency). |
| Key logic | Idempotent: if already `dispatched` with same tracking number, returns success without re-decrementing stock. |

### 5.12 `POST /api/orders/[id]/delivered`

| Field | Value |
|---|---|
| Purpose | Mark a dispatched order as delivered. |
| DB Impact | UPDATE `Order.{status='delivered', deliveredAt}`. INSERT `AuditLog` (`order.delivered`). |
| Used by | PostEx polling, Leopard webhook, manual mark from Order Detail. |

### 5.13 `POST /api/orders/[id]/rto`

| Field | Value |
|---|---|
| Purpose | Process a return-to-origin for a dispatched order. Calls `processOrderReturn()` (`src/lib/actions/order-return.actions.ts`) — **non-transactional**. Restocks items as `return_resellable` (if condition assumed perfect — currently hardcoded `autoProcessedAsPerfect=true`) OR creates `StockLossRecord` if condition is later corrected to damaged. |
| Auth | Modern pattern. |
| Request body | `{ return_reason?: string }` |
| DB Impact | UPDATE `Order.{status='rto', returnedAt}`. INSERT `InventoryTransaction[]` (`return_resellable`). UPDATE `InventoryPool.onHand` (increment). UPDATE `OrderItem.{autoProcessedAsPerfect=true, needsReview=true}`. UPDATE `Customer.{totalRtoCount++}`. |
| Key logic | Auto-processed items go to the "Returns Review Queue" (`needsReview=true`) — staff must spot-check whether they were really perfect. Dismiss confirms perfect; `correct` reverses and creates a stock loss. |

### 5.14 `POST /api/orders/[id]/cod-collected`

| Field | Value |
|---|---|
| Purpose | Mark COD as collected from the customer. Sets `paymentStatus='cod_collected'`, `codCollected=true`, `codCollectedAmount`, `codCollectedAt`. |
| Auth | Modern pattern — `ORDERS_FULFILL` or `ORDERS_MANAGE`. |
| Request body | `{ collected_amount?: number }` |

### 5.15 `POST /api/orders/[id]/refresh-status`

| Field | Value |
|---|---|
| Purpose | Manually refresh a SINGLE order's courier status via the adapter's `trackShipment()` method (NOT the bulk polling job). Wired to the "Refresh Courier Status" button on the Order Detail page. Applies the same status transitions as the bulk poll (auto-dispatch on `in_transit`, mark delivered, RTO handling). |
| Response | `{ success, data: { status, subStatus, updated } }` |
| DB Impact | Potentially UPDATE `Order.{courierSubStatus, status, ...}` + INSERT `CourierStatusHistory`. |

### 5.16 `POST /api/orders/[id]/self-fulfilled-slip`

| Field | Value |
|---|---|
| Purpose | Generate an internal slip PDF for a self-fulfilled order. Returns the PDF as a binary response (not a URL) — avoids 404 issues with static file serving through the Caddy gateway. |
| Auth | Modern pattern. |
| Guard | Order must belong to the active company AND `fulfillmentChannel='self_fulfilled'`. Returns 400 for courier orders. |
| DB Impact | READ `Order` + `Customer` + `OrderItem` + `OrgProductVariant` + `OrgProduct`. Writes PDF to `/public/uploads/self-fulfilled-slips/{companyId}/slip-{ref}.pdf`. |
| Used by | `OrderDetailView` ("Download Slip" button for self-fulfilled orders). |

### 5.17 `GET /api/orders/[id]/returns/review` & `POST /api/orders/[id]/returns/review/correct` & `POST /api/orders/[id]/returns/review/dismiss`

| Field | Value |
|---|---|
| Purpose | The Returns Review Queue — auto-processed RTO items where `needsReview=true`. Staff physically inspect and either `correct` (item was actually damaged → reverse the `return_resellable` transaction + create a `StockLossRecord` with `loss_type='damaged'`, `sourceModule='rto'`) or `dismiss` (confirms the auto-assumed perfect condition was correct). |
| Auth | Modern pattern. |
| Query/body | `correct`: `?item_id=...` query + optional body `{ damage_type?, responsible_party?, notes? }` (defaults to `damage_type='other'`, `responsible_party='courier'` for backward compat). `dismiss`: `?item_id=...` query. |
| DB Impact | `correct`: UPDATE `OrderItem.{needsReview=false}`. INSERT `InventoryTransaction` (reverse the prior `return_resellable`). INSERT `StockLossRecord` (`sourceModule='rto'`). UPDATE `InventoryPool.{onHand}` (decrement the returned stock). `dismiss`: UPDATE `OrderItem.{needsReview=false}`. |

### 5.18 `GET /api/orders/pending`

| Field | Value |
|---|---|
| Purpose | List orders WHERE `status='pending'` for the active company. Read-only queue. |
| Auth | Modern pattern — `ORDERS_VIEW` + scope filter. |
| DB Impact | READ `Order` (status='pending') + `Customer` + primary phone. Hardcoded `take: 200`. |
| Used by | `OrdersPendingConfirmationView`. |

### 5.19 `GET /api/orders/backordered`

| Field | Value |
|---|---|
| Purpose | List backordered order ITEMS grouped by variant (FIFO by `backorderedAt`). Different from other queues — returns `OrderItem[]` not `Order[]`. |
| Auth | Modern pattern — `ORDERS_VIEW` + item-scope filter. |
| DB Impact | READ `OrderItem` (`fulfillmentStatus='backordered'`) + `Order` (status NOT in `cancelled`/`refunded`) + `OrgProductVariant` + `Customer`. |
| Used by | `OrdersBackorderedView`. |

### 5.20 `GET /api/orders/awaiting-production`

| Field | Value |
|---|---|
| Purpose | List made-to-order items awaiting production (their `ProductionOrder` is in `pending`/`fabric_reserved`/`in_production`). |
| DB Impact | READ `OrderItem` (with `productionOrderId`) + `Order` + `ProductionOrder` + `OrgProductVariant`. |
| Used by | `OrdersAwaitingProductionView`. |

### 5.21 `GET /api/orders/ready-to-dispatch`

| Field | Value |
|---|---|
| Purpose | List orders ready to dispatch — `status IN ('confirmed','processing')` AND every `OrderItem.fulfillmentStatus='reserved'` (no backordered items). |
| DB Impact | READ `Order` + `OrderItem` + `Customer` + `InventoryLocation`. JS-side filter for "all items reserved" — known smell from ORDERS_AUDIT (should be DB-side). |
| Used by | `OrdersReadyToDispatchView`. |

### 5.22 `GET /api/orders/returns`

| Field | Value |
|---|---|
| Purpose | List RTO orders for the active company, with items-needing-review counts for the "Needs Review" filter on the returns page. |
| Used by | `OrdersReturnsView`. |

### 5.23 `GET /api/orders/cancelled`

| Field | Value |
|---|---|
| Purpose | List cancelled orders (read-only history). |
| Used by | `OrdersCancelledView`. |

### 5.24 `GET /api/orders/revenue-summary`

| Field | Value |
|---|---|
| Purpose | Returns currency-aware revenue for the orders-view stat card (Phase F1). Computes the per-currency breakdown + an estimated total in the company's `baseCurrency` using the latest `ExchangeRateSnapshot`. |
| Auth | Modern pattern. |
| Response | `{ perCurrency: [{ currency, total, count }], estimatedTotalInBaseCurrency, baseCurrency }` |
| Used by | `OrdersView` (stat card header). |

### 5.25 `POST /api/orders/drafts`

| Field | Value |
|---|---|
| Purpose | Save an order form draft (Unsaved Changes Guard). Delegates to `saveOrderDraft()`. |
| Request body | `{ draftId?, draftData, draftTitle? }` |
| DB Impact | UPSERT `FormDraft` (`draftType='order'`). Assigns `draftNumber` via the atomic `draft_order_number_seq` (migration 006) on first save. |

---

## Section 6 — Purchase Order APIs

Covered in Section 4.11–4.15 above. The PO subsystem has CRUD + cancel + confirm + receive. PO numbers (`PO-{year}-{seq}`) use the atomic `get_next_sequence_number()` (migration 026 — the original `count+1` race condition was fixed).

---

## Section 7 — Production Order APIs

Covered in Section 4.16 above. The Production Order subsystem tracks made-to-order fabric consumption. Cancel reverses the fabric consumption (creates a transaction restoring the fabric). Links to `OrderItem` via `orderItemId` (1:1 unique).

---

## Section 8 — Exchange APIs

All routes under `src/app/api/exchanges/` and `/api/exchange-shipments/`. The Item Exchange System (migration 003 + 008 + 019) supports two distinct exchange methods:

- **`courier_replacement`** — new item dispatched first via courier; courier collects the old item. Status flow: `requested` → `replacement_dispatched` → `old_item_collected` → `completed`.
- **`customer_self_return`** — customer ships the old item back FIRST; staff manually verifies condition; THEN the new item is dispatched. Status flow: `requested` → `customer_shipped` → `old_item_verified` → `replacement_dispatched` → `completed`.

### 8.1 `GET /api/exchanges`

| Field | Value |
|---|---|
| Purpose | List exchanges with filters. |
| Auth | Modern pattern. |
| Query params | `status`, `exchange_method`, `date_from`/`date_to`, `limit`, `offset`. |
| DB Impact | READ `OrderExchange` + `Order` + `OrderItem` + `OrgProductVariant` + `Employee` + `ExchangeShipment[]`. |
| Used by | `ExchangesView`. |

### 8.2 `POST /api/exchanges`

| Field | Value |
|---|---|
| Purpose | Create a new exchange request. |
| Auth | Modern pattern. |
| Request body | `{ original_order_item_id, new_org_variant_id, exchange_method: 'courier_replacement'|'customer_self_return', reason }` |
| Response | `{ exchangeId }` (201) |
| DB Impact | INSERT `OrderExchange` (`priceDifference` is GENERATED in DB as `new-old`). INSERT `AuditLog`. |
| Key logic | Supports `Idempotency-Key`. Exchange can only be created against an order_item belonging to a DELIVERED order. `oldItemPrice` and `newItemPrice` snapshotted at creation. |

### 8.3 `GET /api/exchanges/[id]`

| Field | Value |
|---|---|
| Purpose | Full exchange detail with original order, new order (if linked), exchange shipments, verification info, price difference settlement, etc. |
| Used by | `ExchangeDetailView`. |

### 8.4 `POST /api/exchanges/[id]/cancel`

| Field | Value |
|---|---|
| Purpose | Cancel an exchange (only before dispatch — if `replacement_dispatched` and a courier booking exists, also cancels the courier booking). |
| Request body | `{ cancellation_reason?: string }` |

### 8.5 `POST /api/exchanges/[id]/confirm-shipped` (customer_self_return only)

| Field | Value |
|---|---|
| Purpose | Mark that the customer has shipped the old item back (manual confirmation — no courier API confirms arrival). Sets `customerConfirmedShippedAt`. |
| Request body | `{ customer_return_tracking_number?, customer_return_courier? }` |

### 8.6 `POST /api/exchanges/[id]/verify-old-item` (customer_self_return only)

| Field | Value |
|---|---|
| Purpose | Manually verify old item received — the gating point. Staff inspects the item and records `condition` (`perfect`/`good`/`open_box`/`damaged`). For `damaged`: creates a `StockLossRecord` directly (bypasses the unified `recordStockLoss()` helper — known smell from STOCKLOSS_INVESTIGATION.md). For other conditions: creates an `InventoryTransaction` (`return_resellable`/`return_damaged`). |
| Request body | `{ condition, evidence_urls: string[], notes? }` |
| DB Impact | UPDATE `OrderExchange.{status='old_item_verified', oldItemCondition, oldItemVerifiedAt, oldItemVerifiedBy, oldItemEvidenceUrls, oldItemNotes, oldItemInventoryTxnId?}`. INSERT `InventoryTransaction` OR `StockLossRecord` based on condition. |

### 8.7 `POST /api/exchanges/[id]/dispatch-new-item` (courier_replacement)

| Field | Value |
|---|---|
| Purpose | Dispatch the new variant to the customer (courier_replacement method). Creates an `ExchangeShipment` row, reserves stock, books the courier. |
| Request body | `{ orderRefNumber?, orderDetail? }` (universal courier reference overrides — migration 015). |

### 8.8 `POST /api/exchanges/[id]/dispatch-replacement` (customer_self_return)

| Field | Value |
|---|---|
| Purpose | Dispatch the replacement item AFTER the old item has been verified (customer_self_return method). Same logic as dispatch-new-item but with the verification gate already passed. |

### 8.9 `POST /api/exchanges/[id]/mark-not-returned`

| Field | Value |
|---|---|
| Purpose | Terminal "customer did not return" outcome. The old item never came back; the value becomes a recoverable amount. Flags the customer via `flagCustomer()` with reason "Exchange item not returned". |
| Request body | `{ not_returned_reason?, not_returned_recovery_status?: 'pending'|'recovered'|'written_off', not_returned_recovery_amount? }` |

### 8.10 `POST /api/exchanges/[id]/settle-price-difference`

| Field | Value |
|---|---|
| Purpose | Settle the price difference. If positive (customer owes), records the amount received. If negative (refund due), records refund method + reference. |
| Request body | `{ settled_amount, refund_method?: 'cash'|'bank_transfer'|'store_credit'|'other', refund_reference?, refund_amount? }` |
| DB Impact | UPDATE `OrderExchange.{priceDifferenceStatus='settled', priceDifferenceSettledAmount, priceDifferenceSettledAt, priceDifferenceSettledBy, refundMethod, refundReference, refundProcessedAt, refundProcessedBy, refundAmount}`. |

### 8.11 `GET /api/exchanges/overdue?days_threshold=7`

| Field | Value |
|---|---|
| Purpose | List overdue exchanges (status NOT in terminal states AND `requestedAt < now - days_threshold`) for alerts. |
| Used by | `ExchangesView` (overdue banner / filter). |

### 8.12 Exchange Shipment sub-routes

Each `POST /api/exchange-shipments/[id]/...` operates on an `ExchangeShipment` (structurally separate from `Order` — has its own `EXCH-{year}-{seq}` numbering). These are managed by `src/lib/actions/exchange-shipment.actions.ts`.

| Route | Purpose |
|---|---|
| `POST /api/exchange-shipments/[id]/reserve` | Reserve stock for an exchange shipment. |
| `POST /api/exchange-shipments/[id]/dispatch` | Dispatch with tracking + courier. Sets `status='dispatched'`, `dispatchedAt`, `trackingNumber`, `courierCompanyIntegrationId`. |
| `POST /api/exchange-shipments/[id]/rto` | Manually mark as RTO (returned by courier). Calls `performExchangeShipmentRto()` which restores inventory + sets the parent `OrderExchange.status='exchange_item_returned'` (terminal). |
| `POST /api/exchange-shipments/[id]/cod-collected` | Record COD collection. |
| `POST /api/exchange-shipments/[id]/cancel` | Cancel an exchange shipment (only if not yet picked up — guards `courierSubStatus IN ['slip_generated', 'pickup_requested']`). |

---

## Section 9 — Booking Workbench APIs

All routes under `src/app/api/booking-workbench/`. The Booking Workbench is the centralized UI for booking shipments with couriers (PostEx, Leopard — TCS framework-ready only). Bookable items include both `Order`s and `ExchangeShipment`s.

### 9.1 `GET /api/booking-workbench/bookable`

| Field | Value |
|---|---|
| Purpose | Returns bookable orders AND exchange shipments for the Booking Workbench. Bookable = `courierBookingStatus='not_booked'` AND not cancelled/refunded. |
| Auth | Modern pattern — `ORDERS_FULFILL`. |
| Response | `{ orders: [...], exchangeShipments: [...] }` |
| Used by | `BookingWorkbenchView` (bookable tab). |

### 9.2 `POST /api/booking-workbench/book`

| Field | Value |
|---|---|
| Purpose | Book a single order OR exchange shipment with the selected courier. For ORDERS: delegates to `bookOrderWithCourier()` server action. For EXCHANGE SHIPMENTS: handles inline (the exchange-shipment booking path is not used by auto-booking). |
| Auth | `ORDERS_FULFILL` permission. |
| Request body | `{ orderId? OR shipmentId?, companyIntegrationId, customerName?, customerPhone?, deliveryAddress?, deliveryCity?, codAmount?, orderType?, transactionNotes?, itemDescription?, orderRefNumber?, pickupAddressCode? }` |
| Response | `{ success, bookingResult: { trackingNumber, courierName, ... } }` |
| DB Impact | UPDATE `Order`/`ExchangeShipment.{courierBookingStatus='booked', courierCompanyIntegrationId, trackingNumber, ...}`. INSERT `IntegrationActionLog` (`actionType='book_shipment'`, `direction='outbound'`). |
| Used by | `BookingWorkbenchView`. |
| Key logic | Revalidates city at booking time via `revalidateCityAtBookingTime()` (live fallback if cache stale). For PostEx: determines order type (Overland vs Normal) via `determinePostExOrderType()`. Calculates order weight via `calculateOrderWeightKg()`. **Known limitation**: `bookOrderWithCourier` rejects non-postex providers — Leopard regular-order booking blocked (only exchange shipments can be booked with Leopard). |

### 9.3 `POST /api/booking-workbench/book-batch`

| Field | Value |
|---|---|
| Purpose | Bulk book multiple orders in one call. Iterates `bookOrdersBatch()`. |
| Request body | `{ companyIntegrationId, items: [{ orderId? OR shipmentId?, ...overrides }] }` |
| Response | `{ results: [{ success, orderId?/shipmentId?, error? }] }` |

### 9.4 `GET /api/booking-workbench/activity?date_from=&date_to=`

| Field | Value |
|---|---|
| Purpose | Returns a merged list of all booked orders + exchange shipments for the Booking Activity report (read-only). |

### 9.5 `GET /api/booking-workbench/load-sheet-ready?companyIntegrationId=...`

| Field | Value |
|---|---|
| Purpose | Returns orders AND exchange shipments ready for load sheet generation for the specified courier integration (booked + not yet load-sheeted). |

### 9.6 `POST /api/booking-workbench/load-sheet`

| Field | Value |
|---|---|
| Purpose | Generate a load sheet (pickup manifest) for a batch of orders and/or exchange shipments. Courier-agnostic — dispatches to the adapter's `generateLoadSheet()` method. Stores the PDF in OUR file storage (not an external courier URL). |
| Request body | `{ companyIntegrationId, pickupAddressId?, items: [{ entityType: 'order'|'exchange_shipment', entityId, trackingNumber }] }` |
| Response | `{ loadSheetId, pdfStoragePath, generatedAt }` |
| DB Impact | INSERT `LoadSheet` (immutable once generated). UPDATE `Order`/`ExchangeShipment.{loadSheetId}` per included item. |

### 9.7 `GET /api/booking-workbench/load-sheets`

| Field | Value |
|---|---|
| Purpose | Returns previously generated load sheets for this company (History section). Most recent first, default limit 20. |
| Used by | `LoadSheetsTab`. |

---

## Section 10 — Scan APIs

All routes under `src/app/api/scan/`. The Order Scan Module (migration 017) is the barcode-scanning station for warehouse staff. Every scan is recorded in `ScanEvent` (immutable ledger).

### 10.1 `POST /api/scan`

| Field | Value |
|---|---|
| Purpose | Process a barcode scan OR confirm a sub-action (unpack / cancel). Three distinct payloads: (1) scan: `{ trackingNumber, scanMode, scanStationLabel? }`; (2) confirm unpack: `{ action: 'confirm_unpack', entityType: 'order'|'exchange_shipment', entityId }`; (3) confirm cancel: `{ action: 'confirm_cancel', entityType, entityId }`. |
| Auth | Modern pattern — `SCAN_OPERATE`. |
| Scan modes | `mark_processing`, `mark_packed`, `warehouse_handover`, `receive_return` (NO-OP — staff must navigate to Orders → Order Detail → RTO Dialog → submit, then to Returns → Review Queue to mark damaged), `locate_cancelled`, `cancel_via_scan`. |
| DB Impact | INSERT `ScanEvent` (always — even for rejected/not_found). UPDATE `Order`/`ExchangeShipment.{warehouseHandoverScannedAt, physicalUnpackConfirmedAt, status, ...}` depending on mode. |
| Used by | `OrderScanView`. |
| Key logic | `confirm_unpack` is required when an order was cancelled from `processing`/`dispatched` (a physical parcel exists). `confirm_cancel` finalizes the cancellation after the parcel is physically unpacked. |

### 10.2 `POST /api/scan/confirm-return`

| Field | Value |
|---|---|
| Purpose | One-go return confirmation: confirms RTO, AND optionally records damage — combining what would otherwise require three round-trips (scan receive_return → order detail RTO dialog → returns review queue). |
| Auth | `SCAN_OPERATE` + `INVENTORY_REPORT_LOSS` for the damage path. |
| Request body | `{ trackingNumber, return_reason?, damage_type?, responsible_party?, notes?, evidence_urls? }` |
| DB Impact | Calls `processOrderReturn()` + `recordStockLoss()` (with `sourceModule='return_scan'` — dedup partial unique index prevents double-counting with the manual `/api/orders/[id]/returns/review/correct` path which uses `sourceModule='rto'`). |

### 10.3 `GET /api/scan/reports?dateFrom=&dateTo=&employeeId=&customerId=` & `POST /api/scan/reports` (generate)

| Field | Value |
|---|---|
| Purpose | GET: hybrid stored+live scan report for a date range (uses `ScanDailyReport` if available, falls back to live query). POST: generate a PDF scan report for the date range. |
| Auth | `SCAN_VIEW_REPORTS`. |
| DB Impact | READ `ScanEvent` + `ScanDailyReport`. WRITE PDF to `/public/uploads/scan-reports/{companyId}/scan-report-{from}-to-{to}.pdf`. |
| Used by | `OrderScanView` (reports tab). |
| Key logic | **Bug** (from ORDERS_AUDIT.md): `/api/scan/reports` POST uses `db.userSetting.findFirst({})` with NO where clause — fetches ANY user's settings. Should be `findUnique({ where: { userId: ctx.user.id } })`. |

---

## Section 11 — Stock Loss APIs

All routes under `src/app/api/stock-loss/`. Stock loss records have 5 types: `damaged`, `theft`, `missing`, `transit_loss`, `supplier_dispute`. Migration 027 unified the loss-creation paths via the `recordStockLoss()` helper (`src/lib/stock-loss.ts`) with `sourceModule` discriminator + a dedup partial unique index `stock_loss_orderitem_dedup_idx`.

### 11.1 `GET /api/stock-loss`

| Field | Value |
|---|---|
| Purpose | List stock loss records for the active company. Supports filtering by `loss_type` and `investigation_status`. Hardcoded `take: 100`. |
| Auth | Legacy pattern — `INVENTORY_REPORT_LOSS` permission. |
| Response | `{ records: [{ id, productTitle, sku, location, lossType, subType, damageType, quantity, costPerUnit, totalLossValue, investigationStatus, resolution, responsibleParty, courierClaimStatus, courierRecovered, inventoryTxnId, supplierReturnId, supplierReturn, reportedBy, createdAt, resolvedAt }] }` |
| Used by | `LossesView`. |

### 11.2 `GET /api/stock-loss/[id]`

| Field | Value |
|---|---|
| Purpose | Single stock loss record with full detail (variant, location, reporter, photos, evidence, etc.). |

### 11.3 `GET /api/stock-loss/stats`

| Field | Value |
|---|---|
| Purpose | Stock loss stats for the losses dashboard header. |

### 11.4 `POST /api/stock-loss/report-damaged`

| Field | Value |
|---|---|
| Purpose | Report DAMAGED stock — **single-stage, instant write-off**. Creates a `damage_writeoff` `InventoryTransaction` immediately (decrements on_hand). |
| Auth | `INVENTORY_REPORT_LOSS` permission. |
| Request body | `reportDamagedLossSchema` — `{ org_variant_id, location_id, quantity, cost_per_unit, damage_type: 'water_moisture'|'physical_impact'|'manufacturing_defect'|'transit_damage'|'storage_damage'|'other', responsible_party?, notes?, evidence_urls? }` |
| DB Impact | INSERT `StockLossRecord` (`sourceModule='stock_loss'`). INSERT `InventoryTransaction` (`damage_writeoff`). UPDATE `InventoryPool.onHand`. |

### 11.5 `POST /api/stock-loss/report-theft`

| Field | Value |
|---|---|
| Purpose | Report THEFT — **two-stage, quarantine at report time**. Does NOT call `processInventoryTransaction` — only increments `reserved` (quarantine). Stock remains onHand but is "frozen" pending investigation. |
| Auth | `INVENTORY_REPORT_LOSS`. |
| DB Impact | INSERT `StockLossRecord` (`investigationStatus='open'`). UPDATE `InventoryPool.reserved` (increment — quarantine). |

### 11.6 `POST /api/stock-loss/report-transit`

| Field | Value |
|---|---|
| Purpose | Report TRANSIT LOSS — **no inventory transaction**. Stock was already decremented at dispatch time (`sale_dispatched`). This record is purely for financial/claim tracking. Links to the dispatched order via `orderItemId`. |
| Auth | `INVENTORY_REPORT_LOSS`. |

### 11.7 `POST /api/stock-loss/resolve`

| Field | Value |
|---|---|
| Purpose | Resolve a stock loss record. Two paths: (1) theft/missing: `resolveTheftOrMissingLossSchema` — closes the investigation + either releases quarantine (if recovered) or finalizes the write-off (decrements onHand). (2) transit_loss: `resolveTransitLossSchema` — records the insurance/courier claim outcome. |
| Auth | `INVENTORY_MANAGE_LOSS`. |
| DB Impact | UPDATE `StockLossRecord.{investigationStatus='closed', resolution, resolvedAt, resolvedById, ...}`. UPDATE `InventoryPool` (release quarantine OR decrement on_hand). |

---

## Section 12 — Cycle Count APIs

All routes under `src/app/api/cycle-counts/`. Status flow: `scheduled` → `in_progress` → `pending_review` → `approved` (or `cancelled`).

### 12.1 `GET /api/cycle-counts` & `POST`

| Field | Value |
|---|---|
| Purpose | List cycle counts / create a new count. |
| Auth | `INVENTORY_CYCLE_COUNT` for writes; GET requires auth. |
| Request body (POST) | `createCycleCountSchema` — `{ location_id, count_name, count_type: 'full'|'partial'|'spot'='full', scheduled_at?, notes? }` |
| DB Impact (POST) | INSERT `CycleCount` (status='scheduled'). Auto-populates `CycleCountItem[]` with current `InventoryPool` snapshots as `systemQuantity`. |

### 12.2 `GET /api/cycle-counts/[id]` & `PATCH`

| Field | Value |
|---|---|
| Purpose | GET: full detail with items. PATCH: transitions + submit-counts + approve. The PATCH handler dispatches based on body action: `start_count`, `submit_counts` (records `countedQuantity` per item, computes `discrepancy`), `approve` (finalizes — creates `cycle_count_adjust` `InventoryTransaction`s for discrepancies, creates `StockLossRecord`s for negative discrepancies, marks `adjustmentApproved=true`). |
| Request body (PATCH) | `{ action: 'start_count'|'submit_counts'|'approve', counted_items?: [{ id, counted_quantity, discrepancy_reason?, notes? }] }` |
| DB Impact | UPDATE `CycleCount.{status, startedAt, completedAt, approvedAt, totalDiscrepancies, totalVarianceValue}`. UPDATE `CycleCountItem[]` (countedQuantity, discrepancyValue, adjustmentApproved). INSERT `InventoryTransaction[]` + `StockLossRecord[]` for negative discrepancies (theft/damage suspected). UPDATE `InventoryPool`. |

---

## Section 13 — Supplier Return APIs

All routes under `src/app/api/supplier-returns/`. Status flow: `pending` → `sent_to_supplier` → `refunded`/`replaced`/`credit_note`/`disputed`/`rejected`.

### 13.1 `GET /api/supplier-returns` & `POST`

| Field | Value |
|---|---|
| Purpose | List / create supplier returns. POST creates a `supplier_return` `InventoryTransaction` (decrements onHand — stock leaves the building). |
| Auth | `INVENTORY_MANAGE_SUPPLIER_RETURNS` for writes. |
| Request body (POST) | `createSupplierReturnSchema` — `{ purchase_order_id?, supplier_id, org_variant_id, location_id, quantity, cost_per_unit, reason: 'defective'|'wrong_item'|'quality_issue'|'excess_quantity'|'other', notes? }` |
| DB Impact (POST) | INSERT `SupplierReturn` (status='pending'). INSERT `InventoryTransaction` (`supplier_return`). UPDATE `InventoryPool.onHand`. Supports `Idempotency-Key`. |

### 13.2 `GET/PATCH /api/supplier-returns/[id]`

| Field | Value |
|---|---|
| Purpose | GET: detail. PATCH: resolve the return — set `status` to `refunded`/`replaced`/`credit_note`, populate `resolutionType`, `resolutionAmount`. If `status='rejected'`: auto-creates a `StockLossRecord` with `loss_type='supplier_dispute'` (via the `linkedLossRecord` 1:1 relation — `supplierReturnId` is `@unique` on `StockLossRecord`). |

### 13.3 `POST /api/supplier-returns/[id]/dispute`

| Field | Value |
|---|---|
| Purpose | Mark a supplier return as `disputed` (supplier refused to refund / replace). |

---

## Section 14 — Integration APIs

All routes under `src/app/api/integrations/`. The Universal Integration Framework (migration 004) supports multiple courier providers (PostEx live, Leopard live, TCS framework-ready) + ecommerce providers (Shopify framework-ready, Daraz framework-ready). See `src/lib/integrations/registry.ts` for the adapter factory.

### 14.1 `GET /api/integrations?category=courier|ecommerce`

| Field | Value |
|---|---|
| Purpose | List available providers + the company's connected integrations. |
| Response | `{ providers: [{ providerKey, providerName, category, logoUrl, authType, supportsWebhook, configSchema }], integrations: [{ id, provider, connectionName, isActive, isDefault, connectionStatus, lastSyncAt, lastError, connectedByEmployeeId }] }` |
| Used by | `IntegrationsView`. |

### 14.2 `POST /api/integrations`

| Field | Value |
|---|---|
| Purpose | Connect a new integration. Delegates to `connectIntegration()` — finds-or-reactivates existing integrations, encrypts credentials via `encryptCredentials()` (`src/lib/utils/encryption.ts`). |
| Auth | Modern pattern — `INTEGRATIONS_MANAGE`. |
| Request body | `{ provider_id, connection_name, credentials: Record<string, string> }` |
| DB Impact | INSERT/UPDATE `CompanyIntegration`. INSERT `AuditLog`. |
| Key logic | Supports `Idempotency-Key`. Sets `connectedByEmployeeId` from `ctx.employee.id` (Shopify adapter foundation — the webhook route uses this to build an injected WorkspaceContext). |

### 14.3 `PATCH /api/integrations/[id]/credentials`

| Field | Value |
|---|---|
| Purpose | Update credentials (re-encrypts). |

### 14.4 `POST /api/integrations/[id]/disconnect`

| Field | Value |
|---|---|
| Purpose | Deactivate an integration (`isActive=false`). Does NOT delete the row — preserves audit history. |

### 14.5 `POST /api/integrations/[id]/test`

| Field | Value |
|---|---|
| Purpose | Performs a REAL API connectivity test against the courier's API. Calls the adapter's `pingConnection()` (Leopard: `getAllCities`, PostEx: status API with dummy tracking number). Returns `{ ok, error?, status? }` — NOT a 500 on test failure (the test itself may "fail" if credentials are bad). |
| Auth | Elevated-only (involves API calls with stored credentials). |

### 14.6 `POST /api/integrations/[id]/set-default`

| Field | Value |
|---|---|
| Purpose | Set this integration as the default for its category. Removes `isDefault=true` from any other integration of the same category in the same company. |

### 14.7 `GET/PATCH /api/integrations/[id]/preferences`

| Field | Value |
|---|---|
| Purpose | Leopard-specific integration preferences (e.g. `transactionNote` prefs). Free-form JSON shape, parsed/validated at the boundary by `parseLeopardPreferences()` (`src/lib/integrations/couriers/leopard-preferences.ts`). |

### 14.8 `GET /api/integrations/[id]/pickup-addresses` & `POST`

| Field | Value |
|---|---|
| Purpose | List / add saved pickup/return addresses per company_integration. PostEx's API returns addressType="Pickup/Return Address" (one address serves both). |
| Request body (POST) | `{ label, address, cityName, contactPersonName, phone1, phone2? }` |
| DB Impact | READ/INSERT `CourierPickupAddress`. |
| Used by | `PickupAddressesSection` (`src/components/couriers/pickup-addresses-section.tsx`). |

### 14.9 `PATCH /api/integrations/[id]/pickup-addresses/[addressId]` & `DELETE`

| Field | Value |
|---|---|
| Purpose | PATCH: set as default. DELETE: remove (refuses if any order uses it as a per-order override). |

### 14.10 `POST /api/integrations/[id]/pickup-addresses/sync`

| Field | Value |
|---|---|
| Purpose | Fetch pickup addresses from the courier API and UPSERT them into `CourierPickupAddress`. |

### 14.11 `POST /api/integrations/[id]/pickup-addresses/refresh`

| Field | Value |
|---|---|
| Purpose | Refresh ALL pickup addresses for this integration — re-fetches + updates. |

### 14.12 `POST /api/integrations/[id]/pickup-addresses/import-by-id`

| Field | Value |
|---|---|
| Purpose | Import a specific pickup address by its provider address code (Leopard-specific — supports importing individual addresses vs full sync). |

### 14.13 `GET /api/integrations/logs`

| Field | Value |
|---|---|
| Purpose | Returns `IntegrationActionLog`s for the active company (elevated only). |
| Query params | `provider_key`, `action_type`, `status`, `date_from`, `date_to`. |
| Used by | `IntegrationLogsView`. |

---

## Section 15 — Courier APIs

All routes under `src/app/api/couriers/` + `/api/courier-cancel/` + `/api/courier-status-history/`. The City & Address Book System (migration 007) is the courier-agnostic foundation.

### 15.1 `GET /api/couriers/[providerKey]/cities?q=&live=true&limit=20`

| Field | Value |
|---|---|
| Purpose | Lightweight search endpoint for the `CityAutocomplete` component. Returns cached `CourierOperationalCity` rows for the provider where `cityName` contains `q` (case-insensitive, delivery cities only). When `live=true` AND the cache returns ZERO results: calls `ensureCityCached()` which fetches the full city list live from the courier API, upserts ALL cities into the cache, then re-runs the search. **Special `providerKey='all'`**: searches across ALL providers' cities (union), deduplicated by cityName, with a `providers: string[]` array so the frontend shows courier badges. |
| Auth | Authenticated user. |
| Used by | `CityAutocomplete`. |

### 15.2 `POST /api/couriers/sync-cities`

| Field | Value |
|---|---|
| Purpose | Manually trigger the city sync job (single provider or all). Returns IMMEDIATELY with a "sync started" response — the actual sync runs in the background (fire-and-forget via `src/lib/fire-and-forget.ts`). Prevents gateway timeouts (PostEx's API can take 30-60 seconds). |
| Auth | Elevated-only (involves API calls with stored credentials). |
| Request body | `{ providerKey?: string }` (omit for all providers). |
| DB Impact | INSERT/UPDATE `CourierOperationalCity[]` (per provider). |

### 15.3 `POST /api/couriers/match-city`

| Field | Value |
|---|---|
| Purpose | Fuzzy-match a typed city against the courier's operational cities. Uses `matchCity()` from `src/lib/integrations/city-matcher.ts` (case-insensitive normalization + alias lookup + trigram similarity). Returns the best match + alternatives. |
| Request body | `{ providerKey, typedCity }` |
| Used by | `CityMismatchResolver`. |

### 15.4 `POST /api/couriers/save-city-alias`

| Field | Value |
|---|---|
| Purpose | Save a "city learning" alias — when staff manually confirms a corrected city (e.g. "Karaci" → "Karachi"), the mapping is saved so it auto-resolves next time. `companyId=null` = org-wide; set = company-specific (priority). |
| Request body | `{ providerKey, typedCity, resolvedCityName }` |
| DB Impact | INSERT `CourierCityAlias`. |

### 15.5 `GET /api/couriers/city-shipment-types?providerKey=leopard&cityName=Lahore`

| Field | Value |
|---|---|
| Purpose | Returns the `shipmentTypes` array (e.g. `["overnight","overland"]`) for a specific city from `CourierOperationalCity.shipmentTypes` (Leopard-specific — NULL for providers that don't return this field). |

### 15.6 `POST /api/couriers/postex/poll`

| Field | Value |
|---|---|
| Purpose | Manually trigger the PostEx status polling job (calls `pollPostExOrderStatuses()`). Intended for manual debugging / status refresh. |
| Response | `{ success, processed, dispatched, delivered, returned, failed }` |
| DB Impact | UPDATE `Order`/`ExchangeShipment.{courierSubStatus, status, ...}` per polled entity. INSERT `CourierStatusHistory[]`. INSERT `IntegrationActionLog[]`. |

### 15.7 `POST /api/couriers/postex/load-sheet`

| Field | Value |
|---|---|
| Purpose | Generate a PostEx load sheet for a specific set of tracking numbers. Delegates to `generatePostExLoadSheet()` (`src/lib/actions/postex-status-poll.actions.ts`). |
| Request body | `{ companyIntegrationId, trackingNumbers: string[], pickupAddress?: string }` |

### 15.8 `POST /api/courier-cancel`

| Field | Value |
|---|---|
| Purpose | Cancel a courier booking on both the courier side (calls adapter's `cancelShipment()`) and in FlowOps. Only available while the shipment hasn't been physically picked up — guards `courierSubStatus IN ['slip_generated', 'pickup_requested']`. Blocks when `courierSubStatus` is NULL. |
| Request body | `{ orderId? OR shipmentId? }` |
| DB Impact | UPDATE `Order`/`ExchangeShipment.courierBookingStatus='cancelled'`. INSERT `IntegrationActionLog` (`actionType='cancel_shipment'`). |
| Key logic | Circular-call prevention via `skipCourierCall=true` flag — `cancelCourierBooking` is called both from `/api/courier-cancel` route AND from `cancelOrder()`/`cancelExchangeShipment()` actions; the flag prevents infinite recursion. **Known bug** (ORDERS_AUDIT.md): `cancelCourierBooking` writes `'cancelled'` to `ExchangeShipment.courierBookingStatus` which is NOT in the DB CHECK enum (migration 016 only added it to `Order.courierBookingStatus`) — will throw constraint violation. |

### 15.9 `GET /api/courier-status-history?entityType=order&entityId=...`

| Field | Value |
|---|---|
| Purpose | Returns the courier status history for a specific entity (order or exchange_shipment). |
| DB Impact | READ `CourierStatusHistory`. |
| Key logic | **CRITICAL bug** (ORDERS_AUDIT.md): the route calls `db.courierStatusHistory.findMany(...)` — but `CourierStatusHistory` is a Prisma model added in the schema, BUT the migration 023 created the table via raw SQL without a corresponding Prisma generate. Actually confirmed: `model CourierStatusHistory` IS in `prisma/schema.prisma` — so this works. (Earlier audit findings of "nonexistent Prisma model" were stale.) |
| Used by | `OrderDetailView`, `ExchangeDetailView` (status history tab). |

---

## Section 16 — Webhook APIs

### 16.1 `POST /api/webhooks/[provider_key]/[webhook_endpoint_id]`

| Field | Value |
|---|---|
| Purpose | Generic webhook receiver. URL format: `/api/webhooks/[provider_key]/[webhook_endpoint_id]`. Flow: (1) look up `CompanyIntegration` by `webhookEndpointId` + verify `provider.providerKey` matches — 404 if no match (don't leak endpoint existence); (2) read raw body + signature header; (3) decrypt credentials + get adapter; (4) route by category — courier: parse status webhook → update order; ecommerce: parse order webhook → create order; (5) wrap in `executeLoggedIntegrationAction` (direction='inbound'); (6) always return 200 for processing errors (prevent external retries) — return 404 only for auth/routing failures. |
| Auth | None — webhook is unauthenticated; authenticity verified by adapter's `verifyWebhookSignature()`. |
| Used by | External courier providers (Leopard) push status updates; Shopify pushes order create/cancel webhooks. |
| Key logic | **Leopard**: pushes `{ "data": [{ cn_number, status, ... }, ...] }` — `processLeopardWebhookUpdates()` handles ALL updates in the array, reusing the shared dispatch/RTO functions. **Shopify**: parses order create webhook → calls `createOrderFromShopifyWebhook()` with an injected `WorkspaceContext` built from `CompanyIntegration.connectedByEmployeeId` (the employee who most recently connected OR reconnected the integration). Rejects if `connectedByEmployeeId` is NULL (older integrations connected before this field existed). |

---

## Section 17 — Admin APIs

### 17.1 `GET /api/employees` & `POST`

| Field | Value |
|---|---|
| Purpose | List / invite employees. POST creates an `Invitation` (token-based email invite — works whether user exists or not). |
| Auth | `EMPLOYEES_VIEW` for GET; `EMPLOYEES_INVITE` for POST. |
| Response (GET) | `{ employees: [{ id, employeeCode, department, designation, status, joinedAt, terminatedAt, terminationReason, user: { id, fullName, email, avatarUrl, phone }, role: { id, name, roleTier, isSystemRole, systemRoleKey, ordersDataScope }, directManager: { id, name } | null }] }` |
| Request body (POST) | `inviteEmployeeSchema` — `{ email, role_id, designation?, department?, message? }` |
| DB Impact (POST) | INSERT `Invitation` (status='pending', token via cuid()). INSERT `AuditLog` (`employee.invited`). |
| Used by | `EmployeesView`, `InviteEmployeeView`. |

### 17.2 `GET /api/employees/[id]` & `PATCH`

| Field | Value |
|---|---|
| Purpose | Get / update employee detail. PATCH supports changing role, designation, department, direct manager. |
| Auth | `EMPLOYEES_MANAGE`. |

### 17.3 `POST /api/employees/[id]/terminate`

| Field | Value |
|---|---|
| Purpose | Suspend / terminate / reactivate an employee. Status transitions. |
| Auth | `EMPLOYEES_TERMINATE` for terminate; `EMPLOYEES_MANAGE` for suspend/reactivate. |
| Request body | `{ action: 'suspend'|'terminate'|'reactivate', reason? }` |
| DB Impact | UPDATE `Employee.{status, terminatedAt, terminatedById, terminationReason}`. INSERT `AuditLog`. |
| Key logic | Cannot terminate yourself. Cannot terminate an elevated role employee unless you're also elevated. |

### 17.4 `GET /api/employees/[id]/salary` & `POST`

| Field | Value |
|---|---|
| Purpose | GET: current salary profile + revision history. POST: set new base salary (creates a new `EmployeeSalaryProfile` + appends a `SalaryRevision` row). |
| Auth | Self always allowed; others require `EMPLOYEES_VIEW_SALARY` (GET) or `EMPLOYEES_MANAGE_SALARY` (POST). |
| Response (GET) | `{ profile: { baseSalary, currency, effectiveFrom, status } | null, revisions: [{ id, oldAmount, newAmount, effectiveFrom, changedByName, createdAt }], canEdit: boolean }` |

### 17.5 `GET /api/employees/[id]/commission-rules` & `POST`

| Field | Value |
|---|---|
| Purpose | List / create commission rules. An employee can have multiple active rules. `basisType` ∈ `per_order` | `per_item_sold` | `percentage_of_revenue`. `triggerStatus` matches Order.status or OrderItem.fulfillmentStatus. |
| Auth | Same visibility rules as salary. |
| Request body (POST) | `{ basisType, rateValue, triggerStatus, isActive=true }` |

### 17.6 `GET /api/employees/[id]/commission-preview`

| Field | Value |
|---|---|
| Purpose | Preview the commission earned by this employee for the current month (based on their active rules + their attributed orders). |
| Response | `{ totalCommission, breakdown: [{ rule, earned }] }` |

### 17.7 `GET /api/employees/[id]/performance`

| Field | Value |
|---|---|
| Purpose | Order funnel stats for this employee (count by status: total, dispatched, delivered, rto, cancelled, in_transit). |
| Response | `{ stats: { totalOrders, dispatchedCount, deliveredCount, rtoCount, cancelledCount, inTransitCount } }` |

### 17.8 `GET /api/roles` & `POST`

| Field | Value |
|---|---|
| Purpose | List / create custom (standard) roles. |
| Auth | `SETTINGS_ROLES_MANAGE`. |
| Response (GET) | `{ roles: [{ id, name, description, roleTier, isSystemRole, systemRoleKey, isActive, companyId, permissions: string[], ordersDataScope: 'own'|'all', employeeCount }] }` |
| Request body (POST) | `createRoleSchema` — `{ name, description?, permissions: string[], ordersDataScope?='all' }` |
| DB Impact (POST) | INSERT `Role` + `RolePermission[]`. INSERT `AuditLog` (`role.created`). |

### 17.9 `GET /api/roles/[id]` & `PATCH`

| Field | Value |
|---|---|
| Purpose | Get / update a role. PATCH supports updating name, description, permissions (full replace), ordersDataScope. Cannot modify system roles. |
| Request body (PATCH) | `updateRoleSchema` — `{ name?, description?, permissions?: string[], ordersDataScope? }` |

### 17.10 `GET /api/payroll` & `POST`

| Field | Value |
|---|---|
| Purpose | List / generate payroll runs. Only ONE run per company per month (enforced by unique constraint). A run progresses: `draft` → `finalized` → `paid`. |
| Auth | `PAYROLL_MANAGE` for POST; `PAYROLL_VIEW_ALL` for GET. |
| Request body (POST) | `{ periodMonth: number, periodYear: number }` |
| DB Impact (POST) | INSERT `PayrollRun` + `Payslip[]` (one per active employee — computes `baseSalary` from `EmployeeSalaryProfile` + `commissionEarned` from `CommissionRule[]` + `advanceDeduction` from active `EmployeeAdvance`s). Supports `Idempotency-Key`. |
| Used by | `PayrollView`. |

### 17.11 `GET /api/payroll/[id]` & `PATCH` & `PUT`

| Field | Value |
|---|---|
| Purpose | GET: payroll run detail with payslips. PATCH: `finalize` (locks payslips, sets `finalizedBy`, `finalizedAt`) OR `mark_all_paid` (sets `paymentStatus='paid'`, `paymentDate`, `paymentMethod`, `paymentReference` on all payslips + advances' `remainingBalance` → 0 if fully deducted). PUT: `adjust` (modify `otherAllowances`/`otherDeductions` on a single payslip) OR `mark_paid` (mark individual payslip as paid). |
| Used by | `PayrollRunDetailView`. |

### 17.12 `GET /api/payroll/payslips/own` & `GET /api/payroll/payslips/own/[payslipId]`

| Field | Value |
|---|---|
| Purpose | Self-service payslip access — every employee can view their OWN payslips (no permission needed; identity check only). `[payslipId]` route also generates a PDF buffer for download. |
| Used by | `MyPayslipsTab` (`src/components/employees/my-payslips-tab.tsx`). |

### 17.13 `GET /api/advances` & `POST`

| Field | Value |
|---|---|
| Purpose | List / record salary advances. When `remainingBalance` reaches 0, status flips to `'settled'`. The payroll generator deducts from active advances when computing netPay. |
| Auth | `PAYROLL_MANAGE_ADVANCES`. |
| Request body (POST) | `{ employeeId, amount, reason, dateGiven, repaymentPlan: 'lump_sum'|'installments', installmentAmount?, ... }` |
| DB Impact (POST) | INSERT `EmployeeAdvance`. INSERT `AuditLog`. |

### 17.14 `GET /api/advances/own`

| Field | Value |
|---|---|
| Purpose | Self-service advance access — current employee's active + settled advances. |
| Used by | `AdvancesView` (own tab). |

### 17.15 `GET /api/audit-logs`

| Field | Value |
|---|---|
| Purpose | Paginated, filterable audit log for the active company. |
| Auth | `AUDIT_VIEW` OR elevated. |
| Query params | `action`, `entity_type`, `entity_id`, `user_id`, `date_from`, `date_to`, `limit`, `offset`. |
| Used by | `AuditLogView`. |

### 17.16 `GET /api/dashboard`

| Field | Value |
|---|---|
| Purpose | Dashboard overview for the active company: counts (employees, roles, pending invites, orgs) + recent activity (last 6 audit logs — only if `AUDIT_VIEW`) + 7-day metrics rollup. |
| Auth | Modern pattern. |
| Used by | `DashboardHome`. |

### 17.17 `GET /api/company` & `PATCH`

| Field | Value |
|---|---|
| Purpose | Fetch / update the active company's full profile (legalName, taxId, address, timezone, baseCurrency, etc.). |
| Auth | `SETTINGS_COMPANY_VIEW` for GET; `SETTINGS_COMPANY_EDIT` for PATCH. |
| Used by | `CompanySettingsView`. |

### 17.18 `GET /api/workspaces` & `POST /api/workspace/switch`

| Field | Value |
|---|---|
| Purpose | GET: all workspaces for the current user grouped by organization (SINGLE DB query — replaces the old N+1 pattern). POST: switch the user's active company (2 parallel queries — replaces the old buildSessionPayload which did 7-9). |
| Auth | Authenticated user. |
| POST body | `{ companyId }` |
| DB Impact (POST) | UPDATE `UserSetting.activeCompanyId` + `activeOrgId`. INSERT `AuditLog` (`workspace.switched`). Calls `invalidateWorkspaceCache()` so the next request re-fetches fresh data. |
| Used by | `WorkspaceSwitcher` (`src/components/workspace/workspace-switcher.tsx`). |

### 17.19 `POST /api/organizations/create` & `GET/PATCH /api/organizations/[id]`

| Field | Value |
|---|---|
| Purpose | Create a new organization (owner becomes the creator's `Profile`). PATCH updates name/logo/website (owner only). |
| DB Impact (POST) | INSERT `Organization`. Auto-creates `OrgCategory`, `OrgBrand`, `OrgAttribute` defaults via `seedDefaultAttributes()`. INSERT `AuditLog`. |

### 17.20 `POST /api/companies/create` & `POST /api/companies/[id]/archive`

| Field | Value |
|---|---|
| Purpose | Create / archive a company under an org. |
| DB Impact (POST) | INSERT `Company` + `Role` (owner system role) + `Employee` (linking creator to the new company as owner). Auto-creates `CompanyOrderSetting` default. |

### 17.21 `POST /api/onboarding/create-company` & `GET /api/onboarding/invitations` & `POST /api/onboarding/accept-invite`

| Field | Value |
|---|---|
| Purpose | Onboarding flow: create-company (alt entry point used by the wizard), invitations (fetch pending invitations for the current user's email), accept-invite (accept a token-based invite — creates `Employee` linking the user to the inviting company). |
| Used by | `OnboardingView`, `CreateCompanyView`, `AcceptInviteCard`. |

### 17.22 `GET/PATCH /api/order-settings`

| Field | Value |
|---|---|
| Purpose | Fetch / update the company's order workflow settings (`requireOrderConfirmation`, `requirePackingStep`, `defaultCourier`, `defaultDispatchLocationId`, `courierBookingMode`, `defaultCourierCompanyIntegrationId`, `deductDeliveryChargeFromRefund`, `orderNumberPrefix`). |
| Auth | Elevated-only. |
| Used by | `OrderWorkflowSettingsView`. |

### 17.23 `GET /api/drafts?draftType=product|order&scope=mine|all&mode=count` & `GET /api/drafts?id=draftId` & `DELETE /api/drafts?id=draftId`

| Field | Value |
|---|---|
| Purpose | List / fetch / delete form drafts. `mode=count` returns `{ count }` (used by the sidebar draft badges — refreshes every 60s). |
| Used by | `DraftsView`, `Sidebar` (count badges). |

### 17.24 `GET /api/health`

| Field | Value |
|---|---|
| Purpose | Lightweight health-check endpoint for Docker HEALTHCHECK + orchestration. Does a trivial `SELECT 1` against Prisma to confirm DB connectivity. |
| Response | `{ status: 'ok' }` (200) or 503 if DB unreachable. |

### 17.25 `POST /api/cron/poll-postex` & `POST /api/cron/poll-leopard-safety-net` & `POST /api/cron/sync-cities` & `POST /api/cron/refresh-exchange-rates` & `POST /api/cron/generate-scan-reports`

| Route | Purpose |
|---|---|
| `/api/cron/poll-postex` | Recurring PostEx status polling — intended to run every 30 minutes via external scheduler. Calls `pollPostExOrderStatuses()` — handles `in_transit`/`delivered`/`returned`/`failed` transitions for both orders + exchange shipments. |
| `/api/cron/poll-leopard-safety-net` | Low-frequency safety-net poll for Leopard orders/shipments whose webhooks MAY have been missed. Runs 1-2 times daily (NOT every 30 min like PostEx — Leopard's primary mechanism is push-webhooks). `STALE_THRESHOLD_MS = 1 hour` despite comment saying 12 hours (known smell). |
| `/api/cron/sync-cities` | Recurring city sync job — every 3 hours. Calls `syncAllCourierCities()`. |
| `/api/cron/refresh-exchange-rates` | Fetches current exchange rates for every distinct `baseCurrency` across all companies + stores a daily `ExchangeRateSnapshot`. |
| `/api/cron/generate-scan-reports` | Daily scan report generation (~1am UTC = ~6am PKT). Generates a stored `ScanDailyReport` for "yesterday" for each company. |

---

## Section 18 — Catalog APIs

All routes under `src/app/api/catalog/` + `/api/categories/` + `/api/brands/` + `/api/org/catalog/`. The Product Catalog System (Sprint 3) has org-level shared categories/brands/attributes + company-level pricing.

### 18.1 `GET /api/categories` & `POST`

| Field | Value |
|---|---|
| Purpose | List / create categories for the active org. Hierarchical — `parentId` for tree structure. |
| Auth | Modern pattern — `PRODUCTS_MANAGE_CATALOG` for writes. |

### 18.2 `GET /api/brands` & `POST`

| Field | Value |
|---|---|
| Purpose | List / create brands for the active org. |
| Auth | `PRODUCTS_MANAGE_CATALOG` for writes. |

### 18.3 `GET /api/catalog/categories/[id]` & `PATCH` & `DELETE`

| Field | Value |
|---|---|
| Purpose | CRUD for a single category. `onDelete: SetNull` on `OrgProduct.categoryId` (deleting a category nulls out the product's reference, doesn't delete products). |
| Request body | `categorySchema` — `{ name, slug?, parent_id?, image_url?, display_order?, is_active? }` |

### 18.4 `GET /api/catalog/brands/[id]` & `PATCH` & `DELETE`

| Field | Value |
|---|---|
| Purpose | CRUD for a single brand. |
| Request body | `brandSchema` — `{ name, slug?, logo_url?, is_active? }` |

### 18.5 `GET /api/catalog/attributes` & `POST`

| Field | Value |
|---|---|
| Purpose | List / create attribute definitions (e.g. Size, Color, Piece Type). `attributeType` ∈ `select` | `color`. |
| Auth | `PRODUCTS_MANAGE_CATALOG`. |

### 18.6 `GET /api/catalog/attributes/[id]` & `PATCH` & `DELETE`

| Field | Value |
|---|---|
| Purpose | CRUD for a single attribute. |

### 18.7 `GET /api/catalog/attributes/[id]/values` & `POST`

| Field | Value |
|---|---|
| Purpose | List / create values for an attribute (e.g. S, M, L for Size). `skuCode` (e.g. "M", "XXL", "RED") used to build variant SKUs. `colorHex` only for color type. |
| Request body | `attributeValueSchema` — `{ value, display_value, color_hex?, sku_code?, display_order?, is_active? }` |

### 18.8 `GET/PATCH/DELETE /api/catalog/attribute-values/[id]`

| Field | Value |
|---|---|
| Purpose | CRUD for a single attribute value (independent of attribute route). |

### 18.9 `GET /api/catalog/available-attributes`

| Field | Value |
|---|---|
| Purpose | Get all active attributes for the org, with their values + any `AttributeValueRule`s. Powers the generic `AttributeSelector` in the variant builder. |

### 18.10 `POST /api/catalog/inline-attribute`

| Field | Value |
|---|---|
| Purpose | Inline-create a new attribute + value while creating a product (saves a round-trip to the catalog settings page). Returns the new attribute ID. |
| Request body | `{ name, displayName, attributeType='select', value, displayValue, skuCode? }` |

### 18.11 `POST /api/catalog/inline-value`

| Field | Value |
|---|---|
| Purpose | Inline-create a new value for an existing attribute (saves a round-trip). |
| Request body | `{ attributeId, value, displayValue, skuCode? }` |

### 18.12 `POST /api/catalog/seed-defaults`

| Field | Value |
|---|---|
| Purpose | One-time endpoint to seed default attributes (Size, Color, Piece Type, etc.) for an existing org that was created before seeding was added. Calls `seedDefaultAttributes()` (`src/lib/attribute-seeding.ts`). |

### 18.13 `GET /api/org/catalog`

| Field | Value |
|---|---|
| Purpose | Org catalog overview — for elevated employees. Returns counts + lists of all categories, brands, attributes, products, and selective-access grants across the entire organization. |
| Auth | Elevated-only. |
| Used by | `OrgCatalogView`. |

---

## Quick reference: route count by section

| Section | Routes | Notes |
|---|---|---|
| 1. Auth | 6 | All public |
| 2. Customers | 7 | + backfill-stats |
| 3. Products | 24 | incl. variant override/resync + variant-groups |
| 4. Inventory | 8 + 4 (locations) + 2 (suppliers) | core + locations + suppliers |
| 5. Orders | 26 | largest module — see ORDERS_AUDIT.md |
| 6. Purchase Orders | 5 | inside Section 4 |
| 7. Production Orders | 2 | inside Section 4 |
| 8. Exchanges + Exchange Shipments | 10 + 5 | separate actions module |
| 9. Booking Workbench | 7 | book + book-batch + bookable + activity + load-sheet* (3) |
| 10. Scan | 3 | + 1 cron (generate-scan-reports) |
| 11. Stock Loss | 7 | 4 report types + list/stats/resolve + detail |
| 12. Cycle Counts | 2 | list/[id] with PATCH multi-action |
| 13. Supplier Returns | 3 | list/[id]/dispute |
| 14. Integrations | 12 | core + pickup-addresses (5) + logs + test |
| 15. Couriers | 7 | cities + sync + match + alias + shipment-types + PostEx poll/load-sheet + cancel + status-history |
| 16. Webhooks | 1 | generic receiver |
| 17. Admin | ~28 | employees (7) + roles (2) + payroll (4) + advances (2) + organizations (2) + companies (2) + onboarding (3) + audit-logs (1) + dashboard (1) + health (1) + order-settings (1) + drafts (1) + workspaces (2) + cron (5) |
| 18. Catalog | 13 | categories + brands + attributes + values + inline-create + seed-defaults + org catalog overview |
| **TOTAL** | **~195 route files, ~240+ HTTP handlers** | |

---

## Cross-cutting systems referenced

- **Workspace cache** (`src/lib/workspace-cache.ts`) — 60s in-memory Map cache for `WorkspaceContext`. Invalidated on logout, workspace switch, role permission change. Multi-instance caveat (in-memory, not Redis-backed).
- **Stock-loss unification** (`src/lib/stock-loss.ts`) — `recordStockLoss()` helper + `sourceModule` discriminator + dedup partial unique index `stock_loss_orderitem_dedup_idx`. 8 source modules: `stock_loss`, `rto`, `cycle_count`, `adjust_stock`, `returned_stitched`, `supplier_return`, `exchange`, `return_scan`.
- **Courier adapter pattern** (`src/lib/integrations/registry.ts`) — 3 courier adapters (postex live, leopard live, tcs framework_ready) + 2 ecommerce adapters (shopify framework-ready, daraz framework-ready). `getAdapterStatus()` + `getCourierAdapter()` + `getAdapterCategory()` factory functions.
- **Atomic number generation** (migration 026) — `get_next_sequence_number()` SQL function + `number_sequences` table. Used by PO numbers, order numbers, self-fulfilled references, exchange shipment numbers, draft numbers.
- **Idempotency** (`src/lib/idempotency.ts`) — `withIdempotency()` wrapper. `IdempotencyKey` table guarantees only ONE successful creation per key.
- **Order status state machine** — see `FLOWOPS_BRIEFING.md` §5.2 for the full transition rules. Migration 029 added a DB-level CHECK constraint on `Order.status`.

---

End of INTERNAL_API_GUIDE.md.
