# FlowOps ERP — Complete Technical Briefing Document

> **Purpose**: This document is the single source of truth for the FlowOps ERP system. It covers every module, the API system, dependencies, database schema, frontend, backend, third-party services, what's built, what's in process, and what needs to be built. Use this to train AI assistants so they can generate correct, context-aware prompts.
>
> **Last Updated**: August 2026 (updated after performance optimization pass + products table conversion + hydration fixes)
> **App URL**: Single-page app at `/` (Next.js 16 App Router)
> **Stack**: Next.js 16 + React 19 + TypeScript + Prisma 6 + Supabase PostgreSQL + Tailwind 4 + shadcn/ui
>
> **MAINTENANCE RULE**: This document MUST be updated whenever significant changes are made to the architecture, modules, dependencies, or performance characteristics. Do not let it go stale.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [What FlowOps Is](#2-what-flowops-is)
3. [Technology Stack & Dependencies](#3-technology-stack--dependencies)
4. [Architecture Overview](#4-architecture-overview)
5. [Database Layer](#5-database-layer)
6. [Authentication & Multi-Tenancy](#6-authentication--multi-tenancy)
7. [Module Catalog (Complete)](#7-module-catalog-complete)
8. [API System (Complete Route Map)](#8-api-system-complete-route-map)
9. [Backend Server Actions](#9-backend-server-actions)
10. [Integration / Courier Adapter Framework](#10-integration--courier-adapter-framework)
11. [Frontend Architecture](#11-frontend-architecture)
12. [Third-Party Services](#12-third-party-services)
13. [Background Jobs & Cron](#13-background-jobs--cron)
14. [Storage & File System](#14-storage--file-system)
15. [Gateway & Deployment](#15-gateway--deployment)
16. [What's Built vs. In-Process vs. Needed](#16-whats-built-vs-in-process-vs-needed)
17. [Key Conventions & Patterns](#17-key-conventions--patterns)
18. [Known Issues & Gotchas](#18-known-issues--gotchas)
19. [Prompt Generation Guide](#19-prompt-generation-guide)

---

## 1. Executive Summary

**FlowOps** is a multi-tenant SaaS ERP built for Pakistani e-commerce businesses. It manages the complete order lifecycle: product catalog → customer management → order creation → inventory reservation → courier booking → dispatch → delivery/RTO → returns/exchanges. It integrates with Pakistani courier services (PostEx, Leopard) for real-time booking and status tracking.

**Core value proposition**: One system to manage products, inventory, orders, customers, and courier bookings — replacing the spreadsheets + WhatsApp + manual courier portal workflow that Pakistani e-commerce sellers currently use.

**Scale**: 58 Prisma models, 148 API routes, ~153 React components (101 non-UI + 52 shadcn/ui), 21 SQL migrations, 30 permission keys, 2 live courier integrations.

**Performance posture** (as of latest optimization pass):
- First Load JS: **1,070 KB** (down from 3,148 KB baseline — 66% reduction via code-splitting)
- Total JS across all chunks: **4,665 KB** (95 chunks — was 10 chunks pre-split)
- All 70 data-fetching views use TanStack Query (was 64/70 — 6 migrated from raw `useEffect`+`api.get()`)
- `React.memo` used on leaf components in 6 largest views
- 10 dead dependencies removed (node_modules: 1.2 GB, was 1.3 GB)
- Route-aware `LoadingFallback` renders PageHeader text immediately at Suspense boundary

---

## 2. What FlowOps Is

### Target User
Pakistani e-commerce sellers (Instagram/Facebook/Daraz/Shopify) who:
- Sell products COD (Cash on Delivery) — the dominant payment method in Pakistan
- Ship via local couriers (PostEx, Leopard, TCS)
- Need to track which orders are confirmed, packed, dispatched, delivered, or returned (RTO)
- Need inventory management (stock-based + made-to-order)
- Need customer management with RTO-rate flagging (high-return customers)

### Multi-Tenant Model
```
Organization (top-level tenant, owned by one user)
  └── Company (sub-tenant — a brand/store under the org)
        ├── Employees (users with roles/permissions in this company)
        ├── Products (company subscribes to org-level product templates)
        ├── Inventory (company-owned stock in locations)
        ├── Orders (company's orders)
        ├── Customers (org-level, shared across companies in the org)
        └── Integrations (company's courier connections)
```

A user can belong to multiple companies (via Employee records) and switch between them using the workspace switcher. The active company is stored in `UserSetting.activeCompanyId`.

### Order Lifecycle (the heart of the system)
```
pending → confirmed → processing → packed → dispatched → delivered
                ↓                                      ↓
         partially_backordered                       rto
                ↓
            cancelled
```

Every transition has inventory side-effects:
- **Confirm**: reserve stock (`reserved += qty`) or backorder if insufficient
- **Dispatch**: deduct stock (`onHand -= qty`, `reserved -= qty`)
- **Cancel**: unreserve stock (`reserved -= qty`)
- **RTO**: restock (`onHand += qty` via `return_resellable` or `return_stitched_received`)

---

## 3. Technology Stack & Dependencies

### Core Framework (NON-NEGOTIABLE)
| Component | Version | Notes |
|---|---|---|
| Next.js | 16.1+ | App Router, Turbopack dev server, `output: 'standalone'` |
| React | 19 | |
| TypeScript | 5 | Strict mode, `@/*` path alias → `./src/*` |
| Bun | 1.3+ | Runtime + package manager + production server (`bun .next/standalone/server.js`) |

### Database
| Component | Version | Notes |
|---|---|---|
| Prisma ORM | 6.11+ | PostgreSQL provider, `db push` workflow (not migrations) |
| Supabase PostgreSQL | — | Mumbai (ap-south-1) region, session pooler on port 5432 |
| `pg` | 8.22+ | Raw SQL queries (e.g., `generate_order_number()` SQL function) |

### State & Data Fetching
| Library | Purpose |
|---|---|
| Zustand 5 | Client state (session, active company, SPA routing) — single store `useAppStore` |
| TanStack Query 5 | Server state (data fetching, caching, mutations) — used by ALL 70 data-fetching views |

### Forms & Validation
| Library | Purpose |
|---|---|
| React Hook Form 7 | All forms |
| Zod 4 | Schema validation (shared between client + server) |
| `@hookform/resolvers` | Zod resolver for RHF |

### UI
| Library | Purpose |
|---|---|
| Tailwind CSS 4 | Styling (NO indigo/blue colors per design rules) |
| shadcn/ui (New York style) | 52 component primitives in `src/components/ui/` |
| Radix UI | 26 `@radix-ui/react-*` packages (shadcn/ui foundation) |
| Lucide React | Icons |
| Sonner | Toast notifications |
| next-themes | Dark/light mode |
| vaul, embla-carousel, cmdk | Drawer, carousel, command palette |

### Other Key Libraries
| Library | Purpose |
|---|---|
| `@react-pdf/renderer` | Scan report PDF generation |
| `recharts` | Dashboard charts |
| `date-fns` | Date utilities |
| `bcryptjs` | Password hashing (actually uses Node `crypto.scrypt` in `src/lib/auth.ts`) |
| `z-ai-web-dev-sdk` | AI skills (image generation, VLM, etc.) — backend only |

### Removed Dependencies (Step 4 cleanup — August 2026)
The following 10 packages were installed but confirmed unused (0 code imports) and removed to reduce install time + Docker image size:
- `@mdxeditor/editor` (1.1 MB) — was listed for "rich text" but never imported
- `@tanstack/react-table` (796 KB) — FlowOps uses shadcn/ui `Table` component instead
- `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` (2.4 MB total) — no drag-drop features
- `framer-motion` (5.4 MB) — animations handled by CSS transitions + Tailwind
- `react-syntax-highlighter` (8.9 MB) — no code display features
- `react-markdown` (88 KB) — no markdown rendering
- `next-intl` (1.6 MB) — app is English-only, no i18n
- `next-auth` (2.7 MB) — app uses custom HMAC sessions (see §6)

### Full dependency list: see `package.json`

---

## 4. Architecture Overview

### High-Level Data Flow
```
Browser (SPA at /)
  ↓ Authorization: Bearer <token> + cookie
Caddy Gateway (:81 → :3000)
  ↓
Next.js 16 API Routes (148 routes under src/app/api/)
  ↓
Server Actions (src/lib/actions/*.ts)
  ↓
Prisma Client (src/lib/db.ts)
  ↓
Supabase PostgreSQL (Mumbai)
```

### Key Architectural Decisions

1. **Single SPA route** — the entire app lives at `/` (`src/app/page.tsx`). Navigation is client-side via Zustand's `navigate(route)` with URL sync. There are no other Next.js pages.

2. **Custom HMAC sessions** — Sessions are HMAC-signed tokens: `userId.timestamp.hmac` (30-day TTL). Dual-channel: `Authorization: Bearer` header (works in iframes/cross-origin) + HttpOnly cookie fallback. (`next-auth` was previously installed but unused; it was removed in Step 4 — see §3.)

3. **Multi-tenant isolation in app layer** — `getWorkspace()` in `src/lib/workspace.ts` resolves the caller's active company from `UserSetting.activeCompanyId` via a SINGLE Prisma JOIN query (Profile → settings.activeCompany + employees.role). No database-level RLS — all scoping is enforced in the application layer via `requirePermission()`.

4. **Fire-and-forget audit/metric writes** — `insertAuditLog()` and `insertMetricEvent()` return `void` immediately (detached promises via `fireAndForget()`). This works because the app runs on a long-lived Bun/Node server where the event loop survives the HTTP response.

5. **Adapter pattern for couriers** — provider-agnostic `CourierAdapter` interface. Only PostEx + Leopard are real implementations; TCS is a stub. All courier calls go through `executeLoggedIntegrationAction()` which logs every API call to `integration_action_logs`.

6. **Prisma `db push` workflow** — the `supabase/migrations/*.sql` files are reference SQL. The live schema is managed via `prisma db push` against `prisma/schema.prisma`. SQL functions (like `generate_order_number()`) must be applied manually to the DB.

---

## 5. Database Layer

### Connection
- **Provider**: PostgreSQL (Supabase)
- **Region**: Mumbai (ap-south-1) — ~100ms latency from sandbox
- **Pooler**: Session mode, port 5432
- **Client**: `src/lib/db.ts` — Prisma singleton with `log: ['error', 'warn']`

### Environment Variables (REQUIRED)
```env
DATABASE_URL="postgresql://postgres.gobwxqkzfulbwhzbbsdj:123%40Usman123%40@aws-0-ap-south-1.pooler.supabase.com:5432/postgres"
DIRECT_URL="postgresql://postgres.gobwxqkzfulbwhzbbsdj:123%40Usman123%40@aws-0-ap-south-1.pooler.supabase.com:5432/postgres"
INTEGRATION_ENCRYPTION_KEY="1fbf4fd279d9476183566c878e38907764feac7e7843d16ac60065720a451951"
SESSION_SECRET="flowops-session-secret-v1-change-in-production-please-32-chars-min"
CRON_SECRET="flowops-cron-secret-v1-change-in-production"
APP_URL="http://localhost:3000"
```

> ⚠️ **KNOWN ISSUE**: The `.env` file keeps reverting to SQLite (`file:./db/custom.db`). The `predev` script guards against this — it refuses to start if `DATABASE_URL` doesn't start with `postgresql://`. Always verify `.env` before starting the server.

### Schema: 58 Prisma Models

#### Auth / Org / Tenancy (10 models)
| Model | Purpose |
|---|---|
| `Profile` | Registered user (email, passwordHash, isOnboarded) |
| `Organization` | Top-level tenant (ownerId → Profile) |
| `Company` | Sub-tenant (brand/store under an org) |
| `Role` | Company-scoped role (isSystemRole, systemRoleKey ∈ owner/founder/co_founder/investor) |
| `RolePermission` | Permission grant per role |
| `Employee` | User's membership in a Company |
| `Invitation` | Pending invite (email, token, role) |
| `UserSetting` | Per-user settings (activeCompanyId, activeWorkspaceId) |
| `AuditLog` | Immutable event log (every mutation) |
| `MetricEvent` | KPI/metric events (for dashboards) |

#### Catalog / Products (14 models)
| Model | Purpose |
|---|---|
| `OrgCategory` | Org-level category |
| `OrgBrand` | Org-level brand |
| `OrgAttribute` | Org-level attribute (color, size, etc.) |
| `OrgAttributeValue` | Attribute value |
| `AttributeValueRule` | Rules over attribute values |
| `OrgProduct` | Org-level product template |
| `OrgProductVariant` | Org-level variant (SKU, weight, cost, fulfillmentType) |
| `OrgProductImage` | Product image |
| `OrgProductBundle` | Product bundle composition |
| `SelectiveProductAccess` | Which companies can subscribe to which org products |
| `CompanyProductSetting` | Company-level product subscription state |
| `CompanyVariantPricing` | Company-specific pricing override |
| `ProductFulfillmentCost` | Per-product fulfillment cost |
| `ReturnedStitchedInventory` | Returned-stitched inventory bucket (for made-to-order) |

#### Inventory (15 models)
| Model | Purpose |
|---|---|
| `InventoryLocation` | Warehouse/dispatch hub (warehouse, dispatch_hub, retail_store, transit, damaged_hold) |
| `Supplier` | Supplier master |
| `InventoryPool` | Stock pool per location × variant (onHand, reserved, incoming, avgCost) |
| `InventoryTransaction` | Append-only ledger of every stock movement |
| `AvgCostHistory` | Moving average cost history |
| `StockTransfer` | Location-to-location transfer |
| `PurchaseOrder` | PO header |
| `PurchaseOrderItem` | PO line items |
| `PurchaseOrderReceipt` | Receipt against PO |
| `PurchaseOrderReceiptItem` | Receipt line items |
| `SupplierReturn` | Return to supplier |
| `StockLossRecord` | Damaged/transit/theft loss |
| `CycleCount` | Cycle count header |
| `CycleCountItem` | Cycle count line |
| `ProductionOrder` | Made-to-order production order |

#### Customer (4 models)
| Model | Purpose |
|---|---|
| `Customer` | Customer master (org-level, shared across companies) |
| `CustomerPhone` | Multi-phone (normalized + raw) |
| `CustomerAddress` | Multi-address |
| `CustomerExternalIdentity` | External ID mapping (Shopify/Daraz customer ID) |

#### OMS / Orders (3 models)
| Model | Purpose |
|---|---|
| `CompanyOrderSetting` | Company-level order workflow config (requireOrderConfirmation, courierBookingMode, defaultCourier, defaultDispatchLocation) |
| `Order` | Order header — LARGE model (status, payment, courier, tracking, timestamps, totals) |
| `OrderItem` | Order line item (fulfillmentStatus, fulfillmentTypeSnapshot, reservedLocationId, productionOrderId) |

**Order.status enum**: `pending | confirmed | partially_backordered | processing | dispatched | delivered | rto | cancelled | refunded`

**OrderItem.fulfillmentStatus**: `pending | reserved | backordered | dispatched | returned`

#### Exchange (2 models)
| Model | Purpose |
|---|---|
| `OrderExchange` | Exchange request against an order |
| `ExchangeShipment` | Replacement shipment for an exchange |

#### Integrations / Courier (6 models)
| Model | Purpose |
|---|---|
| `IntegrationProvider` | Registered provider master (postex, leopard, tcs, shopify, daraz) |
| `CompanyIntegration` | Company's connection to a provider (encrypted credentials) |
| `IntegrationActionLog` | Every API call to a provider (logged with duration) |
| `CourierOperationalCity` | Cached list of cities each courier serves |
| `CourierCityAlias` | Local city ↔ courier city fuzzy-match mapping |
| `CourierPickupAddress` | Pickup address book per integration |

#### Scan (2 models)
| Model | Purpose |
|---|---|
| `ScanEvent` | Individual scan event (trackingNumber, scanMode, scanResult) |
| `ScanDailyReport` | Daily aggregated scan report |

#### Load Sheets (1 model)
| Model | Purpose |
|---|---|
| `LoadSheet` | Pickup manifest (PostEx load sheet — PDF stored locally) |

#### Drafts (1 model)
| Model | Purpose |
|---|---|
| `FormDraft` | Autosaved form drafts (product create, order create) |

### SQL Functions (applied manually, not in Prisma schema)
| Function | Purpose |
|---|---|
| `generate_order_number(companyId TEXT)` | Generates `ORD-{year}-{seq}` per company per year |
| `generate_exchange_shipment_number()` | Generates `EXCH-{year}-{seq}` |
| `generate_draft_number()` | Generates draft numbers |
| `normalize_phone(phone TEXT)` | Normalizes Pakistani phone numbers |
| `recompute_order_status(orderId)` | Recomputes order status from items |
| RLS helpers | `get_active_company_id()`, `get_active_org_id()`, `has_permission()`, `is_elevated_employee()` |
| Triggers | `backfill_order_timestamps()`, `update_*_updatedAt()` |

### Migrations
21 SQL migration files in `supabase/migrations/` (numbered 001–021, with 015 and 017 missing). These are reference SQL — the live schema is managed via `prisma db push`.

---

## 6. Authentication & Multi-Tenancy

### Session System
- **Token format**: `userId.timestamp.hmac` (HMAC-SHA256 signed)
- **TTL**: 30 days
- **Storage**: `localStorage` key `flowops_session_token` + HttpOnly cookie `flowops_session`
- **Dual-channel**: API client sends BOTH `Authorization: Bearer <token>` header AND cookie — works in iframes, cross-origin, and same-origin

### Auth Flow
```
1. POST /api/auth/login {email, password}
2. Server: verify scrypt hash → create session token → set cookie + return token
3. Client: store token in localStorage + Zustand store
4. Subsequent requests: send Bearer token + cookie
5. POST /api/auth/logout → clear cookie + localStorage
```

### Permission System (30 keys)
Permissions use dot-notation `module.action`:

| Module | Keys |
|---|---|
| Inventory (14) | view, create, adjust, delete, receive, report_loss, manage_loss, manage_locations, manage_suppliers, transfer, manage_purchase_orders, manage_supplier_returns, cycle_count, manage_production |
| Products (7) | view, create, edit, manage_catalog, subscribe, pricing, promote |
| Orders (5) | view, create, fulfill, cancel, manage |
| Employees (4) | view, invite, terminate, manage |
| Finance (2) | view, manage |
| Reports (2) | view, export |
| Settings (3) | company_view, company_edit, roles_manage |
| Integrations (2) | view, manage |
| KPI & Audit (3) | kpi_view, kpi_manage, audit_view |

**Elevated roles** (`owner`, `founder`, `co_founder`, `investor`) bypass ALL permission checks via `isElevated()`.

### Workspace Resolution
`getWorkspace()` in `src/lib/workspace.ts`:
- Resolves caller's active company + employee + role in a SINGLE Prisma query (Profile → settings.activeCompany + employees.role)
- Throws `ApiError(401)` if not signed in, `ApiError(403)` if no active company or not a member
- Returns `WorkspaceContext` = `{ user, employee, company }`
- Called by nearly every authenticated API route

---

## 7. Module Catalog (Complete)

### 7.1 Auth Module
- **Status**: ✅ Built
- **Routes**: `/api/auth/login`, `/api/auth/register`, `/api/auth/logout`, `/api/auth/me`, `/api/auth/forgot-password`, `/api/auth/reset-password`
- **Components**: `auth-shell`, `login-form`, `register-form`, `forgot-password-form`, `reset-password-form`
- **Logic**: scrypt password hashing, HMAC token sessions, dual-channel auth

### 7.2 Onboarding Module
- **Status**: ✅ Built
- **Routes**: `/api/onboarding/invitations`, `/api/onboarding/create-company`, `/api/onboarding/accept-invite`
- **Components**: `onboarding-view`, `create-organization-view`, `create-company-view`, `accept-invite-card`
- **Logic**: New user creates org → creates company → auto-becomes Owner. Existing users accept invitations via token.

### 7.3 Organization & Company Management
- **Status**: ✅ Built
- **Routes**: `/api/organizations/create`, `/api/organizations/[id]`, `/api/companies/create`, `/api/companies/[id]/archive`, `/api/company`, `/api/workspaces`, `/api/workspace/switch`
- **Components**: `workspace-switcher`, `organization-view`, `company-settings-view`
- **Logic**: Org owns companies. User switches active company via `POST /api/workspace/switch` which updates `UserSetting.activeCompanyId`. The switch returns minimal data (active company + employee + role + permissions) — no full session rebuild.

### 7.4 Employee & Role Management
- **Status**: ✅ Built
- **Routes**: `/api/employees`, `/api/employees/[id]`, `/api/employees/[id]/terminate`, `/api/roles`, `/api/roles/[id]`
- **Components**: `employees-view`, `invite-employee-view`, `employee-detail-view`, `roles-view`, `role-edit-view`, `permission-key-selector`
- **Logic**: Owner invites employees by email → employee accepts → gets role with permissions. System roles (Owner/Founder/Co-Founder/Investor) are elevated (bypass permissions). Custom roles are created per-company with selected permission keys.

### 7.5 Catalog Module (Org-Level)
- **Status**: ✅ Built
- **Routes**: `/api/categories`, `/api/brands`, `/api/catalog/attributes`, `/api/catalog/attributes/[id]/values`, `/api/catalog/seed-defaults`, `/api/catalog/inline-attribute`, `/api/catalog/inline-value`, `/api/org/catalog`
- **Components**: `org-catalog-view`, `catalog-settings-view`
- **Logic**: Org-level categories, brands, and attributes (color, size, fabric, etc.). Attributes have values (e.g., Color → Red/Blue/Green). These are templates shared across all companies in the org.

### 7.6 Product Module (Company-Level)
- **Status**: ✅ Built
- **Routes**: 24 routes under `/api/products/` — CRUD, subscribe, promote/demote, pricing, variants, variant-groups, images, selective-access
- **Components**: `products-view`, `product-create-view`, `product-detail-view`, `parent-child-variant-table`, `attribute-selector`, `fulfillment-type-badge`, `product-scope-badge`, `returned-stock-banner`
- **Logic**:
  - Org creates product templates (`OrgProduct` + `OrgProductVariant`)
  - Companies SUBSCRIBE to org products (creates `CompanyProductSetting`)
  - Companies can override pricing (`CompanyVariantPricing`), cost, weight per variant
  - Variants have `fulfillmentType`: `stock_based` or `made_to_order`
  - Made-to-order variants have `fabricSourceVariantId` (the raw fabric variant used for stitching)
  - Selective access controls which companies can see which org products

### 7.7 Inventory Module
- **Status**: ✅ Built
- **Routes**: `/api/inventory/dashboard`, `/api/inventory/summary`, `/api/inventory/opening-stock`, `/api/inventory/receive`, `/api/inventory/adjust`, `/api/inventory/transfers`, `/api/inventory/fulfill-mto`, `/api/inventory/receive-returned-stitched`
- **Components**: `inventory-dashboard-view`, `locations-view`, `location-detail-view`, `receive-stock-view`, `adjust-stock-view`, `transfer-stock-view`
- **Logic**:
  - **InventoryPool**: one row per (variant × location) with `onHand`, `reserved`, `incoming`, `avgCost`
  - **Available** = `onHand - reserved` (computed in app, no DB column)
  - **InventoryTransaction**: append-only ledger — the ONLY way to modify pools is via `processInventoryTransaction()` in `src/lib/inventory.ts`
  - **Transaction types**: `opening_stock`, `purchase_received`, `sale_dispatched`, `order_reserved`, `order_unreserved`, `return_resellable`, `return_stitched_received`, `return_damaged`, `transfer_out`, `transfer_in`, `cycle_count_adjust`, `damage_writeoff`, `theft_writeoff`, `missing_writeoff`, `transit_loss`, `supplier_return`, `fabric_consumed_for_stitching`
  - **WAC (Weighted Average Cost)**: recalculated on every IN-direction transaction
  - **Made-to-order**: `checkAndFulfillMadeToOrderVariant()` checks returned-stitched inventory first, then triggers fresh production (consumes fabric + creates `ProductionOrder`)

### 7.8 Supplier & Purchase Order Module
- **Status**: ✅ Built
- **Routes**: `/api/suppliers`, `/api/suppliers/[id]`, `/api/purchase-orders`, `/api/purchase-orders/[id]`, `/api/purchase-orders/[id]/confirm`, `/api/purchase-orders/[id]/receive`, `/api/purchase-orders/[id]/cancel`
- **Components**: `suppliers-view`, `supplier-detail-view`, `purchase-orders-view`, `po-create-view`, `po-detail-view`
- **Logic**: Create PO → confirm → receive (increments `incoming` then `onHand` via `purchase_received` transaction) → cancel (if needed)

### 7.9 Production Order Module (Made-to-Order)
- **Status**: ✅ Built
- **Routes**: `/api/production-orders`, `/api/production-orders/[id]`
- **Components**: `production-orders-view`
- **Logic**: When an order contains a made-to-order variant, `checkAndFulfillMadeToOrderVariant()` creates a `ProductionOrder` that consumes fabric (`fabric_consumed_for_stitching` transaction) and produces the finished variant.

### 7.10 Stock Loss Module
- **Status**: ✅ Built
- **Routes**: `/api/stock-loss`, `/api/stock-loss/[id]`, `/api/stock-loss/stats`, `/api/stock-loss/report-theft`, `/api/stock-loss/report-transit`, `/api/stock-loss/report-damaged`, `/api/stock-loss/resolve`
- **Components**: `losses-view`, `loss-detail-view`
- **Logic**: Report loss (theft/transit/damaged) → resolve (write off stock via `damage_writeoff` / `theft_writeoff` / `missing_writeoff` / `transit_loss` transactions)

### 7.11 Cycle Count Module
- **Status**: ✅ Built
- **Routes**: `/api/cycle-counts`, `/api/cycle-counts/[id]`
- **Components**: `cycle-counts-view`
- **Logic**: Create cycle count → count items → adjust stock via `cycle_count_adjust` transaction (sets `onHand` directly to counted value)

### 7.12 Returned Stitched Inventory Module
- **Status**: ✅ Built
- **Routes**: `/api/returned-stitched`, `/api/returned-stitched/[id]`, `/api/returned-stitched/stats`
- **Components**: `returned-stitched-view`
- **Logic**: When a made-to-order item is returned in "perfect" condition, it goes into `ReturnedStitchedInventory` (not back into regular `InventoryPool`). Future made-to-order orders check this bucket first before triggering fresh production (saves stitching cost).

### 7.13 Customer Management System (CMS)
- **Status**: ✅ Built
- **Routes**: `/api/customers`, `/api/customers/[id]`, `/api/customers/[id]/phones`, `/api/customers/[id]/addresses`, `/api/customers/backfill-stats`
- **Components**: `customers-view`, `customer-detail-view`, `CreateCustomerForm`, `CustomerSearchAutocomplete`, `AddressSelector`
- **Logic**:
  - Customers are org-level (shared across companies in the org)
  - Multi-phone (normalized via `normalize_phone()` SQL function) + multi-address
  - External identity mapping (Shopify/Daraz customer IDs)
  - Cached stats: `totalOrdersCount`, `totalOrderValue`, `totalRtoCount` — recomputed via `updateCustomerStats()` on every order mutation
  - Auto-flag at 3+ RTO (`isFlagged = true`, `flagReason = 'High RTO rate'`)
  - `matchOrCreateExternalCustomer()` — layered matching: exact_identity → phone_match → email_match → create new

### 7.14 Order Management System (OMS)
- **Status**: ✅ Built (recently fixed — inventory connection was broken, now fixed)
- **Routes**: `/api/orders` (GET/POST), `/api/orders/[id]` (GET), + 7 queue routes (pending, cancelled, backordered, awaiting-production, ready-to-dispatch, returns, returns/review), + 13 lifecycle action routes (confirm, processing, packed, dispatch, delivered, cancel, rto, cod-collected, convert-payment, payment-proof, refresh-status, returns/review/dismiss, returns/review/correct)
- **Components**: `orders-view`, `orders-pending-confirmation-view`, `orders-backordered-view`, `orders-awaiting-production-view`, `orders-ready-to-dispatch-view`, `orders-returns-view`, `orders-returns-review-view`, `orders-cancelled-view`, `order-create-view`, `order-detail-view`, `order-workflow-settings-view`
- **Logic**:
  - **Create** (`createManualOrder`): parallelized — customer resolution + variant fetch + settings fetch + order-number generation run in parallel; batch-creates order items via `createManyAndReturn`; auto-confirms if payment is prepaid OR `requireOrderConfirmation=false`; fires auto-booking in background if `courierBookingMode='automatic'`
  - **Confirm**: reserves stock (`reserveStockForOrder`) — may backorder if insufficient
  - **Payment convert**: confirms pending order + reserves stock
  - **Dispatch** (`performOrderDispatch`): deducts stock (`dispatchOrder` → `sale_dispatched`), sets tracking number, blocks if backordered items exist
  - **Cancel**: unreserves stock
  - **RTO** (manual `processOrderReturn`): restocks via `return_resellable` / `return_stitched_received`
  - **RTO** (auto via courier poll): `restockOrderForRto()` — session-free version for cron/webhook context
  - **Payment types**: `full_cod`, `partial_advance`, `fully_prepaid`
  - **Payment statuses**: `cod_pending`, `advance_paid`, `fully_prepaid`, `cod_collected`

### 7.15 Exchange System (Item Exchange)
- **Status**: ✅ Built
- **Routes**: `/api/exchanges`, `/api/exchanges/[id]`, + 8 action routes (cancel, verify-old-item, dispatch-new-item, dispatch-replacement, confirm-shipped, mark-not-returned, settle-price-difference, overdue)
- **Components**: `exchanges-view`, `exchange-detail-view`, `request-exchange-dialog`, `verify-old-item-dialog`, `send-exchange-shipment-modal`
- **Logic**: Customer requests exchange for an order item → verify old item returned → dispatch replacement → settle price difference. Exchange methods: `courier_replacement` (ship new item via courier) or `self_ship` (customer ships themselves).

### 7.16 Exchange Shipment Module
- **Status**: ✅ Built
- **Routes**: `/api/exchange-shipments/[id]/reserve`, `/dispatch`, `/cod-collected`, `/rto`, `/cancel`
- **Components**: `shipment-tracking-card`
- **Logic**: Replacement shipments have their own lifecycle (reserve → dispatch → deliver/RTO/cancel), separate from orders but reusing the same inventory functions.

### 7.17 Courier Integration Framework
- **Status**: ✅ Built (PostEx + Leopard live; TCS stub)
- **Routes**: `/api/integrations` (GET/POST), `/api/integrations/[id]/credentials`, `/disconnect`, `/set-default`, `/pickup-addresses`, `/pickup-addresses/sync`, `/api/integrations/logs`
- **Components**: `integrations-view`, `integration-logs-view`, `pickup-addresses-section`
- **Logic**:
  - `IntegrationProvider` master (postex, leopard, tcs, shopify, daraz)
  - `CompanyIntegration` — company's connection (credentials encrypted with AES-256-GCM via `INTEGRATION_ENCRYPTION_KEY`)
  - `executeLoggedIntegrationAction()` — wraps EVERY adapter call, logs to `IntegrationActionLog` with duration + response payload
  - `pingConnection()` — read-only connectivity test (uses `fetchOperationalCities` or `calculateRate`)
  - `testIntegrationConnection()` — called from UI "Test Connection" button

### 7.18 City & Address Book Module
- **Status**: ✅ Built
- **Routes**: `/api/couriers/[providerKey]/cities`, `/api/couriers/sync-cities`, `/api/couriers/match-city`, `/api/couriers/save-city-alias`, `/api/integrations/[id]/pickup-addresses`, `/pickup-addresses/sync`
- **Components**: `city-autocomplete`, `city-mismatch-resolver`, `pickup-addresses-section`
- **Logic**:
  - `CourierOperationalCity` — cached list of cities each courier serves (synced via `fetchOperationalCities()`)
  - **Auto-fetch missing cities**: when search returns 0 results, the UI automatically fires a `?live=true` request that calls `ensureCityCached()` → fetches full city list from courier API → bulk-inserts via `createMany({ skipDuplicates: true })` → re-runs search
  - `matchCity()` — 3-tier: learned aliases → exact match → fuzzy Levenshtein (70% threshold)
  - `revalidateCityAtBookingTime()` — final authoritative check at booking time with staleness guard (3h) + live fallback
  - `CourierPickupAddress` — pickup address book per integration (synced from courier or manually created)

### 7.19 Booking Workbench Module
- **Status**: ✅ Built
- **Routes**: `/api/booking-workbench/bookable`, `/book`, `/load-sheet-ready`, `/load-sheet`, `/load-sheets`, `/activity`
- **Components**: `booking-workbench-view`, `load-sheets-tab`
- **Logic**:
  - Shows all bookable orders (confirmed + tracking number null) + exchange shipments
  - "Upload Booking" — sequentially POSTs `/book` for each selected entity
  - `bookOrderWithCourier()` — single source of truth for booking logic (used by both workbench + auto-booking)
  - **Auto-booking**: if `courierBookingMode='automatic'`, order creation fires `maybeAutoBookOrder()` in the background (PostEx can take 50-100s)
  - **Load sheets**: generates a PDF manifest for multiple orders (PostEx `generateLoadSheet()`), stored locally in `public/uploads/courier-slips/`

### 7.20 Courier Status Tracking Module
- **Status**: ✅ Built (recently fixed — bulk API fallback + auto-poller added)
- **Routes**: `/api/orders/[id]/refresh-status` (single-order track), `/api/cron/poll-postex` (bulk poll)
- **Logic**:
  - **Auto-poller** (`instrumentation.ts`): starts on server boot, polls every 30 minutes via `setInterval`
  - **Bulk poll** (`pollPostExOrderStatuses`): fetches all active orders with tracking numbers → calls `trackBulkShipments()` → maps statuses → updates `courierSubStatus` + triggers transitions (dispatch/deliver/RTO/cancel)
  - **Bulk-to-single fallback**: if PostEx's bulk API returns HTTP 400 (intermittent bug), falls back to single-track per order
  - **Single-track** (`trackSingleOrderStatus`): called by "Refresh Courier Status" button — reliable single-order endpoint
  - **Status mapping** (`mapPostExStatus`): PostEx `transactionStatus` → FlowOps `courierSubStatus` + trigger flags (triggerDispatch, triggerDelivered, triggerRto)

### 7.21 Courier Cancel Module
- **Status**: ✅ Built
- **Routes**: `/api/courier-cancel`, `/api/couriers/postex/poll`
- **Components**: `cancel-courier-booking-button`
- **Logic**: Cancels a courier booking — calls adapter `cancelShipment()` + updates order status

### 7.22 Webhook Receiver Module
- **Status**: ✅ Built
- **Routes**: `/api/webhooks/[provider_key]/[webhook_endpoint_id]`
- **Logic**: Generic webhook receiver — routes by `provider_key` to the appropriate adapter's `parseStatusWebhook()`. Each `CompanyIntegration` gets a unique `webhookEndpointId` for security (only someone who knows the endpoint ID can push). Leopard webhook handler processes the full status array.

### 7.23 Order Scan Module
- **Status**: ✅ Built (recently fixed — markOrderPacked now transitions status)
- **Routes**: `/api/scan`, `/api/scan/reports`
- **Components**: `order-scan-view` (ScanStation)
- **Logic**:
  - Scan modes: `mark_processing`, `mark_packed`, `warehouse_handover`, `receive_return`, `locate_cancelled`, `cancel_via_scan`
  - Scans by tracking number → looks up order/exchange shipment → applies the mode's action
  - `mark_packed` → calls `markOrderPacked()` → sets `packedAt` + transitions `status` to `'processing'` (so the status badge updates)
  - `cancel_via_scan` → shows confirmation dialog before cancelling
  - `locate_cancelled` → if `physicalUnpackRequired`, shows unpack confirmation
  - Scan events logged to `ScanEvent` + audit log
  - Daily scan reports generated via cron → PDF stored in `public/uploads/scan-reports/`

### 7.24 Dashboard Module
- **Status**: ✅ Built
- **Routes**: `/api/dashboard`
- **Components**: `dashboard-home`
- **Logic**: KPI cards (total orders, pending, dispatched, delivered, RTO rate, revenue), recent activity, quick actions

### 7.25 Audit Log Module
- **Status**: ✅ Built
- **Routes**: `/api/audit-logs`
- **Components**: `audit-log-view`
- **Logic**: Every mutation calls `insertAuditLog()` (fire-and-forget). Audit logs are immutable (never update/delete). Filterable by action, entity, user, date range.

### 7.26 Form Drafts Module
- **Status**: ✅ Built
- **Routes**: `/api/drafts`, `/api/orders/drafts`, `/api/products/drafts`
- **Components**: `drafts-view`
- **Logic**: Autosaves form drafts (product create, order create) to `FormDraft` table so users don't lose progress on page refresh.

### 7.27 Settings Module
- **Status**: ✅ Built
- **Routes**: `/api/order-settings`, `/api/company`, `/api/organizations/[id]`
- **Components**: `settings-view`, `organization-view`, `company-settings-view`, `integrations-view`, `audit-log-view`
- **Logic**: Company settings (name, logo, currency, address, tax ID), order workflow settings (requireOrderConfirmation, courierBookingMode, defaultCourier, defaultDispatchLocation), organization settings.

---

## 8. API System (Complete Route Map)

### Conventions
- **All routes**: `export const runtime = 'nodejs'` + `export const dynamic = 'force-dynamic'`
- **Auth**: `getCurrentUser()` from `src/lib/session.ts` (dual-channel: Bearer header + cookie)
- **Workspace**: `getWorkspace()` from `src/lib/workspace.ts` (resolves active company)
- **Permissions**: `requirePermission(ctx, PERMISSIONS.XXX)` — throws 403 if lacking
- **Response**: `Response.json(data)` or `json(data, status)` helper
- **Error handling**: `handleError(err)` — `ApiError` → status code, else 500
- **Body parsing**: `readBody<T>(req)` — throws 400 on invalid JSON
- **Audit/metrics**: fire-and-forget `insertAuditLog()` + `insertMetricEvent()`

### Complete Route List (148 routes)

#### Auth (6)
| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/login` | Email + password login |
| POST | `/api/auth/register` | New user registration |
| POST | `/api/auth/logout` | Clear session |
| GET | `/api/auth/me` | Current session payload |
| POST | `/api/auth/forgot-password` | Send reset email |
| POST | `/api/auth/reset-password` | Reset password with token |

#### Onboarding (3)
| Method | Path | Description |
|---|---|---|
| GET | `/api/onboarding/invitations` | List pending invitations for user |
| POST | `/api/onboarding/create-company` | Create company (new user flow) |
| POST | `/api/onboarding/accept-invite` | Accept invitation by token |

#### Organizations & Companies (7)
| Method | Path | Description |
|---|---|---|
| POST | `/api/organizations/create` | Create new organization |
| PATCH/POST | `/api/organizations/[id]` | Update organization |
| POST | `/api/companies/create` | Create company under org |
| POST | `/api/companies/[id]/archive` | Archive company |
| GET/PATCH | `/api/company` | Get/update active company |
| GET | `/api/workspaces` | List user's workspaces |
| POST/GET | `/api/workspace/switch` | Switch active company |

#### Employees & Roles (5)
| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/employees` | List/invite employees |
| GET/PATCH | `/api/employees/[id]` | Get/update employee |
| POST | `/api/employees/[id]/terminate` | Terminate employee |
| GET/POST | `/api/roles` | List/create roles |
| PATCH/DELETE | `/api/roles/[id]` | Update/delete role |

#### Dashboard & Audit (2)
| Method | Path | Description |
|---|---|---|
| GET | `/api/dashboard` | Dashboard KPIs |
| GET | `/api/audit-logs` | List audit logs (filtered) |

#### Catalog (14)
| Method | Path | Description |
|---|---|---|
| GET | `/api/org/catalog` | Full org catalog |
| GET/POST | `/api/categories` | List/create categories |
| GET/POST | `/api/brands` | List/create brands |
| POST | `/api/catalog/seed-defaults` | Seed default attributes |
| GET | `/api/catalog/available-attributes` | Available attributes |
| POST | `/api/catalog/inline-attribute` | Create attribute inline |
| POST | `/api/catalog/inline-value` | Create attribute value inline |
| PATCH/DELETE | `/api/catalog/categories/[id]` | Update/delete category |
| PATCH/DELETE | `/api/catalog/brands/[id]` | Update/delete brand |
| GET/POST | `/api/catalog/attributes` | List/create attributes |
| PATCH/DELETE | `/api/catalog/attributes/[id]` | Update/delete attribute |
| GET/POST | `/api/catalog/attributes/[id]/values` | List/create attribute values |
| PATCH/DELETE | `/api/catalog/attribute-values/[id]` | Update/delete attribute value |

#### Products (24)
| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/products` | List/create products |
| POST | `/api/products/drafts` | Save product draft |
| POST | `/api/products/generate-stitched` | Generate stitched variant |
| GET/PATCH/DELETE | `/api/products/[id]` | Get/update/delete product |
| POST/DELETE | `/api/products/[id]/images` | Add/delete images |
| POST | `/api/products/[id]/subscribe` | Subscribe company to product |
| POST | `/api/products/[id]/promote` | Promote product |
| POST | `/api/products/[id]/demote` | Demote product |
| POST | `/api/products/[id]/pricing` | Set pricing |
| POST/DELETE | `/api/products/[id]/selective-access` | Grant/revoke access |
| GET | `/api/products/[id]/variant-groups` | List variant groups |
| POST | `/api/products/[id]/variant-groups/[parentValueId]/cost` | Set group cost |
| POST | `/api/products/[id]/variant-groups/[parentValueId]/weight` | Set group weight |
| POST | `/api/products/[id]/variant-groups/[parentValueId]/sale-price` | Set group price |
| POST | `/api/products/[id]/variants` | Create variant |
| POST | `/api/products/[id]/variants/generate` | Auto-generate variants |
| PATCH | `/api/products/[id]/variants/[variantId]` | Update variant |
| POST | `/api/products/[id]/variants/[variantId]/toggle` | Toggle variant active |
| POST | `/api/products/[id]/variants/[variantId]/override-price` | Override price |
| POST | `/api/products/[id]/variants/[variantId]/override-cost` | Override cost |
| POST | `/api/products/[id]/variants/[variantId]/override-weight` | Override weight |
| POST | `/api/products/[id]/variants/[variantId]/resync-price` | Resync price |
| POST | `/api/products/[id]/variants/[variantId]/resync-cost` | Resync cost |
| POST | `/api/products/[id]/variants/[variantId]/resync-weight` | Resync weight |

#### Inventory Locations (2)
| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/inventory-locations` | List/create locations |
| GET/PATCH/DELETE | `/api/inventory-locations/[id]` | Get/update/delete location |

#### Inventory Operations (8)
| Method | Path | Description |
|---|---|---|
| GET | `/api/inventory/dashboard` | Inventory dashboard |
| GET | `/api/inventory/summary` | Inventory summary |
| POST | `/api/inventory/opening-stock` | Set opening stock |
| POST | `/api/inventory/receive` | Receive stock (PO receipt) |
| POST | `/api/inventory/adjust` | Adjust stock |
| POST/GET | `/api/inventory/transfers` | Create/list transfers |
| POST | `/api/inventory/fulfill-mto` | Fulfill made-to-order |
| POST | `/api/inventory/receive-returned-stitched` | Receive returned stitched |

#### Suppliers (2)
| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/suppliers` | List/create suppliers |
| PATCH/DELETE | `/api/suppliers/[id]` | Update/delete supplier |

#### Purchase Orders (4)
| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/purchase-orders` | List/create POs |
| GET | `/api/purchase-orders/[id]` | Get PO |
| POST | `/api/purchase-orders/[id]/confirm` | Confirm PO |
| POST | `/api/purchase-orders/[id]/receive` | Receive PO |
| POST | `/api/purchase-orders/[id]/cancel` | Cancel PO |

#### Production Orders (2)
| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/production-orders` | List/create production orders |
| GET/PATCH | `/api/production-orders/[id]` | Get/update production order |

#### Supplier Returns (3)
| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/supplier-returns` | List/create supplier returns |
| PATCH | `/api/supplier-returns/[id]` | Update supplier return |
| POST | `/api/supplier-returns/[id]/dispute` | Dispute supplier return |

#### Stock Loss (7)
| Method | Path | Description |
|---|---|---|
| GET | `/api/stock-loss` | List losses |
| GET | `/api/stock-loss/[id]` | Get loss detail |
| GET | `/api/stock-loss/stats` | Loss statistics |
| POST | `/api/stock-loss/report-theft` | Report theft |
| POST | `/api/stock-loss/report-transit` | Report transit loss |
| POST | `/api/stock-loss/report-damaged` | Report damaged |
| POST | `/api/stock-loss/resolve` | Resolve loss |

#### Cycle Counts (2)
| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/cycle-counts` | List/create cycle counts |
| GET/PATCH | `/api/cycle-counts/[id]` | Get/update cycle count |

#### Returned Stitched (3)
| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/returned-stitched` | List/receive returned stitched |
| POST | `/api/returned-stitched/[id]` | Update returned stitched |
| GET | `/api/returned-stitched/stats` | Returned stitched stats |

#### Customers (7)
| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/customers` | List/create customers |
| POST | `/api/customers/backfill-stats` | Backfill cached stats |
| GET/PATCH | `/api/customers/[id]` | Get/update customer |
| POST | `/api/customers/[id]/phones` | Add phone |
| DELETE | `/api/customers/[id]/phones/[phoneId]` | Delete phone |
| POST | `/api/customers/[id]/addresses` | Add address |
| PATCH/DELETE | `/api/customers/[id]/addresses/[addressId]` | Update/delete address |

#### Orders — Core (2)
| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/orders` | List/create orders |
| GET | `/api/orders/[id]` | Get order detail |

#### Orders — Queues (7)
| Method | Path | Description |
|---|---|---|
| GET | `/api/orders/pending` | Pending confirmation queue |
| GET | `/api/orders/cancelled` | Cancelled orders |
| GET | `/api/orders/backordered` | Backordered orders |
| GET | `/api/orders/awaiting-production` | Awaiting MTO production |
| GET | `/api/orders/ready-to-dispatch` | Ready to dispatch |
| GET | `/api/orders/returns` | Returns queue |
| GET | `/api/orders/returns/review` | Returns review queue |

#### Orders — Lifecycle Actions (13)
| Method | Path | Description |
|---|---|---|
| POST | `/api/orders/[id]/confirm` | Confirm order |
| POST | `/api/orders/[id]/processing` | Mark processing |
| POST | `/api/orders/[id]/packed` | Mark packed |
| POST | `/api/orders/[id]/dispatch` | Dispatch order |
| POST | `/api/orders/[id]/delivered` | Mark delivered |
| POST | `/api/orders/[id]/cancel` | Cancel order |
| POST | `/api/orders/[id]/rto` | Process RTO return |
| POST | `/api/orders/[id]/cod-collected` | Mark COD collected |
| POST | `/api/orders/[id]/convert-payment` | Convert payment type |
| POST | `/api/orders/[id]/payment-proof` | Upload payment screenshot |
| POST | `/api/orders/[id]/refresh-status` | Refresh courier status |
| POST | `/api/orders/[id]/returns/review/dismiss` | Dismiss return review |
| POST | `/api/orders/[id]/returns/review/correct` | Correct return condition |

#### Order Settings (1)
| Method | Path | Description |
|---|---|---|
| GET/PUT | `/api/order-settings` | Get/update order settings |

#### Exchanges (10)
| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/exchanges` | List/create exchanges |
| GET | `/api/exchanges/overdue` | Overdue exchanges |
| GET | `/api/exchanges/[id]` | Get exchange detail |
| POST | `/api/exchanges/[id]/cancel` | Cancel exchange |
| POST | `/api/exchanges/[id]/verify-old-item` | Verify old item returned |
| POST | `/api/exchanges/[id]/dispatch-new-item` | Dispatch new item |
| POST | `/api/exchanges/[id]/dispatch-replacement` | Dispatch replacement |
| POST | `/api/exchanges/[id]/confirm-shipped` | Confirm customer shipped |
| POST | `/api/exchanges/[id]/mark-not-returned` | Mark not returned |
| POST | `/api/exchanges/[id]/settle-price-difference` | Settle price difference |

#### Exchange Shipments (5)
| Method | Path | Description |
|---|---|---|
| POST | `/api/exchange-shipments/[id]/reserve` | Reserve stock |
| POST | `/api/exchange-shipments/[id]/dispatch` | Dispatch shipment |
| POST | `/api/exchange-shipments/[id]/cod-collected` | Mark COD collected |
| POST | `/api/exchange-shipments/[id]/rto` | Process RTO |
| POST | `/api/exchange-shipments/[id]/cancel` | Cancel shipment |

#### Booking Workbench (6)
| Method | Path | Description |
|---|---|---|
| GET | `/api/booking-workbench/bookable` | List bookable orders + shipments |
| POST | `/api/booking-workbench/book` | Book single order/shipment |
| GET | `/api/booking-workbench/load-sheet-ready` | List load-sheet-ready entities |
| POST | `/api/booking-workbench/load-sheet` | Generate load sheet |
| GET | `/api/booking-workbench/load-sheets` | List load sheets |
| GET | `/api/booking-workbench/activity` | Booking activity log |

#### Courier Cancel (1)
| Method | Path | Description |
|---|---|---|
| POST | `/api/courier-cancel` | Cancel courier booking |

#### Couriers — City & Address (5)
| Method | Path | Description |
|---|---|---|
| GET | `/api/couriers/[providerKey]/cities` | Search cities (supports `?live=true`) |
| POST | `/api/couriers/sync-cities` | Manual city sync |
| POST | `/api/couriers/match-city` | 3-tier city match |
| POST | `/api/couriers/save-city-alias` | Save city alias |
| POST | `/api/couriers/postex/poll` | Manual PostEx poll trigger |

#### Couriers — Load Sheet (1)
| Method | Path | Description |
|---|---|---|
| POST | `/api/couriers/postex/load-sheet` | Generate PostEx load sheet |

#### Integrations (8)
| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/integrations` | List/create integrations |
| GET | `/api/integrations/logs` | List integration action logs |
| PATCH | `/api/integrations/[id]/credentials` | Update credentials |
| POST | `/api/integrations/[id]/disconnect` | Disconnect integration |
| POST | `/api/integrations/[id]/set-default` | Set as default |
| GET/POST | `/api/integrations/[id]/pickup-addresses` | List/create pickup addresses |
| POST | `/api/integrations/[id]/pickup-addresses/sync` | Sync from courier |
| PATCH/DELETE | `/api/integrations/[id]/pickup-addresses/[addressId]` | Update/delete address |

#### Scan (2)
| Method | Path | Description |
|---|---|---|
| POST | `/api/scan` | Process scan event |
| GET/POST | `/api/scan/reports` | List/generate scan reports |

#### Webhooks (1)
| Method | Path | Description |
|---|---|---|
| POST | `/api/webhooks/[provider_key]/[webhook_endpoint_id]` | Generic webhook receiver |

#### Cron (4)
| Method | Path | Schedule | Description |
|---|---|---|---|
| POST/GET | `/api/cron/sync-cities` | `0 */3 * * *` (3h) | Sync courier cities |
| POST/GET | `/api/cron/poll-postex` | `*/30 * * * *` (30min) | Poll PostEx statuses |
| POST/GET | `/api/cron/poll-leopard-safety-net` | `0 */12 * * *` (12h) | Leopard safety-net poll |
| POST/GET | `/api/cron/generate-scan-reports` | `0 1 * * *` (daily 1AM) | Generate scan reports |

---

## 9. Backend Server Actions

All server-side business logic lives in `src/lib/actions/*.ts` (18 files). API routes are thin wrappers that call these actions.

### Key Action Files

| File | Key Functions | Purpose |
|---|---|---|
| `order.actions.ts` | `createManualOrder`, `confirmOrder`, `convertPaymentStatus`, `cancelOrder`, `performOrderDispatch`, `markOrderProcessing`, `markOrderPacked`, `markOrderDelivered`, `reserveOrderStock` (helper) | Order lifecycle + inventory side-effects |
| `order-return.actions.ts` | `processOrderReturn`, `correctReturnItemCondition`, `dismissReturnReview` | RTO return processing + inventory restock |
| `backorder.actions.ts` | `checkAndFulfillBackorders` | Auto-fulfill backorders when stock arrives |
| `customer.actions.ts` | `createCustomer`, `createCustomerInternal`, `updateCustomerStats`, `markAddressAsUsed`, `matchOrCreateExternalCustomer`, `flagCustomer` | Customer CRUD + stats |
| `exchange.actions.ts` | `requestExchange`, `verifyOldItem`, `dispatchReplacement`, `settlePriceDifference` | Exchange lifecycle |
| `exchange-shipment.actions.ts` | `performExchangeShipmentDispatch`, `performExchangeShipmentRto`, `markExchangeShipmentDelivered` | Exchange shipment lifecycle |
| `booking.actions.ts` | `bookOrderWithCourier`, `maybeAutoBookOrder` | Courier booking (single source of truth) |
| `load-sheet.actions.ts` | `generateLoadSheet`, `listLoadSheetReady`, `listLoadSheetHistory` | Load sheet generation |
| `courier-cancel.actions.ts` | `cancelCourierBooking` | Cancel courier booking |
| `courier-address-book.actions.ts` | `createPickupAddress`, `syncPickupAddresses` | Pickup address CRUD |
| `city-sync.actions.ts` | `syncCourierOperationalCities`, `syncAllCourierCities` | City sync |
| `integration.actions.ts` | `connectIntegration`, `disconnectIntegration`, `testIntegrationConnection` | Integration management |
| `postex-status-poll.actions.ts` | `pollPostExOrderStatuses`, `trackSingleOrderStatus` | PostEx status polling |
| `leopard-webhook.actions.ts` | `processLeopardWebhookUpdates`, `pollLeopardOrderStatuses` | Leopard webhook + safety-net poll |
| `scan.actions.ts` | `processScan` | Scan event processing |
| `scan-report.actions.ts` | `generateDailyScanReport` | Daily scan report PDF |
| `drafts/save-draft.ts` | `saveDraft`, `getDrafts`, `deleteDraft` | Form draft autosave |
| `order-settings.actions.ts` | `getOrderSettings`, `updateOrderSettings` | Order workflow settings |

### Inventory Module (`src/lib/inventory.ts`)

The inventory module is the ONLY sanctioned way to modify `InventoryPool`. Key functions:

| Function | Transaction Type | Effect |
|---|---|---|
| `processInventoryTransaction(input)` | (varies) | Core — find-or-create pool, validate, mutate, ledger, WAC recalc |
| `reserveStockForOrder(input)` | `order_reserved` | `reserved += qty` |
| `unreserveStockForOrder(input)` | `order_unreserved` | `reserved -= qty` (clamped to 0) |
| `dispatchOrder(input)` | `sale_dispatched` | `onHand -= qty`, `reserved -= qty`, locks COGS at avgCost |
| `restockOrderForRto(orderId, ctx)` | `return_resellable` / `return_stitched_received` | Restocks RTO order (session-free, for cron/webhook) |
| `checkAndFulfillMadeToOrderVariant(...)` | (varies) | MTO: returns existing_stock or fresh_production |
| `checkReturnedStockAvailability(...)` | — | Check returned-stitched bucket |
| `getProductInventorySummary(...)` | — | Read-only summary |
| `incrementIncomingStock` / `decrementIncomingStock` | — | PO incoming stock |
| `quarantineStock` / `releaseQuarantine` | — | Quarantine |

---

## 10. Integration / Courier Adapter Framework

### Architecture
```
API Route / Server Action
  ↓
executeLoggedIntegrationAction({ fn: () => adapter.method() })
  ↓ logs to IntegrationActionLog
CourierAdapter (interface)
  ↓
PostExAdapter | LeopardAdapter | TcsAdapter (stub)
  ↓
External Courier API
```

### `CourierAdapter` Interface (`src/lib/integrations/types.ts`)

**Required methods:**
| Method | Purpose |
|---|---|
| `bookShipment(input)` | Book a shipment → returns tracking number |
| `trackShipment(trackingNumber)` | Track single shipment |
| `cancelShipment(trackingNumber)` | Cancel shipment |
| `calculateRate(input)` | Get shipping rate (stub in both PostEx + Leopard) |
| `parseStatusWebhook(rawPayload)` | Parse webhook payload |
| `verifyWebhookSignature(rawBody, signature, secret)` | Verify webhook signature |

**Optional methods (capability detection):**
| Method | Used by |
|---|---|
| `fetchOperationalCities?()` | City sync cron |
| `createPickupAddress?(input)` | Address book API |
| `fetchExistingPickupAddresses?()` | Address sync |
| `trackBulkShipments?(trackingNumbers[])` | PostEx bulk poll |
| `generateLoadSheet?(trackingNumbers[], pickupAddress?)` | Load sheet generation |
| `pingConnection?()` | Test connection |

### Registered Adapters (`src/lib/integrations/registry.ts`)

| Provider | Type | Status | Notes |
|---|---|---|---|
| `postex` | Courier | **live** | Full implementation — booking, tracking (single + bulk with fallback), cities, pickup addresses, load sheets, cancellation |
| `leopard` | Courier | **live** | Full implementation — booking, tracking, cities (with shipmentTypes), createShipper, cancellation |
| `tcs` | Courier | `framework_ready` | Stub — methods throw "not implemented" |
| `shopify` | Ecommerce | `framework_ready` | Stub |
| `daraz` | Ecommerce | `framework_ready` | Stub |

### PostEx Status Mapping (`src/lib/integrations/couriers/postex.status-map.ts`)

| PostEx `transactionStatus` | FlowOps `courierSubStatus` | Trigger |
|---|---|---|
| `Unbooked` | `slip_generated` | — |
| `Booked` | `pickup_requested` | — |
| `Picked By PostEx` | `picked_up` | `triggerDispatch` → `performOrderDispatch` |
| `PostEx WareHouse` | `at_warehouse` | — |
| `En-Route to PostEx warehouse` | `en_route` | — |
| `Out For Delivery` | `out_for_delivery` | — |
| `Delivered` | `delivered` | `triggerDelivered` |
| `Returned` | `returned` | `triggerRto` → `restockOrderForRto` |
| `Out For Return` | `out_for_return` | — |
| `Attempted` | `attempted` | `needsShipperAdvice` |
| `Delivery Under Review` | `under_review` | `needsShipperAdvice` |
| `Un-Assigned By Me` | `cancelled_by_merchant` | `orderStatus='cancelled'` |
| `Expired` | `expired` | `orderStatus='cancelled'` |

### Leopard Status Mapping (`src/lib/integrations/couriers/leopard.status-map.ts`)

Leopard uses 2-character status codes: RC, SP, DP, AR, AC, DV, PN1, PN2, RO, RN1, RN2, NR, RW, DW, RS, DR — all mapped to FlowOps canonical subStatuses.

---

## 11. Frontend Architecture

### 11.1 Single-Page App Structure

The entire app is a **single Next.js page** at `/` (`src/app/page.tsx`). All "pages" are route cases inside a `switch(route.name)` in `renderRoute()`.

**Code-splitting strategy** (Step 1 optimization — August 2026):
All 70+ view components are lazy-loaded via `next/dynamic` with `ssr: false`:
```typescript
const ProductsView = dynamic(
  () => import('@/components/products/products-view').then(m => ({ default: m.ProductsView })),
  { ssr: false, loading: LoadingFallback }
)
```
This splits the bundle into ~95 chunks: 5 root main (always loaded) + 90 lazy chunks (loaded on-demand when the user navigates to that route). First Load JS dropped from 3,148 KB → 1,070 KB (66% reduction).

**Route-aware LoadingFallback** (renders PageHeader text immediately at Suspense boundary):
```typescript
const ROUTE_METADATA: Record<string, { title: string; description?: string }> = {
  products: { title: 'Products', description: 'Manage your product catalog...' },
  // ... 55 routes total
}
const LoadingFallback = () => {
  const route = useAppStore((s) => s.route)
  const meta = ROUTE_METADATA[route.name]
  // Renders PageHeader + skeleton grid — LCP text paints immediately
}
```
This makes the LCP text element paint as soon as the Suspense boundary renders, NOT after the lazy chunk downloads.

> ⚠️ **IMPORTANT — Do NOT add `ROUTE_CHUNK_LOADERS`**: A previous attempt to "prefetch" route chunks in parallel with session hydration used a module-scope map of 55 `() => import(...)` functions. Turbopack statically analyzed all 55 targets and created DUPLICATE chunks (+55 chunks, +1,303 KB). This was removed. The ONLY place each route's code should be imported is the `dynamic()` call. Do not reintroduce module-scope import maps.

**Pre-switch gating logic:**
1. **Hydration via TanStack Query**: On mount, `useQuery(['session', 'me'])` fires `GET /api/auth/me`. This query has a **deliberate per-query override**: `refetchOnWindowFocus: true` (the global default is `false`). Session validity (active employee status, permissions, platform-level access) is the one place where catching a change quickly after the user returns to a background tab matters — e.g., an employee terminated while their tab sat in the background should see their UI reflect that promptly on refocus. Every other view stays on the global `false` default because they display data, not gate security-sensitive UI. The query result is wired into `useAppStore.setSession()` via a `useEffect` — first fetch shows a loading spinner, background refetches update the store silently (only if data changed). If URL has `?view=...`, restores that route. Listens to `popstate` for browser back/forward.
2. **Loading screen**: `<Loader2 className="animate-spin">` while `!hydrated` (first session fetch only — background refetches do NOT show a spinner).
3. **Unauthenticated** (`!user`): login/register/forgot/reset forms, all wrapped in `AuthShell`.
4. **Authenticated but not onboarded**: `OnboardingView` / `CreateOrganizationView` / `CreateCompanyView`.
5. **Authenticated + onboarded**: `<DashboardShell>{renderRoute(route)}</DashboardShell>`.

**62 named routes** in the `AppRoute` discriminated union, each mapping to a component:

| Category | Routes |
|---|---|
| Auth (4) | `login`, `register`, `forgot`, `reset` |
| Onboarding (4) | `onboarding`, `accept-invite`, `create-organization`, `create-company` |
| Core (12) | `dashboard`, `employees`, `employees-invite`, `employee-detail`, `roles`, `role-edit`, `organization`, `company-settings`, `settings`, `integrations`, `integration-logs`, `audit` |
| Payroll (2) | `payroll`, `payroll-run-detail` |
| Products (7) | `products`, `product-create`, `product-drafts`, `product-detail`, `product-settings`, `returned-stitched`, `org-catalog` |
| Inventory (15) | `inventory`, `inventory-locations`, `inventory-location-detail`, `inventory-suppliers`, `inventory-supplier-detail`, `inventory-receive`, `inventory-adjust`, `inventory-transfer`, `inventory-purchase-orders`, `inventory-po-create`, `inventory-po-detail`, `inventory-supplier-returns`, `inventory-losses`, `inventory-loss-detail`, `inventory-production-orders`, `inventory-cycle-counts` |
| OMS (18) | `orders`, `order-create`, `order-drafts`, `order-detail`, `orders-pending-confirmation`, `orders-backordered`, `orders-awaiting-production`, `orders-ready-to-dispatch`, `orders-returns`, `orders-returns-review`, `orders-cancelled`, `exchanges`, `exchange-detail`, `customers`, `customer-detail`, `order-workflow-settings`, `booking-workbench`, `order-scan` |

### 11.2 State Management (Zustand)

**Single store**: `useAppStore` (`src/stores/app-store.ts`, 171 lines).

| State Field | Type | Purpose |
|---|---|---|
| `user` | `UserPublic \| null` | Logged-in user |
| `activeCompany` | `CompanyPublic \| null` | Current workspace |
| `companies` | `CompanyPublic[]` | All companies user has access to |
| `employee` | `{ id, roleTier, roleName, systemRoleKey, permissions[], isElevated } \| null` | Permission context |
| `hydrated` | `boolean` | Session bootstrap complete |
| `loading` | `boolean` | Generic loading flag |
| `route` | `AppRoute` | Current route (default: `{ name: 'login' }`) |

| Action | Behavior |
|---|---|
| `setSession(s)` | Sets user/company/companies/employee + `hydrated=true` |
| `navigate(route)` | Sets route + scrolls to top + pushes to browser history via `pushRouteToURL()` |
| `reset()` | Clears all session fields + removes token from localStorage + redirects to login |

**`useCan()` hook**: Returns a function `(key: string) => boolean`. Elevated roles (Owner/Founder/Co-Founder/Investor) always return `true`. Standard roles check `employee.permissions.includes(key)`.

### 11.3 URL Sync (`src/lib/routing/url-sync.ts`)

**Strategy**: Query-string navigation. Routes are encoded as URL query params: `/?view=<route_name>&id=<optional>&token=<optional>`.

| Function | Purpose |
|---|---|
| `routeToQuery(route)` | Serializes an `AppRoute` to `URLSearchParams` |
| `queryToRoute()` | Reads `window.location.search`, validates `view` against known route lists |
| `pushRouteToURL(route)` | `window.history.pushState()` — new history entry |
| `replaceRouteInURL(route)` | `window.history.replaceState()` — used on initial load + logout |

**Known bug**: `payroll-run-detail` is missing from `routesWithId` in `url-sync.ts` — navigating to it won't carry the `id` in the URL, so a refresh would lose context.

### 11.4 API Client (`src/lib/api-client.ts`)

- **Token storage**: `localStorage` key `'flowops_session_token'`
- **Request flow**: `fetch(url, { credentials: 'include', cache: 'no-store', headers: { Authorization: Bearer <token> } })`
- **Dual-channel auth**: Bearer header (works in iframes/cross-origin) + cookie fallback
- **Error handling**: Throws `FetchError(status, message)` on non-2xx, reads `body.error` for server message
- **Exports**: `api.get/post/put/patch/delete` typed helpers
- **No retry, no timeout, no abort, no multipart/form-data helper**

### 11.5 Component Inventory — 153 files (101 non-UI + 52 shadcn/ui)

#### `auth/` (5 files)
| Component | Description | API Calls |
|---|---|---|
| `auth-shell.tsx` | Split-screen layout (brand panel + form panel) | — |
| `login-form.tsx` | Email/password login | `POST /api/auth/login` |
| `register-form.tsx` | New account registration | `POST /api/auth/register` |
| `forgot-password-form.tsx` | Send reset email | `POST /api/auth/forgot-password` |
| `reset-password-form.tsx` | Set new password with token | `POST /api/auth/reset-password` |

#### `layout/` (5 files)
| Component | Description |
|---|---|
| `dashboard-shell.tsx` | Top-level layout: sidebar (w-60) + sticky header (h-16, backdrop-blur) + main scroll area (max-w-7xl) |
| `sidebar.tsx` | Desktop left nav with 3 collapsible groups (Products/Inventory/Orders) + 14 flat items. Permission-gated. Draft-count badges (60s refetch). |
| `navbar.tsx` | User menu dropdown (avatar, name, role, logout). Re-exports WorkspaceSwitcher. |
| `mobile-nav.tsx` | Sheet-based nav (md:hidden), flattened list, closes on navigate |
| `brand.tsx` | FlowOpsLogo SVG (3 nodes + curved connector, 40×40 viewBox) |

#### `dashboard/` (1 file)
| Component | Description | API |
|---|---|---|
| `dashboard-home.tsx` | 4 stat cards + recent activity + metrics | `GET /api/dashboard` |

#### `onboarding/` (6 files)
| Component | Description |
|---|---|
| `onboarding-view.tsx` | Routes between selector / create / accept based on invitations |
| `onboarding-selector.tsx` | Choose "create company" or "accept invite" |
| `create-organization-view.tsx` | Combined org+company creation (3-step wizard) |
| `create-company-view.tsx` | Add company to existing org (3-step wizard) |
| `create-company-wizard.tsx` | Reusable 3-step wizard with zod validation |
| `accept-invite-card.tsx` | Card UI for accepting a single invitation |

#### `employees/` (7 files)
| Component | Description | Key Features |
|---|---|---|
| `employees-view.tsx` | Table with search + 4 filters (status/role/designation/department) | `useMemo`, manual `api.get` (tech debt) |
| `invite-employee-view.tsx` | Invite form with designation dropdown auto-defaulting role | |
| `employee-detail-view.tsx` | 5-tab profile: Overview, Access, Performance, Salary, My Payslips | Tabs only for `isSelf` |
| `employee-status-badge.tsx` | Colored badge for active/suspended/terminated/on_leave | |
| `salary-tab.tsx` | Salary profile + commission rules + live monthly preview | 5 `useQuery`, `useMemo` |
| `performance-tab.tsx` | Order funnel analytics with recharts BarChart + date range filter | 2 `useQuery`, `useMemo` |
| `my-payslips-tab.tsx` | Employee-facing payslip history + PDF download | 3 `useQuery`, `fetch()` for PDF binary |

#### `roles/` (3 files)
| Component | Description |
|---|---|
| `roles-view.tsx` | Role list + create/delete dialogs |
| `role-edit-view.tsx` | Edit role name/permissions + ordersDataScope toggle (2-option card) |
| `permission-key-selector.tsx` | Collapsible checkbox group driven by `PERMISSION_GROUPS` |

#### `payroll/` (3 files)
| Component | Description | Key Features |
|---|---|---|
| `payroll-view.tsx` | Tabbed: Payroll Runs list + Advances tab. Generate run dialog. | 4 `useQuery` |
| `payroll-run-detail-view.tsx` | Payslips table + finalize + mark-all-paid + per-payslip adjust dialog + mark-paid dialog | 5 `useMutation` |
| `advances-view.tsx` | Advances list + record dialog (lump_sum/installments) | 3 `useQuery` |

#### `products/` (13 files)
| Component | Description | Key Features |
|---|---|---|
| `products-view.tsx` | **Responsive table (desktop) + stacked card list (mobile)** — switches at `md` breakpoint via `hidden md:block` / `block md:hidden`. Desktop table has 8 columns (Img, Product, Type, Status, Variants, Tags, Price Range, Actions) with progressive column visibility (`lg`/`xl`). Mobile shows full-width compact cards. All sub-components (`ProductsTable`, `ProductTableRow`, `ProductMobileCard`) wrapped in `memo()`. | `useQuery`, `useMemo`, 3 `memo` components |
| `product-create-view.tsx` | 2321-line creation wizard with draft autosave. **Scroll-to-top on step change** (added to prevent users landing at the bottom of step 3). | 7 `useQuery`, `useMemo`, `useCallback`, `useFormGuard` |
| `product-detail-view.tsx` | Tabs: variants, pricing, images, inventory | 16 `useQuery`/`useMutation` |
| `catalog-settings-view.tsx` | 2289-line tabbed CRUD: Categories, Brands, Attributes, Values | 22 `useQuery`/`useMutation`, `useMemo` |
| `parent-child-variant-table.tsx` | Variant table with override/resync/toggle | 9 `useQuery`, `useMemo` |
| `client-side-parent-child-variant-table.tsx` | Pure local-state variant table for creation wizard | `useMemo` |
| `variant-table-parts.tsx` | Shared presentational sub-components | — |
| `attribute-selector.tsx` | Multi-select with inline create | 5 `useQuery`, `useMemo`, `useCallback`, `useRef` |
| `returned-stitched-view.tsx` | Returned-stitched inventory management | 8 `useQuery` |
| `org-catalog-view.tsx` | Org-level catalog view (elevated only) | 8 `useQuery` |
| `fulfillment-type-badge.tsx` | Stock Based / Made to Order badge | — |
| `product-scope-badge.tsx` | Private/Org/Selective/Archived badge | — |
| `returned-stock-banner.tsx` | Inline banner for returned-stitched stock | 2 `useQuery` |

#### `inventory/` (17 files)
| Component | Description | Key Features |
|---|---|---|
| `inventory-dashboard-view.tsx` | KPI cards + low/out-of-stock/overstock tables | `useMemo`, 2 `useQuery` |
| `locations-view.tsx` | CRUD for inventory locations | 8 `useQuery`, `useMemo` |
| `location-detail-view.tsx` | Per-location stock levels + transfers | 2 `useQuery` |
| `suppliers-view.tsx` | Suppliers CRUD | 6 `useQuery`, `useMemo` |
| `supplier-detail-view.tsx` | Supplier profile + PO history + edit | 5 `useQuery`, `useMemo` |
| `receive-stock-view.tsx` | Receive PO stock into a location | 5 `useQuery`, `useMemo` |
| `adjust-stock-view.tsx` | Manual stock +/- adjustment | 6 `useQuery`, `useMemo` |
| `transfer-stock-view.tsx` | Inter-location transfer | 6 `useQuery`, `useMemo` |
| `purchase-orders-view.tsx` | PO list with status filter | 2 `useQuery` |
| `po-create-view.tsx` | Create PO with line items | 7 `useQuery`, `useMemo` |
| `po-detail-view.tsx` | PO detail with confirm/cancel/receive | 6 `useQuery`, `useMemo` |
| `supplier-returns-view.tsx` | Returns to supplier + dispute flow | 9 `useQuery` |
| `production-orders-view.tsx` | MTO production orders + status transitions | 5 `useQuery` |
| `losses-view.tsx` | Stock losses: damaged/theft/transit + resolve (2249 lines) | 12 `useQuery` |
| `loss-detail-view.tsx` | Loss detail with resolve action | 5 `useQuery` |
| `cycle-counts-view.tsx` | Cycle count creation + workflows (2249 lines) | 11 `useQuery`, `useMemo` |

#### `orders/` (24 files)
| Component | Description | Key Features |
|---|---|---|
| `_shared.ts` | Helpers: `formatPKR`, `formatDate`, `badgeForStatus`, `ORDER_STATUS_BADGE` | — |
| `orders-view.tsx` | Master orders list (2599 lines) with recharts Bar+Line charts, customer/product autocomplete | 8 `useQuery`, `useMemo`, `useCallback`, 300ms debounce |
| `order-create-view.tsx` | 2390-line creation wizard with draft autosave, customer search, address selection | 7 `useQuery`, `useMemo`, `useCallback`, `useFormGuard` |
| `order-detail-view.tsx` | 2040-line detail with 9 mutations (confirm/dispatch/deliver/cancel/rto/etc.) | 13 `useQuery`/`useMutation`, `useMemo` |
| `orders-pending-confirmation-view.tsx` | Confirm/cancel/convert-payment queue | 7 `useQuery`, `useMemo` |
| `orders-backordered-view.tsx` | Backordered item queue (collapsible) | 2 `useQuery`, `useMemo` |
| `orders-awaiting-production-view.tsx` | MTO items grouped by production status | 2 `useQuery` |
| `orders-ready-to-dispatch-view.tsx` | Bulk dispatch with checkbox selection | 5 `useQuery`, `useMemo` |
| `orders-returns-view.tsx` | RTO list with review flags | 2 `useQuery`, `useMemo` |
| `orders-returns-review-view.tsx` | Per-item review: dismiss or correct | 5 `useQuery`, `useMemo` |
| `orders-cancelled-view.tsx` | Cancelled orders list | 2 `useQuery` |
| `exchanges-view.tsx` | Exchange list with bulk actions | 7 `useQuery`, `useMemo` |
| `exchange-detail-view.tsx` | Exchange detail with shipment cards + settlement | 5 `useQuery` |
| `customers-view.tsx` | Customer list with flagging + search debounce | 4 `useQuery` |
| `customer-detail-view.tsx` | Customer profile: phones, addresses, recent orders, flag | 12 `useQuery` |
| `order-workflow-settings-view.tsx` | Configure order workflow + courier defaults | 6 `useQuery` |
| `booking-workbench-view.tsx` | 3-tab bulk booking: Orders / Shipments / Activity | 6 `useQuery` |
| `order-scan-view.tsx` | Barcode scanner with 6 modes + reports + PDF download | 7 `useQuery` |
| `load-sheets-tab.tsx` | Generate + download pickup manifests | 6 `useQuery` |
| `cancel-courier-booking-button.tsx` | Reusable confirm-then-cancel button | 2 `useQuery` |
| `request-exchange-dialog.tsx` | Inline exchange request from order detail | 5 `useQuery`, `useMemo` |
| `send-exchange-shipment-modal.tsx` | Dispatch replacement shipment (6-step) | 7 `useQuery` |
| `verify-old-item-dialog.tsx` | Verify condition of returned old item | 3 `useQuery` |
| `shipment-tracking-card.tsx` | Read-only shipment card (status, tracking, timestamps) | — |

#### `couriers/` (3 files)
| Component | Description | Key Features |
|---|---|---|
| `city-autocomplete.tsx` | City search with live-fallback when cache misses | 3 `useQuery`, 200ms debounce, auto `?live=true` on 0 results |
| `city-mismatch-resolver.tsx` | Fuzzy-match suggestions + manual fallback | 2 `useQuery` |
| `pickup-addresses-section.tsx` | Pickup address CRUD embedded in integrations card | 7 `useQuery` |

#### `customers/` (5 files)
| Component | Description | Key Features |
|---|---|---|
| `CustomerSearchAutocomplete.tsx` | Debounced phone/name search dropdown | 2 `useQuery`, `useCallback`, `useMemo`, `useRef`, 300ms debounce |
| `CreateCustomerForm.tsx` | Multi-phone / multi-address creation form | 2 `useQuery` |
| `AddressSelector.tsx` | Saved-address radio group + inline new-address with CityAutocomplete | — |
| `types.ts` | Shared DTOs + helpers (`formatLastUsed`, `PLATFORM_LABELS`) | — |
| `index.ts` | Barrel re-exports | — |

#### `settings/` (6 files)
| Component | Description |
|---|---|
| `settings-view.tsx` | Personal profile card (read-only) |
| `organization-view.tsx` | Org details + companies list + archive |
| `company-settings-view.tsx` | Company profile, tax IDs, currency, logo |
| `audit-log-view.tsx` | Audit log table with filters + pagination |
| `integrations-view.tsx` | Courier integration cards: connect/disconnect/set-default |
| `integration-logs-view.tsx` | Integration call log with expandable rows |

#### `workspace/` (1 file)
| Component | Description | Key Features |
|---|---|---|
| `workspace-switcher.tsx` | Dropdown switcher for org→company tree | **Optimistic updates** (`setQueryData`), **prefetch** (`prefetchQuery` for dashboard), **targeted invalidation** (5 specific keys) |

#### `shared/` (2 files)
| Component | Description |
|---|---|
| `drafts-view.tsx` | Reusable drafts list (products + orders) with restore/delete |
| `unsaved-changes-modal.tsx` | AlertDialog: Save Draft / Discard / Keep Editing |

#### `ui/` (52 shadcn/ui components)
Standard shadcn/ui (New York style) + 4 custom FlowOps components:
- `country-selector.tsx` — Pakistan-aware country dropdown
- `currency-selector.tsx` — currency dropdown
- `initials-avatar.tsx` — avatar with auto initials
- `logo-upload.tsx` — image upload with preview
- `chart.tsx` — recharts wrapper

### 11.6 Theme System

- **Provider**: `next-themes` with `attribute="class"`, `defaultTheme="light"`, `enableSystem={false}` (does NOT auto-detect OS preference)
- **No theme toggle UI exists** — dark mode is defined but not user-accessible
- **CSS**: Tailwind v4 with `@theme inline` mapping. 28 CSS variables in OKLCH color space.
- **Primary color**: Emerald (`oklch(0.52 0.13 165)`) — distinctive, NOT blue/indigo per design rules
- **Sidebar**: Dark navy (`oklch(0.17 0.015 250)`) in light mode
- **Custom utilities**: `.scrollbar-thin` (8px scrollbar), `.bg-grid` (radial-gradient dot pattern for AuthShell)
- **Fonts**: Geist Sans + Geist Mono (via `next/font/google`)

### 11.7 Performance Analysis

#### Bundle metrics (latest — August 2026)

| Metric | Value |
|---|---|
| First Load JS | **1,070 KB** (was 3,148 KB pre-code-split — 66% reduction) |
| Root main JS (5 chunks) | 400 KB |
| Polyfill | 109 KB |
| Page shell (page.tsx + DashboardShell + LoadingFallback) | 560 KB |
| Total JS (all 95 chunks) | 4,665 KB |
| Total CSS | 167 KB |
| JS chunk count | 95 (was 10 pre-split) |
| node_modules size | 1.2 GB (was 1.3 GB before dead dep removal) |
| `dependencies` count | 60 (was 70 before removing 10 dead deps) |

#### What's optimized ✅
- **Code-splitting**: All 70+ views lazy-loaded via `next/dynamic` with `ssr: false`. 95 chunks total (5 upfront + 90 lazy).
- **Route-aware LoadingFallback**: Renders PageHeader + skeleton at Suspense boundary — LCP text paints immediately without waiting for chunk download.
- **`React.memo`**: Used on leaf components in 6 largest views (orders-view, order-create-view, product-create-view, catalog-settings-view, losses-view, cycle-counts-view) + products-view table components.
- **TanStack Query**: ALL 70 data-fetching views use `useQuery`/`useMutation` (6 migrated from raw `useEffect`+`api.get()` in Step 3). Global `staleTime: 30_000`, `refetchOnWindowFocus: false`, `retry: 1`. 100+ per-query overrides (10s for detail pages, 60s for slow-changing data, 15s for queue views).
- **Zustand atomic subscriptions**: `useAppStore((s) => s.field)` — only re-renders when the specific field changes.
- **`useMemo`**: Used in 41+ component files for expensive computations.
- **`useCallback`**: Used in 8+ files for stable handler references.
- **Debounced search**: 300ms debounce on customer/product/city autocomplete (7 instances).
- **Optimistic workspace switch**: `setQueryData` flips `is_active_workspace` before server responds.
- **Targeted cache invalidation**: Workspace switcher invalidates exactly 6 keys (not whole cache): `['dashboard']`, `['employees']`, `['roles']`, `['audit-logs']`, `['company']`, and `['session', 'me']` (added so the session refetches immediately after activeCompanyId changes, not waiting for next focus event).
- **Prefetch**: Dashboard data prefetched after workspace switch.
- **Fire-and-forget audit/metric writes**: Non-blocking DB writes (see §9).

#### Known performance issue ⚠️
- ~~**`/api/auth/me` takes 500-1000ms**~~ **FIXED (Phase 1)**: `buildSessionPayload()` now uses a single raw SQL JOIN (`prisma.$queryRaw`) instead of 5-6 sequential Prisma queries. Latency reduced from ~696ms avg to ~210ms warm (67% faster). The raw SQL JOINs Profile + UserSetting + Employee + Company + Role + RolePermission in one statement, then groups flat rows back into the nested TypeScript shape in JS. See `src/lib/session-payload.ts` for the implementation + JSDoc explaining the root cause.

### 11.8 Layout Dimensions

| Element | Size | Behavior |
|---|---|---|
| Sidebar | `w-60` (240px) | `hidden md:flex` — desktop only |
| Header | `h-16` (64px) | `sticky top-0 z-30`, `backdrop-blur`, `bg-background/80` |
| Content | `max-w-7xl` (1280px) | Centered, `px-4 sm:px-6 lg:px-8 py-6 lg:py-8` |
| Mobile nav | Sheet `w-64` | `md:hidden` hamburger, flattened list |
| Breakpoint | `md` (768px) | Below: mobile nav + no sidebar. Above: sidebar + no hamburger |

### 11.9 Data Fetching Patterns

**TanStack Query** (primary — ALL 70 data-fetching views):
```typescript
const { data, isLoading } = useQuery({
  queryKey: ['orders', filters],
  queryFn: () => api.get('/api/orders?' + params),
  staleTime: 15_000, // 15s for queue views, 60s for slow-changing data, 10s for detail pages
})
```

**staleTime conventions** (established in Step 3 migration):
- 10s — detail pages (product-detail, order-detail, PO detail)
- 15s — queue-like views (orders, audit-logs, losses, cycle-counts)
- 30s — directories (employees, suppliers, products, onboarding invitations)
- 60s — slow-changing settings (roles, organization, company-settings, workspaces)

**Mutations** (42+ components use `useMutation`):
```typescript
const mutation = useMutation({
  mutationFn: (data) => api.post('/api/orders', data),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['orders'] })
    toast.success('Order created')
    navigate({ name: 'orders' })
  },
  onError: (err) => toast.error(err instanceof FetchError ? err.message : 'Failed')
})
```

> ✅ **All 6 tech-debt views migrated** (Step 3 — August 2026): `employees-view`, `roles-view`, `organization-view`, `company-settings-view`, `audit-log-view`, `onboarding-view` now use TanStack Query instead of raw `api.get()` in `useEffect`.

### 11.10 Form Handling

- **React Hook Form** + **Zod** validation (shared schemas between client + server)
- **`useFormGuard`** hook (in `src/hooks/form-guard/`): intercepts navigation when forms are dirty. Coordinates with `page.tsx`'s `popstate` handler via `window.__formGuardIntercepting` flag. Used by `product-create-view` and `order-create-view`.
- **Draft autosave**: Form drafts saved to `FormDraft` table via `/api/drafts` — survives page refresh.

### 11.11 Bundle Size Summary

| Metric | Value |
|---|---|
| Non-UI component files | 101 |
| shadcn/ui components | 52 |
| Total component files | 153 |
| Total LOC in `src/components/` | ~62,309 |
| Largest 10 files LOC | ~21,500 (34% of total) |
| `useQuery`/`useMutation` usage | **70 files** (all data-fetching views) |
| `useMemo` usage | 41+ files |
| `React.memo` usage | **6+ views** (orders, order-create, product-create, catalog-settings, losses, cycle-counts, products-view) |
| Dynamic imports | **70+** (all views via `next/dynamic`) |
| First Load JS | **1,070 KB** |
| Total JS (all chunks) | 4,665 KB |
| JS chunk count | 95 |
| Dead dependencies | **0** (10 removed in Step 4) |

---

## 12. Third-Party Services

### Database: Supabase PostgreSQL
- **Project**: `gobwxqkzfulbwhzbbsdj` (Mumbai / ap-south-1)
- **Connection**: Session pooler on port 5432
- **Credentials**: `postgres.gobwxqkzfulbwhzbbsdj` / `123@Usman123@`
- **Managed by**: Prisma ORM (`db push` workflow, not migrations)

### Courier: PostEx
- **API Base**: `https://api.postex.pk/services/integration/api/order`
- **Auth**: `token` header (bearer-style)
- **Endpoints used**:
  - `POST /v3/create-order` — book shipment
  - `GET /v1/track-order/{trackingNumber}` — single tracking
  - `GET /v1/track-bulk-order?TrackingNumbers=...` — bulk tracking (intermittent 400 → fallback to single)
  - `GET /v2/get-operational-city` — fetch all cities
  - `PUT /v1/cancel-order` — cancel shipment
  - `POST /v3/create-pickup-address` — create pickup address
  - `GET /v3/get-pickup-addresses` — fetch existing pickup addresses
  - `POST /v2/generate-load-sheet` — generate manifest PDF
- **Status field**: `transactionStatus` (string)
- **Known issue**: Bulk tracking API intermittently returns HTTP 400 "Required List parameter 'TrackingNumbers' is not present" — handled with single-track fallback

### Courier: Leopard
- **API Base**: `https://www.leopardscourierspk.com/services`
- **Auth**: `api_key` + `api_password` in body/query
- **Endpoints used**:
  - `POST /bookPacket/format/json/` — book shipment
  - `POST /trackBookedPacket/format/json/` — track shipment
  - `POST /cancelBookedPackets/format/json/` — cancel shipment
  - `POST /getAllCities/format/json/` — fetch all cities (returns `shipment_type` array per city)
  - `POST /createShipper/format/json/` — create pickup address (shipper)
  - `GET /getShipperDetails/format/json/` — fetch existing shippers
- **Status field**: 2-character codes (RC, SP, DP, AR, AC, DV, PN1, PN2, RO, RN1, RN2, NR, RW, DW, RS, DR)
- **No HMAC webhook signature** — security relies on `webhookEndpointId` URL routing

### Courier: TCS (NOT integrated)
- **Status**: `framework_ready` (stub)
- **Needed**: Real API integration

### E-commerce: Shopify (NOT integrated)
- **Status**: `framework_ready` (stub)
- **Partial work**: `createOrderFromShopifyWebhook()` exists in `order.actions.ts` but the Shopify adapter is a stub

### E-commerce: Daraz (NOT integrated)
- **Status**: `framework_ready` (stub)

### AI SDK: z-ai-web-dev-sdk
- **Used for**: Image generation, VLM (vision), TTS, ASR, LLM, web search — backend only
- **Skills**: Available via the Skills system (see `skills/` directory)

---

## 13. Background Jobs & Cron

### Vercel Cron (`vercel.json`)
4 cron schedules — but **only work on Vercel deployments** (the app currently runs on a long-lived Bun server, so these DON'T fire automatically):

| Schedule | Path | Purpose |
|---|---|---|
| `0 */3 * * *` (3h) | `/api/cron/sync-cities` | Sync courier cities |
| `*/30 * * * *` (30min) | `/api/cron/poll-postex` | Poll PostEx statuses |
| `0 */12 * * *` (12h) | `/api/cron/poll-leopard-safety-net` | Leopard safety-net poll |
| `0 1 * * *` (daily 1AM) | `/api/cron/generate-scan-reports` | Generate scan reports |

### In-Process Poller (`instrumentation.ts`)
Since the app runs on a long-lived server (not Vercel), the PostEx status poller is started in-process via Next.js's instrumentation hook:
- **Schedule**: every 30 minutes (matches vercel.json)
- **Initial delay**: 1 minute after server boot
- **Mechanism**: `setInterval` calling `pollPostExOrderStatuses()`
- **Guarded**: only runs in `nodejs` runtime, only once per process

### Manual Triggers
All cron routes accept GET (manual) + POST (cron-triggered with `x-cron-secret` header). The `CRON_SECRET` is `flowops-cron-secret-v1-change-in-production`.

---

## 14. Storage & File System

### Local File Storage
| Path | Purpose |
|---|---|
| `public/uploads/company-logos/` | Company logo images |
| `public/uploads/courier-slips/` | Downloaded courier slip PDFs (stored locally, not trusted to external URLs) |
| `public/uploads/scan-reports/` | Daily scan report PDFs |
| `public/uploads/product-images/` | Product images (uploaded via `/api/products/[id]/images`) |

### File Upload Pattern
- Images: `sharp` for processing → stored in `public/uploads/`
- PDFs: `@react-pdf/renderer` for generation (scan reports) OR downloaded from courier (slips)
- No cloud storage (S3, Cloudinary, etc.) — all local filesystem

### Database Storage
- All business data in Supabase PostgreSQL
- No Redis/cache — TanStack Query handles client-side caching
- No file blobs in DB — only file paths

---

## 15. Gateway & Deployment

### Caddy Gateway (`Caddyfile`)
The sandbox exposes one port (81) via Caddy:
- **Default**: reverse-proxies `:81` → `localhost:3000` (Next.js)
- **XTransformPort**: if URL has `?XTransformPort=XXXX`, proxies to `localhost:XXXX` (for mini-services)
- **Timeouts**: 120s (supports long courier API calls)

### Development
- **Command**: `bun run dev` (runs `next dev -p 3000`)
- **Predev guard**: refuses to start if `.env` `DATABASE_URL` isn't `postgresql://`
- **Hot reload**: Turbopack (can be unstable in sandbox — memory issues)

### Production
- **Build**: `next build` → `.next/standalone/`
- **Start**: `NODE_ENV=production bun .next/standalone/server.js`
- **Output mode**: `standalone` (self-contained server bundle)

### Mini-Services
- **Directory**: `mini-services/`
- **`postex-poller/`**: Scaffold for a detached PostEx status poller service (for horizontal scaling). Has `package.json`, `README.md`, placeholder `Dockerfile`. NOT yet implemented — the `ENABLE_IN_PROCESS_POLLER` env var (default `true`) controls whether the in-process poller runs. Set to `false` on all but one replica, or use this dedicated worker.
- **Convention**: Each mini-service is an independent Bun project with its own port + `package.json`
- **Gateway**: Access via `?XTransformPort=PORT` query parameter

---

## 16. What's Built vs. In-Process vs. Needed

### ✅ Fully Built & Working

1. **Auth System** — login, register, logout, forgot/reset password, dual-channel sessions
2. **Multi-Tenancy** — org → company → employee, workspace switching, 30 permissions
3. **Catalog** — org-level categories, brands, attributes, attribute values
4. **Product Management** — org products, company subscriptions, variant management, pricing overrides, selective access. **Products list view**: responsive table (desktop, 8 columns) + stacked card list (mobile), switches at `md` breakpoint.
5. **Customer Management** — multi-phone, multi-address, external identities, RTO flagging, stats
6. **Order Management** — create (manual + Shopify stub), confirm, dispatch, deliver, cancel, RTO, payment conversion, queues
7. **Inventory System** — pools, transactions (16 types), WAC, reservations, dispatch, returns, transfers, adjustments
8. **Stock-Based + Made-to-Order** — fulfillment types, fabric consumption, production orders, returned-stitched bucket
9. **Purchase Orders** — create, confirm, receive, cancel
10. **Supplier Returns** — create, dispute
11. **Stock Loss** — theft, transit, damaged, resolve
12. **Cycle Counts** — create, count, adjust
13. **Exchanges** — request, verify, dispatch replacement, settle price difference
14. **Exchange Shipments** — reserve, dispatch, RTO, cancel
15. **Courier Integrations** — PostEx (live), Leopard (live)
16. **Booking Workbench** — book orders/shipments, load sheets
17. **City Management** — sync, search, auto-fetch missing cities, fuzzy match, aliases
18. **Courier Status Tracking** — auto-poller (30min), bulk+single fallback, status mapping, auto-dispatch/deliver/RTO
19. **Webhook Receiver** — generic, PostEx + Leopard
20. **Order Scan Module** — 6 scan modes, daily reports
21. **Dashboard** — KPIs, recent activity
22. **Audit Logs** — every mutation logged (fire-and-forget)
23. **Form Drafts** — autosave
24. **Settings** — company, organization, order workflow, integrations
25. **Inventory-OMS Connection** — reserve on confirm, deduct on dispatch, unreserve on cancel, restock on RTO (recently fixed)
26. **Docker Deployment** — multi-stage Dockerfile (dev + prod), docker-compose files, local DB for testing, PostEx poller toggle (see DOCKER.md)

### 🔧 In-Process / Recently Fixed

1. **PostEx bulk tracking API** — added single-track fallback for intermittent 400 errors (FIXED)
2. **Courier status auto-poller** — added in-process poller via `instrumentation.ts` since Vercel cron doesn't fire on long-lived server (FIXED)
3. **Scan "packed" status** — `markOrderPacked` now transitions `order.status` to `'processing'` + shows "Packed" badge (FIXED)
4. **Inventory-OMS disconnect** — 4 bugs fixed: placeholder `'reserved'` → `'pending'`, `convertPaymentStatus` now reserves, courier RTO restocks dispatched orders, Shopify webhook now reserves (FIXED)
5. **Fire-and-forget audit/metrics** — all 257 call sites converted from blocking `await` to non-blocking (FIXED)
6. **getWorkspace() optimization** — 4 sequential queries → 1 JOIN query (FIXED)
7. **createManualOrder() parallelization** — sequential reads → `Promise.all` batches (FIXED)
8. **Code-splitting** (Step 1) — all 70+ views lazy-loaded via `next/dynamic`; First Load JS 3,148 KB → 1,070 KB (66% reduction) (FIXED)
9. **React.memo** (Step 2) — leaf components in 6 largest views wrapped in `memo()` to prevent unnecessary re-renders (FIXED)
10. **TanStack Query migration** (Step 3) — 6 tech-debt views (`employees-view`, `roles-view`, `organization-view`, `company-settings-view`, `audit-log-view`, `onboarding-view`) migrated from raw `useEffect`+`api.get()` to `useQuery`/`useMutation` (FIXED)
11. **Dead dependencies removed** (Step 4) — 10 unused packages removed (`@mdxeditor/editor`, `@tanstack/react-table`, `@dnd-kit/*`, `framer-motion`, `react-syntax-highlighter`, `react-markdown`, `next-intl`, `next-auth`); node_modules 1.3 GB → 1.2 GB (FIXED)
12. **LCP optimization** — route-aware `LoadingFallback` added; renders PageHeader text at Suspense boundary immediately (FIXED)
13. **LCP regression** — `ROUTE_CHUNK_LOADERS` map (which caused +55 duplicate chunks) removed; chunk count 150 → 95 (FIXED)
14. **Products view conversion** — grid cards → responsive table (desktop, 8 columns) + stacked card list (mobile); switches at `md` breakpoint (FIXED)
15. **Product create scroll** — added `useEffect` to scroll to top on step change; prevents users landing at the bottom of step 3 (FIXED)
16. **Hydration mismatch** — added `suppressHydrationWarning` to `<body>` tag in `layout.tsx`; fixes Grammarly browser extension attribute injection (FIXED)
17. **Docker setup** — multi-stage Dockerfile (dev + prod), docker-compose.yml (dev), docker-compose.prod.yml (prod), docker-compose.local-db.yml (local Postgres for schema testing), DOCKER.md guide, PostEx poller toggle via `ENABLE_IN_PROCESS_POLLER` env var (FIXED)

### ❌ Not Yet Built / Needed

1. **TCS Courier Integration** — adapter is a stub, needs real API integration
2. **Shopify E-commerce Integration** — adapter is a stub; `createOrderFromShopifyWebhook()` exists but the adapter that parses webhooks isn't implemented
3. **Daraz E-commerce Integration** — adapter is a stub
4. **External Scheduler for Cron Jobs** — Vercel cron doesn't fire on this server. Options:
   - External service (cron-job.org, GitHub Actions) hitting the cron endpoints
   - OR deploy to Vercel (where the cron config works natively)
5. **Calculate Rate** — both PostEx + Leopard `calculateRate()` throw "not implemented" — needed for shipping cost estimation
6. **Reports & Analytics** — `REPORTS_VIEW` / `REPORTS_EXPORT` permissions exist but no reporting module is built
7. **KPI Dashboard** — `KPI_VIEW` / `KPI_MANAGE` permissions exist; basic dashboard exists but no advanced KPI management
8. **Finance Module** — `FINANCE_VIEW` / `FINANCE_MANAGE` permissions exist but no finance module is built
9. **Real-time Notifications** — no websocket/notification system (mini-services/postex-poller/ is a stub; examples/websocket/ is reference only)
10. **Mobile App** — no mobile app (web-only, but responsive)
11. **Multi-currency** — `baseCurrency` field exists but no currency conversion logic
12. **Tax Management** — `taxAmount` / `taxLabel` fields exist but no tax calculation engine
13. **Email Notifications** — no email sending (forgot-password is a stub)
14. **SMS Notifications** — no SMS integration
15. **Product Bundles** — `OrgProductBundle` model exists but no bundle management UI
16. **Attribute Value Rules** — `AttributeValueRule` model exists but no rule engine UI
17. **Advanced Inventory Features** — reorder points (`reorderPoint` / `reorderQuantity` fields exist) but no low-stock alerts
18. **Data Export** — `REPORTS_EXPORT` permission exists but no CSV/Excel export
19. ~~**`/api/auth/me` performance**~~ **FIXED (Phase 1)**: `buildSessionPayload()` now uses a single raw SQL JOIN. Latency reduced from ~696ms to ~210ms (67% faster). See §11.7.

    > **Note (deferred, not forgotten)**: Server-side in-memory caching for `/api/auth/me` was considered and deliberately deferred after the raw-SQL JOIN fix brought warm requests to ~210ms. At current traffic levels, the marginal gain (shaving ~210ms to ~1-5ms only on repeat calls within a short window) didn't justify the added invalidation complexity (workspace switch, termination, role change, future isBlocked flag). Revisit this alongside introducing Redis, once either (a) a second server replica is deployed, or (b) concurrent DB read load from this endpoint becomes measurable.

---

## 17. Key Conventions & Patterns

### Naming
- **Tables**: PascalCase (Prisma default) — `Order`, `OrderItem`, `InventoryPool`
- **Columns**: camelCase (Prisma default) — `flowopsOrderNumber`, `courierSubStatus`
- **API routes**: kebab-case — `/api/booking-workbench/bookable`
- **Files**: kebab-case — `order.actions.ts`, `postex.adapter.ts`
- **Components**: PascalCase — `OrderDetailView`, `BookingWorkbenchView`

### Status Enums (all plain strings, no DB enums)
- **Order.status**: `pending | confirmed | partially_backordered | processing | dispatched | delivered | rto | cancelled | refunded`
- **OrderItem.fulfillmentStatus**: `pending | reserved | backordered | dispatched | returned`
- **courierSubStatus**: `slip_generated | pickup_requested | picked_up | at_warehouse | en_route | out_for_delivery | delivered | returned | out_for_return | attempted | under_review | cancelled_by_merchant | expired`
- **courierBookingStatus**: `not_booked | booked | failed | cancelled`
- **paymentStatus**: `cod_pending | advance_paid | fully_prepaid | cod_collected`
- **fulfillmentType**: `stock_based | made_to_order`
- **inventoryPolicy**: `deny | continue`

### Fire-and-Forget Pattern
```typescript
// insertAuditLog + insertMetricEvent return void immediately
// The DB write happens on the event loop AFTER the response is sent
insertAuditLog({ action: 'order.created', ... })  // no await!
insertMetricEvent({ metricKey: 'order.created', ... })  // no await!
```

### Workspace Context Pattern
```typescript
// Every authenticated API route starts with:
const ctx = await getWorkspace()  // resolves user + employee + company
await requirePermission(ctx, PERMISSIONS.ORDERS_CREATE)  // throws 403 if lacking
```

### Adapter Pattern
```typescript
// Never call adapter methods directly — always through executeLoggedIntegrationAction:
const result = await executeLoggedIntegrationAction({
  companyIntegrationId: integration.id,
  organizationId: ctx.company.organizationId,
  actionType: 'book_shipment',
  direction: 'outbound',
  fn: async () => adapter.bookShipment(bookInput),
})
// This logs the call to IntegrationActionLog + handles errors
```

### Idempotency
- `reserveOrderStock` skips items with `fulfillmentStatus === 'reserved'` or `'dispatched'`
- `performOrderDispatch` skips items already `'dispatched'`
- `restockOrderForRto` skips items already `'returned'`
- `processInventoryTransaction` validates stock before mutating

---

## 18. Known Issues & Gotchas

### Environment
1. **`.env` reverts to SQLite** — the `predev` script guards against this, but always verify before starting. If it happens, restore from DOCKER.md reference or git history.
2. **DB latency** — Mumbai region (~100ms per query from sandbox). Performance optimizations (fire-and-forget, parallel queries, single-JOIN getWorkspace) have been applied. The `/api/auth/me` route is still slow (500-1000ms) due to 5-6 Prisma round-trips — see §16 item 19.
3. **Turbopack instability** — dev server can hang during compilation in the sandbox (memory issue). Clear `.next/` cache and restart.
4. **Hydration mismatch from browser extensions** — Grammarly injects `data-gr-ext-installed` + `data-new-gr-c-s-check-loaded` attributes into `<body>`. Fixed via `suppressHydrationWarning` on `<body>` in `layout.tsx`. If new hydration errors appear, check for other browser-extension-injected attributes.

### Bundling
5. **Do NOT add module-scope `import()` maps** — a `ROUTE_CHUNK_LOADERS` map with 55 `() => import(...)` entries caused Turbopack to create 55 duplicate chunks (+1,303 KB). The ONLY place each route's code should be imported is the `dynamic()` call in `page.tsx`. See §11.1 warning.

### Integrations
6. **PostEx bulk tracking API** — intermittently returns HTTP 400. Handled with single-track fallback
7. **Vercel cron doesn't fire** — on long-lived server. In-process poller added for PostEx (30min). Other crons (city sync, scan reports, Leopard safety-net) need manual triggering or external scheduler. The `ENABLE_IN_PROCESS_POLLER` env var (default `true`) can disable the poller for multi-replica deployments.
8. **PostEx API lag** — parcels may be physically picked up but PostEx's API still shows "Booked" for hours. This is a PostEx issue, not FlowOps

### Schema
9. **SQL functions must be applied manually** — `generate_order_number()`, `normalize_phone()`, etc. are NOT in the Prisma schema. They must be applied via raw SQL to the DB (they were lost during DB migration). A consolidated file `supabase/functions-only.sql` contains all 23 functions + 2 sequences + 12 triggers.
10. **No DB-level RLS** — all multi-tenant isolation is in the app layer. A bug in `getWorkspace()` or a missing `companyId` filter could leak data across tenants
11. **No `available` column** — `available = onHand - reserved` is computed in app code every time

### Performance
12. **Audit/metric writes are fire-and-forget** — on a serverless platform (Vercel Edge), these would be killed mid-flight. The current long-lived Bun server keeps them alive
13. **`executeLoggedIntegrationAction` has a blocking DB write** — the `IntegrationActionLog` insert in the `finally` block is awaited (~150ms per booking). Not yet converted to fire-and-forget
14. ~~**`/api/auth/me` takes 500-1000ms**~~ **FIXED (Phase 1 + Phase 2)**: `buildSessionPayload()` now uses a single raw SQL JOIN (`prisma.$queryRaw`) instead of 5-6 sequential Prisma queries. Latency reduced from ~696ms avg to ~210ms warm (67% faster). The raw query JOINs Profile + UserSetting + Employee + Company + Role + RolePermission in one statement. See `src/lib/session-payload.ts`. Phase 2: client-side stale-while-revalidate caching added via TanStack Query (`refetchOnWindowFocus: true` scoped to session query only — see §11.1). Server-side in-memory cache deliberately deferred (see §16 item 19 note).

---

## 19. Prompt Generation Guide

When generating prompts for AI assistants working on FlowOps, use these patterns:

### Context to Always Include
```
- Project: FlowOps ERP (Pakistani e-commerce ERP)
- Stack: Next.js 16 + React 19 + TypeScript + Prisma 6 + Supabase PostgreSQL + Tailwind 4 + shadcn/ui
- Multi-tenant: Organization → Company → Employee
- Auth: custom HMAC sessions (not NextAuth), dual-channel (Bearer + cookie)
- State: Zustand (client) + TanStack Query (server) — ALL 70 data-fetching views use useQuery/useMutation
- Single SPA route at /, ~62 named view states, all lazy-loaded via next/dynamic (ssr: false)
- API: 148 routes under src/app/api/, all use getWorkspace() + requirePermission()
- Actions: 18 files under src/lib/actions/ contain all business logic
- Inventory: src/lib/inventory.ts is the ONLY way to modify InventoryPool
- Couriers: PostEx (live) + Leopard (live) + TCS (stub)
- Fire-and-forget: insertAuditLog/insertMetricEvent return void
- Performance: First Load JS 1,070 KB (code-split into 95 chunks). React.memo on leaf components.
- CRITICAL: Do NOT add module-scope import() maps — use dynamic() in page.tsx only (causes duplicate chunks)
```

### Module-Specific Context
- **Orders**: `src/lib/actions/order.actions.ts` — `createManualOrder`, `confirmOrder`, `cancelOrder`, `performOrderDispatch`, `markOrderPacked`, `markOrderDelivered`
- **Inventory**: `src/lib/inventory.ts` — `processInventoryTransaction`, `reserveStockForOrder`, `unreserveStockForOrder`, `dispatchOrder`, `restockOrderForRto`
- **Couriers**: `src/lib/integrations/couriers/postex.adapter.ts` + `leopard.adapter.ts`
- **Booking**: `src/lib/actions/booking.actions.ts` — `bookOrderWithCourier`, `maybeAutoBookOrder`
- **Status polling**: `src/lib/actions/postex-status-poll.actions.ts` + `instrumentation.ts`
- **Scan**: `src/lib/actions/scan.actions.ts` + `src/components/orders/order-scan-view.tsx`

### Common Prompt Patterns
```
"Fix a bug in the [MODULE] module where [SYMPTOM]. The relevant files are
[FILE PATHS]. The expected behavior is [BEHAVIOR]. Use the existing patterns
in the codebase (getWorkspace, requirePermission, insertAuditLog fire-and-forget)."

"Add a new feature to [MODULE]. The flow should be: [FLOW]. Create the API
route at [PATH], the server action in [FILE], and the component in [DIR].
Follow the existing conventions (runtime='nodejs', dynamic='force-dynamic',
ApiError handling, fire-and-forget audit logs)."

"Diagnose why [SYMPTOM]. Check the [MODULE] flow from UI → API → action → DB.
Report the root cause without fixing it yet."
```

### What NOT to Suggest
- Don't suggest NextAuth — the app uses custom HMAC sessions (next-auth was removed in Step 4)
- Don't suggest edge runtime — all routes are `runtime = 'nodejs'`
- Don't suggest Redis — the app uses TanStack Query + in-memory caching
- Don't suggest DB-level RLS — isolation is in the app layer
- Don't suggest Prisma migrations — the app uses `db push`
- Don't suggest indigo/blue colors — design rules prohibit them
- Don't suggest client-side `z-ai-web-dev-sdk` — it's backend-only
- Don't suggest `next start` — production uses `bun .next/standalone/server.js`
- Don't suggest `framer-motion`, `@dnd-kit/*`, `@tanstack/react-table`, `react-markdown`, `@mdxeditor/editor`, `react-syntax-highlighter`, `next-intl` — all were removed as dead dependencies in Step 4
- Don't add module-scope `import()` maps in `page.tsx` — causes Turbopack to create duplicate chunks. Use `dynamic()` only.
- Don't suggest `React.Table` — FlowOps uses shadcn/ui `Table` component (`src/components/ui/table.tsx`)

---

*This document is the authoritative reference for the FlowOps ERP system. It MUST be updated whenever significant changes are made to the architecture, modules, dependencies, performance characteristics, or integrations. Do not let it go stale — a stale briefing leads to incorrect AI-assisted code generation.*

*Performance reports: see `perf-baseline.md` (Step 0 baseline) and `perf-results.md` (Step 4+5 after dead dep removal) for detailed before/after bundle measurements.*
