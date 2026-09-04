# FlowOps ERP — Technical Briefing

> **Purpose** — This document is the canonical briefing for FlowOps, the multi-tenant ERP built for Pakistani e-commerce sellers. It is written for two audiences:
>
> 1. **Future developers** joining the project — onboarding reference for architecture, module catalog, key systems, and operational gotchas.
> 2. **AI coding assistants** — context-pack for generating correct, idiomatic prompts and code suggestions.
>
> **How to read this document**
> - Section 1–2 → 5-minute orientation ("what is FlowOps, why does it exist").
> - Section 3–4 → mental model of the stack + the request lifecycle (read before touching any backend code).
> - Section 5 → full module catalog (lookup table — every screen the user sees).
> - Section 6 → cross-cutting systems that span multiple modules (read before touching inventory, orders, or stock-loss).
> - Section 7 → database overview (for schema questions, see `DATABASE_GUIDE.md` for full detail).
> - Section 8 → current state: what's live, what's deferred, what's not built.
> - Section 9 → operational rules + sandbox gotchas (read BEFORE running any command).
>
> **Maintenance rule** — Update this document whenever architecture, modules, key systems, or operational rules change. A stale briefing produces incorrect AI suggestions and wastes engineering hours.
>
> **Last updated**: September 2026 (rewrite — DOCS-BRIEFING task). Companion documents:
> - `PRODUCTION_DEPLOYMENT_GUIDE.md` — Hostinger + production DB rules
> - `DATABASE_GUIDE.md` — full Prisma schema reference
> - `INVENTORY_AUDIT.md`, `PRODUCTS_AUDIT.md`, `ORDERS_AUDIT.md`, `STOCKLOSS_INVESTIGATION.md` — read-only audit findings
> - `worklog.md` — every task ever completed on the project

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Technology Stack](#2-technology-stack)
3. [Architecture Overview](#3-architecture-overview)
4. [Module Catalog](#4-module-catalog)
5. [Key Systems](#5-key-systems)
6. [Database Overview](#6-database-overview)
7. [Current Status](#7-current-status)
8. [Important Notes & Operational Rules](#8-important-notes--operational-rules)
9. [Appendix: Quick Reference](#9-appendix-quick-reference)

---

## 1. Executive Summary

### What FlowOps is

FlowOps is a multi-tenant SaaS ERP built for **Pakistani e-commerce sellers**. It manages the complete operational lifecycle of a COD-first e-commerce business:

```
Product catalog → Inventory → Customer → Order → Courier booking →
Dispatch → Delivery / RTO → Returns / Exchanges → Reporting
```

The platform replaces the patchwork of spreadsheets, WhatsApp threads, and manual courier portals that Pakistani sellers currently stitch together to run their operations.

### Who it is for

The target user is a Pakistani e-commerce seller who:

- Sells on Instagram, Facebook, Daraz, Shopify, or their own storefront.
- Ships COD (Cash on Delivery) — the dominant payment method in Pakistan (~95% of e-commerce).
- Ships via local couriers — PostEx, Leopard Couriers, TCS (the three providers FlowOps integrates).
- Needs to track every order through its lifecycle: confirmed → packed → dispatched → delivered / RTO (Return to Origin).
- Needs inventory management with two fulfillment models: **stock-based** (pre-made stock) and **made-to-order** (stitched on demand, with fabric consumption).
- Needs customer management with RTO-rate flagging (sellers refuse service to high-return customers).
- Operates one or more brands/companies under a single organization (multi-brand operator).

### What problem it solves

| Pain point (before FlowOps) | FlowOps solution |
|---|---|
| Orders tracked in WhatsApp + Excel — no single source of truth | Centralized `Order` table with full lifecycle + audit log |
| Courier bookings done manually on each courier's portal | Auto-booking via `bookOrderWithCourier()` + Booking Workbench for bulk |
| Order status updates require manually refreshing courier sites | Auto-poller every 30 minutes (PostEx) + Leopard webhook receiver |
| Inventory counted by hand at month-end | Real-time `InventoryPool` with append-only ledger + WAC cost tracking |
| RTO returns lost track of who returned what | RTO review queue + per-item condition correction + stock loss recording |
| Customer return rates invisible | `Customer.isFlagged` auto-set at 3+ RTO with `flagReason = 'High RTO rate'` |
| Multi-brand operators maintain separate spreadsheets per brand | One org → many companies; user switches workspace with a dropdown |
| Made-to-order stitching has no fabric tracking | `ProductionOrder` model + `fabric_consumed_for_stitching` ledger transaction |
| Stock losses recorded ad-hoc (often missing) | Unified `recordStockLoss()` helper + DB dedup index — see §5 |
| Permutations of who can do what in each module | 30-key permission system + 4 elevated-role bypass — see §5 |

### Scale (current snapshot)

| Metric | Value |
|---|---|
| Prisma models | 68 (full list in §6) |
| API routes under `src/app/api/` | 170+ |
| React components | ~160 (108 non-UI + 52 shadcn/ui) |
| Server action files (`src/lib/actions/*.ts`) | 18 |
| SQL migrations in `supabase/migrations/` | 29 (001–029, with 015 and 017 skipped) |
| Permission keys | 30 |
| Live courier integrations | 2 (PostEx, Leopard) |
| Stub courier integrations | 1 (TCS) |
| Stub ecommerce integrations | 2 (Shopify, Daraz) |
| Background jobs (in-process pollers) | 2 (PostEx status poll, exchange-rate refresh) |
| First Load JS bundle (after code-splitting) | 1,070 KB (was 3,148 KB before split — 66% reduction) |
| Total JS across all chunks | 4,665 KB (95 chunks) |
| Number of dependencies | 60 (10 dead deps removed in Aug 2026 cleanup) |

### The order lifecycle (the heart of the system)

Every order moves through the state machine below. Every transition has an inventory side-effect that runs through the unified `processInventoryTransaction()` ledger.

```
                      ┌──────────────────────────────────────────────────────────┐
                      │                                                          │
                      ▼                                                          │
   pending ──► confirmed ──► processing ──► packed ──► dispatched ──► delivered   │
                  │                                                  │            │
                  │                                                  ▼            │
                  ▼                                               returned ◄──────┘
            cancelled                                  (RTO → auto-restock)
                  ▲
                  │
            partially_backordered
                  │
                  ▼
            cancelled
```

**Inventory side-effects per transition**:

| Transition | Inventory effect | Ledger transaction type |
|---|---|---|
| `pending → confirmed` | reserve stock for each line item | `order_reserved` (decreases available, doesn't touch onHand) |
| `pending → cancelled` | none (nothing reserved yet) | — |
| `confirmed → partially_backordered` | reserve available, backorder remainder | `order_reserved` (partial) + `OrderItem.fulfillmentStatus = 'backordered'` |
| `confirmed → processing` | none (operational marker) | — |
| `processing → packed` | none (operational marker) | — |
| `confirmed/processing/packed → dispatched` | deduct stock + release reservation | `sale_dispatched` (decreases onHand + reserved, locks COGS at avgCost) |
| `dispatched → delivered` | none (operational marker) | — |
| `dispatched → returned` (RTO) | restock returned items | `return_resellable` or `return_stitched_received` (increases onHand) |
| `dispatched → cancelled` | blocked — post-dispatch cancellation not allowed | — |

### The multi-tenant model

```
Organization (top-level tenant, owned by one user — the Org Owner)
  │
  └── Company (sub-tenant — a brand or store under the org)
        │
        ├── Employees (users with roles/permissions in this company)
        ├── Products (company SUBSCRIBES to org-level product templates)
        ├── Inventory (company-owned stock in its own locations)
        ├── Orders (company's orders — company-scoped)
        ├── Customers (org-level, shared across companies in the org)
        └── Integrations (company's own courier connections)
```

A user can belong to multiple companies (via `Employee` records) and switch between them using the workspace switcher. The active company is stored in `UserSetting.activeCompanyId` and resolved on every API call by `getWorkspace()` (see §3 and §5).

### Why custom, not off-the-shelf

FlowOps was built custom (rather than on Shopify, Odoo, or Erpnext) because:

1. **Pakistani courier integrations** — PostEx and Leopard have non-standard REST APIs with quirks (Leopard uses 2-character status codes; PostEx bulk tracking intermittently returns HTTP 400). Off-the-shelf ERPs don't support these.
2. **COD-first payment model** — most ERPs assume prepaid/card payment as the default. FlowOps treats COD as the default with optional prepaid.
3. **Multi-brand with shared catalog** — the org/company split (org owns catalog, companies subscribe) is unusual; most multi-tenant ERPs have one tenant = one catalog.
4. **Made-to-order stitching** — fabric consumption + returned-stitched bucket reuse is a niche workflow specific to Pakistani apparel sellers.

---

## 2. Technology Stack

FlowOps is a TypeScript-first Next.js 16 application. Every layer of the stack was chosen deliberately — see "Why this choice" column for rationale.

### 2.1 Core framework

| Component | Version | Why this choice |
|---|---|---|
| **Next.js** | 16.1+ | App Router (file-based routing under `src/app/`); Turbopack dev server; `output: 'standalone'` for self-contained production server bundles |
| **React** | 19 | Latest stable; concurrent features used implicitly via TanStack Query |
| **TypeScript** | 5 | Strict mode (`"strict": true` in `tsconfig.json`); `@/*` path alias → `./src/*` |
| **Bun** | 1.3+ | Runtime + package manager + production server (`bun .next/standalone/server.js`). Faster than Node for cold start + I/O |

### 2.2 Database

| Component | Version | Why this choice |
|---|---|---|
| **Prisma ORM** | 6.11+ | Type-safe DB client; `db push` workflow (not migrations) — see §8 for why |
| **PostgreSQL** | (Supabase-managed) | Mature relational DB; Supabase provides hosted PG + pooler |
| **Supabase** | ap-south-1 (Mumbai) region | Closest region to Pakistan (~50-100ms latency from sandbox + Hostinger) |
| **Pooler** | Session mode, port 5432 | Prisma requires session-mode pooler (transaction-mode on port 6543 breaks prepared statements) |
| **`pg`** | 8.22+ | Raw SQL queries via `prisma.$queryRaw` (used for atomic sequence counters + session payload JOIN) |

### 2.3 State & data fetching

| Library | Version | Purpose |
|---|---|---|
| **Zustand** | 5 | Client state — single store `useAppStore` (session, active company, SPA routing). ~170 lines total. |
| **TanStack Query** | 5 | Server state — data fetching, caching, mutations. Used by ALL 70 data-fetching views. Global config: `staleTime: 30s`, `refetchOnWindowFocus: false`, `retry: 1`. |

### 2.4 Forms & validation

| Library | Version | Purpose |
|---|---|---|
| **React Hook Form** | 7 | All forms — performant uncontrolled RHF inputs |
| **Zod** | 4 | Schema validation; **shared between client + server** (same schema in `src/lib/validations/*.ts` is imported by both API routes and React components) |
| **@hookform/resolvers** | 5 | Zod resolver adapter for RHF |

### 2.5 UI

| Library | Purpose |
|---|---|
| **Tailwind CSS 4** | Styling. **Design rule: NO blue/indigo primary** — primary is emerald (`oklch(0.52 0.13 165)`). Sidebar is dark navy. 28 CSS variables in OKLCH color space. |
| **shadcn/ui** (New York style) | 52 component primitives in `src/components/ui/` — Dialog, Sheet, Table, Form, Command, etc. Built on Radix UI. |
| **Radix UI** | 26 `@radix-ui/react-*` packages — the foundation under shadcn/ui primitives (accessible, unstyled) |
| **Lucide React** | Icons |
| **Sonner** | Toast notifications (used by every mutation's `onSuccess`/`onError`) |
| **next-themes** | Dark/light mode provider. `attribute="class"`, `defaultTheme="light"`, `enableSystem={false}` (does NOT auto-detect OS) — dark mode is defined but not user-toggleable |
| **vaul, embla-carousel, cmdk** | Drawer, carousel, command palette primitives (used in mobile-nav, shadcn Combobox) |

### 2.6 Other key libraries

| Library | Purpose |
|---|---|
| **@react-pdf/renderer** | Scan report PDFs + internal self-fulfilled slip PDFs |
| **jsbarcode** | CODE128 barcode generation for self-fulfilled slip PDFs (rendered to SVG → sharp → PNG → embedded in PDF) |
| **sharp** | Image processing — SVG → PNG for barcodes, image resizing for product images |
| **recharts** | Dashboard charts (BarChart, LineChart, PieChart) |
| **date-fns** | Date formatting + arithmetic |
| **libphonenumber-js** | International phone number validation + E.164 normalization (used in customer creation + order creation) |
| **bcryptjs** | Password hashing (NOTE: actual implementation uses Node `crypto.scrypt` in `src/lib/auth.ts`; bcryptjs is a transitive safety net) |
| **uuid** | UUID v4 generation for idempotency keys |
| **z-ai-web-dev-sdk** | AI skills (image generation, VLM, TTS, ASR, LLM, web search) — **backend only**, never imported in client components |

### 2.7 Removed dependencies (August 2026 cleanup)

The following 10 packages were installed but confirmed unused (0 imports found) and removed to reduce install time + Docker image size:

| Removed package | Size | Reason removed |
|---|---|---|
| `@mdxeditor/editor` | 1.1 MB | Listed for "rich text" but never imported |
| `@tanstack/react-table` | 796 KB | FlowOps uses shadcn/ui `Table` component instead |
| `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` | 2.4 MB total | No drag-drop features |
| `framer-motion` | 5.4 MB | Animations handled by CSS transitions + Tailwind |
| `react-syntax-highlighter` | 8.9 MB | No code-display features |
| `react-markdown` | 88 KB | No markdown rendering |
| `next-intl` | 1.6 MB | App is English-only, no i18n |
| `next-auth` | 2.7 MB | App uses custom HMAC sessions (see §3) |

**Rule for future development**: do NOT reintroduce any of the above. If a feature seems to need one, propose the alternative pattern first.

---

## 3. Architecture Overview

FlowOps is a single-page Next.js app with a thin API layer over Supabase PostgreSQL. All business logic lives in server action files — API routes are thin wrappers.

### 3.1 High-level data flow

```
┌────────────────────────────────────────────────────────────────┐
│ Browser (single SPA at /)                                       │
│  └─ Zustand store (session + route)                             │
│  └─ TanStack Query cache (server data)                          │
│  └─ fetch() with Bearer header + cookie                         │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────────┐
│ Caddy Gateway (:81 → :3000)                                     │
│  └─ 120s timeout (supports long courier API calls)              │
│  └─ ?XTransformPort=PORT for mini-services                      │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────────┐
│ Next.js 16 App Router                                           │
│  └─ src/app/api/**/route.ts  (170+ API routes)                  │
│  └─ src/app/page.tsx         (single SPA page)                  │
└──────────────────────────┬───────────────────────────────────────┘
                           │ thin wrapper — extracts body, calls action
                           ▼
┌────────────────────────────────────────────────────────────────┐
│ Server Actions  (src/lib/actions/*.ts — 18 files)               │
│  └─ getWorkspace()  →  requirePermission()  →  business logic   │
│  └─ insertAuditLog()  +  insertMetricEvent()  (fire-and-forget) │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────────┐
│ Prisma Client (src/lib/db.ts — singleton)                       │
│  └─ $queryRaw for atomic sequences + session payload JOIN       │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────────┐
│ Supabase PostgreSQL  (ap-south-1, session pooler port 5432)     │
└────────────────────────────────────────────────────────────────┘
```

### 3.2 The five key architectural decisions

These decisions are NON-NEGOTIABLE — they define FlowOps. Future prompts MUST respect them.

#### Decision 1: Single SPA route (no per-page routing)

The entire app lives at `/` (`src/app/page.tsx`). There are no other Next.js pages. Navigation is client-side via Zustand's `navigate(route)` with URL sync via query string (`?view=<route_name>&id=<optional>`).

**Why**: A single-page architecture keeps all state in one place (Zustand + TanStack Query), eliminates Next.js layout-shift between pages, and lets us code-split aggressively without SSR complications.

**Consequence**: Every "page" is a route case in a `switch(route.name)` inside `renderRoute()`. There are ~62 named routes in the `AppRoute` discriminated union.

#### Decision 2: Custom HMAC sessions (NOT NextAuth)

Sessions are HMAC-signed tokens: `<userId>.<timestamp>.<hmac>`, 30-day TTL. Stored in BOTH:

1. `localStorage` key `flowops_session_token` (for the API client's Bearer header)
2. HttpOnly cookie `flowops_session` (for fallback when localStorage isn't available, e.g. iframe embeds)

```typescript
// Session token format
const token = `${userId}.${timestamp}.${hmacSha256(userId + '.' + timestamp, SESSION_SECRET)}`
```

**Why**: Dual-channel auth works in cross-origin iframes, doesn't require an extra OAuth provider, and avoids the 2.7 MB `next-auth` dependency.

**Auth flow**:

```
1. POST /api/auth/login {email, password}
   - Server: verify scrypt(password, user.passwordHash)
   - Server: create session token, set HttpOnly cookie, return token in body
   - Client: store token in localStorage + Zustand store
2. Subsequent requests: client sends Bearer header AND cookie (both)
3. POST /api/auth/logout → clear cookie + localStorage + Zustand
```

#### Decision 3: Multi-tenant isolation in the APPLICATION layer (not DB RLS)

There is NO database-level Row-Level Security. Every query scopes by `companyId` in the application code, enforced by `getWorkspace()` + `requirePermission()`.

**Why**: Prisma's RLS support is limited; managing RLS policies alongside schema changes is error-prone. Application-layer scoping is easier to audit (grep for missing `companyId` filters).

**Risk**: A bug in `getWorkspace()` or a missing `companyId` filter could leak data across tenants. The audit reports (`INVENTORY_AUDIT.md`, `PRODUCTS_AUDIT.md`, `ORDERS_AUDIT.md`) flagged several instances of missing company-scoping on detail endpoints — these are known tech debt.

#### Decision 4: Fire-and-forget audit + metric writes

```typescript
// insertAuditLog + insertMetricEvent return void IMMEDIATELY
// The DB write happens on the event loop AFTER the HTTP response is sent
insertAuditLog({ action: 'order.created', ... })    // no await!
insertMetricEvent({ metricKey: 'order.created', ... })  // no await!
```

**Why**: Eliminates ~50ms per audit-log write from the request path. Works because FlowOps runs on a long-lived Bun/Node server (NOT serverless), so the event loop survives the HTTP response.

**Risk**: On a serverless platform (Vercel Edge), these writes would be killed mid-flight. Don't deploy FlowOps to serverless without converting audit logs to a queue + worker pattern.

#### Decision 5: Adapter pattern for couriers (single integration point)

Every outbound call to a courier API goes through ONE function: `executeLoggedIntegrationAction()`. This function:

1. Wraps the call in a try/finally that logs to `IntegrationActionLog` (with request payload + response payload + duration).
2. Re-throws errors after logging.
3. Centralizes retry / timeout behavior (future-proofing).

```typescript
// Never call adapter methods directly — always through the wrapper:
const result = await executeLoggedIntegrationAction({
  companyIntegrationId: integration.id,
  organizationId: ctx.company.organizationId,
  actionType: 'book_shipment',
  direction: 'outbound',
  requestPayload: bookInput,           // NEW — logs the request data, not just response
  fn: async () => adapter.bookShipment(bookInput),
})
```

### 3.3 The request lifecycle (every authenticated API call)

Every authenticated API route follows the same 6-step pattern. Learn this pattern; every new route should follow it.

```typescript
// src/app/api/<resource>/route.ts
import { NextRequest } from 'next/server'
import { getWorkspace } from '@/lib/workspace'
import { requirePermission } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'
import { insertAuditLog } from '@/lib/audit'
import { handleError } from '@/lib/api-error'
import { readBody } from '@/lib/api-client'
import { createOrderSchema } from '@/lib/validations/order.schemas'
import { createOrder } from '@/lib/actions/order.actions'

export const runtime = 'nodejs'        // NEVER 'edge' — see §8
export const dynamic = 'force-dynamic' // NEVER statically render

export async function POST(req: NextRequest) {
  try {
    // 1. Resolve workspace (user + employee + active company)
    //    Uses 60s in-memory cache — see §5
    const ctx = await getWorkspace()

    // 2. Check permission (throws ApiError 403 if lacking)
    await requirePermission(ctx, PERMISSIONS.ORDERS_CREATE)

    // 3. Parse + validate body (throws ApiError 400 on invalid)
    const body = await readBody(req)
    const input = createOrderSchema.parse(body)

    // 4. Call server action (business logic lives here)
    const order = await createOrder(ctx, input)

    // 5. Fire-and-forget audit + metric writes (no await!)
    insertAuditLog({
      organizationId: ctx.company.organizationId,
      companyId: ctx.company.id,
      employeeId: ctx.employee.id,
      action: 'order.created',
      entityType: 'order',
      entityId: order.id,
    })

    // 6. Return success response
    return Response.json(order, { status: 201 })
  } catch (err) {
    // handleError converts ApiError(401|403|400|404|500) to proper HTTP status
    return handleError(err)
  }
}
```

### 3.4 The workspace cache system (60-second in-memory cache)

`getWorkspace()` is called by EVERY authenticated API route. Without caching, that's one Prisma query (~140-280ms to Supabase pooler) per request — a 60% overhead on every API call.

**Solution**: a per-process in-memory Map cache, 60-second TTL, scoped by `userId`.

```
┌─────────────────────────────────────────────────────────────────┐
│ src/lib/workspace-cache.ts                                       │
│                                                                  │
│  workspaceCache: Map<userId, { value: WorkspaceContext,          │
│                                expiresAt: number }>              │
│                                                                  │
│  getCachedWorkspace(userId)  → WorkspaceContext | null           │
│  setCachedWorkspace(userId, ctx, ttlMs = 60_000)  → void        │
│  invalidateWorkspaceCache(userId)  → void  (clears role cache too)│
│  clearAllCaches()  → void                                        │
└─────────────────────────────────────────────────────────────────┘
```

**Cache hit (warm)**:

```
1. API route calls getWorkspace()
2. getWorkspace() calls getCachedWorkspace(userId) → returns cached ctx
3. Total time: ~0ms (no DB query)
```

**Cache miss (cold)**:

```
1. API route calls getWorkspace()
2. getCachedWorkspace(userId) returns null
3. getWorkspace() runs a SINGLE Prisma query that JOINs:
     Profile → settings.activeCompany → Company
            + employees → role
4. setCachedWorkspace(userId, ctx, 60_000) caches the result
5. Total time: ~140-280ms (one DB round-trip)
6. Subsequent calls within 60s hit cache → 0ms
```

**Cache invalidation** — call `invalidateWorkspaceCache(userId)` when:

| Trigger | Where called |
|---|---|
| User switches company | `POST /api/workspace/switch` |
| User logs out | `POST /api/auth/logout` (calls `clearAllCaches()`) |
| Admin edits an employee's role | `PATCH /api/employees/[id]` (when role changes) |
| Admin terminates an employee | `POST /api/employees/[id]/terminate` |
| Admin edits a role's permissions | `PATCH /api/roles/[id]` |

**Multi-instance caveat**: this is a per-process Map, NOT Redis. In a multi-instance deployment, each instance has its own cache. Worst case: a permission change takes 60s to propagate to all instances. Acceptable for an ERP — not for a security-critical system.

### 3.5 The stock-loss unification system

Before unification, stock loss was created in **8 disconnected code paths** (Stock Losses module, RTO flow, cycle count, adjust stock, returned-stitched, exchange, supplier return, return scan). This caused:

- **Double-decrements** — same loss recorded twice (e.g. RTO review + return scan both recorded a damage for the same order item).
- **Missing records** — cycle count and adjust stock decremented `onHand` but created no `StockLossRecord` → Stock Losses dashboard under-reported actual losses.
- **No order linking** — courier-damage losses had no FK back to the order item, so filing courier claims was impossible.

**Solution**: a single helper `recordStockLoss()` in `src/lib/stock-loss.ts` that every module MUST call.

```typescript
import { recordStockLoss } from '@/lib/stock-loss'

const result = await recordStockLoss({
  organizationId, companyId, orgVariantId, locationId,
  lossType: 'damaged',                  // 'damaged' | 'theft' | 'missing' | 'transit_loss' | 'supplier_dispute'
  sourceModule: 'cycle_count',          // discriminator — see table below
  quantity: 2,
  costPerUnit: 500,
  orderItemId: '...',                  // optional — enables dedup
  cycleCountItemId: '...',              // optional — traceability
  employeeId: '...',
  notes: 'Cycle count found 2 damaged',
  // createInventoryTransaction: true (default) — also decrements onHand
})

if (result.wasDuplicate) {
  // Loss already recorded for this (orderItemId, lossType, sourceModule)
  // — idempotent success, no action needed
}
```

**The 8 source modules** (the `sourceModule` discriminator):

| `sourceModule` | Origin code path | Loss types typically recorded |
|---|---|---|
| `stock_loss` | Dedicated Stock Losses module form | damaged, theft, transit_loss |
| `rto` | RTO review queue — `correctReturnItemCondition()` | damaged |
| `cycle_count` | Cycle count approve — theft/unknown shortage | missing |
| `adjust_stock` | Adjust Stock module — negative adjustment | damaged (auto-classified) |
| `returned_stitched` | Returned Stitched module — damaged branch | damaged |
| `supplier_return` | Supplier Returns — status='rejected' branch | supplier_dispute |
| `exchange` | Exchange flow — `verifyOldItemReceived()` damaged | damaged |
| `return_scan` | (planned) Return Order Scan inline damage | damaged |

**Dedup mechanism**: a partial unique index `stock_loss_orderitem_dedup_idx` on `(orderItemId, lossType, sourceModule) WHERE orderItemId IS NOT NULL`. If a second call attempts to record the same loss, the insert hits the unique constraint → `recordStockLoss()` catches the P2002 error and returns `wasDuplicate: true` (idempotent success).

**Atomicity**: the loss record + inventory transaction are created in sequence. If the inventory transaction fails, the loss record is deleted (manual rollback). The two writes are NOT in a `db.$transaction` — this is a known tech debt flagged in the audit reports.

**Known gap**: the `exchange` source module bypasses `recordStockLoss()` in `verifyOldItemReceived()` — it creates the `StockLossRecord` directly without `orderItemId`. This is flagged as a CRITICAL bug in `ORDERS_AUDIT.md` (causes dedup to not apply).

### 3.6 The courier adapter pattern

FlowOps integrates with three Pakistani couriers via a provider-agnostic adapter interface. The app calls adapters through `getCourierAdapter(providerKey, credentials)` — never instantiates adapter classes directly.

```
┌──────────────────────────────────────────────────────────────┐
│ src/lib/integrations/registry.ts                              │
│                                                               │
│ COURIER_FACTORIES: Record<providerKey, (creds) => Adapter>    │
│   postex   → new PostExAdapter(creds)                         │
│   leopard  → new LeopardAdapter(creds)                        │
│   tcs      → new TcsAdapter(creds)        ← stub              │
│                                                               │
│ ECOMMERCE_FACTORIES:                                          │
│   shopify  → new ShopifyAdapter(creds)    ← stub              │
│   daraz    → new DarazAdapter(creds)       ← stub              │
└──────────────────────────────────────────────────────────────┘
```

**The `CourierAdapter` interface** (`src/lib/integrations/types.ts`):

```typescript
interface CourierAdapter {
  // Required — every courier must implement these:
  bookShipment(input: BookShipmentInput): Promise<{ trackingNumber: string }>
  trackShipment(trackingNumber: string): Promise<ShipmentStatus>
  cancelShipment(trackingNumber: string): Promise<void>
  calculateRate(input: RateInput): Promise<{ rate: number }>          // both stubs today
  parseStatusWebhook(rawPayload: unknown): ParsedWebhook
  verifyWebhookSignature(rawBody, signature, secret): boolean

  // Optional — capability detection via `'method' in adapter`:
  fetchOperationalCities?(): Promise<City[]>                       // city sync
  createPickupAddress?(input: PickupAddressInput): Promise<{ id: string }>
  fetchExistingPickupAddresses?(): Promise<PickupAddress[]>
  trackBulkShipments?(trackingNumbers: string[]): Promise<ShipmentStatus[]>  // PostEx only
  generateLoadSheet?(trackingNumbers: string[], pickupAddress?): Promise<{ pdfUrl: string }>  // PostEx only
  pingConnection?(): Promise<boolean>
}
```

**Adapter implementation status** (from `COURIER_ADAPTER_STATUS` map in `registry.ts`):

| Provider | Status | Notes |
|---|---|---|
| `postex` | **live** | Full implementation — booking, single + bulk tracking (with 400 fallback), cities, pickup addresses, load sheets, cancellation |
| `leopard` | **live** | Full implementation — booking, tracking, cities (with shipmentTypes), createShipper, cancellation. No webhook HMAC signature — security via `webhookEndpointId` URL routing |
| `tcs` | `framework_ready` | Stub — methods throw `not implemented`. Ready for future integration |
| `shopify` | `framework_ready` | Stub — `createOrderFromShopifyWebhook()` is fully implemented (parses payload, matches customer, creates order), but the adapter that maps Shopify webhook payloads is a stub |
| `daraz` | `framework_ready` | Stub — no order creation path |

**Every outbound call is logged** — `executeLoggedIntegrationAction()` wraps the adapter call and writes to `IntegrationActionLog` with:

| Field | Description |
|---|---|
| `actionType` | `book_shipment`, `cancel_shipment`, `track_shipment`, `track_shipment_bulk`, `generate_load_sheet`, `create_pickup_address`, etc. |
| `direction` | `outbound` (always for these calls) |
| `requestPayload` | The actual business data sent to the courier (city, address, COD amount, tracking number) — NEW, was always null before Aug 2026 |
| `responsePayload` | The courier's response (success or error body) |
| `durationMs` | End-to-end wall-clock time |
| `success` | `true` if the adapter returned without throwing |
| `error` | Error message if `success=false` |

**No credentials are logged** — only business data. Credentials live in `CompanyIntegration.encryptedCredentials` (AES-256-GCM via `INTEGRATION_ENCRYPTION_KEY`).

### 3.7 Background jobs

FlowOps runs on a long-lived Bun server, so Vercel-style cron (`vercel.json`) does NOT fire. Two background jobs are started in-process via Next.js's `instrumentation.ts` hook:

| Job | Interval | Purpose | Env var to disable |
|---|---|---|---|
| PostEx status poller | 30 minutes | Polls all active orders with tracking numbers; transitions dispatched → delivered / returned / cancelled | `ENABLE_IN_PROCESS_POLLER=false` |
| Exchange-rate refresh | 24 hours | Fetches daily FX rates relative to USD; stores in `ExchangeRateSnapshot` | `ENABLE_IN_PROCESS_FX_REFRESH=false` |

The other 3 cron jobs defined in `vercel.json` (city sync every 3h, scan reports daily 1AM, Leopard safety-net every 12h) require **manual triggering or external scheduler** (cron-job.org, GitHub Actions). They are exposed at `/api/cron/*` and accept GET (manual) + POST with `x-cron-secret` header.

### 3.8 The frontend routing architecture

```
src/app/page.tsx
  ├─ useQuery(['session', 'me']) → GET /api/auth/me
  │    (refetchOnWindowFocus: true — catches terminated-employee state)
  ├─ if !hydrated → <Loader2 spin /> loading screen
  ├─ if !user → <AuthShell>{login|register|forgot|reset}</AuthShell>
  ├─ if user && !isOnboarded → <OnboardingView />
  └─ if user && isOnboarded → <DashboardShell>{renderRoute(route)}</DashboardShell>
```

`renderRoute(route)` is a `switch(route.name)` over the ~62 named routes in the `AppRoute` discriminated union. Every view component is lazy-loaded via `next/dynamic` with `ssr: false`:

```typescript
const ProductsView = dynamic(
  () => import('@/components/products/products-view').then(m => ({ default: m.ProductsView })),
  { ssr: false, loading: LoadingFallback }
)
```

This code-split the bundle from 1 monolithic 3,148 KB chunk to 95 chunks (5 root + 90 lazy), reducing First Load JS to 1,070 KB (66% reduction).

**IMPORTANT**: do NOT add module-scope `() => import(...)` maps (a previous attempt called `ROUTE_CHUNK_LOADERS` caused Turbopack to create 55 duplicate chunks, +1,303 KB). Each route's code should be imported ONLY in its `dynamic()` call.

---

## 4. Module Catalog

This section enumerates every user-facing module in FlowOps, grouped by sidebar section. For each module, we list:

- **Status**: ✅ Built / 🔧 In-process / ❌ Not built
- **Permission key** required (if any)
- **Key API routes**
- **Key frontend components**
- **What it does** (1-2 sentences)

### 4.1 Products section

The Products section is for managing the product catalog. Products are org-level templates; companies subscribe to them and add their own pricing/inventory.

| Module | Status | Permission | Description |
|---|---|---|---|
| **All Products** | ✅ | `PRODUCTS_VIEW` | Master list of all products the active company subscribes to. Responsive table (desktop, 8 columns) + stacked card list (mobile), switches at `md` breakpoint. Search + filter by status, type, category, brand. Click row → Product Detail. |
| **Add Product** | ✅ | `PRODUCTS_CREATE` | 3-step creation wizard (Basics → Variants → Pricing). Auto-saves draft to `FormDraft`. Phone validation, attribute selector, variant cartesian generation with bidirectional rule filtering. |
| **Product Drafts** | ✅ | `PRODUCTS_VIEW` | List of saved product drafts. Restore / delete. Drafts persist forever (no TTL — known tech debt). |
| **Returned Stock** | ✅ | `INVENTORY_VIEW` | Made-to-order items returned in "perfect" condition go into `ReturnedStitchedInventory` (not regular pool). Future MTO orders check this bucket first before triggering fresh production (saves stitching cost). |
| **Catalog Settings** | ✅ | `PRODUCTS_MANAGE_CATALOG` | Org-level catalog management: Categories, Brands, Attributes, Attribute Values. Tabbed CRUD interface. Seeding default attributes (Piece Type, Size, Color, Fabric, Unstitched→One Size rule) is supported via `POST /api/catalog/seed-defaults`. |

**Key API routes** (`/api/products/**`, `/api/returned-stitched/**`, `/api/catalog/**`, `/api/categories`, `/api/brands`, `/api/org/catalog`): 24 product routes + 3 returned-stitched + 10 catalog + 2 legacy shims = ~39 routes.

### 4.2 Inventory section

The Inventory section manages stock — its location, movement, valuation, and reconciliation.

| Module | Status | Permission | Description |
|---|---|---|---|
| **Dashboard** | ✅ | `INVENTORY_VIEW` | KPI cards (total stock value, low-stock count, out-of-stock count, overstock count) + low-stock table + out-of-stock table + overstock table. |
| **Locations** | ✅ | `INVENTORY_VIEW` (`INVENTORY_MANAGE_LOCATIONS` for write) | CRUD for `InventoryLocation` (warehouse, dispatch_hub, retail_store, transit, damaged_hold). Each location has type + address + active flag. |
| **Suppliers** | ✅ | `INVENTORY_VIEW` (`INVENTORY_MANAGE_SUPPLIERS` for write) | CRUD for `Supplier` master. Each supplier has name, contact, lead time, payment terms. |
| **Receive Stock** | ✅ | `INVENTORY_RECEIVE` | Receive PO stock into a location. Selects PO → selects location → enters quantities → calls `POST /api/inventory/receive` which decrements `incoming` and increments `onHand` via `purchase_received` transaction. |
| **Adjust Stock** | ✅ | `INVENTORY_ADJUST` | Manual stock +/- adjustment. Negative adjustment uses `damage_writeoff` transaction type and SHOULD now create a `StockLossRecord` via `recordStockLoss()` with `sourceModule='adjust_stock'` (see §5.4 — known gap). |
| **Transfer Stock** | ✅ | `INVENTORY_TRANSFER` | Inter-location transfer. Two-step: out of source location (`transfer_out`) + into destination (`transfer_in`). Known CRITICAL bug: non-atomic — if the second step fails, stock is destroyed. |
| **Purchase Orders** | ✅ | `INVENTORY_VIEW` (`INVENTORY_MANAGE_PURCHASE_ORDERS` for write) | PO lifecycle: create → confirm → receive → close/cancel. PO number generated atomically via `get_next_sequence_number(orgId, 'po_number', year)` (migration 026). Increments `incoming` on confirm; decrements `incoming` + increments `onHand` on receive. |
| **Supplier Returns** | ✅ | `INVENTORY_VIEW` (`INVENTORY_MANAGE_SUPPLIER_RETURNS` for write) | Return to supplier flow. Create return → mark disputed (creates `StockLossRecord` with `lossType='supplier_dispute'`, `sourceModule='supplier_return'`). |
| **Production Orders** | ✅ | `INVENTORY_VIEW` (`INVENTORY_MANAGE_PRODUCTION` for write) | Made-to-order production orders. Created automatically when an order containing an MTO variant is confirmed. Consumes fabric (`fabric_consumed_for_stitching` transaction). On completion, produces the finished variant + reserves for the order. |
| **Losses & Write-offs** | ✅ | `INVENTORY_VIEW` (`INVENTORY_REPORT_LOSS` + `INVENTORY_MANAGE_LOSS` for write) | Stock losses: damaged / theft / transit / missing. Report → investigate → resolve (write off). Calls `recordStockLoss()` with `sourceModule='stock_loss'`. Stats endpoint shows total loss value by type + responsible party. |
| **Cycle Counts** | ✅ | `INVENTORY_VIEW` (`INVENTORY_CYCLE_COUNT` for write) | Create cycle count → enter counted quantities → approve. On approve: adjusts stock via `cycle_count_adjust` transaction (sets onHand to counted value). For theft/unknown shortage, also creates a `StockLossRecord` with `sourceModule='cycle_count'`. |

**Key API routes** (`/api/inventory/**`, `/api/inventory-locations/**`, `/api/suppliers/**`, `/api/purchase-orders/**`, `/api/production-orders/**`, `/api/stock-loss/**`, `/api/cycle-counts/**`, `/api/supplier-returns/**`): ~40 routes.

**Core helper file**: `src/lib/inventory.ts` (949 lines) — `processInventoryTransaction`, `reserveStockForOrder`, `unreserveStockForOrder`, `dispatchOrder`, `restockOrderForRto`, `checkAndFulfillMadeToOrderVariant`, `quarantineStock`, `releaseQuarantine`. This is the **ONLY** sanctioned way to modify `InventoryPool`.

### 4.3 Orders section

The Orders section manages the complete order lifecycle — from creation through courier booking, dispatch, delivery, RTO, and exchange.

| Module | Status | Permission | Description |
|---|---|---|---|
| **All Orders** | ✅ | `ORDERS_VIEW` | Master orders list (2599 lines component). Customer/product autocomplete, status filter, date range, search by order number / tracking / phone. Recharts Bar+Line charts for revenue trend. |
| **Create Order** | ✅ | `ORDERS_CREATE` | 6-section creation wizard: Customer → Items → Payment → Discounts → Summary → Submit. Customer search via `CustomerSearchAutocomplete` (300ms debounce). Items section gated by 3-Gate enforcement (variant active → market enabled → market priced). Auto-saves draft. Idempotency key via `useIdempotentMutation()`. |
| **Order Drafts** | ✅ | `ORDERS_VIEW` | Saved order drafts. Restore / delete. |
| **Pending Confirmation** | ✅ | `ORDERS_VIEW` (`ORDERS_FULFILL` to act) | Queue of orders with `status='pending'` (when `requireOrderConfirmation=true`). Actions: confirm (reserves stock), cancel, convert payment type. |
| **Backordered** | ✅ | `ORDERS_VIEW` | Queue of orders with `status='partially_backordered'`. Shows which items are backordered. Auto-fulfills when stock arrives via `checkAndFulfillBackorders()` (combined priority queue: exchange shipments first, then order items). |
| **Awaiting Production** | ✅ | `ORDERS_VIEW` | MTO items grouped by production status. Each group shows production order + estimated completion. |
| **Ready to Dispatch** | ✅ | `ORDERS_VIEW` (`ORDERS_FULFILL` to act) | Bulk dispatch queue. Checkbox selection + bulk dispatch action. Calls `performOrderDispatch()` which is idempotent (skips already-dispatched items). |
| **Booking Workbench** | ✅ | `ORDERS_VIEW` | 3-tab bulk courier booking: Orders / Shipments / Activity. Selects multiple orders + sequential POSTs to `/book`. Single source of truth: `bookOrderWithCourier()` (used by both workbench + auto-booking). Load sheet tab: generate PDF manifest (PostEx only) for multiple orders. |
| **Order Scan** | ✅ | `ORDERS_VIEW` | Barcode scanner with 6 modes: `mark_processing`, `mark_packed`, `warehouse_handover`, `receive_return`, `locate_cancelled`, `cancel_via_scan`. Scans by tracking number → looks up order → applies mode's action. Daily reports generated via cron → PDF stored locally. |
| **Returns & RTO** | ✅ | `ORDERS_VIEW` | RTO list with review flags. Shows orders that came back via courier (auto-RTO via webhook or polling). Items needing review (damaged, etc.) flagged with `needsReview=true`. |
| **Exchanges** | ✅ | `ORDERS_VIEW` | Customer-requested exchanges. Methods: `courier_replacement` (we ship a new item via courier) or `self_ship` (customer ships back themselves). Lifecycle: request → verify old item received → dispatch replacement → settle price difference. |
| **Cancelled** | ✅ | `ORDERS_VIEW` | Cancelled orders list. Post-dispatch cancellation is NOT allowed. Pre-dispatch cancellation auto-cancels courier booking first via `cancelCourierBooking()`. |

**Key API routes** (`/api/orders/**`, `/api/exchanges/**`, `/api/exchange-shipments/**`, `/api/scan/**`, `/api/booking-workbench/**`): ~45 routes.

**Core action files**:
- `src/lib/actions/order.actions.ts` (2681 lines) — `createManualOrder`, `confirmOrder`, `cancelOrder`, `performOrderDispatch`, `markOrderPacked`, `markOrderDelivered`, `reserveOrderStock` (helper)
- `src/lib/actions/order-return.actions.ts` (490 lines) — `processOrderReturn`, `correctReturnItemCondition`, `dismissReturnReview`
- `src/lib/actions/exchange.actions.ts` (1352 lines) — full exchange lifecycle
- `src/lib/actions/exchange-shipment.actions.ts` (1382 lines) — exchange shipment lifecycle
- `src/lib/actions/booking.actions.ts` (969 lines) — `bookOrderWithCourier`, `maybeAutoBookOrder`, `bookOrdersBatch`
- `src/lib/actions/courier-cancel.actions.ts` (270 lines) — `cancelCourierBooking` (both orders + exchange shipments)
- `src/lib/actions/backorder.actions.ts` (413 lines) — `checkAndFulfillBackorders`
- `src/lib/actions/postex-status-poll.actions.ts` (868 lines) — PostEx polling + status transitions
- `src/lib/actions/leopard-webhook.actions.ts` (572 lines) — Leopard webhook processing + safety-net poll
- `src/lib/actions/scan.actions.ts` (356 lines) — barcode scan processing
- `src/lib/actions/load-sheet.actions.ts` (524 lines) — PostEx load sheet generation

### 4.4 Customers section

Customers are org-level (shared across all companies in the org). This is unusual but intentional — the same customer (e.g. a repeat Instagram buyer) is the same person regardless of which brand they're buying from.

| Module | Status | Permission | Description |
|---|---|---|---|
| **Customer List** | ✅ | `CUSTOMERS_VIEW` | List with search (debounced 300ms by phone or name), filter by flagged status. Each row shows: name, primary phone, total orders, total value, RTO count, flagged badge. |
| **Customer Detail** | ✅ | `CUSTOMERS_VIEW` | Profile page: multi-phone list, multi-address list (with country flag), order history, RTO history, flagged status. Auto-flag sets `isFlagged=true` + `flagReason='High RTO rate'` at 3+ RTO. |
| **Customer Create** | ✅ | `CUSTOMERS_CREATE` | Multi-phone / multi-address form. Phone validation via `libphonenumber-js` (`isValidPhoneFormat`). City autocomplete with live-fallback when cache misses. |
| **Customer Search Autocomplete** | ✅ | `CUSTOMERS_VIEW` | Debounced dropdown used in Order Create. Searches by phone (normalized) + name (trigram index on `customer_phones.phoneRaw`). |
| **Customer Stats Backfill** | ✅ | `CUSTOMERS_MANAGE` (typically admin) | One-off backfill of `totalOrdersCount`, `totalOrderValue`, `totalRtoCount` for legacy customers. |

**Key API routes** (`/api/customers/**`): 5 routes (list+create, [id], [id]/phones, [id]/addresses, backfill-stats).

**Customer matching** — `matchOrCreateExternalCustomer()` uses 4-layer matching:
1. **Exact identity** — Shopify/Daraz customer ID match
2. **Phone match** — normalized phone match (libphonenumber-js for international)
3. **Email match** — case-insensitive email match
4. **Create new** — if no match, create a new Customer row

### 4.5 Admin section

The Admin section is for elevated-role users (Owner, Founder, Co-Founder, Investor). Standard-role employees cannot see these modules.

| Module | Status | Permission | Description |
|---|---|---|---|
| **Employees** | ✅ | `EMPLOYEES_VIEW` (`EMPLOYEES_INVITE` to invite, `EMPLOYEES_TERMINATE` to terminate) | Employee list with 4 filters (status, role, designation, department). Invite by email (sends email with token). 5-tab detail: Overview, Access (role + permissions), Performance (order funnel analytics), Salary (profile + commission rules + live monthly preview), My Payslips. |
| **Payroll** | ✅ | `PAYROLL_VIEW_ALL` | Tabbed view: Payroll Runs + Advances. Generate run dialog (selects period, department filter). Run detail: payslips table, finalize, mark-all-paid, per-payslip adjust, mark-paid. |
| **Roles & Permissions** | ✅ | `SETTINGS_ROLES_MANAGE` | Role list + create/delete. Role edit: name + permission keys (collapsible checkbox group driven by `PERMISSION_GROUPS`) + `ordersDataScope` toggle (controls whether role sees all orders or only their own). |
| **Organization** | ✅ | elevated only | Org details + companies list + archive company. |
| **Company Settings** | ✅ | `SETTINGS_COMPANY_VIEW` (`SETTINGS_COMPANY_EDIT` for write) | Company profile: name, logo, base currency, country code, tax IDs, address. |
| **Audit Log** | ✅ | `AUDIT_VIEW` | Immutable event log of every mutation in the system. Filterable by action, entity type, employee, date range. |
| **Org Catalog** | ✅ | elevated only | Org-level catalog view (categories, brands, attributes) across all companies. |
| **Personal Settings** | ✅ | (any authenticated user) | Personal profile card (read-only). |

### 4.6 Integrations section

The Integrations section manages connections to external courier + ecommerce providers. Elevated-only.

| Module | Status | Permission | Description |
|---|---|---|---|
| **Courier Integrations** | ✅ | elevated only | Cards for each registered provider (PostEx, Leopard, TCS). Connect (enter credentials, encrypted with AES-256-GCM), disconnect, set as default. Per-integration: pickup addresses, sync cities, test connection. |
| **Ecommerce Integrations** | ✅ | elevated only | Cards for Shopify + Daraz (stubs). Connect flow exists; actual order ingestion is stubbed. |
| **Integration Logs** | ✅ | elevated only | Full call log of every outbound API call to a courier/ecommerce. Expandable rows showing request payload + response payload + duration. |
| **Webhooks** | ✅ | elevated only (read-only in UI; calls are server-side) | Generic webhook receiver at `/api/webhooks/[provider_key]/[webhook_endpoint_id]`. Each `CompanyIntegration` has a unique `webhookEndpointId` for security (only someone who knows the endpoint ID can push). Leopard webhook processes the full status array; PostEx uses polling instead. |
| **Leopard Preferences** | ✅ | elevated only | Per-integration preferences for Leopard booking payload. Toggles: include product name / SKU / color / quantity in special instructions. Position (start/end) + custom separator. Live preview mirrors `buildLeopardSpecialInstructions()`. |

### 4.7 Other top-level modules

| Module | Status | Permission | Description |
|---|---|---|---|
| **Dashboard** | ✅ | (any authenticated user) | KPI cards: total orders, pending, dispatched, delivered, RTO rate, revenue (with multi-currency rollup). Recent activity. Quick actions. |
| **Order Settings** | ✅ | elevated only | Company-level order workflow config: `requireOrderConfirmation` (true → orders go to Pending Confirmation queue; false → auto-confirm), `courierBookingMode` (automatic / manual), `defaultCourier`, `defaultDispatchLocation`. |
| **Form Drafts** | ✅ | (any authenticated user) | Autosaved form drafts (product create, order create). Survives page refresh. No TTL — drafts persist forever (known tech debt). |

---

## 5. Key Systems

These are the cross-cutting systems that span multiple modules. Understanding these is essential before touching inventory, orders, or stock-loss code.

### 5.1 Stock types (onHand / reserved / available / incoming)

Every variant × location pair has 4 stock numbers in `InventoryPool`:

| Field | DB column | What it means | Mutated by |
|---|---|---|---|
| **onHand** | `onHand Int @default(0)` | Physical units currently in the warehouse | `purchase_received` (+), `sale_dispatched` (−), `return_resellable` (+), `transfer_in` (+), `transfer_out` (−), `damage_writeoff` (−), etc. |
| **reserved** | `reserved Int @default(0)` | Units reserved for confirmed orders (not yet dispatched) | `order_reserved` (+), `order_unreserved` (−), `sale_dispatched` (−) |
| **incoming** | `incoming Int @default(0)` | Units on order from supplier (PO confirmed, not yet received) | PO confirm (+), PO receive (−, moves to onHand), PO cancel (−) |
| **available** | (computed, no DB column) | `onHand - reserved` — what's actually sellable | Computed in app code every time it's needed |

**The invariant** — at any moment, for any pool:
```
onHand >= reserved           (you can't reserve more than you physically have)
available = onHand - reserved (computed; never stored)
incoming >= 0                (can't have negative incoming)
```

`processInventoryTransaction()` enforces these invariants — it validates before mutating and throws on violation. **NEVER** mutate `InventoryPool` directly with `db.inventoryPool.update()` — always go through `processInventoryTransaction()`.

### 5.2 Order lifecycle (create → confirm → cancel/un-cancel → dispatch → RTO → return)

The order lifecycle is the heart of FlowOps. Every transition has inventory side-effects.

```
                              ┌─────────── cancel (unreserve) ─────────┐
                              │                                         │
                              ▼                                         │
   pending ──────────► confirmed ──► processing ──► packed ──► dispatched ──► delivered
       │                   │                                         │
       │                   │ unreserve + cancel                       │
       │                   ▼                                         ▼
       └──────────────► cancelled                              returned
                           ▲                                  (RTO → restock)
                           │
                   partially_backordered
                           │
                           ▼ (when stock arrives, auto-fulfills)
                       confirmed
```

**Transition rules**:

| Transition | Trigger | Inventory effect | Reverse-able? |
|---|---|---|---|
| `pending → confirmed` | Manual confirm OR auto-confirm (if prepaid OR `requireOrderConfirmation=false`) | `reserveStockForOrder()` per line item | Yes — `confirmed → cancelled` |
| `pending → cancelled` | Manual cancel | None (nothing reserved) | ❌ No un-cancel — must recreate |
| `confirmed → partially_backordered` | When reservation fails for some items | Reserve available; backorder remainder | Yes — auto-fulfills when stock arrives |
| `confirmed → processing` | Manual mark processing (or `mark_packed` scan mode) | None | Yes |
| `processing → packed` | Manual mark packed (or `mark_packed` scan) | None | Yes |
| `confirmed/processing/packed → dispatched` | Manual dispatch (or auto from PostEx/Leopard poll: `picked_up` triggers dispatch) | `dispatchOrder()` → `sale_dispatched` (decreases onHand + reserved) | ❌ No un-dispatch |
| `dispatched → delivered` | Manual mark delivered (or auto from courier poll: `delivered` status) | None | Yes |
| `dispatched → returned` (RTO) | Manual RTO mark (or auto from courier poll: `returned` status) | `restockOrderForRto()` → `return_resellable` or `return_stitched_received` (increases onHand) | Yes |
| `dispatched → cancelled` | ❌ BLOCKED — post-dispatch cancellation not allowed | — | — |
| `confirmed → cancelled` (with courier booking) | Manual cancel | `cancelCourierBooking()` first (pre-pickup only), then `unreserveStockForOrder()` | ❌ No un-cancel |

**Payment types** (separate from order status):

| `paymentType` | Description | `paymentStatus` flow |
|---|---|---|
| `full_cod` | Cash on delivery — full amount collected by courier | `cod_pending` → `cod_collected` (on delivery) |
| `partial_advance` | Partial advance paid online, remainder COD | `cod_pending` → `advance_paid` → `cod_collected` |
| `fully_prepaid` | Full amount paid online before dispatch | `cod_pending` → `fully_prepaid` → `advance_paid` (on dispatch) |

**Auto-confirm rule**: if `paymentType === 'fully_prepaid'` OR `requireOrderConfirmation === false`, the order auto-confirms on creation (skips the Pending Confirmation queue).

**Auto-book rule**: if `courierBookingMode === 'automatic'`, order confirmation fires `maybeAutoBookOrder()` in the background (PostEx can take 50-100s). The booker is fire-and-forget — order creation response doesn't wait.

### 5.3 Courier booking (single + bulk, slip PDF, load sheet)

**Single booking** — `bookOrderWithCourier()` in `src/lib/actions/booking.actions.ts` (969 lines). This is the single source of truth — used by both Booking Workbench (manual) and `maybeAutoBookOrder()` (automatic).

```typescript
// Simplified flow:
const result = await bookOrderWithCourier({
  orderId,
  ctx,                    // workspace context (for permission check)
  skipCourierCall: false, // true = only update internal state (used by cancel-after-book)
})

// What it does:
// 1. Resolve courier adapter (from CompanyIntegration for the order's courier)
// 2. Validate city (revalidateCityAtBookingTime — 3h staleness guard + live fallback)
// 3. Build BookShipmentInput (customer info, address, COD amount, items)
// 4. Call adapter.bookShipment(input) via executeLoggedIntegrationAction()
// 5. Save trackingNumber + courierSubStatus='slip_generated' on the order
// 6. (Optionally) fetch slip PDF and store locally
// 7. Fire-and-forget audit log
```

**Bulk booking** — Booking Workbench UI selects multiple orders → sequentially POSTs `/api/booking-workbench/book` for each. NOT parallel — the courier API would rate-limit. Each call is independent; one failure doesn't roll back others.

**Slip PDF generation**:

- **PostEx**: returns a PDF URL in the booking response. FlowOps downloads it and stores locally at `public/uploads/courier-slips/<tracking>.pdf` (don't trust external URLs — they expire).
- **Leopard**: returns PDF bytes inline in the booking response. FlowOps writes them to the same path.
- **Self-fulfilled**: when `fulfillmentChannel === 'self_fulfilled'`, FlowOps generates its own slip PDF using `@react-pdf/renderer` + `jsbarcode` (CODE128 barcode) + `sharp` (SVG → PNG). Stored at `public/uploads/self-fulfilled-slips/<SF-YYYY-NNNNN>.pdf`.

**Load sheet** — PostEx-specific bulk manifest. `generateLoadSheet()` takes a list of tracking numbers + pickup address → calls `POST /v2/generate-load-sheet` → stores the returned PDF at `public/uploads/load-sheets/<id>.pdf`. The `LoadSheet` model records which orders were included for audit.

### 5.4 Stock-loss unification (8 source modules funnel through `recordStockLoss()`)

See §3.5 for the full design. The short version:

| Source module | What calls `recordStockLoss()` |
|---|---|
| `stock_loss` | Stock Losses module form (POST `/api/stock-loss/report-damaged`, `/report-theft`, `/report-transit`) |
| `rto` | RTO review queue — `correctReturnItemCondition()` in `order-return.actions.ts` |
| `cycle_count` | Cycle count approve — `POST /api/cycle-counts/[id]` with `action: 'approve'` for theft/unknown shortage |
| `adjust_stock` | Adjust Stock module — negative adjustment (known gap: currently decrements via `damage_writeoff` txn but doesn't call `recordStockLoss()` — flagged in audit) |
| `returned_stitched` | Receive returned stitched — damaged branch |
| `supplier_return` | Supplier return PATCH with `status='rejected'` |
| `exchange` | `verifyOldItemReceived()` — damaged branch (known gap: bypasses `recordStockLoss()` — creates StockLossRecord directly without orderItemId) |
| `return_scan` | (planned, not built) — Return Order Scan inline damage recording |

**Dedup index**: `stock_loss_orderitem_dedup_idx` partial unique index on `(orderItemId, lossType, sourceModule) WHERE orderItemId IS NOT NULL`. Prevents double-counting.

**Known gaps** (flagged in `STOCKLOSS_INVESTIGATION.md` + audit reports):

1. Adjust Stock module doesn't call `recordStockLoss()` for negative adjustments.
2. Cycle count `damage_not_recorded` / `recording_error` / `transfer_not_recorded` branches don't create loss records.
3. Exchange `verifyOldItemReceived` bypasses `recordStockLoss()` — creates StockLossRecord directly without `orderItemId` (so dedup doesn't apply).
4. Damaged form's `responsible_party` enum omits `'supplier'` and `'unknown'` even though the DB column allows them.
5. Damaged form has no order picker — selecting `responsible_party='courier'` produces a loss record with no order link.

These are documented tech debt — see `STOCKLOSS_INVESTIGATION.md` for the 10-step implementation priority list.

### 5.5 Atomic number generation (`get_next_sequence_number()`)

FlowOps generates human-readable numbers for orders, POs, self-fulfilled references, exchange shipments, and drafts. Format: `<PREFIX>-<YEAR>-<SEQ>` (e.g. `ORD-2026-00123`, `PO-2026-00045`, `SF-2026-00001`, `EXCH-2026-00012`).

**Problem**: the legacy `generate_order_number()` SQL function (migration 001) used `SELECT MAX(...) + 1` — a classic race condition under concurrent inserts. Two simultaneous order creates could grab the same MAX+1, and the `@@unique([companyId, flowopsOrderNumber])` constraint would reject the second with Prisma P2002 → 500 error to the user.

**Solution**: migration 026 (`supabase/migrations/026_atomic_sequence_counter.sql`) introduced `get_next_sequence_number(p_org_id, p_type, p_year)` — an atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` function.

```sql
CREATE TABLE IF NOT EXISTS "number_sequences" (
  "organizationId" TEXT NOT NULL,
  "type"            TEXT NOT NULL,    -- 'order_number' | 'po_number' | 'sf_number' | 'exchange_shipment_number' | 'draft_number'
  "year"            INT  NOT NULL,
  "nextNumber"      INT  NOT NULL DEFAULT 1,
  CONSTRAINT "number_sequences_org_type_year_key" UNIQUE ("organizationId", "type", "year")
);

CREATE OR REPLACE FUNCTION get_next_sequence_number(
  p_org_id TEXT, p_type TEXT, p_year INT
) RETURNS INT AS $$
  INSERT INTO "number_sequences" ("organizationId", "type", "year", "nextNumber")
  VALUES (p_org_id, p_type, p_year, 1)
  ON CONFLICT ("organizationId", "type", "year")
  DO UPDATE SET "nextNumber" = "number_sequences"."nextNumber" + 1
  RETURNING "number_sequences"."nextNumber";
$$ LANGUAGE sql;
```

**Usage** (verified in source code as of this rewrite):

| Generator | Where | Sequence type | Status |
|---|---|---|---|
| `generateOrderNumber(companyId)` | `src/lib/actions/order.actions.ts` line ~90 | `'order_number'` | ✅ Uses `get_next_sequence_number()` |
| `generateSelfFulfilledReference(companyId)` | `src/lib/actions/order.actions.ts` line ~128 | `'sf_number'` | ✅ Uses `get_next_sequence_number()` |
| `generatePoNumber(orgId)` | `src/lib/inventory.ts` line ~455 | `'po_number'` | ✅ Uses `get_next_sequence_number()` |
| `generateExchangeShipmentNumber()` | (legacy SQL function from migration 008) | `'exchange_shipment_number'` | ⚠️ Still uses legacy MAX-based sequence (global, not per-org). Known tech debt. |
| `generateDraftNumber()` | (legacy SQL function from migration 006) | `'draft_number'` | ⚠️ Still uses legacy MAX-based sequence. Known tech debt. |

**Migrating the legacy generators**: write a migration that wraps `generate_exchange_shipment_number()` and `generate_draft_number()` to call `get_next_sequence_number()` internally. The function signatures stay the same; the implementation becomes atomic.

### 5.6 Permission system (roleTier + requirePermission)

**30 permission keys** in `src/lib/permissions.ts`, organized by module:

| Module | Keys |
|---|---|
| Inventory (14) | `view`, `create`, `adjust`, `delete`, `receive`, `report_loss`, `manage_loss`, `manage_locations`, `manage_suppliers`, `transfer`, `manage_purchase_orders`, `manage_supplier_returns`, `cycle_count`, `manage_production` |
| Products (7) | `view`, `create`, `edit`, `manage_catalog`, `subscribe`, `pricing`, `promote` |
| Orders (5) | `view`, `create`, `fulfill`, `cancel`, `manage` |
| Customers (4) | `view`, `create`, `edit`, `manage` |
| Employees (4) | `view`, `invite`, `terminate`, `manage` |
| Finance/Payroll (3) | `view_all`, `manage_own`, `manage_all` |
| Reports (2) | `view`, `export` |
| Settings (3) | `company_view`, `company_edit`, `roles_manage` |
| Integrations (2) | `view`, `manage` |
| KPI & Audit (3) | `kpi_view`, `kpi_manage`, `audit_view` |

**Two-tier permission model**:

| Tier | Who | How permissions checked |
|---|---|---|
| **Elevated** | Owner, Founder, Co-Founder, Investor (`systemRoleKey` ∈ these values) | Bypass ALL permission checks via `isElevated()` — always returns `true` |
| **Standard** | All other roles (custom roles created per-company) | Check `employee.permissions.includes(key)` — explicit grant required |

**`requirePermission(ctx, key)`** in `src/lib/workspace.ts`:

```typescript
export async function requirePermission(
  ctx: WorkspaceContext,
  key: string,
): Promise<void> {
  // Elevated roles bypass all checks
  if (ctx.employee.role.roleTier === 'elevated') return

  // Fast path: check cached permission set (0ms)
  const cached = getCachedRolePermissions(ctx.employee.roleId)
  if (cached) {
    if (cached.has(key)) return
    throw new ApiError(403, `You lack permission: ${key}`)
  }

  // Cache miss: fetch role's permissions from DB
  const perms = await db.rolePermission.findMany({
    where: { roleId: ctx.employee.roleId },
    select: { permissionKey: true },
  })
  const set = new Set(perms.map((p) => p.permissionKey))
  setCachedRolePermissions(ctx.employee.roleId, set)  // 60s TTL

  if (set.has(key)) return
  throw new ApiError(403, `You lack permission: ${key}`)
}
```

**Frontend equivalent**: `useCan()` hook returns a function `(key: string) => boolean`. Elevated roles always return `true`. Standard roles check the cached `employee.permissions` array.

**`ordersDataScope`** — a per-role toggle that controls whether the role sees all orders in the company or only their own. Used by `resolveOrderScope()` in `src/lib/order-scope.ts` (modern pattern used by all queue routes).

### 5.7 Workspace cache (60-second in-memory cache for `getWorkspace()`)

See §3.4 for the full design. The short version:

| Function | Purpose |
|---|---|
| `getCachedWorkspace(userId)` | Returns cached `WorkspaceContext` if not expired, else `null` |
| `setCachedWorkspace(userId, ctx, ttlMs = 60_000)` | Caches the workspace for 60s |
| `invalidateWorkspaceCache(userId)` | Clears the user's workspace + ALL role permission caches (because if the user's role changed, we don't know the old roleId without a DB query) |
| `clearAllCaches()` | Nuclear option — clears everything. Used on logout. |

**Role permissions cache** — separate cache, also 60s TTL, keyed by `roleId`. Eliminates the per-permission-check DB query. Cleared whenever the workspace cache is invalidated (because role changes are correlated).

**When to call `invalidateWorkspaceCache(userId)`**:

| Event | Where to call |
|---|---|
| User switches active company | `POST /api/workspace/switch` route |
| User logs out | `POST /api/auth/logout` route |
| Admin edits an employee's role | `PATCH /api/employees/[id]` route (when role changes) |
| Admin terminates an employee | `POST /api/employees/[id]/terminate` route |
| Admin edits a role's permissions | `PATCH /api/roles/[id]` route |

**Multi-instance caveat**: this is a per-process Map. In a multi-replica deployment, each instance has its own cache. Worst case: a permission change takes 60s to propagate to all instances. Acceptable for an ERP — revisit when adding a second replica.

---

## 6. Database Overview

> **Full schema detail lives in `DATABASE_GUIDE.md`.** This section gives the high-level map so you can navigate the schema.

### 6.1 Connection details

| Property | Value |
|---|---|
| Provider | PostgreSQL (Supabase-managed) |
| Region | `ap-south-1` (Mumbai) |
| Pooler | Session mode, port 5432 |
| Project ID (dev) | `gobwxqkzfulbwhzbbsdj` |
| Schema management | `prisma db push` (NOT migrations — see §8) |
| Reference SQL files | `supabase/migrations/0XX_*.sql` (29 files; 015 + 017 skipped) |
| Consolidated functions file | `supabase/functions-only.sql` (all 24+ functions, 2 sequences, 12 triggers, 2 partial unique indexes) |

### 6.2 Required environment variables

```env
DATABASE_URL="postgresql://postgres.gobwxqkzfulbwhzbbsdj:123%40Usman123%40@aws-0-ap-south-1.pooler.supabase.com:5432/postgres"
DIRECT_URL="postgresql://postgres.gobwxqkzfulbwhzbbsdj:123%40Usman123%40@aws-0-ap-south-1.pooler.supabase.com:5432/postgres"
INTEGRATION_ENCRYPTION_KEY="1fbf4fd279d9476183566c878e38907764feac7e7843d16ac60065720a451951"
SESSION_SECRET="flowops-session-secret-v1-change-in-production-please-32-chars-min"
CRON_SECRET="flowops-cron-secret-v1-change-in-production"
APP_URL="http://localhost:3000"
```

> ⚠️ **KNOWN SANDBOX ISSUE**: the `.env` file reverts to SQLite (`file:./db/custom.db`) on every sandbox restart. The `predev` script refuses to start `bun run dev` if `DATABASE_URL` doesn't begin with `postgresql://`. Always verify `.env` before starting the server.

### 6.3 The 68 Prisma models (high-level grouping)

| Group | Count | Models |
|---|---|---|
| **Auth / Org / Tenancy** | 10 | `Profile`, `Organization`, `Company`, `Role`, `RolePermission`, `Employee`, `Invitation`, `UserSetting`, `AuditLog`, `MetricEvent` |
| **Catalog / Products** | 14 | `OrgCategory`, `OrgBrand`, `OrgAttribute`, `OrgAttributeValue`, `AttributeValueRule`, `OrgProduct`, `OrgProductVariant`, `OrgProductImage`, `OrgProductBundle`, `SelectiveProductAccess`, `CompanyProductSetting`, `CompanyVariantPricing`, `ProductFulfillmentCost`, `ReturnedStitchedInventory` |
| **Inventory** | 15 | `InventoryLocation`, `Supplier`, `InventoryPool`, `InventoryTransaction`, `AvgCostHistory`, `StockTransfer`, `PurchaseOrder`, `PurchaseOrderItem`, `PurchaseOrderReceipt`, `PurchaseOrderReceiptItem`, `SupplierReturn`, `StockLossRecord`, `CycleCount`, `CycleCountItem`, `ProductionOrder` |
| **Customer** | 4 | `Customer`, `CustomerPhone`, `CustomerAddress`, `CustomerExternalIdentity` |
| **OMS / Orders** | 3 | `CompanyOrderSetting`, `Order`, `OrderItem` |
| **Exchange** | 2 | `OrderExchange`, `ExchangeShipment` |
| **Markets** | 5 | `Market`, `MarketCountry`, `MarketVariantPricing`, `MarketProduct`, `ExchangeRateSnapshot` |
| **Integrations / Courier** | 6 | `IntegrationProvider`, `CompanyIntegration`, `IntegrationActionLog`, `CourierOperationalCity`, `CourierCityAlias`, `CourierPickupAddress` |
| **Scan** | 2 | `ScanEvent`, `ScanDailyReport` |
| **Load Sheets** | 1 | `LoadSheet` |
| **Drafts** | 1 | `FormDraft` |
| **Idempotency** | 1 | `IdempotencyKey` |
| **HR / Payroll** | ~4 | `SalaryProfile`, `CommissionRule`, `PayrollRun`, `Payslip`, `SalaryAdvance` (check `DATABASE_GUIDE.md` for exact count) |

### 6.4 Key relationships (the data model in one diagram)

```
Profile ──┬── owns ──► Organization ──┬── has ──► Company ──┬── has ──► Employee ──► Role ──► RolePermission
           │                          │                     │
           └── settings ─────────────┘                     ├── subscribes ──► OrgProduct ──► OrgProductVariant
                                                            │                  │
                                                            │                  └── pricing ──► CompanyVariantPricing
                                                            │                                     │
                                                            │                                     └── per-market ──► MarketVariantPricing
                                                            │                                                       (resolved via Market)
                                                            │
                                                            ├── has ──► InventoryLocation ──► InventoryPool ◄── OrgProductVariant
                                                            │                                  │
                                                            │                                  └── ledger ──► InventoryTransaction
                                                            │
                                                            ├── has ──► Order ──► OrderItem
                                                            │              │
                                                            │              ├── courier ──► CompanyIntegration ──► IntegrationProvider
                                                            │              │              (logs every call to IntegrationActionLog)
                                                            │              │
                                                            │              └── exchange ──► OrderExchange ──► ExchangeShipment
                                                            │
                                                            └── has ──► Customer (org-level, shared across companies)
                                                                          │
                                                                          ├── phones ──► CustomerPhone
                                                                          ├── addresses ──► CustomerAddress
                                                                          └── external IDs ──► CustomerExternalIdentity
```

### 6.5 SQL functions (applied manually, NOT in Prisma schema)

These live in `supabase/functions-only.sql` and must be applied via raw SQL to the DB after `prisma db push`. Prisma's schema doesn't define them, but the application calls them via `prisma.$queryRaw`.

| Function | Purpose |
|---|---|
| `get_next_sequence_number(orgId, type, year)` | **Atomic** sequence counter for order/PO/SF numbers (migration 026) |
| `generate_order_number(companyId)` | **Legacy** MAX+1-based order number (migration 001) — still used by some legacy code paths; new code uses `get_next_sequence_number` directly |
| `generate_self_fulfilled_reference(companyId)` | Self-fulfilled reference (`SF-YYYY-NNNNN`) — now uses `get_next_sequence_number` internally |
| `generate_exchange_shipment_number()` | Exchange shipment number (`EXCH-YYYY-NNNNN`) — still legacy MAX-based |
| `generate_draft_number()` | Draft number — still legacy MAX-based |
| `normalize_phone(phone)` | Normalizes Pakistani phone numbers; international pass-through (returns `+`-prefixed non-PK numbers unchanged) |
| `recompute_order_status(orderId)` | Recomputes order status from items (dead code — flagged in audit) |
| `match_or_create_customer(...)` | Customer matching SQL function (4-layer: exact_identity → phone_match → email_match → create). Now accepts 7 params including `p_country` |
| RLS helpers | `get_active_company_id()`, `get_active_org_id()`, `has_permission()`, `is_elevated_employee()` |
| Triggers | `backfill_order_timestamps()`, `update_*_updatedAt()` |

### 6.6 Partial unique indexes (manually applied)

| Index | Table | Purpose |
|---|---|---|
| `invitation_pending_email_unique` | `Invitation(companyId, invitedEmail) WHERE status='pending'` | Prevents duplicate pending invites (race window fix) |
| `market_one_default_per_company` | `Market(companyId) WHERE "isDefault" = TRUE` | Enforces exactly one Default market per company |
| `stock_loss_orderitem_dedup_idx` | `StockLossRecord(orderItemId, lossType, sourceModule) WHERE orderItemId IS NOT NULL` | Dedup for stock-loss unification (migration 027) |

### 6.7 Migrations

29 SQL migration files in `supabase/migrations/` (numbered 001–029, with 015 and 017 skipped). These are **reference SQL** — the live schema is managed via `prisma db push` against `prisma/schema.prisma`.

**Migration rules** (from `PRODUCTION_DEPLOYMENT_GUIDE.md`):

1. Migrations are ONE-WAY — once applied to production, they cannot be rolled back (no down migrations).
2. Test ALL migrations on DEV first.
3. New migrations: number them `030_+` (next available).
4. Make migrations idempotent (`IF NOT EXISTS` / `DO $$ ... BEGIN ... EXCEPTION WHEN OTHERS THEN END; $$`).
5. NEVER modify an already-applied migration — create a new one instead.

---

## 7. Current Status

### 7.1 What's live in production (verified working)

As of the latest deployment, these are confirmed working end-to-end on the Hostinger production server:

| Area | Status | Notes |
|---|---|---|
| **Leopard Couriers integration** | ✅ Live | Full booking, tracking, cities, createShipper, cancellation. Real production credentials connected. |
| **PostEx integration** | ✅ Live | Full booking, single + bulk tracking (with 400 fallback), cities, pickup addresses, load sheets, cancellation. Real production credentials connected. |
| **Auth + multi-tenancy** | ✅ Live | Custom HMAC sessions, org/company/employee, 30 permissions, 4 elevated roles. |
| **Product catalog** | ✅ Live | Org-level catalog; company subscription; variant generation; pricing overrides. |
| **Inventory system** | ✅ Live | Pools, 16+ transaction types, WAC, reservations, dispatch, returns, transfers, adjustments. |
| **Order management** | ✅ Live | Create (manual), confirm, dispatch, deliver, cancel, RTO, payment conversion, all queue views. |
| **Customer management** | ✅ Live | Multi-phone, multi-address, external identities, RTO flagging, stats. |
| **Stock-based + Made-to-Order** | ✅ Live | Fulfillment types, fabric consumption, production orders, returned-stitched bucket. |
| **Purchase orders + supplier returns** | ✅ Live | PO lifecycle, supplier returns with dispute flow. |
| **Stock losses + cycle counts** | ✅ Live | Theft/transit/damaged reporting, cycle count workflow (with stock-loss unification). |
| **Exchanges** | ✅ Live | Request, verify, dispatch replacement, settle price difference. |
| **Booking Workbench + load sheets** | ✅ Live | Bulk booking, PostEx load sheet PDF generation. |
| **City management** | ✅ Live | Sync, search, auto-fetch missing cities, fuzzy match, aliases. |
| **Courier status tracking** | ✅ Live | Auto-poller every 30 min (PostEx), Leopard webhook receiver, bulk+single fallback. |
| **Order Scan** | ✅ Live | 6 scan modes, daily PDF reports. |
| **Dashboard + audit logs** | ✅ Live | KPIs, recent activity, immutable audit log of every mutation. |
| **Form drafts** | ✅ Live | Autosave for product + order creation forms. |
| **International phone validation** | ✅ Live | libphonenumber-js for UK/UAE/US etc.; normalize_phone() SQL has pass-through for `+` non-PK. |
| **Country system** | ✅ Live | `CustomerAddress.country` + `Order.deliveryCountry` (alpha-2 codes, default "PK"). |
| **Self-fulfilled channel** | ✅ Live | `Order.fulfillmentChannel` ('courier' | 'self_fulfilled'); SF-YYYY-NNNNN reference; internal slip PDF with CODE128 barcode. |
| **Markets system** | ✅ Live | `Market` + `MarketCountry` + `MarketVariantPricing` + `MarketProduct`; 3-gate enforcement; per-market pricing. |
| **Idempotency system** | ✅ Live | `withIdempotency()` backend + `useIdempotentMutation()` frontend; applied to all 24+ creation endpoints. |
| **Stock-loss unification** | ✅ Live | `recordStockLoss()` helper + dedup index (migration 027). Known gaps in `adjust_stock` and `exchange` source modules — see §5.4. |

### 7.2 What's deferred / not yet built

| Area | Status | Notes |
|---|---|---|
| **TCS courier integration** | ❌ Not built | Adapter is a stub (`framework_ready`). Real API integration needed. |
| **Shopify ecommerce integration** | 🔧 Partial | `createOrderFromShopifyWebhook()` is fully implemented (parses payload, matches customer, creates order with 3-gate soft enforcement + total_discounts capture + needsReview flagging). The adapter that verifies webhook signature + maps payload is a stub. |
| **Daraz ecommerce integration** | ❌ Not built | Adapter is a stub. No order creation path. |
| **External scheduler for cron jobs** | ❌ Not built | Vercel cron doesn't fire on this server. Options: external service (cron-job.org, GitHub Actions) hitting the cron endpoints, OR deploy to Vercel. Currently 3 of 5 cron jobs require manual triggering (city sync, scan reports, Leopard safety-net). |
| **`calculateRate()` for couriers** | ❌ Not built | Both PostEx + Leopard `calculateRate()` throw "not implemented". Needed for shipping cost estimation. |
| **Reports & analytics module** | ❌ Not built | `REPORTS_VIEW` / `REPORTS_EXPORT` permissions exist but no reporting module is built. |
| **Advanced KPI dashboard** | ❌ Partial | `KPI_VIEW` / `KPI_MANAGE` permissions exist; basic dashboard exists but no advanced KPI management UI. |
| **Finance module** | ❌ Not built | `FINANCE_VIEW` / `FINANCE_MANAGE` permissions exist but no finance module is built. |
| **Real-time notifications** | ❌ Not built | No websocket/notification system. `mini-services/postex-poller/` is a scaffold; `examples/websocket/` is reference only. |
| **Mobile app** | ❌ Not built | Web-only, but responsive down to mobile breakpoint (`md` = 768px). |
| **Tax management** | ❌ Partial | `taxAmount` / `taxLabel` fields exist on `Order` but no tax calculation engine. |
| **Email notifications** | ❌ Not built | Forgot-password is a stub; no email sending. |
| **SMS notifications** | ❌ Not built | No SMS integration. |
| **Product bundles UI** | ❌ Not built | `OrgProductBundle` model exists but no bundle management UI. |
| **Attribute value rules UI** | ❌ Not built | `AttributeValueRule` model exists but no rule engine UI. |
| **Low-stock alerts** | ❌ Partial | `reorderPoint` / `reorderQuantity` fields exist on `InventoryPool` but no alerting system. |
| **CSV / Excel data export** | ❌ Not built | `REPORTS_EXPORT` permission exists but no export functionality. |
| **Cloud storage (S3, etc.)** | ❌ Not built | All files stored on local filesystem (`public/uploads/`). This is a deployment-time bomb on Vercel — currently fine for Hostinger VPS. |
| **Redis cache layer** | ❌ Deferred | App uses TanStack Query (client) + in-memory Map cache (server, 60s TTL). Redis was considered for `/api/auth/me` server-side caching but deferred after the raw-SQL JOIN fix brought warm requests to ~210ms. Revisit when adding a second server replica or when DB read load becomes measurable. |
| **DB-level Row-Level Security** | ❌ Not built | All multi-tenant isolation is in the application layer. |

### 7.3 Recently fixed (last 6 months of work)

These were major issues that have been resolved. Listed here so future developers don't re-investigate them.

| Issue | Resolution | Task ID |
|---|---|---|
| `/api/auth/me` took 500-1000ms | `buildSessionPayload()` now uses single raw SQL JOIN instead of 5-6 sequential Prisma queries. Latency reduced from ~696ms to ~210ms warm (67% faster). | `AUTH-ME-LATENCY-FIX-PHASE1` + `AUTH-ME-LATENCY-FIX-PHASE2` |
| First Load JS was 3,148 KB | Code-split 70+ views via `next/dynamic` with `ssr: false`. Reduced to 1,070 KB (66% reduction). | `LCP-OPTIMIZATION` |
| LCP regression — duplicate chunks | Removed `ROUTE_CHUNK_LOADERS` module-scope import map that caused Turbopack to create +55 duplicate chunks. Chunk count 150 → 95. | `LCP-REGRESSION-FIX` |
| 10 dead dependencies installed | Removed `@mdxeditor/editor`, `@tanstack/react-table`, `@dnd-kit/*`, `framer-motion`, `react-syntax-highlighter`, `react-markdown`, `next-intl`, `next-auth`. node_modules 1.3 GB → 1.2 GB. | `DEAD-DEPS-REMOVAL` |
| Inventory-OMS disconnect (4 bugs) | Fixed placeholder `'reserved'` → `'pending'`, `convertPaymentStatus` now reserves, courier RTO restocks dispatched orders, Shopify webhook now reserves. | `OMS-FIXES-*` |
| Courier cancel — Leopard support | Removed PostEx-only guard; Leopard's `cancelShipment()` now works for both orders + exchange shipments. | `COURIER-CANCEL-FIX` |
| Order cancel → courier cancel | `cancelOrder()` now calls `cancelCourierBooking()` first when a courier booking exists (pre-dispatch only). | `ORDER-CANCEL-COURIER-FIX` |
| Exchange shipment cancel → courier cancel | `cancelExchangeShipment()` now calls courier cancel when trackingNumber exists. | (part of `COURIER-CANCEL-FIX`) |
| City propagation | Corrected cities propagate from order creation + booking-time resolution back to CustomerAddress (only when using saved address). | `CITY-PERMISSIVE-PROPAGATION` + `CITY-PROPAGATION-VERIFICATION` |
| International phone validation | libphonenumber-js for international numbers; normalize_phone() SQL has pass-through for `+`-prefixed non-PK numbers. | `PHONE-VALIDATION-INTERNATIONAL` + `PHONE-INTL-FIX` |
| Idempotency system | `withIdempotency()` backend helper + `useIdempotentMutation()` frontend hook; applied to ALL 24+ creation endpoints; DB-level unique constraints on employee invites + company integrations. | `IDEMPOTENCY-PHASE1-4` + `IDEMPOTENCY-DB-LEVEL-UNIQUENESS` |
| Request payload logging | `IntegrationActionLog.requestPayload` now populated for all outbound courier calls. | `REQUEST-PAYLOAD-LOGGING` |
| Stock-loss unification | `recordStockLoss()` helper + `stock_loss_orderitem_dedup_idx` partial unique index (migration 027). | `STOCKLOSS-INVESTIGATE` (design) — implementation in subsequent tasks |
| Atomic number generation | `get_next_sequence_number()` (migration 026) used by PO numbers, order numbers, and self-fulfilled references. | `IDEMPOTENCY-DB-LEVEL-UNIQUENESS` + `IDEMPOTENCY-VERIFICATION-FINAL` |
| Self-fulfilled slip PDF 404 | API now returns PDF as binary response (`Content-Type: application/pdf`); frontend uses `fetch()` → `blob()` → `URL.createObjectURL()` → `window.open()`. No static file serving needed. | (recent slip PDF binary response fix) |
| Order-create child-component scope leaks | 6 child function components in `order-create-view.tsx` (declared at module level, not closures) had parent-scope variables referenced directly without being passed as props. Fixed by passing ALL required variables as props. | (part of order-create scope-leak fixes) |
| Markets system cleanup | Markets system was removed from order-creation path then re-added with cleaner architecture. 3-gate enforcement is now consistent. | `REVERT-MARKET-SYSTEM-FROM-ORDER-CREATION` + `REMOVE-MARKET-SYSTEM` + subsequent rebuild tasks |

### 7.4 Known issues / tech debt

These are documented issues that have NOT been fixed yet. Reference the audit reports for full detail.

| Severity | Issue | Source |
|---|---|---|
| CRITICAL | `db.courierStatusHistory` references nonexistent Prisma model — runtime crash on every courier status update + every Courier Status History tab fetch. Migration 023 created the raw SQL table but no Prisma model was added. | `ORDERS_AUDIT.md` |
| CRITICAL | `ExchangeShipment.courierBookingStatus` CHECK constraint violation on cancellation — `cancelCourierBooking()` writes `'cancelled'` which is NOT in the DB CHECK enum. | `ORDERS_AUDIT.md` |
| CRITICAL | Non-atomic multi-step product creation in `POST /api/products` — partial products can be left if a later step fails. | `PRODUCTS_AUDIT.md` |
| CRITICAL | Permission bypass on `POST /api/categories` and `/api/brands` — any active employee can create org-level catalog entities. | `PRODUCTS_AUDIT.md` |
| CRITICAL | Non-atomic transfer endpoint in `/api/inventory/transfers` — if the second step (transfer_in) fails, stock is destroyed. | `INVENTORY_AUDIT.md` |
| CRITICAL | Non-atomic PO receive — if a step fails mid-receive, PO state is inconsistent. | `INVENTORY_AUDIT.md` |
| HIGH | `verifyOldItemReceived` (exchange damaged branch) bypasses `recordStockLoss()` — creates StockLossRecord directly without `orderItemId`, so dedup doesn't apply. | `ORDERS_AUDIT.md` + `STOCKLOSS_INVESTIGATION.md` |
| HIGH | Adjust Stock module doesn't call `recordStockLoss()` for negative adjustments — Stock Losses dashboard under-reports. | `STOCKLOSS_INVESTIGATION.md` |
| HIGH | ~13 routes still use legacy manual auth pattern (not modern `getWorkspace()` + `requirePermission()`). | `ORDERS_AUDIT.md` |
| HIGH | Missing company-scoping on several detail endpoints (cross-company access possible). | `INVENTORY_AUDIT.md` + `PRODUCTS_AUDIT.md` |
| MEDIUM | `generate_exchange_shipment_number()` and `generate_draft_number()` still use legacy MAX+1 race-condition SQL (not migrated to `get_next_sequence_number`). | `ORDERS_AUDIT.md` |
| MEDIUM | Image storage is local filesystem under `public/uploads/products/{orgId}/{productId}/` despite schema comment claiming Supabase Storage. Deployment-time bomb on Vercel. | `PRODUCTS_AUDIT.md` |
| MEDIUM | Draft system (`FormDraft`) has NO expiry / TTL / size limit — drafts persist forever. | `PRODUCTS_AUDIT.md` |
| MEDIUM | `payroll-run-detail` route is missing from `routesWithId` in `url-sync.ts` — navigating to it won't carry the `id` in the URL, so a refresh loses context. | `URL-NAVIGATION-MIGRATION` |
| LOW | Dead Zod schemas in `validations/inventory.ts` + `validations/stock-loss.ts` (~50% of schemas defined but unused). | `INVENTORY_AUDIT.md` |
| LOW | `executeLoggedIntegrationAction` has a blocking DB write — the `IntegrationActionLog` insert in the `finally` block is awaited (~150ms per booking). Not yet converted to fire-and-forget. | (performance note) |

---

## 8. Important Notes & Operational Rules

### 8.1 The 5 golden rules (NON-NEGOTIABLE)

These are the operating rules for the FlowOps codebase. Violating them causes production incidents.

#### Rule 1: TWO databases — NEVER mix them

- **DEV/TEST DB** — `postgresql://postgres.gobwxqkzfulbwhzbbsdj:...@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`
  - Used for: development, testing, brute-force testing, sandbox experiments.
  - Contains: test users, test orders, test products, fake data.
  - **NEVER** connect production code to this DB.
- **PRODUCTION DB** — (new Supabase project — created on deployment day)
  - Used for: live business operations.
  - Contains: real users, real orders, real money data.
  - **NEVER** run test scripts against this DB.
  - **NEVER** create test users in this DB.

#### Rule 2: `.env` file management

- The `.env` file in the sandbox **always reverts to SQLite** (`file:./db/custom.db`) on restart — this is a known sandbox issue.
- On Hostinger (production), the `.env` will be set once and persist.
- **DEV `.env`** → points to DEV Supabase (current credentials).
- **PRODUCTION `.env`** → points to PRODUCTION Supabase (new credentials — set on Hostinger).
- **NEVER** commit `.env` to git (it's in `.gitignore`).
- The `predev` script refuses to start `bun run dev` if `.env` `DATABASE_URL` doesn't start with `postgresql://`. Always verify `.env` before starting the server.

#### Rule 3: NO test data in production

- The production DB starts EMPTY (only schema, no data).
- Onboarding flow creates the first org → company → owner.
- **NEVER** run seed scripts, test data generators, or brute-force tests against production.
- **NEVER** create test customers, test orders, or test products in production.

#### Rule 4: Migrations are ONE-WAY

- Database migrations (`supabase/migrations/*.sql`) are applied to production ONCE.
- Once a migration is applied to production, it CANNOT be rolled back (no down migrations).
- Test ALL migrations on DEV first — verify they work before applying to production.
- Migration numbering: 001–029 exist. New migrations start at 030+.
- NEVER modify an already-applied migration — create a new one instead.
- NEVER use `prisma db push` on production after initial setup (it can drop columns) — use `prisma migrate` or manual SQL.

#### Rule 5: CODE CHANGES — DEV first, PRODUCTION second

- ALL code changes are developed + tested on the DEV sandbox first.
- Only after DEV testing passes, changes are deployed to Hostinger production.
- **NEVER** make code changes directly on the Hostinger server.
- **NEVER** run `bun run dev` on Hostinger — use `bun run build` + `bun run start`.

### 8.2 The sandbox rules (what NOT to do on the sandbox)

| Rule | Why |
|---|---|
| **NEVER run `bun run build` on the sandbox** | The build can take 5-10 minutes and will hang the dev server. Build only on Hostinger. The sandbox is for `bun run dev` only. |
| **NEVER run `prisma db push` against production** | `db push` is schema-destructive — it can drop columns. Use it ONLY on DEV. |
| **NEVER run `prisma migrate reset` against production** | Drops all data. DEV only. |
| **NEVER run brute-force test scripts against production** | Test scripts generate fake data + load. Production DB is for real business data. |
| **NEVER commit `.env` to git** | Contains DB credentials. `.gitignore` already excludes it. |
| **NEVER hardcode production credentials in code** | Use env vars. Production credentials should never appear in source. |
| **NEVER run `bun run dev` on Hostinger** | Hostinger uses `bun run build` + `bun run start`. The dev server is not production-grade. |
| **NEVER connect to production DB from the sandbox** | Even read-only queries can lock rows or affect query plans. The AI's standing rule is "never connect to the production database from this sandbox." |
| **NEVER create test users in production** | The first user is the org owner — created via the onboarding flow with real credentials. |
| **NEVER modify production `.env` from the sandbox** | The user does this on Hostinger directly. |
| **NEVER apply a migration to production without testing on DEV first** | Migrations are one-way — a broken migration on production is a crisis. |

### 8.3 The predev guard

The `predev` script in `package.json`:

```bash
node -e "const fs=require('fs');const e=fs.readFileSync('.env','utf8');
if(e.includes('file:')||!e.includes('postgresql://')){
  console.error('❌ .env has invalid DATABASE_URL — must be postgresql://, not file:. Fix .env before starting.');
  process.exit(1);
}
console.log('✅ .env verified — using PostgreSQL');"
```

If you see `❌ .env has invalid DATABASE_URL`, restore the correct `.env` from `PRODUCTION_DEPLOYMENT_GUIDE.md` or git history. The correct DEV `.env` is in §6.2 above.

### 8.4 The development workflow

```
┌─────────────────────────────────────────────────────────────┐
│                    DEV SANDBOX (this machine)                │
│                                                              │
│  .env → DEV Supabase (test DB)                              │
│  ┌──────────────────────────────────────┐                   │
│  │ 1. Make code changes                 │                   │
│  │ 2. Test on dev server (bun run dev)  │                   │
│  │ 3. Brute-force test                  │                   │
│  │ 4. Lint check (bun run lint)         │                   │
│  │ 5. Commit to git                     │                   │
│  └──────────────────────────────────────┘                   │
│                         ↓                                    │
│  ┌──────────────────────────────────────┐                   │
│  │ 6. Apply migrations to DEV DB first │                   │
│  │ 7. Verify schema on DEV              │                   │
│  │ 8. If migration works → proceed      │                   │
│  │ 9. If migration breaks → fix on DEV │                   │
│  └──────────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────┘
                          ↓ (only when DEV is green)
┌─────────────────────────────────────────────────────────────┐
│                  PRODUCTION (Hostinger)                       │
│                                                              │
│  .env → PRODUCTION Supabase (live DB)                        │
│  ┌──────────────────────────────────────┐                   │
│  │ 1. Pull latest code (git pull)       │                   │
│  │ 2. Apply migrations to PROD DB        │                   │
│  │ 3. Rebuild (bun run build)           │                   │
│  │ 4. Restart server (bun run start)    │                   │
│  │ 5. Verify /api/health                 │                   │
│  │ 6. Verify key flows manually          │                   │
│  └──────────────────────────────────────┘                   │
│                                                              │
│  ⚠️ NO test scripts, NO brute-force, NO seed data            │
│  ⚠️ NO `bun run dev` — only `bun run build` + `bun run start`│
│  ⚠️ NO direct DB edits — only via migrations or the app     │
└─────────────────────────────────────────────────────────────┘
```

### 8.5 Other operational gotchas

#### Environment

1. **`.env` reverts to SQLite on sandbox restart** — the `predev` script guards against this. Always verify before starting.
2. **DB latency from sandbox** — Mumbai region (~100ms per query). Performance optimizations (fire-and-forget, parallel queries, single-JOIN getWorkspace, 60s workspace cache) have been applied.
3. **Turbopack instability** — dev server can hang during compilation in the sandbox (memory issue). Clear `.next/` cache and restart.
4. **Hydration mismatch from browser extensions** — Grammarly injects `data-gr-ext-installed` + `data-new-gr-c-s-check-loaded` attributes into `<body>`. Fixed via `suppressHydrationWarning` on `<body>` in `layout.tsx`. If new hydration errors appear, check for other browser-extension-injected attributes.

#### Bundling

5. **Do NOT add module-scope `import()` maps** — a `ROUTE_CHUNK_LOADERS` map with 55 `() => import(...)` entries caused Turbopack to create 55 duplicate chunks (+1,303 KB). The ONLY place each route's code should be imported is the `dynamic()` call in `page.tsx`. See §3.8 warning.

#### Integrations

6. **PostEx bulk tracking API** — intermittently returns HTTP 400 "Required List parameter 'TrackingNumbers' is not present". Handled with single-track fallback. Don't "fix" by removing the bulk path — single-track is too slow for 100+ orders.
7. **Vercel cron doesn't fire** — on long-lived server. In-process pollers added for PostEx (30min) + exchange rate refresh (24h). Other crons (city sync, scan reports, Leopard safety-net) need manual triggering or external scheduler. The `ENABLE_IN_PROCESS_POLLER` + `ENABLE_IN_PROCESS_FX_REFRESH` env vars (default `true`) can disable for multi-replica deployments.
8. **PostEx API lag** — parcels may be physically picked up but PostEx's API still shows "Booked" for hours. This is a PostEx issue, not FlowOps.

#### Schema

9. **SQL functions must be applied manually** — `generate_order_number()`, `generate_self_fulfilled_reference()`, `normalize_phone()`, `match_or_create_customer()`, `get_next_sequence_number()`, etc. are NOT in the Prisma schema. They must be applied via raw SQL to the DB. A consolidated file `supabase/functions-only.sql` contains all 24+ functions + 2 sequences + 12 triggers + 2 partial unique indexes (`invitation_pending_email_unique` + `market_one_default_per_company` + `stock_loss_orderitem_dedup_idx`).
10. **No DB-level RLS** — all multi-tenant isolation is in the app layer. A bug in `getWorkspace()` or a missing `companyId` filter could leak data across tenants.
11. **No `available` column** — `available = onHand - reserved` is computed in app code every time it's needed.
12. **Order-create child components are module-level functions** — `CustomerSection`, `ItemsSection`, `PaymentSection`, etc. in `order-create-view.tsx` are declared at the module level (NOT closures inside `OrderCreateView`). Any new state variable used in these child components MUST be passed as a prop — referencing it directly will compile fine but crash at runtime with `ReferenceError`. TypeScript does NOT catch this. When adding new state/hooks to `OrderCreateView` that child components need, always: (1) add it to the child's destructured props, (2) add it to the child's type definition, (3) pass it from `<OrderCreateView>` to `<ChildComponent>`.

#### Performance

13. **Audit/metric writes are fire-and-forget** — on a serverless platform (Vercel Edge), these would be killed mid-flight. The current long-lived Bun server keeps them alive.
14. **`executeLoggedIntegrationAction` has a blocking DB write** — the `IntegrationActionLog` insert in the `finally` block is awaited (~150ms per booking). Not yet converted to fire-and-forget.
15. **`/api/auth/me` performance** — FIXED. `buildSessionPayload()` now uses a single raw SQL JOIN. Latency reduced from ~696ms to ~210ms warm (67% faster). Server-side in-memory cache deliberately deferred after the raw-SQL JOIN fix brought warm requests to ~210ms — revisit when adding a second replica or when concurrent DB read load becomes measurable.

### 8.6 What AI assistants should NEVER suggest

When generating prompts or code suggestions for FlowOps, AI assistants should NEVER suggest:

- ❌ **NextAuth** — the app uses custom HMAC sessions (`next-auth` was removed in Step 4)
- ❌ **Edge runtime** — all routes are `runtime = 'nodejs'`
- ❌ **Redis** — the app uses TanStack Query + in-memory Map cache (60s TTL)
- ❌ **DB-level RLS** — isolation is in the app layer
- ❌ **Prisma migrations** — the app uses `db push` (production gets manual SQL migrations)
- ❌ **Indigo / blue colors** — design rules prohibit them (primary is emerald)
- ❌ **Client-side `z-ai-web-dev-sdk`** — it's backend-only
- ❌ **`next start`** — production uses `bun .next/standalone/server.js`
- ❌ **`framer-motion`, `@dnd-kit/*`, `@tanstack/react-table`, `react-markdown`, `@mdxeditor/editor`, `react-syntax-highlighter`, `next-intl`** — all were removed as dead dependencies in Step 4
- ❌ **Module-scope `import()` maps in `page.tsx`** — causes Turbopack to create duplicate chunks. Use `dynamic()` only.
- ❌ **`React.Table`** — FlowOps uses shadcn/ui `Table` component (`src/components/ui/table.tsx`)
- ❌ **Check-then-create patterns for dedup** — use DB-level unique constraints + catch P2002
- ❌ **Referencing parent-component variables directly in child function components in `order-create-view.tsx`** — they are module-level functions, not closures. ALWAYS pass new state/hooks as props to child components. See §8.5 item 12.
- ❌ **Leaving `requestPayload` null in `executeLoggedIntegrationAction`** — always pass the business data

### 8.7 What AI assistants should ALWAYS do

When working on FlowOps, AI assistants should ALWAYS:

- ✅ Develop + test all changes on the DEV sandbox first
- ✅ Write migrations as idempotent SQL (`IF NOT EXISTS` / `DO $$ ... EXCEPTION ... $$`)
- ✅ Test migrations on DEV DB before declaring them ready
- ✅ Commit all changes to git with clear commit messages
- ✅ Provide exact commands for the user to run on Hostinger
- ✅ Flag any breaking changes that require special deployment steps
- ✅ Use `getWorkspace()` + `requirePermission()` pattern for every authenticated API route
- ✅ Use `processInventoryTransaction()` for every inventory mutation (never direct `db.inventoryPool.update()`)
- ✅ Use `recordStockLoss()` for every stock-loss creation (never direct `db.stockLossRecord.create()`)
- ✅ Use `executeLoggedIntegrationAction()` for every courier API call
- ✅ Use `withIdempotency()` for every creation endpoint (and `useIdempotentMutation()` on the frontend)
- ✅ Fire-and-forget `insertAuditLog()` + `insertMetricEvent()` (no `await`)
- ✅ Use TanStack Query for all data-fetching views (never raw `useEffect` + `api.get()`)
- ✅ Use `next/dynamic` with `ssr: false` for all view components (never static imports)
- ✅ Update this document whenever architecture, modules, key systems, or operational rules change

### 8.8 Common prompt patterns for AI assistants

When generating prompts for AI assistants working on FlowOps, use these patterns:

#### Context to ALWAYS include

```
- Project: FlowOps ERP (Pakistani e-commerce ERP)
- Stack: Next.js 16 + React 19 + TypeScript + Prisma 6 + Supabase PostgreSQL + Tailwind 4 + shadcn/ui
- Multi-tenant: Organization → Company → Employee
- Auth: custom HMAC sessions (not NextAuth), dual-channel (Bearer + cookie)
- State: Zustand (client) + TanStack Query (server) — ALL 70 data-fetching views use useQuery/useMutation
- Single SPA route at /, ~62 named view states, all lazy-loaded via next/dynamic (ssr: false)
- API: 170+ routes under src/app/api/, all use getWorkspace() + requirePermission()
- Actions: 18 files under src/lib/actions/ contain all business logic
- Inventory: src/lib/inventory.ts is the ONLY way to modify InventoryPool
- Stock loss: src/lib/stock-loss.ts recordStockLoss() is the ONLY way to create StockLossRecord
- Couriers: PostEx (live) + Leopard (live) + TCS (stub)
- Fire-and-forget: insertAuditLog/insertMetricEvent return void
- Performance: First Load JS 1,070 KB (code-split into 95 chunks). React.memo on leaf components.
- Workspace cache: 60s in-memory Map cache for getWorkspace() (per-process, not Redis)
- Idempotency: withIdempotency() wraps ALL creation endpoints; useIdempotentMutation() on frontend
- CRITICAL: Do NOT add module-scope import() maps — use dynamic() in page.tsx only (causes duplicate chunks)
```

#### Bug-fix prompt pattern

```
"Fix a bug in the [MODULE] module where [SYMPTOM]. The relevant files are
[FILE PATHS]. The expected behavior is [BEHAVIOR]. Use the existing patterns
in the codebase (getWorkspace, requirePermission, insertAuditLog fire-and-forget)."
```

#### New-feature prompt pattern

```
"Add a new feature to [MODULE]. The flow should be: [FLOW]. Create the API
route at [PATH], the server action in [FILE], and the component in [DIR].
Follow the existing conventions (runtime='nodejs', dynamic='force-dynamic',
ApiError handling, fire-and-forget audit logs, recordStockLoss for any
stock-loss creation, withIdempotency for creation endpoints)."
```

#### Diagnosis prompt pattern

```
"Diagnose why [SYMPTOM]. Check the [MODULE] flow from UI → API → action → DB.
Report the root cause without fixing it yet. Reference the relevant audit
reports (INVENTORY_AUDIT.md, PRODUCTS_AUDIT.md, ORDERS_AUDIT.md,
STOCKLOSS_INVESTIGATION.md) for known issues."
```

---

## 9. Appendix: Quick Reference

### 9.1 File structure (top-level)

```
/home/z/my-project/
├── src/
│   ├── app/
│   │   ├── api/                    # 170+ API routes (App Router)
│   │   ├── page.tsx                # single SPA page
│   │   ├── layout.tsx              # root layout (Providers)
│   │   └── globals.css             # Tailwind 4 + design system
│   ├── components/                 # ~160 React components
│   │   ├── ui/                     # 52 shadcn/ui primitives
│   │   ├── orders/                 # 24 order components
│   │   ├── inventory/              # 17 inventory components
│   │   ├── products/               # 13 product components
│   │   ├── customers/              # 5 customer components
│   │   ├── employees/              # 7 employee components
│   │   ├── roles/                  # 3 role components
│   │   ├── payroll/                # 3 payroll components
│   │   ├── couriers/               # 3 courier components
│   │   ├── settings/               # 6 settings components
│   │   ├── onboarding/             # 6 onboarding components
│   │   ├── auth/                   # 5 auth components
│   │   ├── layout/                 # 5 layout components
│   │   ├── dashboard/              # 1 dashboard component
│   │   ├── workspace/              # 1 workspace switcher
│   │   └── shared/                 # 2 shared components
│   ├── lib/                        # business logic
│   │   ├── actions/                # 18 server action files
│   │   ├── integrations/           # courier + ecommerce adapters
│   │   │   ├── couriers/           # postex, leopard, tcs adapters
│   │   │   ├── ecommerce/          # shopify, daraz adapters
│   │   │   ├── registry.ts         # adapter factory
│   │   │   ├── types.ts            # CourierAdapter interface
│   │   │   └── city-matcher.ts     # fuzzy city matching
│   │   ├── validations/            # Zod schemas (shared client + server)
│   │   ├── workspace.ts            # getWorkspace + requirePermission
│   │   ├── workspace-cache.ts      # 60s in-memory cache
│   │   ├── inventory.ts            # processInventoryTransaction + 10+ helpers
│   │   ├── stock-loss.ts           # recordStockLoss helper
│   │   ├── session.ts              # HMAC session token
│   │   ├── auth.ts                 # scrypt password hashing
│   │   ├── permissions.ts          # 30 permission keys
│   │   ├── audit.ts                # insertAuditLog (fire-and-forget)
│   │   ├── metrics.ts              # insertMetricEvent (fire-and-forget)
│   │   ├── api-client.ts          # fetch wrapper + typed helpers
│   │   ├── api-error.ts           # ApiError + handleError
│   │   ├── db.ts                   # Prisma singleton
│   │   ├── idempotency.ts          # withIdempotency wrapper
│   │   ├── phone-validation.ts     # libphonenumber-js wrapper
│   │   ├── session-payload.ts      # /api/auth/me builder (raw SQL JOIN)
│   │   └── order-scope.ts          # resolveOrderScope (modern pattern)
│   ├── stores/
│   │   └── app-store.ts            # Zustand single store
│   ├── hooks/
│   │   ├── use-idempotent-mutation.ts
│   │   └── form-guard/             # useFormGuard (dirty form protection)
│   └── lib/routing/
│       └── url-sync.ts             # ?view=...&id=... URL sync
├── prisma/
│   └── schema.prisma               # 2,760 lines, 68 models
├── supabase/
│   ├── migrations/                 # 29 SQL migration files
│   └── functions-only.sql         # consolidated SQL functions + indexes
├── public/
│   └── uploads/                    # local file storage
│       ├── company-logos/
│       ├── scan-reports/
│       ├── payslips/
│       ├── self-fulfilled-slips/
│       ├── load-sheets/
│       ├── courier-slips/
│       ├── product-images/
│       └── payment-proofs/
├── mini-services/
│   └── postex-poller/              # scaffold for detached poller
├── docs (top-level project files)
│   ├── FLOWOPS_BRIEFING.md         # THIS document
│   ├── PRODUCTION_DEPLOYMENT_GUIDE.md
│   ├── DATABASE_GUIDE.md
│   ├── INVENTORY_AUDIT.md
│   ├── PRODUCTS_AUDIT.md
│   ├── ORDERS_AUDIT.md
│   ├── STOCKLOSS_INVESTIGATION.md
│   ├── DOCKER.md
│   ├── worklog.md                  # 12,000+ lines — every task ever done
│   ├── package.json
│   ├── Caddyfile                   # gateway config
│   ├── vercel.json                 # cron config (only fires on Vercel)
│   └── instrumentation.ts          # in-process pollers
└── ...
```

### 9.2 The 30 permission keys (full list)

```typescript
// src/lib/permissions.ts
export const PERMISSIONS = {
  // Inventory (14)
  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_CREATE: 'inventory.create',
  INVENTORY_ADJUST: 'inventory.adjust',
  INVENTORY_DELETE: 'inventory.delete',
  INVENTORY_RECEIVE: 'inventory.receive',
  INVENTORY_REPORT_LOSS: 'inventory.report_loss',
  INVENTORY_MANAGE_LOSS: 'inventory.manage_loss',
  INVENTORY_MANAGE_LOCATIONS: 'inventory.manage_locations',
  INVENTORY_MANAGE_SUPPLIERS: 'inventory.manage_suppliers',
  INVENTORY_TRANSFER: 'inventory.transfer',
  INVENTORY_MANAGE_PURCHASE_ORDERS: 'inventory.manage_purchase_orders',
  INVENTORY_MANAGE_SUPPLIER_RETURNS: 'inventory.manage_supplier_returns',
  INVENTORY_CYCLE_COUNT: 'inventory.cycle_count',
  INVENTORY_MANAGE_PRODUCTION: 'inventory.manage_production',

  // Products (7)
  PRODUCTS_VIEW: 'products.view',
  PRODUCTS_CREATE: 'products.create',
  PRODUCTS_EDIT: 'products.edit',
  PRODUCTS_MANAGE_CATALOG: 'products.manage_catalog',
  PRODUCTS_SUBSCRIBE: 'products.subscribe',
  PRODUCTS_PRICING: 'products.pricing',
  PRODUCTS_PROMOTE: 'products.promote',

  // Orders (5)
  ORDERS_VIEW: 'orders.view',
  ORDERS_CREATE: 'orders.create',
  ORDERS_FULFILL: 'orders.fulfill',
  ORDERS_CANCEL: 'orders.cancel',
  ORDERS_MANAGE: 'orders.manage',

  // Customers (4)
  CUSTOMERS_VIEW: 'customers.view',
  CUSTOMERS_CREATE: 'customers.create',
  CUSTOMERS_EDIT: 'customers.edit',
  CUSTOMERS_MANAGE: 'customers.manage',

  // Employees (4)
  EMPLOYEES_VIEW: 'employees.view',
  EMPLOYEES_INVITE: 'employees.invite',
  EMPLOYEES_TERMINATE: 'employees.terminate',
  EMPLOYEES_MANAGE: 'employees.manage',

  // Finance / Payroll (3)
  PAYROLL_VIEW_ALL: 'payroll.view_all',
  PAYROLL_MANAGE_OWN: 'payroll.manage_own',
  PAYROLL_MANAGE_ALL: 'payroll.manage_all',

  // Reports (2)
  REPORTS_VIEW: 'reports.view',
  REPORTS_EXPORT: 'reports.export',

  // Settings (3)
  SETTINGS_COMPANY_VIEW: 'settings.company_view',
  SETTINGS_COMPANY_EDIT: 'settings.company_edit',
  SETTINGS_ROLES_MANAGE: 'settings.roles_manage',

  // Integrations (2)
  INTEGRATIONS_VIEW: 'integrations.view',
  INTEGRATIONS_MANAGE: 'integrations.manage',

  // KPI & Audit (3)
  KPI_VIEW: 'kpi.view',
  KPI_MANAGE: 'kpi.manage',
  AUDIT_VIEW: 'audit.view',
} as const
```

### 9.3 The 16 inventory transaction types

```typescript
// InventoryTransaction.transactionType enum values:
type TransactionType =
  | 'opening_stock'                     // initial stock when pool created
  | 'purchase_received'                 // PO received → onHand += qty
  | 'sale_dispatched'                   // order dispatched → onHand -= qty, reserved -= qty
  | 'order_reserved'                    // order confirmed → reserved += qty
  | 'order_unreserved'                  // order cancelled → reserved -= qty
  | 'return_resellable'                 // RTO return, perfect condition → onHand += qty
  | 'return_stitched_received'          // RTO return, stitched item → onHand += qty (ReturnedStitchedInventory)
  | 'return_damaged'                    // RTO return, damaged → not added to onHand (loss)
  | 'transfer_out'                       // transfer out of source location → onHand -= qty
  | 'transfer_in'                       // transfer into destination → onHand += qty
  | 'cycle_count_adjust'                // cycle count → onHand set to counted value (absolute set)
  | 'damage_writeoff'                   // damaged loss → onHand -= qty
  | 'theft_writeoff'                    // theft loss → onHand -= qty
  | 'missing_writeoff'                  // missing loss → onHand -= qty
  | 'transit_loss'                      // transit loss → onHand -= qty
  | 'supplier_return'                   // return to supplier → onHand -= qty
  | 'fabric_consumed_for_stitching'     // MTO production → fabric variant onHand -= qty
  | 'manual_adjustment_in'              // manual positive adjustment → onHand += qty (audit-fixed)
```

### 9.4 The order status state machine (canonical)

```typescript
// Order.status enum (plain string, not DB enum)
type OrderStatus =
  | 'pending'                 // initial state after creation
  | 'confirmed'               // customer confirmed + stock reserved
  | 'partially_backordered'   // some items reserved, others backordered
  | 'processing'              // operational marker — being prepared
  | 'dispatched'              // handed to courier, tracking number assigned
  | 'delivered'               // customer received the order
  | 'rto'                     // return to origin — courier returned the package
  | 'cancelled'               // cancelled (pre-dispatch only)
  | 'refunded'                // (rare) payment refunded

// OrderItem.fulfillmentStatus enum
type FulfillmentStatus =
  | 'pending'                  // not yet reserved
  | 'reserved'                 // stock reserved for this item
  | 'backordered'              // stock not available, waiting for replenishment
  | 'dispatched'               // handed to courier
  | 'returned'                 // RTO'd
```

### 9.5 The courier sub-status mapping

```typescript
// Order.courierSubStatus — populated by courier polling/webhooks
type CourierSubStatus =
  | 'slip_generated'           // booking successful, tracking number assigned, not picked up yet
  | 'pickup_requested'         // pickup request sent to courier
  | 'picked_up'                // courier picked up the package → triggers performOrderDispatch
  | 'at_warehouse'             // at courier's sorting warehouse
  | 'en_route'                 // in transit to destination
  | 'out_for_delivery'         // out for final delivery
  | 'delivered'                // delivered to customer → triggers markOrderDelivered
  | 'returned'                 // returned to origin → triggers restockOrderForRto
  | 'out_for_return'           // in transit back to shipper
  | 'attempted'                // delivery attempted, failed → needsShipperAdvice
  | 'under_review'             // delivery under review (suspicious) → needsShipperAdvice
  | 'cancelled_by_merchant'    // merchant cancelled the booking
  | 'expired'                  // booking expired without pickup
```

### 9.6 Key URLs (dev / production)

| Service | URL |
|---|---|
| DEV app | `http://localhost:3000` (via `bun run dev`) |
| DEV DB (Supabase) | `postgresql://postgres.gobwxqkzfulbwhzbbsdj:...@aws-0-ap-south-1.pooler.supabase.com:5432/postgres` |
| Health check | `GET /api/health` → `{"status":"healthy","db":"connected"}` |
| PostEx API base | `https://api.postex.pk/services/integration/api/order` |
| Leopard API base | `https://www.leopardscourierspk.com/services` |

### 9.7 Common commands

| Command | Purpose |
|---|---|
| `bun run dev` | Start dev server on port 3000 (with `predev` guard checking `.env`) |
| `bun run lint` | Run ESLint |
| `bun run build` | Build for production (DO NOT run on sandbox) |
| `bun run start` | Start production server (Hostinger only) |
| `bunx prisma db push` | Sync schema to DEV DB (DEV ONLY — never on production) |
| `bunx prisma generate` | Regenerate Prisma client after schema change |
| `bunx prisma studio` | Open Prisma Studio (DB browser) |
| `bunx prisma migrate dev --name <name>` | Create a new migration (DEV ONLY) |

### 9.8 The consolidated SQL functions file

`supabase/functions-only.sql` contains all manually-applied SQL:

- 24+ functions: `get_next_sequence_number`, `generate_order_number`, `generate_self_fulfilled_reference`, `generate_exchange_shipment_number`, `generate_draft_number`, `normalize_phone`, `recompute_order_status`, `match_or_create_customer`, RLS helpers
- 2 sequences: `draft_order_number_seq`, `exchange_shipment_number_seq`
- 12 triggers: `backfill_order_timestamps`, `update_*_updatedAt`, etc.
- 3 partial unique indexes: `invitation_pending_email_unique`, `market_one_default_per_company`, `stock_loss_orderitem_dedup_idx`

Apply this file to a fresh DB after `prisma db push` to enable all SQL functions.

---

*This document is the canonical briefing for the FlowOps ERP system. It MUST be updated whenever significant changes are made to the architecture, modules, dependencies, performance characteristics, or integrations. A stale briefing leads to incorrect AI-assisted code generation and wasted engineering hours — do not let it go stale.*

*Companion documents*:
- `PRODUCTION_DEPLOYMENT_GUIDE.md` — Hostinger + production DB rules (golden rules, deployment checklist, emergency procedures)
- `DATABASE_GUIDE.md` — full Prisma schema reference (all 68 models with field-level detail)
- `INVENTORY_AUDIT.md` — read-only audit findings for inventory subsystem (4 CRITICAL + 37 HIGH + 38 MEDIUM + 24 LOW issues)
- `PRODUCTS_AUDIT.md` — read-only audit findings for products subsystem (3 CRITICAL + 9 HIGH + 11 MEDIUM + 14 LOW issues)
- `ORDERS_AUDIT.md` — read-only audit findings for orders subsystem (5 CRITICAL + 14 HIGH + 18 MEDIUM + 16 LOW issues)
- `STOCKLOSS_INVESTIGATION.md` — design document for the stock-loss unification system + 10-step implementation priority list
- `DOCKER.md` — Docker deployment guide
- `worklog.md` — every task ever completed on the project (12,000+ lines, 200+ task entries)

*End of briefing.*
