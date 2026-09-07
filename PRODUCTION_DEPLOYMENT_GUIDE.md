# FlowOps ERP — Production Deployment Guide & Development Safety Rules

> **CRITICAL DOCUMENT** — Read this BEFORE deploying to a VPS or making any changes after deployment.
> Last Updated: 2026-09-04 (VPS-ready)
> Applicable to: v1.0.0 — pre-Hostinger production codebase (bun/docker/VPS-ready)

---

## 🚨 GOLDEN RULES (NON-NEGOTIABLE)

### Rule 1: TWO databases — NEVER mix them
- **DEV/TEST DB**: `postgresql://postgres.gobwxqkzfulbwhzbbsdj:...@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`
  - Used for: development, testing, brute-force testing, sandbox experiments
  - Contains: test users, test orders, test products, fake data
  - **NEVER** connect production code to this DB

- **PRODUCTION DB**: (new Supabase project — create on deployment day)
  - Used for: live business operations
  - Contains: real users, real orders, real money data
  - **NEVER** run test scripts against this DB
  - **NEVER** create test users in this DB

### Rule 2: .env FILE MANAGEMENT
- The `.env` file in the sandbox **always reverts to SQLite** on restart — this is a known sandbox issue
- On a VPS (production), the `.env` will be set once and persist (stored at `/app/flowops/.env`, mode `0600`)
- **DEV .env**: points to DEV Supabase (current credentials)
- **PRODUCTION .env**: points to PRODUCTION Supabase (new credentials — set on the VPS)
- **NEVER** commit `.env` to git (it's in `.gitignore`)
- The `predev` hook in `package.json` aborts `bun run dev` if `DATABASE_URL` is not a `postgresql://` URL — guards against the sandbox SQLite-revert issue and against typos in production `.env`

### Rule 3: NO TEST DATA IN PRODUCTION
- The production DB starts EMPTY (only schema, no data)
- Onboarding flow creates the first org → company → owner
- **NEVER** run seed scripts, test data generators, or brute-force tests against production
- **NEVER** create test customers, test orders, or test products in production

### Rule 4: MIGRATIONS ARE ONE-WAY
- Database migrations (supabase/migrations/) are applied to production ONCE
- Once a migration is applied to production, it CANNOT be rolled back (no down migrations)
- Test ALL migrations on DEV first — verify they work before applying to production
- Migration numbering: 001-029 exist. New migrations start at 030+

### Rule 5: CODE CHANGES — DEV FIRST, PRODUCTION SECOND
- ALL code changes are developed + tested on the DEV sandbox first
- Only after DEV testing passes, changes are deployed to the VPS via `git pull` + rebuild
- **NEVER** make code changes directly on the VPS (develop on DEV sandbox → commit → `git pull` on VPS)
- **NEVER** run `bun run dev` on the VPS — use `bun run build` + `bun run start`

---

## 📋 PRE-DEPLOYMENT CHECKLIST

### Step 1: Create Production Supabase Project
1. Go to https://supabase.com → New Project
2. Name it: `flowops-production`
3. Choose region: `ap-south-1 (Mumbai)` — closest to Pakistan
4. Set a strong database password
5. Wait for project to initialize
6. Copy the connection strings:
   - `DATABASE_URL=postgresql://postgres.[project-ref]:[password]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`
   - `DIRECT_URL=postgresql://postgres.[project-ref]:[password]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`

### Step 2: Apply Schema + Migrations to Production DB
```bash
# Set production env vars
export DATABASE_URL="postgresql://postgres.[prod-ref]:[prod-password]@..."
export DIRECT_URL="postgresql://postgres.[prod-ref]:[prod-password]@..."

# Push the full schema (creates all tables + relations)
bunx prisma db push

# Apply all migrations (SQL functions, indexes, CHECK constraints, etc.)
# Run each migration file in order:
for f in supabase/migrations/0*.sql; do
  echo "Applying $f..."
  # Apply via Supabase SQL Editor OR psql
done
```

### Step 3: Provision the VPS
1. Provision a Linux VPS (Ubuntu 22.04+ recommended) with:
   - **2 vCPU / 4 GB RAM minimum** (the build step is RAM-heavy)
   - **Node.js 20+** (build runtime only — the server runs on **bun**, not Node)
   - **bun 1.3.14** (pinned to match `Dockerfile`)
   - **git**, **curl**, **psql** (for migration application)
2. Clone the repo, install deps, and generate the Prisma Client:
   ```bash
   git clone [repo-url] /app/flowops
   cd /app/flowops
   bun install
   bunx prisma generate     # POSTINSTALL NOTE — see "POSTINSTALL NOTE" section below
   ```
3. Create `/app/flowops/.env` (mode `0600`) with production values — see the
   "Environment Variables Reference" section for the full list. **Important**:
   any `@` in the Supabase password MUST be URL-encoded as `%40` (the dev `.env`
   already does this — copy that pattern). Example skeleton:
   ```
   DATABASE_URL=postgresql://postgres.[prod-ref]:[prod-password]%40@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   DIRECT_URL=postgresql://postgres.[prod-ref]:[prod-password]%40@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   INTEGRATION_ENCRYPTION_KEY=[same 64-char hex key as dev — required for credential decryption]
   SESSION_SECRET=[NEW strong secret — 32+ chars — different from dev]
   CRON_SECRET=[NEW strong secret — different from dev]
   APP_URL=https://yourdomain.com
   NODE_ENV=production
   ```
4. Push the schema and apply SQL functions / triggers:
   ```bash
   bun run db:push        # creates all tables from prisma/schema.prisma (FIRST TIME ONLY)
   bun run db:generate    # regenerates Prisma Client (idempotent — safe to re-run)

   # Apply SQL functions, sequences, and triggers (idempotent — safe to re-run):
   cat supabase/functions-only.sql | psql "$DATABASE_URL"
   # Or paste each supabase/migrations/0XX_*.sql into the Supabase SQL Editor in order.
   ```
5. Build the standalone bundle:
   ```bash
   bun run build
   ```
   This runs `next build` (webpack by default — **Turbopack is NOT used for production
   builds**; see the "Turbopack Crash + --webpack Flag" section below) and copies
   `.next/static` + `public/` into `.next/standalone/`.
6. Start the production server:
   ```bash
   bun run start
   # Equivalent to: NODE_ENV=production bun .next/standalone/server.js 2>&1 | tee server.log
   ```
   For long-running deployments, wrap this in `pm2`, `systemd`, or a Docker
   container (see `DOCKER.md`).
7. Verify: visit `https://yourdomain.com/api/health` → should return
   `{"status":"healthy","db":"connected"}`.

### Step 4: First User Onboarding
1. Visit `https://yourdomain.com`
2. Click "Create an account"
3. Enter YOUR real email + password (this becomes the organization owner)
4. Complete the workspace creation wizard (org name, company name, etc.)
5. Connect Leopard Courier with REAL production credentials
6. Sync cities (Settings → Integrations → Sync Cities)
7. Import shippers by shipment_id (as done in testing)
8. You're live!

---

## 🔄 POST-DEPLOYMENT DEVELOPMENT WORKFLOW

### How future development works after deployment:

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
│                         ↓                                    │
└─────────────────────────────────────────────────────────────┘
                          ↓ (only when DEV is green)
┌─────────────────────────────────────────────────────────────┐
│                  PRODUCTION (VPS)                              │
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

### Development Session Workflow (what you + I do):

1. **User requests a change** → I implement on DEV sandbox
2. **I test on DEV** → brute-force test, lint, verify
3. **I commit to git** → code is version-controlled
4. **User deploys to VPS** → `git pull` → `bun run build` → `bun run start`
5. **If migration needed** → I write it → test on DEV → user applies to PROD DB
6. **User verifies on production** → manually check the changed feature

### Migration Application Rules:
- New migration files go in `supabase/migrations/0XX_description.sql`
- **ALWAYS test on DEV first**: `bun -e "..."` with `DATABASE_URL=dev_url`
- **Then apply to PROD**: via Supabase SQL Editor (paste the SQL) OR psql
- **NEVER** modify an already-applied migration (create a new one instead)
- **NEVER** use `prisma db push` on production after initial setup (it can drop columns) — use `prisma migrate` or manual SQL

---

## 🔒 SAFETY GUIDELINES

### What I (AI) will NEVER do:
1. ❌ Never connect to the production database from this sandbox
2. ❌ Never run test scripts against production
3. ❌ Never create test users/orders/products in production
4. ❌ Never modify production `.env` (user does this on the VPS)
5. ❌ Never run `prisma db push` on production (schema-destructive)
6. ❌ Never apply a migration to production without testing on DEV first

### What I (AI) WILL do:
1. ✅ Develop + test all changes on the DEV sandbox
2. ✅ Write migrations as idempotent SQL (IF NOT EXISTS)
3. ✅ Test migrations on DEV DB before declaring them ready
4. ✅ Commit all changes to git with clear commit messages
5. ✅ Provide exact commands for the user to run on the VPS
6. ✅ Flag any breaking changes that require special deployment steps

### What the USER must do:
1. 🔧 Create the production Supabase project
2. 🔧 Set production `.env` on the VPS (I'll provide exact values)
3. 🔧 Apply schema + migrations to production DB (I'll provide exact SQL)
4. 🔧 Deploy the app on the VPS (build + start)
5. 🔧 Create the first (owner) account with real credentials
6. 🔧 Connect real Leopard/PostEx credentials in the production app
7. 🔧 NEVER share production database credentials in chat
8. 🔧 Backup production DB before applying any migration

---

## 📦 DEPLOYMENT COMMANDS (for VPS)

### Initial Deployment:
```bash
# On the VPS:
git clone [repo-url] /app/flowops
cd /app/flowops
bun install
bunx prisma generate     # POSTINSTALL NOTE — no postinstall hook in package.json

# Create /app/flowops/.env (mode 0600) with production values
#   - DATABASE_URL (postgresql://, with @ encoded as %40)
#   - DIRECT_URL
#   - INTEGRATION_ENCRYPTION_KEY (same 64-char hex as dev)
#   - SESSION_SECRET (NEW, 32+ chars)
#   - CRON_SECRET (NEW)
#   - APP_URL=https://yourdomain.com
#   - NODE_ENV=production
chmod 600 .env

# Push schema to production DB (FIRST TIME ONLY)
bun run db:push

# Regenerate Prisma Client (uses the npm script — equivalent to `bunx prisma generate`)
bun run db:generate

# Apply SQL functions / triggers / sequences (idempotent):
cat supabase/functions-only.sql | psql "$DATABASE_URL"
# Or paste each supabase/migrations/0XX_*.sql into the Supabase SQL Editor in order.

# Build the standalone bundle (next build → webpack, NOT Turbopack)
bun run build

# Start the production server
bun run start
# Equivalent to: NODE_ENV=production bun .next/standalone/server.js 2>&1 | tee server.log
```

### Subsequent Updates (when I make changes):
```bash
# On the VPS:
cd /app/flowops
git pull origin main
bun install             # if package.json or bun.lock changed
bun run db:generate     # if prisma/schema.prisma changed (idempotent — safe to always run)

# If new migrations exist, apply them:
#   cat supabase/functions-only.sql | psql "$DATABASE_URL"
#   (or paste each new supabase/migrations/0XX_*.sql into the Supabase SQL Editor)

# Rebuild + restart
bun run build
# Restart the server process:
#   pm2 restart flowops  (if using pm2)
#   systemctl restart flowops  (if using systemd)
#   docker compose -f docker-compose.prod.yml up -d --build  (if using Docker)
```

### Database Backup (BEFORE any migration):
```bash
# Via Supabase Dashboard:
# Settings → Database → Backup → Create backup

# OR via pg_dump:
pg_dump "postgresql://postgres.[prod-ref]:[prod-password]@..." > backup-$(date +%Y%m%d).sql
```

---

## ⚙️ TURBOPACK CRASH + --webpack FLAG

### Background
Next.js 16.1.3 ships with Turbopack as the default dev compiler. Under certain conditions (large module graphs, deeply nested `import()` chains, or the `ROUTE_CHUNK_LOADERS` pattern in `src/app/page.tsx`), Turbopack's Rust core panics with:

```
thread 'xxx' panicked at crates/.../inner_of_uppers_lost_follower
```

This is a known upstream issue. **Production builds are NOT affected.**

### Workaround
The `dev` script in `package.json` passes `--webpack` to bypass Turbopack:

```json
"dev": "next dev -p 3000 --webpack"
```

| Command | Compiler | Notes |
|---|---|---|
| `bun run dev` | **Webpack** | Uses the `--webpack` flag — works around the Rust panic |
| `bun run build` | **Webpack** | `next build` defaults to Webpack (no Turbopack involved) |
| `bun run start` | None | Runs the prebuilt standalone bundle (no compiler) |

### If the panic still appears on dev:
1. Confirm `package.json` has the `--webpack` flag on `dev` (it does on the v1.0.0 release).
2. Clear the cache: `rm -rf .next/cache/`
3. Restart `bun run dev`.
4. **NEVER** run with `next dev --turbo` until upstream fixes the issue.

---

## 🐆 LEOPARD PRODUCTION / STAGING TOGGLE

The Leopard Courier adapter (`src/lib/integrations/couriers/leopard.adapter.ts`) talks to two endpoints:
- **Staging** (default): `https://merchantapistaging.leopardscourier.com/api/`
- **Production**: `https://merchantapi.leopardscourier.com/api/`

### Toggle Behavior
- The integration's `isProduction` field (stored in `CompanyIntegration.credentials`) controls which base URL is used.
- The UI is a **Switch** component (ON = production, OFF = staging) in the integrations panel.
- The adapter defensively handles all boolean representations:
  - `true` / `false` (boolean from `JSON.parse`)
  - `"true"` / `"false"` (string from JSON)
  - `"on"` (HTML checkbox default)
  - `undefined` (field left empty → defaults to staging)

### Deployment Guidance
- **DEV sandbox**: leave OFF (staging). Validate the full lifecycle (book → track → cancel) against Leopard's staging environment first.
- **PRODUCTION VPS**: flip ON once you've validated the integration. Every API call is recorded in `IntegrationLog` (337+ verified rows across 12 action types in dev).
- **Pre-flight checklist before flipping ON**:
  - [ ] Booked a packet in staging and received a tracking number (~0.25 s response time)
  - [ ] Tracked the packet via tracking number
  - [ ] Cancelled the packet via the `cn_numbers` field
  - [ ] Verified `IntegrationLog` shows all three actions
  - [ ] Confirmed shipper pickup address is set (otherwise auto-booking silently skips)

---

## 🔐 PERMISSIONS SYSTEM (51 KEYS, ROLE EDITOR)

### Overview
FlowOps uses a 51-key permission registry (`src/lib/permissions.ts`) covering 12 functional modules. Each key is enforced at the API route level via `requirePermission()` (cached per-request through `getWorkspace()` — saves 140–280 ms vs inline checks).

### Permission Count by Module
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

### Role Editor
- All 51 keys are visible in the Role Editor UI (`src/components/roles/role-edit-view.tsx`). Previously only 26 were exposed — the gap was closed in September 2026.
- "Select All" button grants all 51 keys to a role in one click.
- Roles flagged `isElevated` bypass permission checks via `isElevated()` — reserved for owner/admin roles only.
- 6 "orphan" permissions (keys not referenced in the UI but enforced at the API) are now properly enforced — they protect admin-only routes.

### Production Verification
- 35+ API routes are protected by `requirePermission()`.
- A cross-company data leak in the inventory dashboard route was patched — `requirePermission()` now scopes queries to the active company.
- Default roles can be seeded via `bun scripts/seed-default-roles.ts` (DEV only — never run against production).
- Always test new roles against a real user account in DEV before assigning them in production.

---

## 📦 POSTINSTALL NOTE: PRISMA CLIENT GENERATION

The `package.json` does NOT include a `postinstall` script (it was deliberately removed when the codebase reverted to the pre-Hostinger state — see commit `77c0923`). This means **Prisma Client is NOT generated automatically** after `bun install`.

### When to run `prisma generate` manually:
| Trigger | Required? | Command |
|---|---|---|
| After `bun install` (first time on the VPS) | ✅ YES | `bunx prisma generate` or `bun run db:generate` |
| After `git pull` if `prisma/schema.prisma` changed | ✅ YES | `bun run db:generate` |
| After `git pull` if only TS/TSX code changed | ❌ No | — |
| Before `bun run build` (if Prisma Client is missing) | ✅ YES | `bun run db:generate` |
| Inside Docker builds | ❌ No | Handled automatically in `Dockerfile` (`RUN bunx prisma generate`) |

### What happens if you skip it?
- `bun run dev` will fail at the first Prisma query: `PrismaClient is unable to run...`
- `bun run build` will still succeed (TypeScript is set to `ignoreBuildErrors: true` in `next.config.mjs`), but `bun run start` will fail at runtime.
- The standalone bundle includes a snapshot of the generated client, so missing it at build time produces a broken image.

### Quick fix on the VPS:
```bash
cd /app/flowops
bun run db:generate   # or: bunx prisma generate
bun run build
# Restart the server process (pm2 restart / systemctl restart flowops / etc.)
```

---

## 🗂️ ENVIRONMENT VARIABLES REFERENCE

### DEV (.env on sandbox):
```
DATABASE_URL=postgresql://postgres.gobwxqkzfulbwhzbbsdj:123%40Usman123%40@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
DIRECT_URL=postgresql://postgres.gobwxqkzfulbwhzbbsdj:123%40Usman123%40@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
INTEGRATION_ENCRYPTION_KEY=1fbf4fd279d9476183566c878e38907764feac7e7843d16ac60065720a451951
SESSION_SECRET=flowops-session-secret-v1-change-in-production-please-32-chars-min
CRON_SECRET=flowops-cron-secret-v1-change-in-production
APP_URL=http://localhost:3000
```

### PRODUCTION (.env on the VPS — user fills in):
```
DATABASE_URL=postgresql://postgres.[PROD-PROJECT-REF]:[PROD-PASSWORD]%40@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
DIRECT_URL=postgresql://postgres.[PROD-PROJECT-REF]:[PROD-PASSWORD]%40@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
INTEGRATION_ENCRYPTION_KEY=1fbf4fd279d9476183566c878e38907764feac7e7843d16ac60065720a451951
SESSION_SECRET=[NEW-STRONG-SECRET-32-CHARS-MIN-GENERATE-A-NEW-ONE]
CRON_SECRET=[NEW-STRONG-SECRET-GENERATE-A-NEW-ONE]
APP_URL=https://yourdomain.com
NODE_ENV=production
```

### Required Variables Summary
| Variable | Purpose | Notes |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection (Prisma Client — pooled) | Supabase pooler port `5432`. URL-encode any `@` in the password as `%40`. |
| `DIRECT_URL` | PostgreSQL connection (Prisma Migrations — direct) | Supabase pooler port `5432`. Same as `DATABASE_URL` in this project. |
| `INTEGRATION_ENCRYPTION_KEY` | AES-256 key for encrypting stored courier/API credentials | **MUST be identical on dev and prod** — otherwise encrypted credentials can't be decrypted across environments. 64-char hex. |
| `SESSION_SECRET` | HMAC signing key for signed cookies | Generate a NEW value for production (32+ chars). Different from dev. |
| `CRON_SECRET` | Bearer token for `/api/cron/*` endpoints (Vercel-style cron) | Generate a NEW value for production. Different from dev. |
| `APP_URL` | Canonical app URL (used in emails, webhooks, redirects) | `https://yourdomain.com` in production. |
| `NODE_ENV` | Node runtime mode | `production` on the VPS. The `start` script also sets it explicitly. |

> **Note**: `INTEGRATION_ENCRYPTION_KEY` MUST be the same on both dev and production —
> otherwise credentials encrypted on dev can't be decrypted on production (and vice versa).
> The other secrets (SESSION_SECRET, CRON_SECRET) SHOULD be different for security.

---

## 🚨 EMERGENCY PROCEDURES

### If production breaks after a deployment:
1. **Revert code**: `git revert [commit-hash] && bun run build && restart`
2. **Don't revert migrations** — they're forward-only. Fix forward with a new migration.
3. **Restore DB backup** if data corruption occurred

### If production DB is corrupted:
1. **Immediately restore** from the latest Supabase backup
2. **Notify users** of downtime
3. **Investigate root cause** on DEV (reproduce the issue)
4. **Fix** on DEV, test, then redeploy

### If a migration fails on production:
1. **Check** the error message (Supabase SQL Editor shows it)
2. **Fix** the migration SQL on DEV
3. **Apply** the fixed migration to production
4. **Never** try to "undo" a partial migration — fix forward

---

## 📋 MIGRATION CHECKLIST (for each new migration)

Before applying to production:
- [ ] Migration tested on DEV DB
- [ ] Migration is idempotent (IF NOT EXISTS / DO $$ blocks)
- [ ] Migration doesn't drop any existing columns or tables
- [ ] Migration doesn't lock the database for extended periods
- [ ] Backup taken before applying
- [ ] Applied via Supabase SQL Editor (not psql — easier to monitor)
- [ ] Verified after application (check schema, run a test query)

---

## 📋 CODE CHANGE CHECKLIST (for each new feature/fix)

Before deploying to production:
- [ ] Code tested on DEV sandbox
- [ ] `bun run lint` passes (0 errors)
- [ ] Brute-force tested (all flows work end-to-end)
- [ ] No hardcoded dev credentials in code
- [ ] No `console.log` debug statements in production paths
- [ ] `NODE_ENV=production` doesn't break anything
- [ ] Git committed with clear message
- [ ] No `.env` file committed to git
- [ ] If new env vars needed → document them in this guide

---

*This document is the single source of truth for deployment + development rules. Update it whenever the workflow changes.*
