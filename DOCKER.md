# FlowOps ERP — Docker Guide

## Overview

FlowOps uses Docker for two purposes:

1. **Dev/prod parity** (Phase 1) — the app runs in a container whether developing or in production, connecting to the remote Supabase Mumbai database.
2. **Local schema experimentation** (Phase 2) — a disposable local PostgreSQL container for testing risky `prisma db push` changes without touching production data.

> **Runtime**: All containers (dev + prod) run on **bun 1.3.14** (not Node.js). See the "Bun Runtime in Docker" section below.
> **Production target**: VPS (Ubuntu 22.04+). See the "VPS Docker Deployment" section below for full instructions.

---

## Phase 1: Dev / Prod Containers

### Development (with hot reload)

```bash
# Start the dev server with Webpack hot reload
# (the `dev` script uses the --webpack flag to bypass the Turbopack Rust panic — see
#  the "Turbopack Crash + --webpack Flag" section below)
docker compose up --build

# App is at http://localhost:3000
# Edit files on the host → changes reflect immediately via bind-mount

# Stop
docker compose down
```

**How it works:**
- `Dockerfile.dev` installs all dependencies (including devDeps) + generates Prisma Client
- `docker-compose.yml` bind-mounts the source directory (`.:/app`) so Webpack watches host files for hot reload
- Anonymous volumes (`/app/node_modules`, `/app/.next`) prevent host versions from overwriting the container's installed versions
- Uploaded files (`public/uploads/`) persist on the host filesystem via the bind-mount — no separate named volume is needed in dev (the `flowops_uploads` named volume exists only in `docker-compose.prod.yml`)
- Environment variables loaded from `.env.docker` (contains real Supabase Mumbai credentials)

### Production

```bash
# Build + run the production image
docker compose -f docker-compose.prod.yml up --build -d

# App is at http://localhost:3000
# Verify health
curl http://localhost:3000/api/health

# Stop
docker compose -f docker-compose.prod.yml down
```

**How it works:**
- `Dockerfile` (multi-stage: base → deps → builder → runner) produces a lean production image
- Only `.next/standalone`, `.next/static`, and `public/` are in the final image (no source code)
- Runs as non-root user (`flowops`, UID 1001)
- `NODE_ENV=production`, `CMD ["bun", "server.js"]`
- Health check every 30s via `curl -f http://localhost:3000/api/health`
- `restart: unless-stopped`

### Health Check

The `/api/health` endpoint does a trivial `SELECT 1` against Prisma to confirm DB connectivity:

```bash
curl http://localhost:3000/api/health
# {"status":"healthy","db":"connected","timestamp":"2026-08-14T12:03:43.443Z"}
```

### File Upload Persistence

Uploaded files (company logos, courier slips, scan reports, payslips, product images) are stored in the `flowops_uploads` named volume. They survive `docker compose down && docker compose up` and image rebuilds.

To destroy uploaded files (NOT recommended in production):
```bash
docker compose down -v  # -v removes named volumes
```

---

## Phase 2: Local PostgreSQL for Schema Experimentation

### ⚠️ WARNING

**This local database has NO relation to production data.** It must NEVER be assumed to contain real customer/order records. It is for **schema and logic testing ONLY**. Never run `prisma db push` against Supabase Mumbai without first testing here. But also never assume data in this DB is real — it is disposable.

### Starting the Local DB

```bash
# Start the local PostgreSQL container (port 5433 on host)
docker compose -f docker-compose.local-db.yml up -d

# Verify it's running
docker compose -f docker-compose.local-db.yml ps
```

**Version match:** Supabase uses PostgreSQL 17.6. The local container uses `postgres:17-alpine` (same major version, ensuring schema compatibility).

**Port:** Exposed on host port **5433** (NOT 5432) to avoid clashing with any locally-installed Postgres or the Supabase pooler.

### Schema Sync Workflow

#### Step 1: Point Prisma at the local DB

```bash
# Set env vars to point at the local container
export DATABASE_URL="postgresql://flowops:flowops_local_dev_password@localhost:5433/flowops_local"
export DIRECT_URL="postgresql://flowops:flowops_local_dev_password@localhost:5433/flowops_local"
```

Verify the connection works:
```bash
bunx prisma db execute --stdin <<< "SELECT 1;"
# Should output: "Applied 1 command(s) to database."
```

