# FlowOps — Database Guide

> **Comprehensive reference for the FlowOps Prisma schema, SQL functions, and migration history.**
>
> **Audience**: developers onboarding to FlowOps, AI assistants generating code that touches the database, and engineers debugging data issues or planning schema changes.
>
> **Companion documents**:
> - `INTERNAL_API_GUIDE.md` — every API route
> - `FRONTEND_GUIDE.md` — frontend architecture
> - `FLOWOPS_BRIEFING.md` — high-level architecture
> - `INVENTORY_AUDIT.md`, `PRODUCTS_AUDIT.md`, `ORDERS_AUDIT.md`, `STOCKLOSS_INVESTIGATION.md` — read-only audit findings
>
> **Last updated**: September 2026 (DOCS-API-DB-FRONTEND task)

---

## Schema at a glance

- **ORM**: Prisma 6 (`@prisma/client` ^6.11.1)
- **Database**: PostgreSQL (production Supabase / sandbox local SQLite fallback)
- **Datasource config** (`prisma/schema.prisma`):
  ```prisma
  datasource db {
    provider  = "postgresql"
    url       = env("DATABASE_URL")
    directUrl = env("DIRECT_URL")
  }
  ```
- **Multi-tenancy model**: app-layer (NOT Postgres RLS). Every query is scoped by `companyId` / `organizationId` via Prisma `where` clauses in `src/lib/workspace.ts`. RLS policies exist as defense-in-depth (Supabase direct-access) but the Prisma app bypasses them.
- **68 Prisma models** (see full list below) + 4 additional SQL-only tables/functions managed via raw SQL migrations (e.g. `number_sequences`, `courier_status_history`).
- **Naming convention**: PascalCase model names → PascalCase table names (e.g. `model Order` → table `"Order"`). camelCase column names everywhere (double-quoted so PostgreSQL preserves casing). Some child tables use lowercase names via `@@map("...")` — those are the migrations-managed tables.
- **Migrations**: 29 raw SQL migrations under `supabase/migrations/`. **CRITICAL**: never run `prisma db push` — it would drop the partial unique indexes, CHECK constraints, GENERATED columns, and RLS policies that Prisma can't represent. Use `prisma generate` only. Schema changes go through new migration files.

### Connection details

| Env var | Purpose | Sandbox default |
|---|---|---|
| `DATABASE_URL` | Pooler connection (PgBouncer) — used by Prisma Client for queries | SQLite `file:./db/custom.db` (reverts on sandbox restart — see `FLOWOPS_BRIEFING.md` §9) |
| `DIRECT_URL` | Direct connection — used by Prisma Migrate + DDL operations | same |

---

## Section 1 — Multi-tenancy (Organization, Company, Employee, Role, RolePermission, Profile, UserSetting, Invitation, AuditLog, MetricEvent)

### 1.1 `Profile` (table: `"Profile"`)

**Purpose**: Extends the auth identity. One row per registered user (across all organizations/companies).

**Key fields**:
- `id: String @id @default(cuid())` — primary key
- `email: String @unique` — login identifier
- `fullName: String`
- `passwordHash: String` — bcrypt hash via `src/lib/auth.ts`
- `avatarUrl: String?`
- `phone: String?`
- `isOnboarded: Boolean @default(false)` — gates the onboarding wizard
- `createdAt`, `updatedAt`

**Relations** (7): `ownedOrgs` (Organization, "OrgOwner"), `createdCompanies` (Company, "CompanyCreator"), `employees` (Employee[]), `settings` (UserSetting, 1:1), `invitationsSent` (Invitation[], "InvitedBy"), `invitationsAccepted` (Invitation[], "AcceptedBy"), `terminationsDone` (Employee[], "TerminatedBy"), `employeeInvitedBy` (Employee[], "EmployeeInvitedBy"), `auditLogs` (AuditLog[]), `rolesCreated` (Role[], "RoleCreator").

**Indexes**: `email` is `@unique` (built-in).

**Business rules**:
- `passwordHash` is set via `hashPassword()` in `src/lib/auth.ts` — never store plaintext.
- `isOnboarded=false` blocks access to the main dashboard (user is routed through the onboarding wizard).

### 1.2 `Organization` (table: `"Organization"`)

**Purpose**: Top-level tenant. A holding umbrella for one or more companies. All business data lives under an Organization.

**Key fields**:
- `id: String @id @default(cuid())`
- `name: String`
- `slug: String @unique` — URL-safe identifier (e.g. `flowops-pk`)
- `logoUrl: String?`
- `ownerId: String` — FK to `Profile.id` (the user who created the org)
- `subscriptionPlan: String @default("free")` — `free` | `starter` | `growth` | `enterprise`
- `subscriptionStatus: String @default("active")` — `active` | `past_due` | `cancelled` | `trialing`
- `isActive: Boolean @default(true)`
- `metadata: String @default("{}")` — JSONB-style blob (used for `description`, `website`)
- `createdAt`, `updatedAt`

**Relations**: `companies` (Company[]), `invitations` (Invitation[]), `auditLogs` (AuditLog[]), and dozens of back-relations to every domain (orgCategories, orgBrands, orgAttributes, orgProducts, inventoryLocations, suppliers, customers, orders, etc.).

**Business rules**:
- Owner is set at creation; ownership is NOT transferred via API (must be a direct DB update).
- `slug` must be unique globally — generated via `uniqueSlug()` (`src/lib/slugify.ts`).

### 1.3 `Company` (table: `"Company"`)

**Purpose**: Legal operating entity under an Organization. ALL business data (orders, products, inventory, etc.) lives at the Company level.

**Key fields**:
- `id: String @id @default(cuid())`
- `organizationId: String` — FK to `Organization.id` (onDelete: Cascade)
- `name: String`
- `legalName: String?`
- `slug: String @unique`
- `logoUrl: String?`
- `baseCurrency: String @default("PKR")` — ISO 4217 code
- `countryCode: String @default("PK")` — ISO 3166-1 alpha-2 code
- `taxId: String?`, `taxIdType: String?` — `NTN` | `STRN`
- `addressStreet, addressCity, addressProvince, addressPostalCode, addressCountry: String?`
- `phone, email, website: String?`
- `timezone: String @default("Asia/Karachi")`
- `fiscalYearStart: Int @default(1)` — month number (1-12)
- `isActive: Boolean @default(true)`
- `metadata: String @default("{}")`
- `createdById: String` — FK to `Profile.id`
- `createdAt`, `updatedAt`

**Relations**: `roles`, `employees`, `invitations`, `rolePermissions`, `auditLogs`, `metricEvents`, `activeForSettings` (UserSetting[]), and back-relations for every business domain (orders, products, inventory, etc.).

**Business rules**:
- A company's `isActive=false` blocks the workspace switcher from selecting it (returns 403 in `/api/workspace/switch`).
- `slug` must be unique globally.

### 1.4 `Role` (table: `"Role"`)

**Purpose**: Company-scoped roles. System roles (`Owner`/`Founder`/`Co-Founder`/`Investor`) are **elevated** and bypass ALL permission checks. Custom roles use `RolePermission` rows.

**Key fields**:
- `id, companyId, name, description?`
- `roleTier: String @default("standard")` — `elevated` | `standard`
- `isSystemRole: Boolean @default(false)` — true for the 4 system roles
- `systemRoleKey: String?` — `owner` | `founder` | `co_founder` | `investor` | null
- `ordersDataScope: String @default("all")` — `all` | `own` (whether the role sees ALL company orders or only their own attributed ones — enforced at query layer)
- `isActive: Boolean @default(true)`
- `createdById: String?`, `createdBy: Profile?`
- `createdAt`, `updatedAt`

**Relations**: `employees` (Employee[]), `rolePermissions` (RolePermission[]), `invitations` (Invitation[]).

**Indexes**: `@@unique([companyId, name])` — role name is unique per company. `@@unique([companyId, systemRoleKey])` — system role keys are unique per company (NOT globally — every company can seed its own owner/founder/etc.).

**Business rules**:
- System roles are auto-seeded when a Company is created (via `seedDefaultRoles()` in `src/lib/seed-default-roles.ts`).
- `roleTier='elevated'` bypasses ALL `requirePermission()` checks (see `src/lib/workspace.ts`).
- `ordersDataScope='own'` enforces `salesEmployeeId === ctx.employee.id` at query time (see `getOrdersDataScope()` in `src/lib/workspace.ts`).

### 1.5 `RolePermission` (table: `"RolePermission"`)

**Purpose**: Permission keys attached to standard roles. Elevated roles bypass this entirely.

**Key fields**:
- `id, roleId, companyId, permissionKey: String, createdAt`

**Relations**: `role` (Role), `company` (Company).

**Indexes**: `@@unique([roleId, permissionKey])` — a role can't have the same permission twice.

**Business rules**: The 30 valid permission keys are defined in `src/lib/permissions.ts` (`PERMISSIONS` constant). Any string can be inserted (no DB-level enum), but the app layer only checks against this list.

### 1.6 `Employee` (table: `"Employee"`)

**Purpose**: Core of the Employment System. Merges HR + system access. One user can have multiple employee records (one per company).

**Key fields**:
- `id, companyId, userId` — FK to `Profile.id`
- `roleId: String` — FK to `Role.id`
- `employeeCode, department, designation: String?`
- `directManagerId: String?` — self-reference (Employee, "EmployeeManager")
- `status: String @default("active")` — `active` | `suspended` | `terminated` | `on_leave`
- `joinedAt: DateTime @default(now())`
- `terminatedAt, terminatedById, terminationReason: ?`
- `terminatedBy: Profile?` (relation "TerminatedBy")
- `invitedById, invitedBy: Profile?` (relation "EmployeeInvitedBy")
- `metadata: String @default("{}")`
- `createdAt, updatedAt`

**Relations** (~30 named relations): `createdCategories`, `createdBrands`, `createdAttributes`, `createdProducts`, `promotedProducts`, `demotedProducts`, `createdVariants`, `uploadedProductImages`, `grantedSelectiveAccess`, `subscribedProducts`, `revokedSubscriptions`, `receivedReturnedItems`, `writtenOffReturnedItems`, `loggedFulfillmentCosts`, `createdLocations`, `createdSuppliers`, `inventoryTxnEmployee`, `transferInitiator`, `poCreator`, `poCanceller`, `poReceiver`, `supplierReturnReporter`, `supplierReturnResolver`, `stockLossReporter`, `stockLossApprover`, `stockLossResolver`, `cycleCountAssignee/Creator/Approver/Counter`, `productionOrderCreator`, `orderSettingsUpdater`, `orderCreator`, `orderConverter`, `flaggedCustomers`, `createdCustomers`, `exchangeRequestsRequested`, `exchangesOldItemVerified`, `exchangesCustomerShippedConfirmed`, `exchangePriceDiffSettled`, `exchangeRefundsProcessed`, `integrationsCreated`, `integrationsConnectedTo`, `formDraftsCreated`, `exchangeShipmentsCreated`, `scanEvents`, `loadSheetsGenerated`, `salesOrders`, `employeeStats` (1:1), `salaryProfile` (1:1), `salaryRevisions`, `salaryRevisionsMade`, `commissionRules`, `payslips`, `advancesReceived`, `advancesCreatedBy`, `payrollRunsFinalized`.

**Indexes**: `@@unique([companyId, userId])` — one user can have only ONE employee record per company. `@@index([companyId, designation])`.

**Business rules**:
- Status transitions: `active → suspended` (manager action), `active → terminated` (requires `EMPLOYEES_TERMINATE` permission + reason), `suspended/terminated → active` (reactivate — requires `EMPLOYEES_MANAGE`).
- An employee's `roleId` can be changed (PATCH `/api/employees/[id]`).
- Cannot terminate yourself; cannot terminate an elevated employee unless you're also elevated.

### 1.7 `UserSetting` (table: `"UserSetting"`)

**Purpose**: Stores active workspace context per user (1:1 with Profile).

**Key fields**:
- `id, userId: String @unique`
- `activeCompanyId: String?` (FK, onDelete: SetNull — if company is deleted, this falls back to null)
- `activeOrgId: String?`
- `theme: String @default("system")` — `light` | `dark` | `system`
- `language: String @default("en")`
- `notificationPrefs: String @default("{}")` — JSONB blob

**Business rules**: Switching active company is done via `/api/workspace/switch` which updates `activeCompanyId` + `activeOrgId` + invalidates the workspace cache.

### 1.8 `Invitation` (table: `"Invitation"`)

**Purpose**: Token-based email invitations. Works whether user exists or not.

**Key fields**: `id, companyId, organizationId, invitedEmail, invitedById, roleId, token: String @unique @default(cuid()), status: String @default("pending")` — `pending` | `accepted` | `expired` | `revoked`, `acceptedById?, acceptedAt?, expiresAt, message?, metadata`.

**Business rules**: Token is a cuid (40-char unguessable string). Status transitions are app-enforced.

