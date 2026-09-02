# FlowOps ERP — Docker Guide

## Overview

FlowOps uses Docker for two purposes:

1. **Dev/prod parity** (Phase 1) — the app runs in a container whether developing or in production, connecting to the remote Supabase Mumbai database.
2. **Local schema experimentation** (Phase 2) — a disposable local PostgreSQL container for testing risky `prisma db push` changes without touching production data.

---

## Phase 1: Dev / Prod Containers

### Development (with hot reload)

```bash
# Start the dev server with Turbopack hot reload
docker compose up --build

# App is at http://localhost:3000
# Edit files on the host → changes reflect immediately via bind-mount

# Stop
docker compose down
```

**How it works:**
- `Dockerfile.dev` installs all dependencies (including devDeps) + generates Prisma Client
- `docker-compose.yml` bind-mounts the source directory (`.:/app`) so Turbopack watches host files
- Anonymous volumes (`/app/node_modules`, `/app/.next`) prevent host versions from overwriting container's
- Named volume (`flowops_uploads`) persists uploaded files across rebuilds
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