#### Step 2: Push the schema

```bash
# Push the Prisma schema to the local DB (creates all tables)
bun run db:push
```

This creates all 58+ tables defined in `prisma/schema.prisma` but does NOT create the SQL functions, sequences, or triggers — those are manually maintained in `supabase/migrations/*.sql` and must be applied separately.

#### Step 3: Apply SQL functions, sequences, and triggers

The following SQL objects are NOT in the Prisma schema and must be applied manually after `db:push`:

**Functions (23 total):**
- `generate_order_number(company_id TEXT)` — generates `ORD-{year}-{seq}` per company
- `generate_exchange_shipment_number()` — generates `EXCH-{year}-{seq}`
- `generate_draft_number()` — generates draft numbers
- `normalize_phone(p_raw_phone TEXT)` — normalizes Pakistani phone numbers
- `recompute_order_status(p_order_id TEXT)` — recomputes order status from items
- `backfill_order_timestamps()` — trigger function for order timestamps
- `match_or_create_customer(...)` — customer matching SQL function
- `get_active_company_id()`, `get_active_org_id()`, `get_active_user_id()` — RLS helpers
- `is_elevated_employee(p_company_id TEXT)` — checks if employee has elevated role
- `has_permission(p_company_id TEXT, p_permission_key TEXT)` — permission check
- `update_*_updatedAt()` — 10 trigger functions for auto-updating timestamps

**Sequences (2 total):**
- `draft_order_number_seq` — for draft numbering
- `exchange_shipment_number_seq` — for exchange shipment numbering

**Triggers (12 total):**
- `trg_backfill_order_timestamps` — on Order table
- `trg_customers_updatedAt` — on Customer table
- `trg_company_order_settings_updatedAt` — on CompanyOrderSetting
- `trg_order_items_updatedAt` — on OrderItem
- `trg_courier_operational_cities_updatedAt` — on CourierOperationalCity
- `trg_courier_pickup_addresses_updatedAt` — on CourierPickupAddress
- `trg_integration_providers_updatedAt` — on IntegrationProvider
- `trg_company_integrations_updatedAt` — on CompanyIntegration
- `trg_exchange_shipments_updatedAt` — on ExchangeShipment
- `trg_customer_addresses_updatedAt` — on CustomerAddress
- `trg_form_drafts_updatedAt` — on FormDraft
- `trg_order_exchanges_updatedAt` — on OrderExchange

**Apply all functions, sequences, and triggers:**

All 23 functions, 2 sequences, and 12 triggers have been consolidated into a single file: `supabase/functions-only.sql`. This file contains ONLY `CREATE FUNCTION`, `CREATE TRIGGER`, and `CREATE SEQUENCE` statements (no `CREATE TABLE` / `ALTER TABLE` — those are handled by `prisma db push`). Statements are ordered so dependencies are satisfied (sequences → functions → triggers).

```bash
# Apply the consolidated SQL functions file:
cat supabase/functions-only.sql | docker exec -i flowops-local-db psql -U flowops -d flowops_local

# Or against any Postgres instance:
cat supabase/functions-only.sql | psql "$DATABASE_URL"
```

All statements are idempotent (`CREATE OR REPLACE`, `IF NOT EXISTS`, `DROP IF EXISTS` before `CREATE`) — safe to re-run.

**Alternative — apply via Prisma:**
```bash
# Apply a single SQL file via prisma db execute:
bunx prisma db execute --file supabase/migrations/001_oms_schema.sql --schema prisma/schema.prisma

# Note: prisma db execute does NOT support multiple statements in some cases.
# The psql approach above is more reliable for multi-statement files.
```

#### Step 4: Seed test data (optional)

```bash
# Seed the default roles for a test company (if you have one)
bun scripts/seed-default-roles.ts
```

#### Step 5: Test your schema changes

```bash
# Run the dev server against the local DB
# (DATABASE_URL is already set to localhost:5433 from Step 1)
bun run dev

# Test your changes — create orders, run inventory actions, etc.
# All data is disposable — destroy with `docker compose -f docker-compose.local-db.yml down -v`
```

#### Step 6: Switch back to Supabase Mumbai