### 1.9 `AuditLog` (table: `"AuditLog"`)

**Purpose**: Immutable append-only event log. Foundation for the KPI system.

**Key fields**: `id, companyId?, organizationId?, userId?, employeeId?, action: String, entityType: String, entityId?, ipAddress?, userAgent?, oldValues?, newValues?, metadata: String @default("{}"), createdAt`.

**Indexes**: `@@index([companyId, entityType, createdAt])`, `@@index([companyId, createdAt])`.

**Business rules**: Written via `insertAuditLog()` (`src/lib/audit.ts`) — fire-and-forget (NON-transactional). `entityType` defaults to empty string (known smell from ORDERS_AUDIT.md).

### 1.10 `MetricEvent` (table: `"MetricEvent"`)

**Purpose**: Raw numeric events. Future KPI dashboards aggregate from this table.

**Key fields**: `id, companyId, entityType, entityId, metricKey, numericValue: Float, currency?, dimensions: String @default("{}"), recordedAt, createdAt`.

**Indexes**: `@@index([companyId, entityType, metricKey, recordedAt])`.

**Business rules**: Written via `insertMetricEvent()` (`src/lib/metrics.ts`) — fire-and-forget (NON-transactional).

---

## Section 2 — Products (OrgProduct, OrgProductVariant, OrgProductImage, OrgCategory, OrgBrand, OrgAttribute, OrgAttributeValue, AttributeValueRule, CompanyVariantPricing, CompanyProductSetting, ProductFulfillmentCost, FormDraft)

The Product Catalog System (Sprint 3) uses a two-tier model:
- **Org-level master records** (shared across companies in the org): `OrgProduct`, `OrgProductVariant`, `OrgProductImage`, `OrgCategory`, `OrgBrand`, `OrgAttribute`, `OrgAttributeValue`, `AttributeValueRule`, `OrgProductBundle`, `SelectiveProductAccess`.
- **Company-level pricing/subscription**: `CompanyVariantPricing`, `CompanyProductSetting`, `ProductFulfillmentCost`.
- **Form drafts** (Unsaved Changes Guard): `FormDraft`.

### 2.1 `OrgCategory` (table: `"OrgCategory"`)

**Purpose**: Hierarchical categories at organization level (shared by all companies).

**Key fields**: `id, organizationId, parentId?` (self-reference "CategoryTree", onDelete: SetNull), `name, slug, imageUrl?, displayOrder, isActive, createdById?, createdBy: Employee?`.

**Indexes**: `@@unique([organizationId, slug])`, `@@index([organizationId])`.

### 2.2 `OrgBrand` (table: `"OrgBrand"`)

**Purpose**: Brands at organization level. e.g. LAMHA, Muzammil Collection.

**Key fields**: `id, organizationId, name, slug, logoUrl?, isActive, createdById?, createdBy: Employee?`.

**Indexes**: `@@unique([organizationId, slug])`, `@@index([organizationId])`.

### 2.3 `OrgAttribute` (table: `"OrgAttribute"`)

**Purpose**: Attribute definitions used to build variants. e.g. Size, Color, Piece Type.

**Key fields**: `id, organizationId, name: String` (e.g. "Size"), `displayName: String` (e.g. "Select Size"), `attributeType: String @default("select")` — `select` | `color`, `displayOrder, isActive, createdById?, createdBy: Employee?`.

**Relations**: `values` (OrgAttributeValue[]), `rulesAsForcedAttr` (AttributeValueRule[], "ForcedAttribute").

**Indexes**: `@@unique([organizationId, name])`, `@@index([organizationId])`.

### 2.4 `OrgAttributeValue` (table: `"OrgAttributeValue"`)

**Purpose**: Values for each attribute. e.g. S, M, L / Red, Navy / Unstitched, Stitched.

**Key fields**: `id, attributeId, organizationId, value: String` (e.g. "Medium"), `displayValue: String` (e.g. "M"), `colorHex: String?` (only for color type), `skuCode: String?` (e.g. "M", "XXL", "RED" — used to build variant SKUs), `displayOrder, isActive, createdAt`.

**Relations**: `attribute` (OrgAttribute), `rulesAsTrigger` (AttributeValueRule[], "TriggerValue"), `rulesAsForced` (AttributeValueRule[], "ForcedValue").

**Indexes**: `@@unique([attributeId, value])`, `@@index([organizationId])`.

### 2.5 `AttributeValueRule` (table: `"AttributeValueRule"`)

**Purpose**: Generic conditional rules: "when trigger value is selected, force another attribute to a specific value." e.g. Piece Type = "Unstitched" forces Size = "One Size".

**Key fields**: `id, organizationId, triggerAttributeValueId, forcesAttributeId, forcesValueId, createdAt`.

**Relations**: `triggerAttributeValue` (OrgAttributeValue, "TriggerValue"), `forcesAttribute` (OrgAttribute, "ForcedAttribute"), `forcesValue` (OrgAttributeValue, "ForcedValue").

**Indexes**: `@@unique([triggerAttributeValueId, forcesAttributeId])`, `@@index([organizationId])`.

