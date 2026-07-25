# FlowOps — Complete Setup Guide (macOS & Windows)

A production-grade, multi-tenant SaaS ERP for Pakistani e-commerce businesses.
Built with Next.js 16, TypeScript, Tailwind CSS, shadcn/ui, Prisma, and Supabase Postgres.

**System includes:** Authentication, Organizations, Companies, Employees, RBAC,
Product Catalog (with stitched/unstitched variants), Inventory Management
(with WAC costing), Purchase Orders, Suppliers, Stock Transfers, Cycle Counts,
Production Orders, Stock Loss tracking, and an immutable audit log.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [macOS Setup (Step-by-Step)](#2-macos-setup-step-by-step)
3. [Windows Setup (Step-by-Step)](#3-windows-setup-step-by-step)
4. [Configure Environment (.env)](#4-configure-environment-env)
5. [Set Up the Database](#5-set-up-the-database)
6. [Run the Dev Server](#6-run-the-dev-server)
7. [Using the App](#7-using-the-app)
8. [Useful Scripts](#8-useful-scripts)
9. [Project Structure](#9-project-structure)
10. [Troubleshooting](#10-troubleshooting)
11. [Architecture Notes](#11-architecture-notes)
12. [Quick Start (TL;DR)](#12-quick-start-tldr)

---

## 1. Prerequisites

| Tool | Version | Why |
|---|---|---|
| **Node.js** | 20+ LTS | Required by Next.js 16 |
| **Bun** | 1.1+ | Package manager + dev runtime (this project uses `bun.lock`) |
| **Git** | any | To clone/pull the repo |
| **A Supabase account** | free tier ok | Hosts the PostgreSQL database |

You do **not** need to install PostgreSQL locally — the project connects to Supabase's hosted Postgres.

> You can use `npm` instead of `bun` for every command — just replace `bun` with `npm` and `bunx` with `npx`.

---

## 2. macOS Setup (Step-by-Step)

### Step 2.1 — Install Homebrew (if you don't have it)
Open **Terminal** and run:
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```
Restart your terminal afterwards.

### Step 2.2 — Install Node.js, Bun, and Git
```bash
brew install node git
curl -fsSL https://bun.sh/install | bash
```
Close and reopen your terminal, then verify:
```bash
node --version   # should print v20.x or higher
bun --version    # should print 1.1.x or higher
git --version
```

### Step 2.3 — Clone the project
```bash
cd ~/Documents   # or wherever you keep code
git clone <your-repo-url> flowops
cd flowops
```

### Step 2.4 — Install dependencies
```bash
bun install
```
This reads `bun.lock` and installs every package (Next.js, Prisma, shadcn/ui, TanStack Query, etc.).

### Step 2.5 — Create your `.env` file
See [Step 4 — Configure Environment](#4-configure-environment-env) below for the exact contents.

### Step 2.6 — Push the database schema + generate the Prisma client
```bash
bun run db:push
bun run db:generate
```

### Step 2.7 — Start the dev server
```bash
bun run dev
```
Open **http://localhost:3000** in your browser.

✅ **Done on macOS!** Jump to [Step 7 — Using the App](#7-using-the-app).

---

## 3. Windows Setup (Step-by-Step)

You have two options: **WSL2 (recommended)** or **native Windows**. WSL2 matches the dev environment exactly and avoids Unix-ism issues (like the `tee` command in the `dev` script).

### Option A — WSL2 (recommended)

#### Step 3.1 — Install WSL2 + Ubuntu
Open **PowerShell as Administrator** and run:
```powershell
wsl --install
```
Restart your PC. A Ubuntu terminal will open — set your Linux username and password. **All subsequent steps run inside the WSL Ubuntu terminal.**

#### Step 3.2 — Install Node.js, Bun, and Git (inside WSL Ubuntu)
```bash
sudo apt update && sudo apt install -y nodejs npm git
curl -fsSL https://bun.sh/install | bash
```
Close and reopen the WSL terminal, then verify:
```bash
node --version   # v20.x or higher
bun --version    # 1.1.x or higher
git --version
```
> If `apt`'s Node version is too old, install Node 20 via NodeSource:
> ```bash
> curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
> sudo apt install -y nodejs
> ```

#### Step 3.3 — Clone the project (inside WSL)
```bash
cd ~
git clone <your-repo-url> flowops
cd flowops
```

#### Step 3.4 — Install dependencies
```bash
bun install
```

#### Step 3.5 — Create your `.env` file
See [Step 4 — Configure Environment](#4-configure-environment-env) below.

#### Step 3.6 — Push the database schema + generate the Prisma client
```bash
bun run db:push
bun run db:generate
```

#### Step 3.7 — Start the dev server
```bash
bun run dev
```
Open **http://localhost:3000** in your Windows browser (it auto-forwards from WSL).

✅ **Done on Windows (WSL2)!** Jump to [Step 7 — Using the App](#7-using-the-app).

---

### Option B — Native Windows (no WSL)

#### Step 3.1 — Install Git, Node.js, and Bun
- Install **Git** from <https://git-scm.com/download/win>
- Install **Node.js 20 LTS** from <https://nodejs.org>
- Install **Bun** in PowerShell:
  ```powershell
  powershell -c "irm bun.sh/install.ps1 | iex"
  ```
- Close and reopen your terminal, then verify:
  ```powershell
  node --version
  bun --version
  git --version
  ```

#### Step 3.2 — Clone the project
```powershell
cd C:\Users\<You>\Documents
git clone <your-repo-url> flowops
cd flowops
```

#### Step 3.3 — Install dependencies
```powershell
bun install
```

#### Step 3.4 — Create your `.env` file
See [Step 4 — Configure Environment](#4-configure-environment-env) below. On native Windows, create the file using Notepad, VS Code, or PowerShell:
```powershell
@"
DATABASE_URL="postgresql://postgres.flafcggvqfgyafzekxzk:123%40Usman123%40@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"
DIRECT_URL="postgresql://postgres.flafcggvqfgyafzekxzk:123%40Usman123%40@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"
SESSION_SECRET="flowops-dev-secret-change-in-production-32b"
"@ | Set-Content .env
```

#### Step 3.5 — Push the database schema + generate the Prisma client
```powershell
bun run db:push
bun run db:generate
```

#### Step 3.6 — Start the dev server
```powershell
bun run dev
```
> **Native Windows note:** If you get a `tee` error on `bun run dev`, edit `package.json` and change the `dev` script to `"dev": "next dev -p 3000"` (the `tee dev.log` part is a Unix-ism). On WSL2 this works out of the box.

Open **http://localhost:3000** in your browser.

✅ **Done on Windows (native)!** Jump to [Step 7 — Using the App](#7-using-the-app).

---

## 4. Configure Environment (.env)

Create a file named **`.env`** in the **project root** (same folder as `package.json`).

### Option 1 — Use the existing shared Supabase project (fastest)

```env
# FlowOps — Supabase Postgres
# Session-mode pooler (port 5432) — supports Prisma operations
DATABASE_URL="postgresql://postgres.flafcggvqfgyafzekxzk:123%40Usman123%40@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"

# Same pooler — used by Prisma for migrations / db push
DIRECT_URL="postgresql://postgres.flafcggvqfgyafzekxzk:123%40Usman123%40@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"

# Session signing secret (HMAC cookie sessions)
# Change this to a random 32+ character string for production
SESSION_SECRET="flowops-dev-secret-change-in-production-32b"
```

### Option 2 — Use your own Supabase project (recommended for production)

1. Go to <https://supabase.com> → sign up / log in.
2. Click **New Project** → pick a name, set a strong DB password, choose a region close to you.
3. Wait ~2 minutes for it to provision.
4. Go to **Project Settings → Database → Connection string → URI**.
5. Copy the **Session pooler** URI on **port 5432** (not 6543 — Prisma interactive transactions don't work with the transaction pooler).
6. **URL-encode your password** if it contains special characters. For example, `@` becomes `%40`:
   ```
   postgresql://postgres.<project-ref>:<URL-ENCODED-PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres
   ```
7. Put the same URI in both `DATABASE_URL` and `DIRECT_URL`:
   ```env
   DATABASE_URL="postgresql://postgres.<ref>:<URL-ENCODED-PW>@aws-0-<region>.pooler.supabase.com:5432/postgres"
   DIRECT_URL="postgresql://postgres.<ref>:<URL-ENCODED-PW>@aws-0-<region>.pooler.supabase.com:5432/postgres"
   SESSION_SECRET="<random-32-char-string>"
   ```

### ⚠️ Critical notes

1. **Keep the `%40` encoding in the password.** The `@` character in `123@Usman123@` must be URL-encoded as `%40`, otherwise Prisma will fail to parse the connection string.

2. **Use port 5432, not 6543.** Port 6543 (transaction-mode pooler with `?pgbouncer=true`) does **not** support Prisma's operations and will crash on multi-write operations. Port 5432 (session-mode pooler) works correctly.

3. **Don't set `DATABASE_URL` in your shell.** Shell environment variables override the `.env` file. If you have a stale `DATABASE_URL` set globally, unset it:
   ```bash
   # macOS / Linux / WSL
   unset DATABASE_URL
   unset DIRECT_URL

   # Windows PowerShell
   Remove-Item Env:DATABASE_URL
   Remove-Item Env:DIRECT_URL
   ```

4. **Never commit `.env` to git.** Add it to `.gitignore`.

5. **Make sure the file is named exactly `.env`** (not `.env.txt` or `env`). On native Windows, check in File Explorer → View → File name extensions.

---

## 5. Set Up the Database

Push the Prisma schema to your Supabase Postgres database. This creates all 38 tables with their relations, unique constraints, and indexes:

```bash
bun run db:push
```

You should see:
```
🚀 Your database is now in sync with your Prisma schema. Done in ~5s
```

Then generate the Prisma client:

```bash
bun run db:generate
```

### Tables created (38 models across 6 modules)

#### Sprint 1 — Core Platform (10 tables)
| Table | Purpose |
|---|---|
| `Profile` | Registered users (email, password hash, name) |
| `Organization` | Top-level tenant (umbrella for companies) |
| `Company` | Legal operating entity |
| `Role` | Company-scoped roles (system elevated + custom) |
| `RolePermission` | Permission keys assigned to custom roles |
| `Employee` | Employment records (one user per company) |
| `Invitation` | Token-based email invitations |
| `UserSetting` | Active workspace context + preferences |
| `AuditLog` | Immutable append-only event log |
| `MetricEvent` | Raw numeric events for KPI dashboards |

#### Sprint 3 — Product Catalog (12 tables)
| Table | Purpose |
|---|---|
| `OrgCategory` | Hierarchical org-level categories |
| `OrgBrand` | Org-level brands |
| `OrgAttribute` | Variant attribute definitions (Size, Color, Piece Type) |
| `OrgAttributeValue` | Values for each attribute (S, M, L, Red, Navy) |
| `OrgProduct` | Master product record (stitchable flag, base SKU) |
| `OrgProductVariant` | Shopify-compatible variants (fulfillment_type, stitching_type) |
| `OrgProductImage` | Product/variant images |
| `OrgProductBundle` | Bundle component definitions |
| `SelectiveProductAccess` | Per-company selective sharing |
| `CompanyProductSetting` | Per-company product subscription |
| `CompanyVariantPricing` | Per-company variant sale/compare prices |
| `ProductFulfillmentCost` | Made-to-order production cost tracking |

#### Sprint 6 — Inventory System (16 tables)
| Table | Purpose |
|---|---|
| `InventoryLocation` | Warehouse/dispatch/retail locations |
| `Supplier` | Suppliers (org-level shared or company-specific) |
| `InventoryPool` | Stock levels — one row per variant per location |
| `InventoryTransaction` | Append-only ledger (17 transaction types) |
| `AvgCostHistory` | WAC change audit trail |
| `StockTransfer` | Inter-location transfers (logistics cost separate) |
| `PurchaseOrder` | PO header (draft → ordered → received) |
| `PurchaseOrderItem` | PO line items |
| `PurchaseOrderReceipt` | Receiving events (supports partial deliveries) |
| `PurchaseOrderReceiptItem` | Actual received quantities + costs |
| `SupplierReturn` | Stock sent back to suppliers |
| `StockLossRecord` | Damaged/theft/missing/transit loss tracking |
| `CycleCount` | Cycle count header (full/partial/spot) |
| `CycleCountItem` | Per-variant counted vs system quantities |
| `ProductionOrder` | Made-to-order fabric consumption tracking |
| `ReturnedStitchedInventory` | Legacy table (superseded by unified inventory) |

### Resetting the database (⚠️ destructive)

```bash
bun run db:reset
```

---

## 6. Run the Dev Server

```bash
bun run dev
```

You should see:
```
▲ Next.js 16.1.3 (Turbopack)
- Local:        http://localhost:3000
✓ Ready in ~1s
```

Open **<http://localhost:3000>** in your browser.

> The first page load takes ~8-10 seconds while Turbopack compiles. Subsequent loads are instant.

---

## 7. Using the App

### Test Account

An account already exists in the shared Supabase project:

- **Email:** `usman@flowops.pk`
- **Password:** `Test1234!`
- **Company:** "Usman Commerce" (already onboarded)

> If you created your own Supabase project, register fresh instead (see below).

### Or Register Fresh

1. Click **"Create an account"** on the login screen
2. Fill in name, email, password (min 8 chars)
3. Complete the **3-step onboarding wizard** (Organization → Company → Review)
4. You become the **Owner** with 4 system roles seeded (Owner, Founder, Co-Founder, Investor)

### Feature Map

#### Core Platform
| Feature | Where |
|---|---|
| Dashboard (KPIs, recent activity) | Sidebar → Dashboard |
| Employee directory + invite | Sidebar → Employees |
| Roles & Permissions (24+ keys, 10+ modules) | Sidebar → Roles & Permissions |
| Workspace switcher (multi-company) | Navbar top-left dropdown |
| Company settings (tax, address, currency) | Sidebar → Company Settings |
| Organization settings + catalog | Sidebar → Organization |
| Audit log (immutable, filterable) | Sidebar → Audit Log |
| Create new organization/company | Workspace switcher → Create New |

#### Product Catalog
| Feature | Where |
|---|---|
| Product list (search, filter) | Sidebar → Products → All Products |
| Create product (3-step wizard with stitching variants) | Sidebar → Products → Add Product |
| Product detail (Overview, Variants, Images, Shopify Sync, Inventory, Pricing) | Click any product |
| Variant editing (SKU, cost, active toggle) | Product detail → Variants tab |
| Inline product editing | Product detail → Overview tab → Edit |
| Image upload + management | Product detail → Images tab |
| Catalog settings (Categories, Brands, Attributes) | Sidebar → Products → Catalog Settings |
| Org Catalog (promote/demote/subscribe) | Sidebar → Org Catalog (elevated only) |
| Returned stitched stock | Sidebar → Products → Returned Stock |

#### Inventory Management
| Feature | Where |
|---|---|
| Inventory dashboard (stock value, low/out/dead stock) | Sidebar → Inventory → Dashboard |
| Locations (create, edit, deactivate) | Sidebar → Inventory → Locations |
| Suppliers (create, edit, credit balance) | Sidebar → Inventory → Suppliers |
| Receive stock (direct, multi-item) | Sidebar → Inventory → Receive Stock |
| Adjust stock (manual +/-) | Sidebar → Inventory → Adjust Stock |
| Transfer stock (between locations) | Sidebar → Inventory → Transfer Stock |
| Purchase orders (create, receive, cancel) | Sidebar → Inventory → Purchase Orders |
| Supplier returns | Sidebar → Inventory → Supplier Returns |
| Production orders (MTO fabric tracking) | Sidebar → Inventory → Production Orders |
| Stock losses & write-offs | Sidebar → Inventory → Losses & Write-offs |
| Cycle counts (start, count, approve) | Sidebar → Inventory → Cycle Counts |

### Key Business Logic

**Stitched vs Unstitched:**
- Unstitched variants → `stock_based` fulfillment (normal inventory tracking)
- Stitched variants → `made_to_order` fulfillment (no stock held, produced on demand)
- One product can have both variant types

**Weighted Average Cost (WAC):**
- `new_avg = (existing_qty × old_avg + new_qty × new_cost) / total_qty`
- Cost is locked at transaction time — never retroactively recalculated
- Logistics cost on transfers is tracked separately (never merged into WAC)

**Made-to-Order Fulfillment:**
1. Check if returned stock exists → use it first (saves stitching cost)
2. If no returned stock → create production order, consume fabric from source variant
3. Returned items flip `track_inventory` from FALSE to TRUE (one-way, permanent)

---

## 8. Useful Scripts

| Command | What it does |
|---|---|
| `bun run dev` | Start dev server on http://localhost:3000 |
| `bun run build` | Create production build |
| `bun run start` | Run production build |
| `bun run lint` | Check code quality with ESLint |
| `bun run db:push` | Push schema changes to Supabase |
| `bun run db:generate` | Regenerate Prisma client (after schema changes) |
| `bun run db:reset` | ⚠️ Drop & recreate all tables (loses all data) |

---

## 9. Project Structure

```
flowops/
├── prisma/
│   └── schema.prisma                # 38-model multi-tenant schema
├── src/
│   ├── app/
│   │   ├── page.tsx                 # Single SPA route (view router)
│   │   ├── layout.tsx               # Root layout + providers
│   │   ├── globals.css              # Emerald-primary design system
│   │   └── api/                     # All REST API routes
│   │       ├── auth/                # register, login, logout, me, forgot/reset
│   │       ├── onboarding/          # create-org, create-company, accept-invite
│   │       ├── workspace/           # switch active company
│   │       ├── employees/           # list, invite, detail, terminate
│   │       ├── roles/               # list, create, update, delete
│   │       ├── products/            # CRUD, variants, images, promote, pricing
│   │       ├── catalog/             # categories, brands, attributes CRUD
│   │       ├── inventory-locations/ # location CRUD + detail
│   │       ├── suppliers/           # supplier CRUD
│   │       ├── inventory/           # dashboard, summary, receive, adjust, transfers
│   │       ├── purchase-orders/     # create, list, detail, receive, confirm, cancel
│   │       ├── supplier-returns/    # create, resolve, dispute
│   │       ├── stock-loss/          # report, resolve
│   │       ├── cycle-counts/        # create, start, submit, approve
│   │       ├── production-orders/   # create, update status
│   │       ├── returned-stitched/   # list, receive, stats
│   │       ├── org/catalog/         # org-wide catalog overview
│   │       ├── audit-logs/          # paginated audit trail
│   │       ├── company/             # company settings
│   │       ├── dashboard/           # KPI overview
│   │       └── upload/              # file/logo upload
│   ├── components/
│   │   ├── auth/                    # Login, Register, Forgot, Reset forms
│   │   ├── onboarding/              # Org/company wizards, invite cards
│   │   ├── layout/                  # Sidebar, Navbar, WorkspaceSwitcher, MobileNav
│   │   ├── dashboard/               # Dashboard home
│   │   ├── employees/               # Directory, invite, detail
│   │   ├── roles/                   # Roles list, editor, permission selector
│   │   ├── products/                # Product list, create wizard, detail, badges
│   │   ├── inventory/               # Dashboard, locations, suppliers, receive, adjust,
│   │   │                           #   transfer, POs, supplier returns, production orders,
│   │   │                           #   losses, cycle counts
│   │   ├── settings/                # Org, company, personal, audit views
│   │   ├── workspace/               # Workspace switcher
│   │   └── ui/                      # shadcn/ui components (50+ components)
│   ├── lib/
│   │   ├── db.ts                    # Prisma client singleton
│   │   ├── session.ts               # HMAC signed-cookie sessions
│   │   ├── auth.ts                  # scrypt password hashing
│   │   ├── workspace.ts             # getWorkspace, hasPermission, requirePermission
│   │   ├── permissions.ts           # 40+ permission keys across 10+ modules
│   │   ├── inventory.ts             # processInventoryTransaction (core WAC engine),
│   │   │                           #   checkAndFulfillMadeToOrderVariant, incrementIncomingStock
│   │   ├── audit.ts                 # insertAuditLog helper
│   │   ├── metrics.ts               # insertMetricEvent helper
│   │   ├── session-payload.ts       # builds full session response
│   │   ├── slugify.ts               # URL-safe slug generator
│   │   ├── types.ts                 # shared TypeScript types
│   │   ├── api-client.ts            # frontend fetch helpers
│   │   ├── constants/
│   │   │   └── fulfillment-types.ts # fulfillment/stitching constants + Shopify mappings
│   │   ├── data/
│   │   │   ├── currencies.ts        # 160 world currencies
│   │   │   └── countries.ts         # 90+ countries, provinces, timezones
│   │   └── validations/
│   │       ├── auth.ts              # auth Zod schemas
│   │       ├── company.ts           # company Zod schemas
│   │       ├── employee.ts          # employee Zod schemas
│   │       ├── invitation.ts        # invitation Zod schemas
│   │       ├── organization.ts      # org/company creation schemas
│   │       ├── product.ts           # product + variant schemas
│   │       └── inventory.ts         # 15 inventory schemas
│   ├── stores/
│   │   └── app-store.ts             # Zustand: session + SPA view routing
│   └── hooks/
│       ├── use-toast.ts             # toast hook
│       └── use-mobile.ts            # mobile detection
├── .env                             # Supabase credentials (create this)
├── package.json
├── next.config.ts
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.mjs
├── eslint.config.mjs
└── components.json
```

---

## 10. Troubleshooting

### "the URL must start with the protocol postgresql://"

Your `.env` file isn't being loaded:
- Make sure `.env` is in the **project root** (same folder as `package.json`)
- Restart the dev server after creating/editing `.env`
- Don't set `DATABASE_URL` in your shell — it overrides `.env`. Unset it:
  ```bash
  unset DATABASE_URL DIRECT_URL    # macOS/Linux/WSL
  Remove-Item Env:DATABASE_URL    # Windows PowerShell
  ```
- On native Windows, check the file isn't named `.env.txt` (enable File name extensions in File Explorer → View)

### Connection refused / can't reach Supabase

- Confirm your PC has internet access
- Check that your Supabase project isn't **paused** (free-tier auto-pause after ~1 week). Wake it at <https://supabase.com/dashboard>
- Verify: `aws-0-ap-northeast-1.pooler.supabase.com:5432`

### Prisma crashes on multi-write operations

You're using port 6543 with `?pgbouncer=true`. Switch to **port 5432** (session-mode pooler, no pgbouncer param). See [Step 4](#4-configure-environment-env).

### "PERMISSIONS is not defined" runtime error

Missing import. Add `import { PERMISSIONS } from '@/lib/permissions'` to the top of the file throwing the error.

### "Cannot find module '@prisma/client'"

Generate the Prisma client after installing:
```bash
bun run db:generate
```

### Port 3000 already in use

```bash
bunx next dev -p 3001
```

### Changes to `prisma/schema.prisma` aren't reflected

```bash
bun run db:push      # apply changes to database
bun run db:generate  # regenerate typed client
```
Then restart the dev server.

### `tee` error on native Windows when running `bun run dev`

The `dev` script uses `tee` (a Unix command). Edit `package.json` and change the `dev` script to:
```json
"dev": "next dev -p 3000"
```
This works on all platforms. (WSL2 users don't need to do this.)

### Forgot password doesn't send email

By design — the endpoint records the request but doesn't send email (no SMTP configured). To enable real email, wire `src/app/api/auth/forgot-password/route.ts` to an email provider (Resend, SendGrid, or Supabase Auth).

### First page load is slow (~8-10 seconds)

This is normal — Turbopack compiles all routes on first access. Subsequent navigation is instant. For production, use `bun run build && bun run start`.

### TypeScript errors in `inventory.ts` (lines 401, 585)

These are **pre-existing** and don't block the dev server. They're in `getProductInventorySummary()` and `checkAndFulfillMadeToOrderVariant()` — the app runs fine despite them. Safe to ignore during dev.

---

## 11. Architecture Notes

### Single SPA Route

The app lives on a single route (`/`). Navigation is handled client-side by Zustand (`src/stores/app-store.ts`) with a `route` state object. This keeps the app always reachable from the root URL.

### Multi-Tenant Isolation

Enforced in the **application layer**:
- `getWorkspace()` resolves the caller's active company from their session
- `hasPermission(ctx, key)` checks role permissions (elevated roles bypass all checks)
- `requirePermission(ctx, key)` throws 403 if permission is missing
- Every company-scoped API route resolves the active company from the session — **never** from client input

### Authentication

HMAC-signed cookies (no external auth service):
- `createSessionToken(userId)` → `userId.timestamp.hmac`
- `verifySessionToken(token)` → validates HMAC + checks 30-day expiry
- Passwords hashed with Node's built-in `scrypt`

### Inventory Engine (`src/lib/inventory.ts`)

The `processInventoryTransaction()` function is the **only** way to modify `inventory_pools`. It handles:
- WAC recalculation: `new_avg = (existing_qty × old_avg + new_qty × new_cost) / total_qty`
- 17 transaction types (purchase_received, sale_dispatched, transfer_out/in, damage_writeoff, etc.)
- Stock validation for OUT-direction transactions
- `track_inventory` one-way flip (FALSE→TRUE on first return, never back)
- Immutable ledger row insertion with avg_cost_before/after
- `avg_cost_history` recording on cost changes

### Shopify Compatibility

- Max 3 attribute keys per variant (enforced in Zod + UI)
- `fulfillment_type` maps to Shopify's `inventory_management` + `inventory_policy`
- `stock_based` → `inventory_management: "shopify"`, `policy: "deny"`
- `made_to_order` → `inventory_management: null`, `policy: "continue"`
- Fields: SKU, barcode, compare_at_price, weight, requires_shipping, taxable

### Permissions

40+ permission keys across 10+ modules in `src/lib/permissions.ts`:
- Inventory (view, receive, adjust, transfer, manage_locations, manage_suppliers, manage_purchase_orders, manage_supplier_returns, report_loss, manage_loss, cycle_count, manage_production)
- Products (view, create, edit, manage_catalog, subscribe, pricing, promote)
- Employees (view, invite, terminate, manage)
- Orders, Finance, Reports, Settings, Integrations, KPI & Audit

### Metric Events (KPI foundation)

Every mutation route across all 7 domains (Products, Catalog, Inventory, Purchase Orders, Supplier Returns, Stock Loss, Cycle Counts) calls `insertMetricEvent()` after a successful operation. The `metric_events` table is the foundation for all future KPI dashboards — 43/43 routes covered (100%).

---

## 12. Quick Start (TL;DR)

### macOS
```bash
brew install node git
curl -fsSL https://bun.sh/install | bash
git clone <repo> flowops && cd flowops
# create .env (see Step 4 — must use port 5432, password URL-encoded with %40)
bun install
bun run db:push
bun run db:generate
bun run dev
```

### Windows (WSL2 — recommended)
```powershell
wsl --install
# restart, open Ubuntu terminal
sudo apt update && sudo apt install -y nodejs npm git
curl -fsSL https://bun.sh/install | bash
git clone <repo> flowops && cd flowops
# create .env (see Step 4)
bun install
bun run db:push
bun run db:generate
bun run dev
```

### Windows (native)
```powershell
# install Git from git-scm.com, Node 20 LTS from nodejs.org
powershell -c "irm bun.sh/install.ps1 | iex"
git clone <repo> flowops && cd flowops
# create .env (see Step 4 — use Set-Content or Notepad)
bun install
bun run db:push
bun run db:generate
bun run dev
```

Then open **<http://localhost:3000>** → sign in with `usman@flowops.pk` / `Test1234!`

---

**Built with:** Next.js 16 · React 19 · TypeScript 5 · Tailwind CSS 4 · shadcn/ui · Prisma 6 · Supabase Postgres · Zustand · TanStack Query · React Hook Form · Zod · Sonner · date-fns · Lucide

**FlowOps** — the operating system for Pakistani e-commerce.