```bash
# Unset the local DB env vars (restores .env values)
unset DATABASE_URL
unset DIRECT_URL

# Or explicitly set them back:
export DATABASE_URL="postgresql://postgres.gobwxqkzfulbwhzbbsdj:123%40Usman123%40@aws-0-ap-south-1.pooler.supabase.com:5432/postgres"
export DIRECT_URL="$DATABASE_URL"

# Verify you're back on Supabase:
bunx prisma db execute --stdin <<< "SELECT current_database();"
# Should show "postgres" (Supabase) not "flowops_local"

# Stop the local DB container:
docker compose -f docker-compose.local-db.yml down
```

### Destroying the Local DB

```bash
# Stop + remove the container AND its data volume:
docker compose -f docker-compose.local-db.yml down -v

# This destroys ALL data in the local DB — safe because it's disposable.
```

---

## Environment Variable Reference

| Variable | Dev Container | Prod Container | Local DB |
|---|---|---|---|
| `DATABASE_URL` | `.env.docker` (Supabase Mumbai) | `.env.docker` (Supabase Mumbai) | `postgresql://flowops:...@localhost:5433/flowops_local` |
| `DIRECT_URL` | `.env.docker` | `.env.docker` | Same as `DATABASE_URL` |
| `INTEGRATION_ENCRYPTION_KEY` | `.env.docker` | `.env.docker` | Not needed (no integrations) |
| `SESSION_SECRET` | `.env.docker` | `.env.docker` | Any random string |
| `CRON_SECRET` | `.env.docker` | `.env.docker` | Any random string |
| `APP_URL` | `.env.docker` | `.env.docker` | `http://localhost:3000` |
| `ENABLE_IN_PROCESS_POLLER` | `.env.docker` (default: `true`) | `.env.docker` (default: `true`) | Not needed |

## File Reference

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage production image |
| `Dockerfile.dev` | Development image (hot reload) |
| `.dockerignore` | Excludes non-build files from Docker context |
| `docker-compose.yml` | Dev compose (bind-mount + hot reload) |
| `docker-compose.prod.yml` | Production compose (self-contained) |
| `docker-compose.local-db.yml` | Local PostgreSQL for schema testing |
| `.env.docker` | Real env vars for Docker (Supabase Mumbai) — gitignored |
| `.env.docker.example` | Template for `.env.docker` |
| `.env.local-db` | Local DB credentials — gitignored |
| `.env.local-db.example` | Template for `.env.local-db` |
| `src/app/api/health/route.ts` | Health check endpoint for Docker HEALTHCHECK |
| `mini-services/postex-poller/` | Scaffold for future standalone poller worker (Phase 3 groundwork) |
| `instrumentation.ts` | In-process poller toggle (`ENABLE_IN_PROCESS_POLLER` env var) |

---

## Bun Runtime in Docker

FlowOps uses **bun** (not Node.js) as the production runtime inside Docker. Both the build and the server execution happen on bun.

### Image
- Base image: `oven/bun:1.3.14` (pinned to an exact tag for reproducibility — not `:latest`)
- Multi-stage build (in `Dockerfile`):
  - **base**: `oven/bun:1.3.14` — shared base for all subsequent stages
  - **deps**: installs all dependencies via `bun install --frozen-lockfile`
  - **builder**: copies deps + source, runs `bunx prisma generate` and `bun run build`
  - **runner**: copies ONLY `.next/standalone`, `.next/static`, `public/`, and `prisma/` — no source code, no devDeps

### Why bun (not Node)?
| Aspect | bun | Node.js |
|---|---|---|
| Startup time | ~50 ms | ~200 ms |
| I/O throughput | higher (built-in I/O scheduler) | lower |
| TypeScript support | native | requires ts-node or compilation |
| Production CMD | `bun server.js` | `node server.js` |

### Notes
- The standalone `server.js` produced by `next build` is runtime-agnostic but is invoked via `bun server.js` (see `Dockerfile` line 79: `CMD ["bun", "server.js"]`).
- bun 1.3.14 is the version pinned in both `Dockerfile` and `Dockerfile.dev`. Don't upgrade without testing — bun minor versions sometimes break Next.js compatibility.
- For local dev (no Docker), the `dev`, `build`, and `start` scripts in `package.json` are also invoked via `bun run`.

---

## `.env.docker` File Management

Docker Compose loads environment variables from `.env.docker` (NOT `.env`). This separation lets you run Docker with different credentials than your local dev server.