**Business rules**: Evaluated **bidirectionally** during variant generation (see `POST /api/products/[id]/variants/generate` in API guide):
1. **INCLUSION**: if combo contains the trigger value, the forced attribute MUST equal the forced value.
2. **EXCLUSION**: if combo does NOT contain the trigger value, the forced attribute must NOT equal the forced value (it's reserved for the trigger).

### 2.6 `OrgProduct` (table: `"OrgProduct"`)

**Purpose**: Master product record. Lives at org level. Created by one company, can be promoted to org-wide or selective sharing.

**Key fields**:
- `id, organizationId, sourceCompanyId` — FK to Company (the company that created this product)
- `categoryId?` (OrgCategory, onDelete: SetNull), `brandId?` (OrgBrand, onDelete: SetNull)
- `title, slug, baseSku: String?` (manually entered by user, e.g. "FSES-10A")
- `description?, shortDescription? @db.VarChar(500)`
- `productType: String @default("variable")` — `simple` | `variable` | `bundle` | `service`
- `productScope: String @default("private")` — `private` | `organization` | `selective` | `archived`
- `isStitchable: Boolean @default(false)`, `hasSizeVariants: Boolean @default(false)`, `stitchingBasePrice: Decimal @default(0)`
- `isActive, isFeatured: Boolean`
- `promotedAt?, promotedById?, promotedBy: Employee?` ("ProductPromoter")
- `demotedAt?, demotedById?, demotedBy: Employee?` ("ProductDemoter"), `demotionReason?`
- `createdById, createdBy: Employee` ("ProductCreator")
- `createdAt, updatedAt`

**Relations**: `variants` (OrgProductVariant[]), `images` (OrgProductImage[]), `bundles` (OrgProductBundle[], "BundleProduct"), `selectiveAccess` (SelectiveProductAccess[]), `companySettings` (CompanyProductSetting[]).

**Indexes**: `@@unique([organizationId, slug])`, `@@index([organizationId, productScope])`, `@@index([sourceCompanyId])`.

**Business rules**:
- `productScope` transitions: `private → organization` (promote, elevated-only, requires ≥1 active variant + ≥1 image), `private → selective` (promote, then grant selective access via `SelectiveProductAccess`), `* → archived` (DELETE — elevated-only, never hard-delete), `organization/selective → private` (demote, revokes all non-source-company subscriptions).
- `slug` is auto-generated from title via `uniqueSlug()`, deduplicated by appending `-2`, `-3`, etc.

### 2.7 `OrgProductVariant` (table: `"OrgProductVariant"`)

**Purpose**: Every unique sellable combination of a product. Shopify-compatible fields.

**Key fields**:
- `id, productId, organizationId`
- `sku: String @unique` — org-wide unique
- `barcode: String? @unique`
- `attributeValues: String @default("{}")` — JSONB: `{ "Piece Type": "Stitched", "Size": "M" }`. **Max 3 keys (Shopify limit)**.
- `costPrice: Decimal @default(0)`, `weightGrams: Int @default(0)`
- `fulfillmentType: String @default("stock_based")` — `stock_based` | `made_to_order`
- `stitchingType: String?` — `unstitched` | `stitched_basic` | `stitched_heavy` | `custom_order`
- `stitchingCharges: Decimal @default(0)`, `productionDays: Int @default(0)`
- `isTaxable, requiresShipping: Boolean`
- `inventoryPolicy: String @default("deny")` — `deny` | `continue` (synced with `fulfillmentType` via `syncInventoryPolicy()`)
- `isDefault, isActive: Boolean`
- `shopifyVariantId: String? @unique`, `shopifyInventoryItemId: String?`
- `dimensions: String @default("{}")` — JSONB `{ length_cm, width_cm, height_cm }`
- `trackInventory: Boolean @default(true)` — FALSE for made_to_order until first return; **one-way TRUE → never back to FALSE**
- `fabricSourceVariantId: String?` — self-reference: the stock_based variant fabric is drawn from for made_to_order production
- `costPriceSyncedWithParent: Boolean @default(true)` (Sprint 10 — TRUE = follows parent group cost; FALSE = manually overridden)
- `weightKg: Decimal? @db.Decimal(6,3)` (nullable so existing variants remain NULL until manually set)
- `weightSyncedWithParent: Boolean @default(true)`
- `createdById?, createdBy: Employee?` ("VariantCreator")
- `createdAt, updatedAt`

**Relations** (~15): `product`, `organization`, `fabricSourceVariant` (self, "FabricSource"), `fabricSourceFor` (self, "FabricSource"), `images`, `bundleComponents`, `companyPricing`, `returnedInventory`, `fulfillmentCosts`, `inventoryPools`, `inventoryTransactions`, `avgCostHistory`, `stockTransfers`, `stockLossRecords`, `cycleCountItems`, `productionOrdersStitched` ("StitchedVariantProduction"), `productionOrdersFabric` ("FabricVariantProduction"), `supplierReturns`, `purchaseOrderItems`, `purchaseOrderReceiptItems`, `orderItems`, `exchangesAsNewVariant` ("ExchangeNewVariant"), `exchangeShipmentsAsNewVariant`.

**Indexes**: `@@index([productId])`, `@@index([organizationId, fulfillmentType])`.

**Business rules**:
- `attributeValues` JSONB must never exceed 3 keys (Shopify limit, validated at app layer).
- `fulfillmentType` ↔ `inventoryPolicy` synced via `syncInventoryPolicy()` (`src/lib/constants/fulfillment-types.ts`): `made_to_order` → `continue`, `stock_based` + `allow_backorder=false` → `deny`.
- `stitchingType` forces `fulfillmentType`: `unstitched` → `stock_based`, `stitched_basic`/`stitched_heavy`/`custom_order` → `made_to_order`.
- For made_to_order: `cost_price = fabric_cost + stitching_charges` (computed at variant creation time).
- `trackInventory` is one-way: once TRUE, never back to FALSE.
- Parent-child variant grouping: variants are grouped by the lowest-`display_order` attribute ("parent attribute"). `costPriceSyncedWithParent`, `weightSyncedWithParent`, `salePriceSyncedWithParent` track override state.

### 2.8 `OrgProductImage` (table: `"OrgProductImage"`)

**Purpose**: Images stored in Supabase Storage, shared across all subscribing companies.

**Key fields**: `id, productId, organizationId, variantId?, storagePath, publicUrl, displayOrder, isPrimary, uploadedById?, uploadedBy: Employee? ("ImageUploader"), createdAt`.

**Indexes**: `@@index([productId])`.

**Business rules**: First image auto-set as `isPrimary=true` at upload time. Local filesystem storage in sandbox (`/public/uploads/products/{orgId}/{productId}/`) — **Vercel deployment bomb** (won't persist on serverless).

### 2.9 `OrgProductBundle` (table: `"OrgProductBundle"`)

**Purpose**: For bundle-type products. Defines component variants and quantities.

**Key fields**: `id, bundleProductId, componentVariantId, quantity, organizationId, createdAt`.

**Indexes**: `@@unique([bundleProductId, componentVariantId])`.

### 2.10 `SelectiveProductAccess` (table: `"SelectiveProductAccess"`)

**Purpose**: When `product_scope = 'selective'`, controls which companies can access it.

**Key fields**: `id, orgProductId, companyId, organizationId, grantedById?, grantedBy: Employee? ("SelectiveAccessGranter"), grantedAt`.

**Indexes**: `@@unique([orgProductId, companyId])`.

### 2.11 `CompanyProductSetting` (table: `"CompanyProductSetting"`)

**Purpose**: Per-company pricing and activation for a shared org product.

**Key fields**: `id, companyId, organizationId, orgProductId, isActive, subscriptionStatus: String @default("active")` — `active` | `paused` | `revoked`, `subscribedAt, subscribedById?, subscribedBy: Employee? ("SubscriptionCreator"), revokedAt?, revokedById?, revokedBy: Employee? ("SubscriptionRevoker"), revokeReason?, createdAt, updatedAt`.

**Indexes**: `@@unique([companyId, orgProductId])`, `@@index([companyId])`.

### 2.12 `CompanyVariantPricing` (table: `"CompanyVariantPricing"`)

**Purpose**: Per-variant selling price set independently by each company.

**Key fields**: `id, companyId, orgVariantId, organizationId, salePrice: Decimal @db.Decimal(12, 2), comparePrice: Decimal? @db.Decimal(12, 2), salePriceSyncedWithParent: Boolean @default(true)`, `comparePriceSyncedWithParent: Boolean @default(true)`, `isActive, createdAt, updatedAt`.

**Indexes**: `@@unique([companyId, orgVariantId])`, `@@index([companyId])`.

### 2.13 `ProductFulfillmentCost` (table: `"ProductFulfillmentCost"`)

**Purpose**: Tracks cost components for made_to_order variants in production.

**Key fields**: `id, orgVariantId, companyId, organizationId, employeeId?, orderReference?, fabricCost, stitchingCost, embroideryCost, otherCost, totalProductionCost, salePrice?, status: String @default("in_production")` — `in_production` | `dispatched` | `delivered` | `returned` | `written_off`, `tailorName?, notes?, metadata, dispatchedAt?, deliveredAt?, returnedAt?, createdAt, updatedAt`.

**Indexes**: `@@index([companyId, orgVariantId, status])`, `@@index([orderReference])`.

### 2.14 `FormDraft` (table: `"form_drafts"` via `@@map`)

**Purpose**: Generic form draft storage (Unsaved Changes Guard system). Stores in-progress product/order form data as JSON.

**Key fields**: `id, organizationId, companyId, createdById?, createdBy: Employee? ("FormDraftCreator"), draftType: String` — `product` | `order`, `draftData: String @default("{}")` (JSONB), `draftTitle?, draftNumber: String?` (`DRAFT-00001` format — only for order drafts, null for product drafts), `createdAt, updatedAt`.

**Indexes**: `@@index([companyId, draftType, updatedAt])`, `@@index([createdBy])`.

**Business rules**: `draftNumber` is assigned via the atomic `draft_order_number_seq` SQL function (migration 006) on first save.

### 2.15 `ReturnedStitchedInventory` (table: `"ReturnedStitchedInventory"`)

**Purpose**: Special pool for made-to-order items returned in sellable condition. **This is the ONLY stock a made_to_order variant ever holds**.

**Key fields**: `id, organizationId, companyId, orgVariantId, quantity, condition: String` — `perfect` | `good` | `open_box` | `damaged`, `totalCost: Decimal`, `suggestedResalePrice: Decimal?, originalOrderReference?, returnReason?, status: String @default("available")` — `available` | `sold` | `written_off`, `photos: String @default("[]")`, `notes?, receivedById?, receivedBy: Employee? ("ReturnedItemReceiver"), receivedAt, soldAt?, soldOrderReference?, writtenOffAt?, writtenOffById?, writtenOffBy: Employee? ("ReturnedItemWriteOff"), writeOffReason?, inventoryTxnId?` (FK to InventoryTransaction — links the register to the ledger), `createdAt, updatedAt`.

**Indexes**: `@@index([organizationId, orgVariantId, status])`, `@@index([companyId, status])`.

**Business rules**: When a register row is created, the route also creates an `inventory_transaction` (`return_stitched_received`) and stores its ID in `inventoryTxnId` — keeps the register and pool in sync (migration 027).

### 2.16 `ExchangeRateSnapshot` (table: `"ExchangeRateSnapshot"`)

**Purpose**: Daily snapshot of exchange rates for currency conversion (Phase F1). Fetched by the `/api/cron/refresh-exchange-rates` cron job.

**Key fields**: `id, currency: String` (ISO 4217 code), `rateToBaseCurrency: Decimal @db.Decimal(12, 6)`, `fetchedAt: DateTime @default(now())`.

**Indexes**: `@@index([currency, fetchedAt])`.

**Business rules**: Used ONLY for DISPLAY purposes (estimated revenue totals converted to the company's `baseCurrency`). Never influences stored order prices.

---

## Section 3 — Inventory (InventoryLocation, InventoryPool, InventoryTransaction, AvgCostHistory, StockTransfer, Supplier, ReturnedStitchedInventory [see §2.15], StockLossRecord, CycleCount, CycleCountItem, ProductionOrder)

The Inventory System (Sprint 6) introduced the WAC (Weighted Average Cost) model: every stock movement is recorded as an `InventoryTransaction` (append-only ledger), `InventoryPool` is the single source of truth for current stock levels, `AvgCostHistory` provides a full audit trail of every cost change.

### 3.1 `InventoryLocation` (table: `"InventoryLocation"`)

**Purpose**: Warehouse/dispatch/retail locations. `companyId=null` = org-level shared.

**Key fields**: `id, organizationId, companyId?` (NULL = org-level shared), `name, locationType: String @default("warehouse")` — `warehouse` | `dispatch_hub` | `retail_store` | `transit` | `damaged_hold`, `address?` (JSONB), `city, province, countryCode, postalCode?, contactPerson?, contactPhone?, isDefault, isActive, createdById?, createdBy: Employee? ("LocationCreator"), createdAt, updatedAt`.

**Relations**: `inventoryPools`, `inventoryTransactions`, `avgCostHistory`, `stockTransfersFrom` ("TransferFromLocation"), `stockTransfersTo` ("TransferToLocation"), `purchaseOrders`, `supplierReturns`, `stockLossRecords`, `cycleCounts`, `productionOrders`, `companyOrderSettingsDefault` ("CompanyOrderSettingsDefaultLocation"), `orderDispatchLocations` (Order[], "OrderDispatchLocation"), `orderItemReservedLocations` (OrderItem[], "OrderItemReservedLocation").

**Indexes**: `@@index([organizationId])`, `@@index([companyId])`.

### 3.2 `Supplier` (table: `"Supplier"`)

**Purpose**: Suppliers. `companyId=null` = org-level shared supplier.

**Key fields**: `id, organizationId, companyId?` (NULL = shared across org), `name, contactPerson?, phone?, email?, address?` (JSONB), `paymentTerms: String @default("immediate")` — `immediate` | `net_15` | `net_30` | `net_45` | `net_60`, `creditBalance: Decimal @default(0)` — running credit owed BY supplier TO us, `isActive, createdById?, createdBy: Employee? ("SupplierCreator"), createdAt, updatedAt`.

**Relations**: `purchaseOrders`, `supplierReturns`.

**Indexes**: `@@index([organizationId])`, `@@index([companyId])`.

### 3.3 `InventoryPool` (table: `"InventoryPool"`)

**Purpose**: **THE single source of truth for stock levels**. One row per variant per location.

**Key fields**:
- `id, orgVariantId, locationId, organizationId`
- `onHand: Int @default(0)` — physical stock at the location
- `reserved: Int @default(0)` — stock allocated to confirmed orders (not yet dispatched)
- `available = onHand - reserved` (computed in app layer, NOT a column)
- `incoming: Int @default(0)` — sum of undelivered PO quantities
- `avgCost: Decimal @default(0) @db.Decimal(12, 4)` — Weighted Average Cost (WAC)
- `totalStockValue = onHand * avgCost` (computed in app layer)
- `reorderPoint, reorderQuantity: Int`
- `lastReceivedAt, lastSoldAt, lastCountedAt: DateTime?`
- `updatedAt`

**Indexes**: `@@unique([orgVariantId, locationId])` (one row per variant per location), `@@index([organizationId, orgVariantId])`, `@@index([locationId])`.

**Business rules / invariants**:
- `onHand >= 0` (DB-level: enforced via app validation).
- `reserved >= 0`.
- `reserved <= onHand` (app-enforced — reserving more than on_hand is rejected with 400).
- `avgCost` is updated atomically via `processInventoryTransaction()` (`src/lib/inventory.ts`) — uses `db.$transaction` for the pool update + transaction insert + avg cost history insert.

### 3.4 `InventoryTransaction` (table: `"InventoryTransaction"`)

**Purpose**: **Append-only ledger**. Never update or delete rows.

**Key fields**:
- `id, orgVariantId, locationId, organizationId`
- `companyId?` (NULL for org-level events)
- `employeeId?`
- `transactionType: String` — 16 valid values: `opening_stock | purchase_received | sale_dispatched | order_reserved | order_unreserved | return_resellable | return_damaged | return_stitched_received | transfer_out | transfer_in | cycle_count_adjust | damage_writeoff | theft_writeoff | missing_writeoff | transit_loss | supplier_return | fabric_consumed_for_stitching`
- `quantity: Int` — positive = in, negative = out
- `costPerUnit: Decimal @default(0) @db.Decimal(12, 4)`
- `totalCostValue = ABS(quantity) * costPerUnit` (computed in app)
- `avgCostBefore?, avgCostAfter?` — captured for audit
- `referenceType: String?` — `order | purchase_order | transfer | cycle_count | stock_loss | manual | opening | production_order | supplier_return`
- `referenceId?`
- `orderId?` — FK to Order (OMS linkage)
- `notes?, metadata: String @default("{}")`
- `recordedAt, createdAt`

**Relations**: `orgVariant`, `location`, `organization`, `company?`, `employee?`, `order?`, `avgCostHistory[]`, `purchaseOrderReceiptItems[]`, `supplierReturns[]`, `stockLossRecords[]`, `cycleCountItems[]`, `productionOrdersFabric[]`, `returnedStitchedRecords[]`, `exchangeOldItemTxns[]`.

**Indexes**: `@@index([orgVariantId, recordedAt])`, `@@index([companyId, transactionType, recordedAt])`, `@@index([organizationId, transactionType, recordedAt])`, `@@index([referenceType, referenceId])`.

**Business rules / invariants**:
- Rows are append-only — NO UPDATE / DELETE (audited at app layer; would need DB trigger to enforce).
- `quantity > 0` means stock IN (e.g. `opening_stock`, `purchase_received`, `return_resellable`). `quantity < 0` means stock OUT (e.g. `sale_dispatched`, `damage_writeoff`).
- WAC recalculation: for stock-IN, `newAvgCost = (oldOnHand * oldAvgCost + abs(quantity) * costPerUnit) / (oldOnHand + abs(quantity))`. For stock-OUT, avgCost is unchanged (cost flows out at current WAC).

### 3.5 `AvgCostHistory` (table: `"AvgCostHistory"`)

**Purpose**: Audit trail of every average-cost change.

**Key fields**: `id, orgVariantId, locationId, organizationId, avgCostBefore, avgCostAfter, triggeredByTxnId` (FK to InventoryTransaction), `triggerReason?, createdAt`.

**Indexes**: `@@index([orgVariantId])`.

### 3.6 `StockTransfer` (table: `"StockTransfer"`)

**Purpose**: Stock transfer between locations. Logistics cost tracked separately from WAC.

**Key fields**: `id, organizationId, orgVariantId, fromLocationId, toLocationId, quantity, costPerUnitAtTransfer, logisticsCost: Decimal @default(0)` (separate expense — NEVER merged into WAC), `status: String @default("completed")` — `completed` | `in_transit` | `cancelled`, `notes?, initiatedById?, initiatedBy: Employee? ("TransferInitiator"), createdAt`.

**Indexes**: `@@index([organizationId])`, `@@index([orgVariantId])`.

**Business rules**: CHECK `quantity > 0` (enforced in app, NOT in DB — known smell).

### 3.7 `StockLossRecord` (table: `"stock_loss_records"` via `@@map`)

**Purpose**: Stock loss records — 5 types: `damaged`, `theft`, `missing`, `transit_loss`, `supplier_dispute`.

**Key fields**:
- `id, organizationId, companyId, orgVariantId, locationId`
- `lossType: String` — `damaged | theft | missing | transit_loss | supplier_dispute`
- `subType?: String` — `confirmed | suspected | admin_error | manufacturing`
- `damageType?: String` — `water_moisture | physical_impact | manufacturing_defect | transit_damage | storage_damage | other`
- `quantity, costPerUnit, totalLossValue = quantity * costPerUnit (computed)`
- `investigationStatus: String @default("none")` — `none | open | closed`
- `resolution?: String` — `written_off | recovered | error_corrected | claim_accepted | claim_rejected`
- `responsibleParty?: String` — `warehouse | courier | customer | employee | unknown | supplier`
- `policeReportRef?, insuranceClaimRef?, insuranceRecovered, courierClaimRef?, courierClaimStatus?: String` — `not_filed | filed | accepted | rejected`, `courierRecovered`
- `evidenceUrls: String @default("[]")` (JSON array), `notes?`
- `reportedById, reportedBy: Employee ("StockLossReporter")`, `approvedById?, approvedBy: Employee? ("StockLossApprover")`, `resolvedById?, resolvedBy: Employee? ("StockLossResolver")`
- `inventoryTxnId?` (FK to InventoryTransaction — links the loss to the ledger entry)
- `orderReferenceId: String?` (free-text — comment says "for transit_loss: references the dispatched order (future)" — was intended to be upgraded to a real FK but never was)
- `orderItemId?` (FK to OrderItem — proper OMS linkage; only set by ONE caller)
- `sourceModule: String?` — 8 valid values: `stock_loss | rto | cycle_count | adjust_stock | returned_stitched | supplier_return | exchange | return_scan` (added in migration 027; NULL for legacy rows)
- `cycleCountItemId?` (FK to CycleCountItem)
- `supplierReturnId: String? @unique` — ONLY set when `loss_type='supplier_dispute'`, links to originating rejected return (1:1 relation "SupplierReturnLossLink")
- `createdAt, updatedAt, resolvedAt?`

**Relations**: `exchangeOldItemLosses[]` (OrderExchange[], "ExchangeOldItemLoss").

**Indexes**: `@@index([companyId, lossType, investigationStatus])`, `@@index([companyId, createdAt])`, `@@index([orgVariantId])`. **PLUS** a partial unique index `stock_loss_orderitem_dedup_idx` on `(orderItemId, lossType, sourceModule) WHERE orderItemId IS NOT NULL` (added in migration 027 — prevents double-counting: same order item + same loss type + same source module).

**Business rules / unification**:
- Created via `recordStockLoss()` helper (`src/lib/stock-loss.ts`) which:
  - Accepts `sourceModule` discriminator.
  - Maps `lossType` → inventory transaction type (`damaged` → `damage_writeoff`, `theft` → `theft_writeoff`, `missing` → `missing_writeoff`, `transit_loss` → `transit_loss`, `supplier_dispute` → `supplier_return`).
  - Catches P2002 unique-constraint error from the dedup partial unique index → returns `wasDuplicate=true` (idempotent — doesn't re-write).
  - Rolls back the loss record if the inventory transaction fails.

### 3.8 `CycleCount` (table: `"CycleCount"`)

**Purpose**: Cycle count header.

**Key fields**: `id, organizationId, companyId, locationId, countName, countType: String @default("full")` — `full | partial | spot`, `status: String @default("scheduled")` — `scheduled | in_progress | pending_review | approved | cancelled`, `scheduledAt, startedAt?, completedAt?, approvedAt?, assignedToId?, assignedTo: Employee? ("CycleCountAssignee"), createdById, createdBy: Employee ("CycleCountCreator"), approvedById?, approvedBy: Employee? ("CycleCountApprover"), notes?, totalDiscrepancies: Int @default(0), totalVarianceValue: Decimal @default(0), createdAt, updatedAt`.

**Relations**: `items` (CycleCountItem[]).

**Indexes**: `@@index([companyId, status])`.

### 3.9 `CycleCountItem` (table: `"CycleCountItem"`)

**Purpose**: Individual items in a cycle count.

**Key fields**: `id, cycleCountId, orgVariantId, organizationId, systemQuantity: Int, countedQuantity?: Int?, discrepancyValue: Decimal?, discrepancyReason?: String` — `recording_error | theft_suspected | damage_not_recorded | transfer_not_recorded | unknown | no_discrepancy`, `adjustmentApproved: Boolean @default(false), inventoryTxnId?, inventoryTxn: InventoryTransaction?, countedById?, countedBy: Employee? ("CycleCountCounter"), countedAt?, notes?, createdAt, stockLossRecords[]`.

**Indexes**: `@@index([cycleCountId])`.

**Business rules**:
- `discrepancy = countedQuantity - systemQuantity` (computed in app).
- When the count is approved with a negative discrepancy, an `InventoryTransaction` of type `cycle_count_adjust` is created. If `discrepancyReason='theft_suspected'`, a `StockLossRecord` with `sourceModule='cycle_count'` and `cycleCountItemId=...` is also created (linked via the dedup index).

### 3.10 `ProductionOrder` (table: `"ProductionOrder"`)

**Purpose**: Production order for made-to-order fabric tracking.

**Key fields**: `id, organizationId, companyId, stitchedVariantId, fabricVariantId, fabricLocationId, quantity, status: String @default("pending")` — `pending | fabric_reserved | in_production | completed | dispatched | cancelled`, `stitchingCost, fabricCost, totalCost = stitchingCost + fabricCost (computed), assignedTailor?, estimatedCompletionDate?, actualCompletionDate?, referenceType: String @default("order"), referenceId?, orderItemId? @unique` (FK to OrderItem, "OrderItemProduction" — proper OMS linkage), `fabricTxnId?, fabricTxn: InventoryTransaction?`, `createdById, createdBy: Employee ("ProductionOrderCreator"), createdAt, updatedAt, cancelledAt?, cancellationReason?`.

**Indexes**: `@@index([companyId, status])`, `@@index([stitchedVariantId])`.

**Business rules**:
- Status flow: `pending → fabric_reserved → in_production → completed → dispatched` (or `cancelled`).
- Cancel reverses the fabric consumption (creates a transaction restoring the fabric).
- `orderItemId` is `@unique` — 1:1 with OrderItem.

### 3.11 `PurchaseOrder` (table: `"PurchaseOrder"`)

**Purpose**: Purchase order header.

**Key fields**: `id, organizationId, companyId, supplierId, poNumber: String @unique` (`PO-{year}-{seq}` via atomic counter), `status: String @default("draft")` — `draft | ordered | partially_received | received | cancelled`, `orderDate, expectedDeliveryDate?, deliveryLocationId, advancePayment, paymentMethod?, notes?, createdById, createdBy: Employee ("POCreator"), createdAt, updatedAt, cancelledAt?, cancelledById?, cancelledBy: Employee? ("POCanceller"), cancellationReason?`.

**Relations**: `items` (PurchaseOrderItem[]), `receipts` (PurchaseOrderReceipt[]), `supplierReturns` (SupplierReturn[]).

**Indexes**: `@@index([companyId, status])`, `@@index([organizationId])`.

**Business rules**:
- `poNumber` generated via `get_next_sequence_number()` (migration 026 — atomic).
- Status transitions: `draft → ordered` (confirm — increments `incoming` on InventoryPool per item), `ordered → partially_received` (first receipt), `partially_received → received` (when all items fully received), `* → cancelled` (only from `draft` or `ordered` — cannot cancel after partial receipt).

### 3.12 `PurchaseOrderItem` (table: `"PurchaseOrderItem"`)

**Purpose**: Line items on a purchase order.

**Key fields**: `id, purchaseOrderId, orgVariantId, organizationId, orderedQuantity, receivedQuantity: Int @default(0), costPerUnit: Decimal @db.Decimal(12, 4), createdAt, updatedAt`.

**Relations**: `receiptItems` (PurchaseOrderReceiptItem[]).

**Indexes**: `@@index([purchaseOrderId])`.

**Business rules**: `CHECK orderedQuantity > 0` (enforced in app). `receivedQuantity` starts at 0 and accumulates with each receipt.

### 3.13 `PurchaseOrderReceipt` (table: `"PurchaseOrderReceipt"`)

**Purpose**: Each individual receiving event against a PO (supports partial deliveries).

**Key fields**: `id, purchaseOrderId, organizationId, receivedAt, receivedById, receivedBy: Employee ("POReceiver"), notes?, createdAt`.

**Relations**: `items` (PurchaseOrderReceiptItem[]).

**Indexes**: `@@index([purchaseOrderId])`.

### 3.14 `PurchaseOrderReceiptItem` (table: `"PurchaseOrderReceiptItem"`)

**Purpose**: Line items within one receiving event — actual quantity and cost that arrived.

**Key fields**: `id, purchaseOrderReceiptId, purchaseOrderItemId, orgVariantId, receivedQuantity, actualCostPerUnit: Decimal @db.Decimal(12, 4), shortageQuantity: Int @default(0), shortageReason?, inventoryTxnId?, inventoryTxn: InventoryTransaction?, createdAt`.

**Business rules**: `CHECK receivedQuantity >= 0`. The `inventoryTxnId` provides a 1:1 link to the `InventoryTransaction` that recorded the stock movement — enables tracing any pool change back to the receipt that caused it.

### 3.15 `SupplierReturn` (table: `"SupplierReturn"`)

**Purpose**: Supplier returns — stock sent back to supplier.

**Key fields**: `id, organizationId, companyId, purchaseOrderId?, supplierId, orgVariantId, locationId, quantity, costPerUnit, reason: String` — `defective | wrong_item | quality_issue | excess_quantity | other`, `status: String @default("pending")` — `pending | sent_to_supplier | refunded | replaced | credit_note | disputed | rejected`, `resolutionType?: String` — `refund | replacement | credit_note`, `resolutionAmount?, replacementPoId?, photos: String @default("[]")` (JSON array), `notes?, inventoryTxnId?, inventoryTxn: InventoryTransaction?, linkedLossRecord: StockLossRecord?` (1:1, "SupplierReturnLossLink"), `reportedById, reportedBy: Employee ("SupplierReturnReporter"), resolvedById?, resolvedBy: Employee? ("SupplierReturnResolver"), createdAt, resolvedAt?`.

**Indexes**: `@@index([companyId, status])`, `@@index([supplierId])`.

**Business rules**: When `status` transitions to `'rejected'`, the route auto-creates a `StockLossRecord` with `loss_type='supplier_dispute'` via the `linkedLossRecord` 1:1 relation (`supplierReturnId` is `@unique` on `StockLossRecord`).

---

## Section 4 — Orders (Order, OrderItem, CompanyOrderSetting, LoadSheet, ScanEvent, ScanDailyReport)

The Order Management System (OMS) — Sprint 7+. `Order` has 50+ fields, `OrderItem` tracks per-line fulfillment independently of the variant's `fulfillmentType`.

### 4.1 `Order` (table: `"Order"`)

**Purpose**: The central order record.

**Key fields** (selected — see schema for full list):
- `id, organizationId, companyId`
- `flowopsOrderNumber: String` (ORD-{year}-{seq}, per-company sequence via atomic counter; optional `orderNumberPrefix` inserts between "ORD-" and the year)
- `orderSource: String @default("manual")` — `shopify | manual | daraz | instagram`
- `externalOrderReference?, externalOrderId?`
- `fulfillmentChannel: String @default("courier")` — `courier | self_fulfilled`
- `selfFulfilledReferenceNumber: String? @unique` (SF-YYYY-NNNNN, per-company sequence)
- `marketResolutionIssue: String?` (Phase D3 — external order's delivery country not assigned to any market)
- `customerId` (FK to Customer)
- `recipientName?, usedCustomerAddressId?, usedCustomerPhoneId?` (CRM integration)
- `status: String @default("pending")` — `pending | confirmed | partially_backordered | processing | dispatched | delivered | rto | cancelled | refunded` (CHECK constraint from migration 029)
- `paymentType: String @default("full_cod")` — `full_cod | partial_advance | fully_prepaid`
- `paymentStatus: String @default("cod_pending")` — `cod_pending | advance_paid | fully_prepaid | cod_collected`
- `paymentSource: String @default("cod_native")` — `shopify_gateway | manual_conversion | cod_native`
- `subtotal, discountAmount?, discountReason?, courierCharges?, totalOrderValue: Decimal`
- `estimatedDeliveryCharge?, actualDeliveryCharge?, taxAmount?, taxLabel?` (migration 012)
- `advanceAmount?, advancePaymentMethod?, advancePaymentReference?, advancePaymentScreenshotUrl?, advancePaidAt?`
- `remainingCodAmount: Decimal?` (GENERATED column: `totalOrderValue - advanceAmount`)
- `codCollected: Boolean @default(false), codCollectedAmount?, codCollectedAt?`
- `convertedById?, convertedBy: Employee? ("OrderConverter"), convertedAt?`
- `deliveryAddress?, deliveryCity?, deliveryCountry: String? @default("PK")`
- `courierName?, trackingNumber?`
- `courierCompanyIntegrationId?` (FK to CompanyIntegration, "OrderCourierIntegration")
- `courierBookingStatus: String @default("not_booked")` — `not_booked | booked | failed | cancelled` (CHECK — migration 016 added `cancelled`)
- `courierBookingFailureReason?, pickupAddressId?` (FK to CourierPickupAddress, "OrderPickupAddress")
- `recommendedCourierCompanyIntegrationId?` (FK to CompanyIntegration, "OrderRecommendedCourier")
- `courierCityStatus: String @default("not_applicable")` — `matched | unresolved | not_applicable`
- `lastPolledAt?, courierSubStatus?` (PostEx sub-status)
- `needsShipperAdvice: Boolean @default(false), unrecognizedCourierStatus: Boolean @default(false)`
- `dispatchLocationId?` (FK to InventoryLocation, "OrderDispatchLocation")
- `notesForCourier?`
- `orderRefNumber?, orderDetail?` (migration 015 — universal courier reference fields)
- `skippedConfirmation, skippedPacking: Boolean`
- `confirmedAt?, packedAt?, dispatchedAt?, deliveredAt?, cancelledAt?, cancellationReason?, returnedAt?`
- `createdById?, createdBy: Employee? ("OrderCreator"), salesEmployeeId?` (FK to Employee, "OrderSalesEmployee" — sales attribution, distinct from createdBy)
- `createdAt, updatedAt`
- `warehouseHandoverScannedAt?, physicalUnpackRequired: Boolean @default(false), physicalUnpackConfirmedAt?` (Scan module fields)
- `loadSheetId?` (FK to LoadSheet, "OrderLoadSheet" — migration 020)
- `courierSlipStoragePath?` (migration 021 — local stored copy of courier slip PDF)
- `proofOfDeliveryData?` (JSONB — migration 023 — signatureUrl, photoUrl, recipientName, etc., downloaded copies)

**Relations**: `items` (OrderItem[]), `inventoryTransactions` (InventoryTransaction[]), `customer`, `exchangesAsOriginalOrder` (OrderExchange[]), `exchangesAsNewOrder` (OrderExchange[]), `courierStatusHistory[]`.

**Indexes**: `@@unique([companyId, flowopsOrderNumber])`, `@@index([companyId, status])`, `@@index([companyId, createdAt])`, `@@index([externalOrderId])`, `@@index([customerId])`, `@@index([usedCustomerAddressId])`, `@@index([usedCustomerPhoneId])`, `@@index([courierCompanyIntegrationId])`, `@@index([salesEmployeeId])`.

**Check constraints**:
- `order_status_check` (migration 029): `status IN ('pending','confirmed','partially_backordered','processing','dispatched','delivered','rto','cancelled','refunded')`.
- `Order_courierBookingStatus_check` (migration 013 + 016): `courierBookingStatus IN ('not_booked','booked','failed','cancelled')`.
- `Order_courierCityStatus_check` (migration 013): `courierCityStatus IN ('matched','unresolved','not_applicable')`.

**Business rules / state machine**:
- `pending → confirmed` (manual confirm OR auto-confirm via payment conversion OR auto-confirm if `CompanyOrderSetting.requireOrderConfirmation=false`).
- `pending/confirmed → partially_backordered` (when confirmOrder finds insufficient stock for some items).
- `confirmed → processing` (manual mark_processing).
- `confirmed/processing → dispatched` (manual dispatch — blocks if any items still backordered).
- `dispatched → delivered` (PostEx poll / Leopard webhook / manual).
- `dispatched → rto` (returned to origin — restocks items).
- `* → cancelled` (releases reserved stock; sets `physicalUnpackRequired=true` if cancelled from processing/dispatched).
- `cancelled → confirmed/pending` (un-cancel — re-reserves stock; does NOT re-book courier).
- `delivered → refunded` (refund issued — separate state from cancelled).

### 4.2 `OrderItem` (table: `"OrderItem"`)

**Purpose**: Per-line-item fulfillment tracking. `fulfillmentStatus` is INDEPENDENT of the variant's `fulfillmentType` — a stock_based item can be `backordered` while a made_to_order item can be `reserved` or `dispatched`.

**Key fields**:
- `id, orderId, orgVariantId, organizationId`
- `quantity: Int`
- `unitPrice: Decimal @db.Decimal(12, 2)` — final charged price per unit (after per-item discount if any)
- `originalUnitPrice: Decimal?` — system-resolved original price from MarketVariantPricing; NEVER client-writable
- `discountType: String?` — `percentage | fixed`
- `discountValue: Decimal?` — percentage (0-100) or fixed amount
- `lineTotal: Decimal @db.Decimal(14, 2)` — GENERATED ALWAYS AS `(quantity * unitPrice) STORED` in DB
- `fulfillmentStatus: String @default("reserved")` — `reserved | backordered | dispatched`
- `fulfillmentTypeSnapshot: String` — `stock_based | made_to_order` (snapshot at order time)
- `backorderedAt?, fulfilledAt?`
- `productionOrderId?` (FK to ProductionOrder, "OrderItemProduction" — 1:1)
- `returnedStitchedUsed: Boolean @default(false)` — true if a returned-stitched register row was used to fulfill this item
- `autoProcessedAsPerfect: Boolean @default(false)` — set when RTO auto-processes assuming perfect condition
- `needsReview: Boolean @default(false)` — true when auto-processed (must be spot-checked by staff)
- `needsReviewReason?: String` — Phase D3 reason (e.g. "Not enabled for the UAE market")
- `reservedLocationId?` (FK to InventoryLocation, "OrderItemReservedLocation")
- `createdAt, updatedAt`

**Relations**: `order`, `orgVariant`, `productionOrder`, `reservedLocation`, `stockLossRecords[]`, `exchangesAsOriginalItem[]` (OrderExchange[]), `exchangesAsNewItem[]` (OrderExchange[]).

**Indexes**: `@@index([orderId])`, `@@index([orgVariantId, fulfillmentStatus])`.

**Business rules**:
- `unitPrice = originalUnitPrice - discount (clamped at 0 minimum)`.
- `lineTotal` is a GENERATED column — NEVER insert directly.
- `fulfillmentStatus` transitions: `reserved → backordered` (when confirm finds insufficient stock), `reserved → dispatched` (when order is dispatched), `backordered → reserved` (when stock becomes available via backorder fulfillment).

### 4.3 `CompanyOrderSetting` (table: `"CompanyOrderSetting"`)

**Purpose**: Per-company configurable order workflow strictness.

**Key fields**:
- `id, companyId: String @unique` (1:1 with Company)
- `requireOrderConfirmation: Boolean @default(false)`
- `requirePackingStep: Boolean @default(false)`
- `defaultCourier: String?`
- `defaultDispatchLocationId?` (FK to InventoryLocation, "CompanyOrderSettingsDefaultLocation")
- `courierBookingMode: String @default("semi_manual")` — `automatic | semi_manual`
- `defaultCourierCompanyIntegrationId?` (FK to CompanyIntegration, "CompanyOrderSettingsDefaultCourier", onDelete: SetNull)
- `deductDeliveryChargeFromRefund: Boolean @default(false)` (migration 014)
- `orderNumberPrefix: String?` — optional prefix for FlowOps order numbers (ORD-{prefix}-YYYY-NNNNN) — guarantees uniqueness across companies sharing the same courier account
- `updatedBy?, updatedByEmployee: Employee? ("CompanyOrderSettingsUpdater"), updatedAt`

**Indexes**: `@@index([companyId])`.

**Business rules**: A default row is auto-created on Company creation. When `requireOrderConfirmation=false`, orders can jump straight to `dispatched` and the DB trigger auto-backfills the skipped timestamps.

### 4.4 `LoadSheet` (table: `"load_sheets"` via `@@map`)

**Purpose**: A generated load sheet (pickup manifest) from any courier provider. Combines orders AND exchange shipments (a courier rider picks up both types in one trip). The PDF is stored in OUR file storage (not an external courier URL — same principle as Proof of Delivery). **Immutable once generated** (no UPDATE/DELETE exposed).

**Key fields**: `id, organizationId, companyId, providerKey, companyIntegrationId, pickupAddressId?, items: String @default("[]")` (JSONB array of `{ entityType, entityId, trackingNumber }`), `pdfStoragePath?, generatedBy?, generatedBy: Employee? ("LoadSheetGenerator"), generatedAt, createdAt, orders[]` (back-relations), `exchangeShipments[]`.

**Indexes**: `@@index([companyId, generatedAt])`, `@@index([companyIntegrationId])`, `@@index([providerKey])`.

### 4.5 `ScanEvent` (table: `"scan_events"` via `@@map`)

**Purpose**: Immutable scan-event ledger. Every barcode scan (success, rejection, or not-found) is recorded here for audit and reporting. No UPDATE/DELETE.

**Key fields**: `id, organizationId, companyId, scanMode: String` (`mark_processing | mark_packed | warehouse_handover | receive_return | locate_cancelled | cancel_via_scan`), `entityType: String` (`order | exchange_shipment | null`), `entityId?: String` (null if scanned barcode matched nothing), `trackingNumberScanned: String` (raw scanned value, always recorded), `scanResult: String` (`success | rejected | not_found`), `rejectionReason?: String`, `scannedById?, scannedBy: Employee? ("ScanEventScannedBy"), scanStationLabel?: String` (free-text), `createdAt`.

**Indexes**: `@@index([companyId, createdAt])`, `@@index([companyId, scanMode])`, `@@index([entityType, entityId])`, `@@index([scannedBy])`.

### 4.6 `ScanDailyReport` (table: `"scan_daily_reports"` via `@@map`)

**Purpose**: Daily aggregated scan report. One row per company per calendar day. Generated by the cron job shortly after midnight. Upsert-safe on `(companyId, reportDate)` so accidental double-runs don't create duplicates.

**Key fields**: `id, organizationId, companyId, reportDate: DateTime, totalScans, totalProcessingMarked, totalPacked, totalWarehouseHandover, totalReturnsReceived, totalCancellationsViaScan, totalRejectedScans: Int @default(0), breakdownByEmployee: String @default("[]")` (JSONB array), `generatedAt, pdfStoragePath?: String`.

**Indexes**: `@@unique([companyId, reportDate])`, `@@index([companyId, reportDate])`.

---

## Section 5 — Purchase Orders (PurchaseOrder, PurchaseOrderItem, PurchaseOrderReceipt, PurchaseOrderReceiptItem)

Covered in §3.11–3.14 above. The PO subsystem has CRUD + cancel + confirm + receive. PO numbers (`PO-{year}-{seq}`) use the atomic `get_next_sequence_number()` (migration 026 — the original `count+1` race condition was fixed).

---

## Section 6 — Production Orders (ProductionOrder)

Covered in §3.10 above. The Production Order subsystem tracks made-to-order fabric consumption. Cancel reverses the fabric consumption. Links to `OrderItem` via `orderItemId` (1:1 unique).

---

## Section 7 — Exchanges (OrderExchange, ExchangeShipment)

The Item Exchange System (migration 003 + 008 + 019) supports two distinct exchange methods.

### 7.1 `OrderExchange` (table: `"order_exchanges"` via `@@map`)

**Purpose**: Tracks a single item exchange request. An exchange can only be created against an order_item belonging to a DELIVERED order.

**Key fields** (selected):
- `id, organizationId, companyId`
- `originalOrderId` (FK to Order, "ExchangeOriginalOrder")
- `originalOrderItemId` (FK to OrderItem, "ExchangeOriginalOrderItem")
- `newOrgVariantId` (FK to OrgProductVariant, "ExchangeNewVariant")
- `newOrderId?` (FK to Order, "ExchangeNewOrder" — populated only once the linked exchange order is created; for `customer_self_return`, this happens LATE)
- `newOrderItemId?` (FK to OrderItem, "ExchangeNewOrderItem")
- `exchangeShipments` (ExchangeShipment[], "ExchangeNewShipment" — 1:N; an exchange can have multiple shipments over its lifecycle if the first is cancelled)
- `exchangeMethod: String` — `courier_replacement | customer_self_return` (CHECK in SQL)
- `status: String @default("requested")` — 10 states (CHECK in SQL): `requested | replacement_dispatched | old_item_collected | completed | customer_shipped | old_item_verified | replacement_dispatched | exchange_item_returned | cancelled` (migration 019 added `exchange_item_returned`)
- `oldItemCondition?: String` — `perfect | good | open_box | damaged` (CHECK in SQL)
- `oldItemVerifiedAt?, oldItemVerifiedById?, oldItemVerifiedByEmployee: Employee? ("ExchangeOldItemVerifier"), oldItemEvidenceUrls: String @default("[]"), oldItemNotes?`
- `oldItemInventoryTxnId?` (FK to InventoryTransaction, "ExchangeOldItemTxn")
- `oldItemStockLossId?` (FK to StockLossRecord, "ExchangeOldItemLoss")
- `customerReturnTrackingNumber?, customerReturnCourier?`
- `customerConfirmedShippedAt?, customerConfirmedShippedById?, customerConfirmedShippedByEmployee: Employee? ("ExchangeCustomerShippedConfirmer")`
- `oldItemPrice, newItemPrice: Decimal`
- `priceDifference: Decimal` (GENERATED ALWAYS AS `(new-old) STORED` in DB — managed via raw SQL, not Prisma)
- `priceDifferenceStatus: String @default("unsettled")` — `unsettled | customer_owes | refund_due | settled` (CHECK in SQL)
- `priceDifferenceSettledAmount?, priceDifferenceSettledAt?, priceDifferenceSettledById?, priceDifferenceSettledByEmployee: Employee? ("ExchangePriceDiffSettler")`
- `refundMethod?: String` — `cash | bank_transfer | store_credit | other` (CHECK — migration 014)
- `refundReference?, refundProcessedAt?, refundProcessedById?, refundProcessedByEmployee: Employee? ("ExchangeRefundProcessor"), refundAmount?`
- `markedAsNotReturned: Boolean @default(false), notReturnedReason?, notReturnedRecoveryStatus?: String` — `pending | recovered | written_off` (CHECK — migration 014), `notReturnedRecoveryAmount?`
- `reason, requestedById, requestedBy: Employee ("ExchangeRequester"), requestedAt, completedAt?, cancelledAt?, cancellationReason?, updatedAt`

**Indexes**: `@@index([companyId, status])`, `@@index([originalOrderId])`, `@@index([originalOrderItemId])`, `@@index([exchangeMethod, status])`, `@@index([requestedBy])`.

**Business rules / state machine**:
- **`courier_replacement` flow**: `requested → replacement_dispatched → old_item_collected → completed` (new item dispatched first; courier collects old).
- **`customer_self_return` flow**: `requested → customer_shipped → old_item_verified → replacement_dispatched → completed` (old item ships back first, gets verified, then new item dispatches).
- Terminal "customer did not return" outcome: `markedAsNotReturned=true`, value becomes a recoverable amount (`notReturnedRecoveryStatus`). The customer is flagged via `flagCustomer()` with reason "Exchange item not returned".
- `priceDifference` is GENERATED in DB as `new-old`: positive = customer owes; negative = refund due.
- **Managed jointly by Prisma (ORM access) + raw SQL (migration 003)** — `prisma db push` would drop the GENERATED column, CHECK constraints, and RLS policies. Use `prisma generate` only.

### 7.2 `ExchangeShipment` (table: `"exchange_shipments"` via `@@map`)

**Purpose**: Each row is one shipment of a new variant to a customer as part of an item exchange. Has its own `EXCH-{YYYY}-{NNNNN}` numbering, completely independent from `ORD-{YYYY}-{NNNNN}`. Never appears in Order list views, never affects `updateCustomerStats()`, never counts toward revenue metrics.

**Key fields** (selected — see schema for full list):
- `id, exchangeShipmentNumber: String @unique` (`EXCH-{year}-{seq}`)
- `organizationId, companyId`
- `orderExchangeId` (FK to OrderExchange, "ExchangeNewShipment", onDelete: Cascade)
- `newOrgVariantId, quantity: Int @default(1), fulfillmentTypeSnapshot: String @default("stock_based")`
- `customerId` (always existing — `createCustomer()` is NEVER called here)
- `shippingAddressId?` (FK to CustomerAddress, "ExchangeShipmentShippingAddress" — CRM FK, NOT snapshot)
- `shippingPhoneId?` (FK to CustomerPhone, "ExchangeShipmentShippingPhone")
- `shippingCityOverride?: String`
- `status: String @default("confirmed")` — 7 states (CHECK in SQL): `pending | confirmed | backordered | dispatched | delivered | rto | cancelled` (migration 019 added `rto`)
- `isPriorityBackorder: Boolean @default(true)`, `backorderedAt?`
- `invoiceAmount, estimatedDeliveryCharge?, actualDeliveryCharge?, taxAmount?, taxLabel?`
- `courierCompanyIntegrationId?, courierBookingStatus, recommendedCourierCompanyIntegrationId?, trackingNumber?, courierSubStatus?, needsShipperAdvice, unrecognizedCourierStatus, courierCityStatus, lastPolledAt?`
- `orderRefNumber?, orderDetail?` (migration 015)
- `confirmedAt?, dispatchedAt?, deliveredAt?, returnedAt?` (set when status='rto' — migration 019), `cancelledAt?`
- `createdById?, createdByEmployee: Employee? ("ExchangeShipmentCreator"), createdAt, updatedAt`
- `warehouseHandoverScannedAt?, physicalUnpackRequired, physicalUnpackConfirmedAt?`
- `loadSheetId?` (FK to LoadSheet, "ExchangeShipmentLoadSheet")
- `courierSlipStoragePath?`

**Indexes**: `@@index([companyId, status])`, `@@index([orderExchangeId])`, `@@index([newOrgVariantId])`.

**Business rules**:
- RTO means the replacement item itself was returned by the courier. Triggers `markExchangeShipmentRto()` which restores inventory + sets the parent `order_exchanges.status='exchange_item_returned'` (terminal, manual follow-up).
- `isPriorityBackorder=true` — exchange shipments take priority over regular orders in the backorder fulfillment queue (see `src/lib/actions/backorder.actions.ts`).

---

## Section 8 — Integrations (IntegrationProvider, CompanyIntegration, CourierPickupAddress, CourierOperationalCity, CourierCityAlias, IntegrationActionLog, CourierStatusHistory)

The Universal Integration Framework (migration 004) supports multiple courier providers (PostEx live, Leopard live, TCS framework-ready) + ecommerce providers (Shopify framework-ready, Daraz framework-ready).

### 8.1 `IntegrationProvider` (table: `"integration_providers"` via `@@map`)

**Purpose**: Master catalog of integration providers (TCS, Leopard, PostEx, Shopify, Daraz). Platform-level, seeded/maintained — not company-specific.

**Key fields**: `id, providerKey: String @unique` (e.g. `postex`, `leopard`, `tcs`, `shopify`, `daraz`), `providerName, category: String` — `courier | ecommerce | ads | payment` (CHECK in SQL), `logoUrl?, authType: String` — `api_key | oauth2 | basic_auth` (CHECK), `supportsWebhook: Boolean @default(false), configSchema: String @default("[]")` (JSONB array of credential field defs), `capabilities: String @default("[]")` (JSONB array of supported actions), `isActive, createdAt, updatedAt`.

**Relations**: `companyIntegrations` (CompanyIntegration[]).

**Business rules**: Managed jointly by Prisma (ORM access) + raw SQL (migration 004) — `prisma db push` would drop the CHECK constraints, seed data, and RLS policies. Use `prisma generate` only.

### 8.2 `CompanyIntegration` (table: `"company_integrations"` via `@@map`)

**Purpose**: A company's actual connection to a provider — encrypted credentials, connection status, webhook routing. A company can connect multiple providers in the same category (e.g. TCS + Leopard). One `isDefault=true` per category (enforced via app logic).

**Key fields**: `id, companyId, organizationId, providerId, connectionName, credentialsEncrypted?: String` (TEXT — encrypted via `encryptCredentials()` in `src/lib/utils/encryption.ts`), `webhookEndpointId?: String @unique, webhookSecret?, isActive, isDefault, connectionStatus: String @default("pending")` — `pending | connected | error | expired` (CHECK), `lastSyncAt?, lastError?, preferencesJson?: String` (Leopard-specific — free-form JSON parsed by `parseLeopardPreferences()`), `createdBy?, createdByEmployee: Employee? ("IntegrationCreator", onDelete: SetNull), connectedByEmployeeId?: String` (Shopify Adapter Foundation — the employee who most recently connected OR reconnected; used by the webhook route to build an injected WorkspaceContext), `createdAt, updatedAt`.

**Relations**: `provider`, `actionLogs` (IntegrationActionLog[]), `ordersBooked` (Order[], "OrderCourierIntegration"), `ordersRecommended` (Order[], "OrderRecommendedCourier"), `companyOrderSettingsDefault` (CompanyOrderSetting[], "CompanyOrderSettingsDefaultCourier"), `pickupAddresses` (CourierPickupAddress[]), `exchangeShipmentsBooked` (ExchangeShipment[]), `exchangeShipmentsRecommended` (ExchangeShipment[]), `loadSheets` (LoadSheet[]).

**Indexes**: `@@unique([companyId, providerId])`, `@@index([companyId, isActive])`.

**Business rules**:
- `webhookEndpointId` is `@unique` — used as the URL slug for incoming webhooks (`/api/webhooks/[provider_key]/[webhook_endpoint_id]`).
- `connectedByEmployeeId` is nullable so older integrations connected before this field existed remain valid. The webhook route rejects webhooks for integrations where this is NULL and instructs the seller to reconnect.

### 8.3 `IntegrationActionLog` (table: `"integration_action_logs"` via `@@map`)

**Purpose**: Universal logging for every integration call — the single source of truth for debugging "why did this courier booking fail" or "did this Shopify webhook get processed." **Immutable: no UPDATE or DELETE**.

**Key fields**: `id, companyIntegrationId, organizationId, actionType: String` (`book_shipment | track_shipment | receive_order | receive_status_webhook | cancel_shipment | ...`), `direction: String` — `outbound | inbound` (CHECK), `requestPayload?: String` (JSONB), `responsePayload?: String` (JSONB), `status: String` — `success | failed` (CHECK), `errorMessage?, relatedEntityType?: String` — `order | product | exchange_shipment | null` (CHECK — migration 018 added `exchange_shipment`), `relatedEntityId?: String, durationMs?: Int, createdAt`.

**Indexes**: `@@index([companyIntegrationId, createdAt])`, `@@index([relatedEntityType, relatedEntityId])`, `@@index([status, createdAt])`.

### 8.4 `CourierOperationalCity` (table: `"courier_operational_cities"` via `@@map`)

**Purpose**: Global, provider-level cache of which cities each courier serves. NOT company-scoped — cities don't vary per company. Synced via `syncCourierOperationalCities()` from the adapter's `fetchOperationalCities()`.

**Key fields**: `id, providerKey: String` (matches `integration_providers.providerKey`), `cityName: String, cityId?: String` (courier's own city ID — TEXT), `isPickupCity, isDeliveryCity: Boolean @default(true)`, `shipmentTypes?: String` (Leopard-specific — JSON array of allowed shipment types per city, e.g. `["overnight","overland"]` — added in migration 021), `lastSyncedAt, createdAt, updatedAt`.

**Indexes**: `@@unique([providerKey, cityName])`, `@@index([providerKey])`.

### 8.5 `CourierCityAlias` (table: `"courier_city_aliases"` via `@@map`)

**Purpose**: "City learning" fuzzy-match memory. When a staff member manually confirms a suggested/corrected city (e.g. "Karaci" → "Karachi"), the mapping is saved here so it auto-resolves next time. `companyId` is nullable: NULL = org-wide, set = company-specific (priority).

**Key fields**: `id, providerKey, typedCityText` (lowercased/normalized), `resolvedCityName, companyId?: String?` (FK to Company, onDelete: Cascade), `company?: Company?, createdAt`.

**Indexes**: `@@unique([providerKey, typedCityText, companyId])`, `@@index([providerKey, typedCityText])`.

### 8.6 `CourierPickupAddress` (table: `"courier_pickup_addresses"` via `@@map`)

**Purpose**: Pickup/return address book per `company_integration`. PostEx's API returns `addressType="Pickup/Return Address"` (one address serves both), so we do NOT build separate pickup vs return concepts. Only one row per `companyIntegrationId` may have `isDefault=true` (enforced in app logic).

**Key fields**: `id, companyIntegrationId, providerAddressCode: String` (courier's own address code — TEXT always), `label, address, cityName, contactPersonName, phone1, phone2?, isDefault, returnAddressOverride?: String` (Leopard-specific — JSONB `{address, cityName, contactPersonName, phone}` — added in migration 022), `createdAt, updatedAt`.

**Relations**: `ordersUsedIn` (Order[], "OrderPickupAddress"), `loadSheets` (LoadSheet[]).

**Indexes**: `@@index([companyIntegrationId])`.

### 8.7 `CourierStatusHistory` (table: `"courier_status_history"` via `@@map`)

**Purpose**: Append-only audit trail of every courier status update processed (both PostEx polling + Leopard webhook/polling). Created by migration 023.

**Key fields**: `id, organizationId, companyId, entityType: String @default("order")` — `order | exchange_shipment`, `entityId, orderId?: String?` (FK to Order, onDelete: Cascade), `exchangeShipmentId?: String?`, `trackingNumber?: String?, courierIntegrationId?: String?, status, subStatus?: String?, rawResponse?: String?, receivedAt, createdAt`.

**Relations**: `organization`, `company`, `order?`.

**Indexes**: `@@index([entityType, entityId, receivedAt])`, `@@index([companyId, receivedAt])`.

---

## Section 9 — Audit & Metrics (AuditLog, MetricEvent, IdempotencyKey)

### 9.1 `AuditLog` (table: `"AuditLog"`)

See §1.9 above.

### 9.2 `MetricEvent` (table: `"MetricEvent"`)

See §1.10 above.

### 9.3 `IdempotencyKey` (table: `"IdempotencyKey"`)

**Purpose**: Idempotency key for duplicate-submission protection on creation endpoints. Client generates a UUID per form-session; server guarantees only ONE successful creation per key via the unique constraint on `key`. A ticket is only "claimed" on SUCCESS — failed attempts can be retried.

**Key fields**: `id, key: String @unique, companyId, employeeId?, actionType: String, status: String @default("processing")` — `processing | completed | failed`, `resourceType?: String?, resourceId?: String?, responseBody: Json?, createdAt, completedAt?: DateTime?`.

**Indexes**: `@@index([companyId, actionType])`, `@@index([createdAt])`.

**Business rules**: Used by `withIdempotency()` wrapper (`src/lib/idempotency.ts`). Applied to: `customer.create`, `product.create`, `order.create`, `exchange.create`, `payroll_run.create`, `integration.connect`, `supplier-return.create`.

---

## Section 10 — Ecommerce (OrgProductBundle, SelectiveProductAccess, CustomerExternalIdentity)

### 10.1 `OrgProductBundle` (table: `"OrgProductBundle"`)

See §2.9 above.

### 10.2 `SelectiveProductAccess` (table: `"SelectiveProductAccess"`)

See §2.10 above.

### 10.3 `Customer` + child tables (table: `"Customer"`, `"customer_phones"`, `"customer_addresses"`, `"customer_external_identities"`)

The Customer Management System (migration 002) introduced a normalized schema:

#### `Customer`
- `id, organizationId, name, email?`
- `totalOrdersCount: Int @default(0), totalOrderValue: Decimal @default(0), totalRtoCount: Int @default(0)` — cached stats (denormalized for fast list views; kept in sync by `updateCustomerStats()`)
- `isFlagged: Boolean @default(false), flaggedReason?, flaggedAt?, flaggedBy?: String?` (FK to Employee, "CustomerFlagger", onDelete: SetNull)
- `createdBy?: String?` (FK to Employee, "CustomerCreator", onDelete: SetNull)
- `createdAt, updatedAt`
- Relations: `orders` (Order[]), `phones` (CustomerPhone[]), `addresses` (CustomerAddress[]), `externalIdentities` (CustomerExternalIdentity[]), `exchangeShipments` (ExchangeShipment[], "ExchangeShipmentCustomer")
- Indexes: `@@index([organizationId, isFlagged])`

#### `CustomerPhone` (table: `"customer_phones"` via `@@map`)
- `id, customerId, organizationId, phoneRaw: String, phoneNormalized: String, label?, isPrimary: Boolean @default(false), isValidFormat: Boolean @default(true)` (false = phone failed format validation, e.g. from external platform)
- Relations: `customer`, `organization`, `ordersUsedIn` (Order[], "OrderUsedPhone"), `exchangeShipments` (ExchangeShipment[], "ExchangeShipmentShippingPhone")
- Indexes: `@@unique([organizationId, phoneNormalized])`, `@@index([organizationId, phoneNormalized])`, `@@index([customerId])`
- **Partial unique index `customer_phones_one_primary_idx`**: enforces "one primary per customer" — managed via raw SQL (migration 002), Prisma can't represent it.

#### `CustomerAddress` (table: `"customer_addresses"` via `@@map`)
- `id, customerId, organizationId, label?, address, city, country: String @default("PK")` (ISO 3166-1 alpha-2 code), `isDefault: Boolean @default(false), lastUsedAt?: DateTime?`
- `cityMatchedCouriers: String[] @default([])` (Phase 7 — list of providerKeys whose cached operational cities include this address's city; informational only)
- `cityValidatedAt?: DateTime?`
- Relations: `customer`, `organization`, `ordersUsedIn` (Order[], "OrderUsedAddress"), `exchangeShipments` (ExchangeShipment[], "ExchangeShipmentShippingAddress")
- Indexes: `@@index([customerId])`, `@@index([organizationId])`
- **Partial unique index `customer_addresses_one_default_idx`**: enforces "one default per customer" — managed via raw SQL (migration 002).
- **NO `province` field** — per product decision, addresses are just `{ address, city }`.

#### `CustomerExternalIdentity` (table: `"customer_external_identities"` via `@@map`)
- `id, customerId, organizationId, platform: String` (`shopify | daraz | instagram` — CHECK in SQL), `externalCustomerId: String, matchedVia: String @default("manual")` (`exact_identity | phone_match | email_match | manual` — CHECK), `createdAt`
- Indexes: `@@unique([organizationId, platform, externalCustomerId])`, `@@index([customerId])`, `@@index([organizationId, platform, externalCustomerId])`
- Used by the layered matching strategy in `match_or_create_customer()` SQL function.

---

## Section 11 — HR / Payroll (EmployeeStats, EmployeeSalaryProfile, SalaryRevision, CommissionRule, PayrollRun, Payslip, EmployeeAdvance)

### 11.1 `EmployeeStats` (table: `"EmployeeStats"`)

**Purpose**: Cached rollup of an employee's sales performance — mirrors the `Customer.totalOrdersCount` / `totalRtoCount` caching pattern. One row per employee (1:1). Recomputed by `updateEmployeeStats()` on every order mutation.

**Key fields**: `id, employeeId: String @unique, totalOrders, cancelledCount, dispatchedCount, deliveredCount, rtoCount, inTransitCount` (dispatched but not yet delivered), `cancellationRate: Decimal @db.Decimal(5, 4)` (0.0000 - 1.0000), `deliveryRate, rtoRate: Decimal @db.Decimal(5, 4)`, `itemsSoldQty: Int @default(0), damageLossCount: Int @default(0), revenueGenerated: Decimal @default(0) @db.Decimal(14, 2), updatedAt`.

**Indexes**: `@@index([employeeId])`.

### 11.2 `EmployeeSalaryProfile` (table: `"EmployeeSalaryProfile"`)

**Purpose**: Active salary profile for an employee (1:1). Only the LATEST profile is "active" — when a salary changes, a new row is created with `effectiveFrom=now` and the old one's status flips to `"inactive"`. A `SalaryRevision` row is also appended.

**Key fields**: `id, employeeId: String @unique, baseSalary: Decimal @db.Decimal(14, 2), currency: String @default("PKR")` (defaults to company's baseCurrency at creation), `effectiveFrom: DateTime, status: String @default("active")` — `active | inactive`, `createdAt, updatedAt`.

**Indexes**: `@@index([employeeId])`, `@@index([status])`.

### 11.3 `SalaryRevision` (table: `"SalaryRevision"`)

**Purpose**: Append-only salary revision history. NEVER edit an existing row — every salary change creates a new row.

**Key fields**: `id, employeeId, oldAmount?: Decimal?` (null for first-ever revision), `newAmount: Decimal, effectiveFrom: DateTime, changedByEmployeeId: String, changedBy: Employee ("SalaryRevisionChangedBy"), createdAt`.

**Indexes**: `@@index([employeeId, effectiveFrom])`, `@@index([changedByEmployeeId])`.

### 11.4 `CommissionRule` (table: `"CommissionRule"`)

**Purpose**: Commission rule for an employee. An employee can have multiple active rules (e.g. "PKR 50 per dispatched order" + "5% of delivered revenue").

**Key fields**: `id, employeeId, basisType: String` — `per_order | per_item_sold | percentage_of_revenue`, `rateValue: Decimal @db.Decimal(10, 4)` (currency amount OR 0-1 fraction), `triggerStatus: String` (e.g. `dispatched`, `delivered`, `confirmed` — validated at app layer), `isActive: Boolean @default(true), createdAt, updatedAt`.

**Indexes**: `@@index([employeeId, isActive])`, `@@index([triggerStatus])`.

### 11.5 `PayrollRun` (table: `"PayrollRun"`)

**Purpose**: A payroll run for a specific company + month + year. Only ONE run per company per month (enforced by unique constraint). A run progresses: `draft → finalized → paid`. Once finalized, the payslips are locked.

**Key fields**: `id, companyId, periodMonth: Int (1-12), periodYear: Int, status: String @default("draft")` — `draft | finalized | paid`, `generatedAt?, finalizedByEmployeeId?, finalizedBy: Employee? ("PayrollFinalizer", onDelete: SetNull), finalizedAt?, createdAt, updatedAt`.

**Relations**: `payslips` (Payslip[]).

**Indexes**: `@@unique([companyId, periodMonth, periodYear])`, `@@index([companyId, periodYear, periodMonth])`, `@@index([status])`.

### 11.6 `Payslip` (table: `"Payslip"`)

**Purpose**: A single employee's payslip within a `PayrollRun`. `grossPay` and `netPay` are computed at generation time (base + commission + otherAllowances, then minus advanceDeduction + otherDeductions) and stored — NOT recomputed on read, so the numbers stay frozen once finalized.

**Key fields**: `id, payrollRunId, employeeId, baseSalary, commissionEarned: Decimal @default(0), advanceDeduction, otherDeductions, otherAllowances: Decimal @default(0), grossPay, netPay: Decimal @db.Decimal(14, 2)` (computed at generation time, NOT a DB generated column), `paymentStatus: String @default("pending")` — `pending | paid`, `paymentDate?, paymentMethod?, paymentReference?, createdAt, updatedAt`.

**Indexes**: `@@unique([payrollRunId, employeeId])` (one payslip per employee per run), `@@index([employeeId])`, `@@index([paymentStatus])`.

### 11.7 `EmployeeAdvance` (table: `"EmployeeAdvance"`)

**Purpose**: Salary advance given to an employee. Tracks repayment plan + remaining balance. When `remainingBalance` reaches 0, status flips to `"settled"`. The payroll generator deducts from active advances when computing `netPay`.

**Key fields**: `id, employeeId, amount: Decimal @db.Decimal(14, 2), reason, dateGiven, repaymentPlan: String` — `lump_sum | installments`, `installmentAmount?: Decimal?` (required if `repaymentPlan="installments"`), `remainingBalance: Decimal @db.Decimal(14, 2)` (decremented as deductions are applied), `status: String @default("active")` — `active | settled`, `createdByEmployeeId, createdBy: Employee ("AdvanceCreatedBy"), createdAt`.

**Indexes**: `@@index([employeeId, status])`, `@@index([createdByEmployeeId])`.

---

## SQL Functions (raw-SQL managed, not Prisma)

These functions live in `supabase/migrations/*.sql`. They are PostgreSQL-only — NOT available in SQLite (sandbox fallback). The app uses `db.$queryRaw` to call them.

### `normalize_phone(input TEXT) RETURNS TEXT`

Strips all non-digit characters, then canonicalizes Pakistani phone numbers to E.164-style `+92XXXXXXXXXX`. Defined in migration 002.

Examples:
- `normalize_phone('0300-1234567')` → `+923001234567`
- `normalize_phone('+92 300 1234567')` → `+923001234567`
- `normalize_phone('923001234567')` → `+923001234567`
- `normalize_phone('3001234567')` → `+923001234567` (10-digit local)
- `normalize_phone(NULL)` → `NULL`

Used at both storage time (so every `customer_phones.phoneNormalized` is canonical) and at lookup time (so matching is format-independent).

### `match_or_create_customer(p_org_id TEXT, p_phone TEXT, p_email TEXT DEFAULT NULL, p_name TEXT DEFAULT NULL, p_platform TEXT DEFAULT NULL, p_external_id TEXT DEFAULT NULL) RETURNS TABLE(...)`

The layered customer matching strategy:
1. **External identity match** (fastest): if `p_platform` + `p_external_id` provided, look up `customer_external_identities` first.
2. **Phone match**: normalize `p_phone` via `normalize_phone()` and look up `customer_phones.phoneNormalized`.
3. **Email match**: if no phone match and `p_email` provided, look up `Customer.email`.
4. **Create**: if no match at all, create a new `Customer` row.

Returns the customer ID + `matched_via` (`exact_identity | phone_match | email_match | created`).

### `generate_order_number(p_company_id TEXT, p_year INT DEFAULT NULL) RETURNS TEXT` (LEGACY)

**Legacy** — uses `MAX+1` STABLE SQL function. Race condition acknowledged in migration 026 but **order numbers still use this** in some paths. **Most paths have been migrated** to `get_next_sequence_number()` (see below) — verify per-call site.

### `get_next_sequence_number(p_org_id TEXT, p_type TEXT, p_year INT DEFAULT NULL) RETURNS INT` (ATOMIC — migration 026)

The race-free atomic counter for sequence numbers. Uses `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` — a single atomic SQL statement that Postgres guarantees returns a unique incrementing number per `(org, type, year)` even under concurrent access.

```sql
CREATE TABLE "number_sequences" (
  "id"              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "organizationId"  TEXT NOT NULL,
  "type"            TEXT NOT NULL,  -- 'po_number' | 'order_number' | 'sf_number' | 'exchange_number' | 'draft_number'
  "year"            INT NOT NULL,
  "nextNumber"      INT NOT NULL DEFAULT 1,
  ...
  CONSTRAINT "number_sequences_org_type_year_key" UNIQUE ("organizationId", "type", "year")
);

CREATE OR REPLACE FUNCTION get_next_sequence_number(p_org_id TEXT, p_type TEXT, p_year INT DEFAULT NULL)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE v_next INT;
BEGIN
  INSERT INTO "number_sequences" ("organizationId", "type", "year", "nextNumber")
  VALUES (p_org_id, p_type, COALESCE(p_year, EXTRACT(YEAR FROM NOW())::INT), 1)
  ON CONFLICT ("organizationId", "type", "year")
  DO UPDATE SET "nextNumber" = "number_sequences"."nextNumber" + 1, "updatedAt" = NOW()
  RETURNING "number_sequences"."nextNumber" INTO v_next;
  RETURN v_next;
END $$;
```

**Used by**: PO numbers (`po_number`), order numbers (`order_number`), self-fulfilled references (`sf_number`), exchange shipment numbers (`exchange_number`). Draft numbers use a separate `draft_order_number_seq` (migration 006) — older pattern but functionally equivalent.

### `recompute_order_status(p_order_id TEXT) RETURNS VOID` (DEAD)

Dead function — referenced in `src/lib/actions/backorder.actions.ts` but the call is a no-op (the function exists but does nothing meaningful). Known smell from ORDERS_AUDIT.md.

### `backfill_order_timestamps()` (trigger function)

Trigger that auto-backfills skipped timestamps (`confirmedAt`, `packedAt`) when `requireOrderConfirmation=false` or `requirePackingStep=false` and an order jumps straight to `dispatched`.

### `is_elevated_employee(p_company_id TEXT) RETURNS BOOLEAN`

SQL helper that mirrors the app-layer `isElevatedEmployee()`. Used by RLS policies as defense-in-depth.

### `get_active_company_id()`, `get_active_org_id()`, `get_active_user_id()` (RLS helpers)

Read the active company/org/user from the current session's GUC parameters (`app.active_company_id`, etc.). Used by RLS policies.

### `has_permission(company_id TEXT, key TEXT) RETURNS BOOLEAN`

SQL helper that mirrors the app-layer `requirePermission()`.

---

## Partial unique indexes (raw-SQL managed, not Prisma)

| Index | Table | Columns | Purpose |
|---|---|---|---|
| `customer_phones_one_primary_idx` | `customer_phones` | `customerId` WHERE `isPrimary=true` | Enforces "one primary phone per customer" |
| `customer_addresses_one_default_idx` | `customer_addresses` | `customerId` WHERE `isDefault=true` | Enforces "one default address per customer" |
| `stock_loss_orderitem_dedup_idx` | `stock_loss_records` | `(orderItemId, lossType, sourceModule)` WHERE `orderItemId IS NOT NULL` | Prevents double-counting: same order item + same loss type + same source module |

---

## Migration history (001-029)

| # | File | Description |
|---|---|---|
| 001 | `001_oms_schema.sql` | Foundation: RLS helper functions (`get_active_company_id`, `is_elevated_employee`, `has_permission`), `generate_order_number` SQL function (legacy MAX+1), `recompute_order_status` trigger, `backfill_order_timestamps` trigger, RLS policies on all OMS tables. **Prisma creates the TABLES themselves** (PascalCase) — this migration handles what Prisma CAN'T. |
| 002 | `002_customer_system_schema.sql` | Customer Management System: `normalize_phone()` function, `match_or_create_customer()` function, `customer_phones` + `customer_addresses` + `customer_external_identities` tables, partial unique indexes `customer_phones_one_primary_idx` + `customer_addresses_one_default_idx`, RLS policies. Replaces the simplified customer design from the OMS sprint (flat JSONB shippingAddress/billingAddress + single phone column). |
| 003 | `003_exchange_system_schema.sql` | Item Exchange System: `order_exchanges` table with CHECK constraints on `exchangeMethod`, `status` (10 states), `oldItemCondition`, `priceDifferenceStatus`, `refundMethod`, `notReturnedRecoveryStatus`. `priceDifference` is a GENERATED column (`new-old`). RLS policies. **Managed jointly by Prisma + raw SQL** — `prisma db push` would drop the GENERATED column. |
| 004 | `004_integration_framework_schema.sql` | Universal Integration Framework: `integration_providers` (seeded), `company_integrations` (with `webhookEndpointId` unique), `integration_action_logs` (immutable), CHECK constraints on `category`, `authType`, `direction`, `status`, `relatedEntityType`. RLS policies. |
| 005 | `005_draft_status_support.sql` | Form Drafts: `form_drafts` table (`draftType` ∈ `product` | `order`, `draftData` JSONB). For the Unsaved Changes Guard system. |
| 006 | `006_draft_numbering.sql` | Adds `draftNumber` column to `form_drafts` + independent `draft_order_number_seq` sequence. `DRAFT-00001` format — only for order drafts, null for product drafts. |
| 007 | `007_city_address_book_schema.sql` | City & Address Book System (Courier-Agnostic Foundation): `courier_operational_cities`, `courier_city_aliases`, `courier_pickup_addresses`. CHECK constraints on `providerKey`. |
| 008 | `008_exchange_shipments_schema.sql` | Exchange Shipments System (structurally separate from Order): `exchange_shipments` table with its own `EXCH-{year}-{seq}` numbering via `exchange_shipment_number_seq`. CHECK constraints on `status` (originally 6 states). |
| 009 | `009_postex_seed_fix.sql` | Fixes PostEx `integration_providers` seed: `supportsWebhook=FALSE` (PostEx does NOT support webhooks — use polling), other field corrections based on confirmed API behavior. |
| 010 | `010_last_polled_at.sql` | Adds `lastPolledAt` to `Order` + `exchange_shipments`. Used by `pollPostExOrderStatuses()` to avoid re-polling unchanged records. |
| 011 | `011_order_courier_tracking_fields.sql` | Adds `courierSubStatus`, `needsShipperAdvice`, `unrecognizedCourierStatus` to `Order` — mirroring the same fields on `exchange_shipments`. |
| 012 | `012_delivery_charge_tax.sql` | Delivery Charge + Tax Tracking: 4 fields on both `Order` and `exchange_shipments`: `estimatedDeliveryCharge`, `actualDeliveryCharge`, `taxAmount`, `taxLabel`. |
| 013 | `013_booking_workbench_schema.sql` | Booking Workbench: adds `courierBookingStatus` + `recommendedCourierCompanyIntegrationId` to both `Order` and `exchange_shipments`. CHECK constraint on `courierBookingStatus` (initially `not_booked | booked | failed`). |
| 014 | `014_exchange_refund_tracking.sql` | Exchange Refund Tracking + Delivery Charge Folding: adds `refundMethod`, `refundReference`, `refundProcessedAt`, `refundProcessedBy`, `refundAmount` to `order_exchanges`. Adds `deductDeliveryChargeFromRefund` to `CompanyOrderSetting`. |
| 015 | (skipped — placeholder, content merged into 013) | — |
| 016 | `016_courier_booking_cancelled.sql` | Adds `cancelled` to `courierBookingStatus` CHECK constraint on both `Order` and `exchange_shipments` tables. **Known bug** (ORDERS_AUDIT.md): only added to `Order` constraint — `exchange_shipments` constraint is missing `cancelled`, causing runtime crashes when canceling exchange shipment bookings. |
| 017 | (skipped — content merged into 011) | Order Scan Module schema fields. |
| 018 | `018_integration_log_exchange_shipment_check.sql` | Adds `exchange_shipment` to `IntegrationActionLog.relatedEntityType` CHECK constraint (originally only allowed `order` | `product`). |
| 019 | `019_exchange_shipment_rto.sql` | Adds `rto` as a valid `status` for `exchange_shipments`. When a courier returns a replacement-item shipment, triggers `markExchangeShipmentRto()` which restores inventory + sets the parent `order_exchanges.status='exchange_item_returned'` (terminal, manual follow-up). |
| 020 | `020_load_sheets.sql` | Load Sheets — courier-agnostic pickup manifest system. Creates `load_sheets` table. Reuses PostEx's existing `generateLoadSheet()` adapter method (and the `generatePostExLoadSheet()` action) for any provider. |
| 021 | `021_leopard_adapter_fields.sql` | Leopard adapter schema additions: `courier_operational_cities.shipmentTypes` (Leopard returns each city's allowed shipment_type as an array), `courier_pickup_addresses.returnAddressOverride` (Leopard-specific optional return address override JSONB). |
| 022 | `022_leopard_order_fields.sql` | Leopard-specific order/shipment fields: `Order.returnAddressOverrideId` (nullable FK to `courier_pickup_addresses`). When set, the booking uses this address's `returnAddressOverride` JSONB. |
| 023 | `023_pod_and_status_history.sql` | Proof of Delivery + Courier Status History: `Order.proofOfDeliveryData` JSONB (`{ signatureUrl, photoUrl, recipientName, deliveredAt, rawResponse }` — stores OUR file paths, not external URLs). Creates `courier_status_history` table (raw SQL — Prisma can't represent the indexes via `@map`). |
| 024 | `024_shipper_advice_fields.sql` | Shipper Advice tracking fields. Adds fields to track when shipper advice was last submitted for an entity (Leopard-specific capability — PostEx uses read-only flagging only). |
| 025 | `025_customer_search_trgm_indexes.sql` | Customer search performance — `pg_trgm` GIN indexes for fast `LIKE '%query%'` searches on customer name + phone columns. Without these, customer search does a sequential scan (degrades as the customer table grows). |
| 026 | `026_atomic_sequence_counter.sql` | Atomic per-org sequence counter (race-free PO/order number generation). Creates `number_sequences` table + `get_next_sequence_number()` function. Replaces the legacy `count+1` (Prisma) and `MAX+1` (SQL function) race conditions. Used by PO numbers (`po_number`), order numbers (`order_number`), self-fulfilled references (`sf_number`), exchange shipment numbers (`exchange_number`). |
| 027 | `027_stock_loss_unification.sql` | Stock-loss system unification — schema changes. Adds `sourceModule` discriminator (8 values: `stock_loss | rto | cycle_count | adjust_stock | returned_stitched | supplier_return | exchange | return_scan`), `cycleCountItemId` FK, dedup partial unique index `stock_loss_orderitem_dedup_idx`. Adds `inventoryTxnId` FK to `ReturnedStitchedInventory` (links the register to the ledger). See `STOCKLOSS_INVESTIGATION.md` for the full design proposal. |
| 028 | `028_product_search_trgm_indexes.sql` | Product search performance — `pg_trgm` GIN indexes for fast `LIKE '%query%'` searches on product title + variant SKU. Same pattern as migration 025 (customer search). |
| 029 | `029_order_status_check.sql` | Adds a DB-level CHECK constraint on `Order.status` to prevent illegal status values. Allowed: `pending | confirmed | partially_backordered | processing | dispatched | delivered | rto | cancelled | refunded`. |

**Skipped migrations**: 015, 017 — content was merged into 013 and 011 respectively.

---

## Critical operational rules (read BEFORE touching the schema)

1. **Never run `prisma db push`** against the schema. It would drop the partial unique indexes (`customer_phones_one_primary_idx`, `customer_addresses_one_default_idx`, `stock_loss_orderitem_dedup_idx`), CHECK constraints, GENERATED columns, and RLS policies that Prisma can't represent. Use `prisma generate` only. Schema changes go through new migration files under `supabase/migrations/`.
2. **Migrations are one-way**. Never write a "down" migration that drops tables/columns in production. Always add new columns/tables, mark old ones deprecated, and backfill via a separate script.
3. **Sandbox reverts to SQLite on restart**. The PostgreSQL migrations are NOT auto-applied in the sandbox — they must be applied manually via `psql` against the production Supabase instance.
4. **Test data is forbidden in production**. The sandbox has its own `db/custom.db` SQLite file for testing.
5. **Multi-tenancy is enforced at the app layer**. Every query MUST include `where: { companyId: ctx.company.id, ... }` (or `organizationId` for org-level data). RLS policies exist as defense-in-depth but the Prisma app bypasses them (the `postgres` role bypasses RLS).
6. **`InventoryTransaction` is append-only**. Never UPDATE or DELETE rows. The audit trail would break.
7. **`IntegrationActionLog` is append-only**. Same reason.
8. **`ScanEvent` is append-only**. Same reason.
9. **`AuditLog` is append-only**. Same reason.
10. **`SalaryRevision` is append-only**. Every salary change creates a new row.
11. **`InventoryPool` is the single source of truth for stock levels**. Never compute stock from `InventoryTransaction` aggregates in app code — always read from `InventoryPool`.
12. **`priceDifference` on `OrderExchange` is a DB-generated column** (`new-old`). Never set it via Prisma — it's computed automatically.
13. **`lineTotal` on `OrderItem` is a DB-generated column** (`quantity * unitPrice`). Never set it via Prisma.
14. **`remainingCodAmount` on `Order` is a DB-generated column** (`totalOrderValue - advanceAmount`). Never set it via Prisma.
15. **`Order.status` has a DB-level CHECK constraint** (migration 029). Setting an invalid status value will throw a constraint violation.
16. **`courierBookingStatus` on `Order` accepts `cancelled`** (migration 016), but on `exchange_shipments` it does NOT (known bug from ORDERS_AUDIT.md — `cancelCourierBooking` writes `'cancelled'` to `ExchangeShipment.courierBookingStatus` which will throw constraint violation).

---

End of DATABASE_GUIDE.md.