### Files
| File | Purpose | Gitignored? |
|---|---|---|
| `.env` | Used by `bun run dev` (local, no Docker) | ✅ yes |
| `.env.docker` | Used by `docker compose` (dev + prod) | ✅ yes |
| `.env.docker.example` | Template — copy to `.env.docker` and fill in | ❌ no (committed) |
| `.env.local-db` | Used by `docker-compose.local-db.yml` | ✅ yes |
| `.env.local-db.example` | Template for the local DB | ❌ no (committed) |

### Setup
```bash
# One-time setup:
cp .env.docker.example .env.docker
nano .env.docker   # fill in real Supabase Mumbai credentials
chmod 600 .env.docker

# Verify the file is loaded:
docker compose config | grep DATABASE_URL
```

### Production on a VPS
1. Copy `.env.docker.example` → `.env.docker` on the VPS.
2. Fill in PRODUCTION credentials (not dev):
   - `DATABASE_URL` and `DIRECT_URL` → production Supabase project (URL-encode any `@` in the password as `%40`)
   - `INTEGRATION_ENCRYPTION_KEY` → same 64-char hex as dev (required for credential decryption across environments)
   - `SESSION_SECRET` → NEW strong secret (32+ chars, different from dev)
   - `CRON_SECRET` → NEW strong secret (different from dev)
   - `APP_URL` → `https://yourdomain.com`
3. Set file permissions: `chmod 600 .env.docker`.
4. Rebuild: `docker compose -f docker-compose.prod.yml up --build -d`.

### Changes require restart
`.env.docker` is read at container start time. Changes to the file do NOT propagate to a running container — you must restart:
```bash
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d
```

---

## Turbopack Crash + --webpack Flag

### Background
Next.js 16.1.3 ships with Turbopack as the default dev compiler. Under certain conditions (large module graphs, deeply nested `import()` chains, or the `ROUTE_CHUNK_LOADERS` pattern in `src/app/page.tsx`), Turbopack's Rust core panics with:

```
thread 'xxx' panicked at crates/.../inner_of_uppers_lost_follower
```

This is a known upstream issue. **Production builds are NOT affected.**

### How Docker handles it
The `dev` script in `package.json` includes `--webpack`:
```json
"dev": "next dev -p 3000 --webpack"
```

`Dockerfile.dev` invokes `bun run dev` → bun runs `next dev -p 3000 --webpack` → Webpack is used for hot reload (bypassing the Rust panic).

### In the dev container
- `docker compose up --build` starts the dev server with Webpack hot reload (not Turbopack).
- The bind-mount (`.:/app`) lets Webpack watch host files for changes.
- Edits to source code on the host reflect in the container within ~1 second.

### In the prod container
- `next build` (run during the Docker build) uses Webpack by default — no Turbopack involved.
- The standalone server (`bun server.js`) doesn't use any compiler.
- Production is completely unaffected by the Turbopack crash.

### If the panic appears inside Docker
1. Confirm `package.json` has `--webpack` on `dev` (it does on the v1.0.0 release).
2. Clear the container's `.next/cache`:
   ```bash
   docker compose exec app rm -rf .next/cache
   docker compose restart app
   ```
3. NEVER add `--turbo` to the dev script — it will crash on every start.

---

## Permissions System (51 Keys)

The 51-key permission registry (`src/lib/permissions.ts`) is enforced identically inside Docker as on bare-metal — there is no Docker-specific configuration.

### What this means for Docker deployments
- No special env vars needed.
- The Role Editor UI works the same way (all 51 keys visible).
- `requirePermission()` is enforced at the API route level regardless of runtime.
- 35+ API routes are protected, including a cross-company leak fix in the inventory dashboard route.

### Seeding default roles inside Docker (DEV only)
```bash
# Inside the dev container:
docker compose exec app bun scripts/seed-default-roles.ts

# Inside the prod container (NOT recommended — production should not run dev scripts):
# (intentionally omitted — never run seed scripts against production data)
```

### Permission count breakdown (reference)
| Module | Keys |
|---|---|
| Inventory | 13 |
| Products | 7 |
| Orders | 5 |
| Customers | 3 |
| Scan | 2 |
| Employees | 6 |
| Payroll | 3 |
| Finance | 2 |
| Reports | 2 |
| Settings | 3 |
| Integrations | 2 |
| KPI & Audit | 3 |
| **Total** | **51** |

---

## Leopard Production / Staging Toggle

The Leopard Courier adapter (`src/lib/integrations/couriers/leopard.adapter.ts`) supports two endpoints:
- **Staging** (default): `https://merchantapistaging.leopardscourier.com/api/`
- **Production**: `https://merchantapi.leopardscourier.com/api/`

### How the toggle works
The integration's `isProduction` field (stored in `CompanyIntegration.credentials`) controls which base URL is used. The UI is a **Switch** component in the integrations panel. The adapter defensively handles all boolean representations: `true`/`false`, `"true"`/`"false"`, `"on"`, `undefined` (defaults to staging).

### Docker-specific considerations
- **No Docker-specific env var** — the toggle is per-integration, not per-deployment.
- A single Docker container can host integrations pointing to staging AND production simultaneously (though this is unusual).
- Every flip is captured in the audit log (`IntegrationLog`) — no silent toggles.

### Recommended workflow on a VPS Docker deployment
1. **DEV container**: leave the toggle OFF (staging). Verify the full lifecycle: book → track → cancel.
2. **PROD container**: flip ON once verified. Every API call is recorded in `IntegrationLog` (337+ verified rows across 12 action types in dev).

---

## VPS Docker Deployment

### Step 1: Provision the VPS
- Ubuntu 22.04+ (or Debian 12+)
- 2 vCPU / 4 GB RAM minimum (build is RAM-heavy)
- Docker Engine 24+
- Docker Compose v2+ (the `docker compose` plugin, not the legacy `docker-compose` binary)
- 20 GB free disk (for image + uploads volume)

### Step 2: Install Docker (if not pre-installed)
```bash
# Official Docker install script:
curl -fsSL https://get.docker.com | sh

# Add your user to the docker group (then log out and back in):
sudo usermod -aG docker $USER

# Verify:
docker --version
docker compose version
```

### Step 3: Clone + configure
```bash
git clone [repo-url] /app/flowops
cd /app/flowops

# Create .env.docker from the template:
cp .env.docker.example .env.docker
nano .env.docker   # fill in PRODUCTION Supabase credentials
chmod 600 .env.docker
```

### Step 4: First-time database setup
Run `db:push` and `prisma generate` inside a one-shot container:

```bash
# Build the production image first (so prisma generate has the client available):
docker compose -f docker-compose.prod.yml build

# Push schema to production DB (FIRST TIME ONLY):
docker compose -f docker-compose.prod.yml run --rm \
  --entrypoint "bunx prisma db push" app

# Apply SQL functions / triggers / sequences (idempotent — safe to re-run):
cat supabase/functions-only.sql | docker exec -i flowops-prod-app-1 \
  psql "$DATABASE_URL"
# (or paste each supabase/migrations/0XX_*.sql into the Supabase SQL Editor)
```

> **Note**: The container name `flowops-prod-app-1` may differ — check with `docker compose -f docker-compose.prod.yml ps`.

### Step 5: Start the production stack
```bash
docker compose -f docker-compose.prod.yml up -d

# Verify:
curl http://localhost:3000/api/health
# Expected: {"status":"healthy","db":"connected",...}
```

### Step 6: Configure a reverse proxy (recommended)
Put Caddy, Traefik, or Nginx in front of the container for TLS termination. Example with Caddy:
```
yourdomain.com {
  reverse_proxy localhost:3000
}
```

### Step 7: Ongoing operations
```bash
# View logs:
docker compose -f docker-compose.prod.yml logs -f

# Restart:
docker compose -f docker-compose.prod.yml restart

# Pull updates + rebuild:
cd /app/flowops
git pull origin main
docker compose -f docker-compose.prod.yml up -d --build

# Stop:
docker compose -f docker-compose.prod.yml down

# Stop + destroy uploads volume (DESTRUCTIVE — never do this in production):
docker compose -f docker-compose.prod.yml down -v
```

### Step 8: Health monitoring
The production container has a built-in `HEALTHCHECK` (every 30s, 10s timeout, 3 retries). Check status:
```bash
docker ps   # STATUS column shows "healthy" or "unhealthy"
```

For more details on each command and the underlying Docker files, see the "File Reference" table above.
