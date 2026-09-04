# FlowOps ERP — Production Deployment Guide

> **CRITICAL DOCUMENT** — Read this BEFORE deploying to Hostinger or making any changes after deployment.
>
> **Last Updated**: September 2026 (DOCS-TESTING-DEPLOY task — rewrite for zero-downtime + detail).
>
> **Companion documents**:
> - `TESTING_GUIDELINES.md` — what to do BEFORE you read this guide (DEV sandbox testing)
> - `FLOWOPS_BRIEFING.md` — architecture, module catalog, key systems
> - `INTERNAL_API_GUIDE.md` — every API route's contract
> - `DATABASE_GUIDE.md` — full Prisma schema + migration history
> - `FRONTEND_GUIDE.md` — frontend architecture + components
> - `DOCKER.md` — alternative Docker-based deployment (single-host)

---

## Table of Contents

1. [Golden Rules (Non-Negotiable)](#1-golden-rules-non-negotiable)
2. [Hostinger Deployment — Detailed](#2-hostinger-deployment--detailed)
3. [Zero-Downtime Deployment Strategy](#3-zero-downtime-deployment-strategy)
4. [Data Loss Prevention Checklist](#4-data-loss-prevention-checklist)
5. [Rollback Procedure](#5-rollback-procedure)
6. [Environment Variable Management (DEV vs PROD)](#6-environment-variable-management-dev-vs-prod)
7. [Migration Application Guide](#7-migration-application-guide)
8. [Post-Deployment Verification Checklist](#8-post-deployment-verification-checklist)
9. [Monitoring Guide](#9-monitoring-guide)
10. [Common Deployment Pitfalls](#10-common-deployment-pitfalls)
11. [Git Workflow for Deployment](#11-git-workflow-for-deployment)
12. [Emergency Procedures](#12-emergency-procedures)
13. [Deployment Quick Reference](#13-deployment-quick-reference)

---

## 1. Golden Rules (Non-Negotiable)

These are the five rules that, if broken, can take down production or destroy live business data. They are non-negotiable.

### Rule 1 — TWO databases, NEVER mix them

| | DEV / TEST DB | PRODUCTION DB |
|---|---|---|
| Purpose | Development, brute-force testing, sandbox experiments | Live business operations |
| Contents | Test users, test orders, test products, fake data | Real users, real orders, real money data |
| Project (current) | `gobwxqkzfulbwhzbbsdj` (Supabase, ap-south-1) | **Create on deployment day** (new Supabase project) |
| Connection | Already in the dev sandbox `.env` | Set on Hostinger once, persists |
| Connect production code? | ❌ NEVER | ✅ Only this one |
| Run test scripts? | ✅ OK | ❌ NEVER |
| Create test users / orders? | ✅ OK | ❌ NEVER |

### Rule 2 — `.env` FILE MANAGEMENT

- The `.env` file in the dev sandbox **always reverts to SQLite** on restart (known sandbox issue — see `TESTING_GUIDELINES.md` §1.2).
- On Hostinger (production), the `.env` will be set once and persist (Hostinger's process supervisor does not wipe env files between restarts).
- **DEV `.env`** → points to DEV Supabase (current credentials in `TESTING_GUIDELINES.md` §1.3).
- **PRODUCTION `.env`** → points to PRODUCTION Supabase (new credentials — set on Hostinger).
- **NEVER** commit `.env` to git (it is in `.gitignore`).

### Rule 3 — NO TEST DATA IN PRODUCTION

- The production DB starts EMPTY (only schema, no rows except the IntegrationProvider seed).
- The onboarding flow creates the first org → company → owner.
- **NEVER** run seed scripts, test data generators, or brute-force tests against production.
- **NEVER** create test customers, test orders, or test products in production.
- **NEVER** connect sandbox / test Leopard credentials to production.

### Rule 4 — MIGRATIONS ARE ONE-WAY

- Database migrations (`supabase/migrations/0*.sql`) are applied to production ONCE.
- Once applied, they CANNOT be rolled back (no `down` migrations — by design).
- Test ALL migrations on DEV first — verify they work before applying to production.
- Migration numbering: `001` through `029` exist. New migrations start at `030+`.
- If a migration breaks production: write a NEW migration that fixes it forward. Do NOT try to "undo" the broken one.

### Rule 5 — CODE CHANGES: DEV FIRST, PRODUCTION SECOND

- ALL code changes are developed + tested on the DEV sandbox first (see `TESTING_GUIDELINES.md`).
- Only after DEV testing passes (lint 0 errors, brute-force green, no runtime errors) are changes deployed to Hostinger production.
- **NEVER** make code changes directly on the Hostinger server.
- **NEVER** run `bun run dev` on Hostinger — use `bun run build` + `bun run start`.
- **NEVER** run `prisma db push` on production after initial setup (it can drop columns) — use `prisma migrate` or manual SQL migrations applied via Supabase SQL Editor.

---

## 2. Hostinger Deployment — Detailed

### 2.1 Choose the right Hostinger plan

FlowOps requires:

- A persistent Node.js process (Next.js standalone server)
- Long-running background work (cron pollers for Leopard/PostEx)
- Filesystem storage for uploaded PDFs (slips, scan reports)
- ~512 MB RAM minimum (1 GB recommended)
- A public domain with TLS

**Recommended Hostinger options:**

| Option | Plan | Why | Notes |
|---|---|---|---|
| **VPS** (recommended) | KVM 2 — 8 GB RAM, 100 GB NVMe, 4 TB bandwidth | Full root access, run Bun + pm2/systemd, no plan limits | You manage OS patching, firewall, TLS via Caddy/nginx |
| **Shared hosting with Node.js** (acceptable for small rollouts) | Business plan or higher | Pre-configured Node.js + Passenger, easy TLS via cPanel | Limited to ~1 GB RAM; some Node features (cluster) not available; cron must run via cPanel cron |
| **WordPress hosting** | ❌ No | Not Node-compatible | — |

For the rest of this guide, **the VPS path is assumed**. Shared-hosting differences are called out where relevant.

### 2.2 Provision the server (VPS)

```bash
# SSH in as root
ssh root@your-hostinger-vps-ip

# Update the OS
apt update && apt upgrade -y

# Install Node.js 20 LTS (required by Next.js 16)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Install git
apt install -y git

# Install build tools (sharp / @react-pdf/renderer need them)
apt install -y build-essential python3

# Install nginx (for TLS termination + reverse proxy)
apt install -y nginx

# Install certbot for Let's Encrypt TLS
apt install -y certbot python3-certbot-nginx

# Install pm2 — production process manager for Node
npm install -g pm2

# Verify
node -v    # v20.x
bun -v     # 1.x
git --version
pm2 --version
nginx -v
```

### 2.3 Clone the repo + install dependencies

```bash
# Create a deploy user (don't run as root)
adduser --disabled-password --gecos "" flowops
usermod -aG sudo flowops
mkdir -p /app
chown flowops:flowops /app

# Switch to the deploy user
su - flowops

# Clone the repo
cd /app
git clone <your-repo-url> flowops
cd flowops

# Install dependencies
bun install

# Generate the Prisma client (reads schema.prisma)
bunx prisma generate
```

### 2.4 Configure the production `.env`

Create `/app/flowops/.env` with nano or your editor:

```bash
nano /app/flowops/.env
```

Paste the production values (fill in the placeholders — see §6 for what each value should be):

```env
DATABASE_URL=postgresql://postgres.[PROD-PROJECT-REF]:[PROD-URL-ENCODED-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
DIRECT_URL=postgresql://postgres.[PROD-PROJECT-REF]:[PROD-URL-ENCODED-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
INTEGRATION_ENCRYPTION_KEY=1fbf4fd279d9476183566c878e38907764feac7e7843d16ac60065720a451951
SESSION_SECRET=[NEW-STRONG-SECRET-32-CHARS-MIN-GENERATE-A-NEW-ONE]
CRON_SECRET=[NEW-STRONG-SECRET-GENERATE-A-NEW-ONE]
APP_URL=https://yourdomain.com
NODE_ENV=production
```

Lock down the file permissions:

```bash
chmod 600 /app/flowops/.env
chown flowops:flowops /app/flowops/.env
```

### 2.5 Push the schema to the production Supabase DB (FIRST TIME ONLY)

> ⚠️ Do this step ONCE — on initial deployment. After that, schema changes go through migrations only.

```bash
cd /app/flowops

# Verify you're pointing at production (not DEV)
grep DATABASE_URL .env
# Should show: postgresql://postgres.[PROD-REF]...

# Push the schema (creates all 68+ tables)
bunx prisma db push

# Verify the tables exist (should print 60+ table names)
bunx prisma db execute --stdin <<< "\\dt"
```

Then apply all 29 migration SQL files via Supabase SQL Editor (see §7).

### 2.6 Build for production

```bash
cd /app/flowops
bun run build
```

**Expected output (truncated):**

```
   ▲ Next.js 16.1.x
   - Compiled successfully
   - Collecting page data ...
   - Generating static pages ...
   - Build output:
     Standalone: .next/standalone/
     Static:     .next/static/
   ✓ Building completed
```

The `build` script in `package.json` is:

```json
"build": "next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/"
```

This copies the static assets + public folder INTO the standalone bundle so it's self-contained at `.next/standalone/`.

### 2.7 Start the production server (with pm2)

```bash
cd /app/flowops
pm2 start ".next/standalone/server.js" --name flowops --cwd /app/flowops/.next/standalone
pm2 save
pm2 startup    # Follow the printed instructions to enable boot-on-startup
```

Verify:

```bash
pm2 status
# Should show "flowops" as "online"

pm2 logs flowops --lines 20
# Should show "Next.js 16.x" + "Ready" + no errors

curl http://localhost:3000/api/health
# Should return: {"status":"healthy","db":"connected","timestamp":"..."}
```

### 2.8 Configure nginx (reverse proxy + TLS)

Create `/etc/nginx/sites-available/flowops`:

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    # Redirect HTTP to HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com www.yourdomain.com;

    # TLS certs (will be configured by certbot — placeholders for now)
    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    # Next.js standalone server runs on port 3000
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        # Long-running operations (courier booking, PDF generation)
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }

    # Uploaded PDFs / images — serve from disk for performance
    location /uploads/ {
        alias /app/flowops/public/uploads/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # Allow large file uploads (logos, payment proofs)
    client_max_body_size 10M;
}
```

Enable the site + reload:

```bash
sudo ln -s /etc/nginx/sites-available/flowops /etc/nginx/sites-enabled/
sudo nginx -t       # Test config
sudo systemctl reload nginx
```

Issue the Let's Encrypt cert:

```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
# certbot will automatically modify the nginx config above to point at the right cert paths
# and reload nginx
```

### 2.9 Shared-hosting (cPanel) variant

If you're on Hostinger shared hosting with Node.js support:

1. cPanel → **Setup Node.js App**
2. Node.js version: `20.x`
3. Application root: `/home/yourusername/flowops` (upload the built `.next/standalone/` folder)
4. Application URL: `yourdomain.com`
5. Application mode: `Production`
6. Set environment variables in the cPanel UI (same values as §2.4)
7. Click **Run NPM Install** if dependencies aren't bundled
8. Click **Start App**

**Limitations on shared hosting:**

- ❌ No `pm2` — cPanel uses Passenger, which auto-restarts on crash but doesn't support `pm2 logs` / `pm2 restart`
- ❌ No cron from the CLI — schedule via cPanel → **Cron Jobs** (set the 5 cron routes from `vercel.json` with `curl -H "X-Cron-Secret: $CRON_SECRET"`)
- ❌ No filesystem access outside your home directory — uploads go to `~/flowops/public/uploads/`
- ❌ No root — can't install system packages; if `sharp` fails to install, use the `@squoosh/lib` fallback (already in `package.json`)

---

## 3. Zero-Downtime Deployment Strategy

The naive deploy — `git pull && bun run build && pm2 restart flowops` — causes 10-30 seconds of downtime while the build runs and the server restarts. For a business running live orders, even 10 seconds of downtime can mean a missed order or a failed courier booking.

### 3.1 The strategy: blue-green with port swap

Run TWO instances of the app on different ports (3000 = "live", 3001 = "next"). Updates go to 3001, swap nginx to point at 3001, then 3000 becomes "next" for the next deploy.

```
                ┌────────────────────────┐
                │  nginx (port 80/443)    │
                │  proxy_pass → :3000     │ ◄── live traffic
                └──────────┬─────────────┘
                           │
       ┌───────────────────┴───────────────────┐
       │                                       │
┌──────▼────────┐                       ┌──────▼────────┐
│  flowops-blue │                       │ flowops-green │
│  port 3000    │                       │  port 3001    │
│  LIVE         │                       │  IDLE (next)  │
└───────────────┘                       └───────────────┘
```

### 3.2 Initial setup

```bash
# Start the blue instance (initial deploy)
cd /app/flowops
PORT=3000 pm2 start ".next/standalone/server.js" --name flowops-blue --cwd /app/flowops/.next/standalone

# The green instance doesn't exist yet — it'll be created on the first deploy
pm2 save
```

Update nginx to point at port 3000:

```nginx
# In /etc/nginx/sites-available/flowops
location / {
    proxy_pass http://127.0.0.1:3000;     # ← blue is live
    ...
}
```

### 3.3 Deploy script — zero downtime

Save this as `/app/flowops/deploy.sh` (chmod +x):

```bash
#!/bin/bash
# FlowOps zero-downtime deploy script
# Usage: ./deploy.sh
set -euo pipefail

cd /app/flowops

# Determine which port is currently LIVE and which is NEXT
if pm2 list | grep -q "flowops-blue.*online" && curl -sf http://127.0.0.1:3000/api/health >/dev/null; then
    LIVE_PORT=3000; LIVE_NAME=flowops-blue
    NEXT_PORT=3001; NEXT_NAME=flowops-green
elif pm2 list | grep -q "flowops-green.*online" && curl -sf http://127.0.0.1:3001/api/health >/dev/null; then
    LIVE_PORT=3001; LIVE_NAME=flowops-green
    NEXT_PORT=3000; NEXT_NAME=flowops-blue
else
    echo "❌ No live instance detected — first deploy? Setting up blue on :3000"
    LIVE_PORT=""; LIVE_NAME=""
    NEXT_PORT=3000; NEXT_NAME=flowops-blue
fi

echo "▶ Live: $LIVE_NAME (:$LIVE_PORT)  →  Next: $NEXT_NAME (:$NEXT_PORT)"

# 1. Pull latest code
echo "▶ git pull"
git pull origin main

# 2. Install dependencies if changed
if ! git diff --quiet HEAD@{1} HEAD -- package.json bun.lock 2>/dev/null; then
    echo "▶ bun install (package.json changed)"
    bun install
fi

# 3. Regenerate Prisma client if schema changed
if ! git diff --quiet HEAD@{1} HEAD -- prisma/schema.prisma 2>/dev/null; then
    echo "▶ prisma generate (schema changed)"
    bunx prisma generate
fi

# 4. Apply migrations if any new ones exist (see §7 for the manual step)
echo "▶ Check for new migrations in supabase/migrations/"
NEW_MIGRATIONS=$(git diff --name-only HEAD@{1} HEAD -- 'supabase/migrations/*.sql' 2>/dev/null || true)
if [ -n "$NEW_MIGRATIONS" ]; then
    echo "⚠️  NEW MIGRATIONS DETECTED — apply them manually via Supabase SQL Editor:"
    echo "$NEW_MIGRATIONS"
    echo "⚠️  Then press Enter to continue, or Ctrl+C to abort."
    read
fi

# 5. Build for production
echo "▶ bun run build"
bun run build

# 6. Stop the next instance if it exists
if pm2 list | grep -q "$NEXT_NAME"; then
    echo "▶ pm2 stop $NEXT_NAME (cleanup before restart)"
    pm2 stop "$NEXT_NAME" || true
fi

# 7. Start the next instance on the next port
echo "▶ pm2 start $NEXT_NAME on :$NEXT_PORT"
PORT=$NEXT_PORT pm2 start ".next/standalone/server.js" \
    --name "$NEXT_NAME" \
    --cwd /app/flowops/.next/standalone

# 8. Wait for the next instance to be healthy (max 60s)
echo "▶ waiting for $NEXT_NAME to be healthy..."
for i in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:$NEXT_PORT/api/health" | grep -q '"status":"healthy"'; then
        echo "✅ $NEXT_NAME healthy after ${i}s"
        break
    fi
    sleep 1
    if [ $i -eq 60 ]; then
        echo "❌ $NEXT_NAME did not become healthy in 60s — aborting"
        pm2 stop "$NEXT_NAME" || true
        exit 1
    fi
done

# 9. Swap nginx to point at the next port
echo "▶ swapping nginx upstream to :$NEXT_PORT"
sed -i "s|proxy_pass http://127.0.0.1:[0-9]*|proxy_pass http://127.0.0.1:$NEXT_PORT|" /etc/nginx/sites-available/flowops
sudo nginx -t && sudo systemctl reload nginx

# 10. Stop the old live instance (now idle)
if [ -n "$LIVE_NAME" ]; then
    echo "▶ pm2 stop $LIVE_NAME (old live instance)"
    pm2 stop "$LIVE_NAME"
fi

# 11. Save pm2 state
pm2 save

echo "✅ Deploy complete. Live: $NEXT_NAME (:$NEXT_PORT)"
echo "   To roll back, run: ./deploy.sh  (it will swap back to $LIVE_NAME on :$LIVE_PORT)"
```

Make it executable:

```bash
chmod +x /app/flowops/deploy.sh
sudo chown flowops:flowops /app/flowops/deploy.sh
```

### 3.4 Usage

```bash
# Trigger a deploy from the server:
cd /app/flowops && ./deploy.sh
```

What it does (per step above):
1. Detects which instance is live + which is idle
2. Pulls latest code
3. Installs new deps (only if `package.json` changed)
4. Regenerates Prisma client (only if `schema.prisma` changed)
5. Pauses if there are new migrations (you apply them manually — see §7)
6. Builds
7. Stops the idle instance, starts it on the new port
8. Waits up to 60s for `/api/health` to return `200`
9. Atomically swaps nginx upstream + reloads nginx (sub-second cut-over)
10. Stops the now-idle old instance
11. Saves pm2 state

If step 8 fails (new instance doesn't come up healthy), the script aborts — nginx is still pointing at the old live instance, so users see no downtime.

### 3.5 Rollback (one command)

If the new version has a runtime bug that wasn't caught by health check:

```bash
cd /app/flowops && ./deploy.sh
```

The script will detect that `flowops-green` (the just-deployed new version) is live on :3001, and deploy `flowops-blue` (the previous version) on :3000. Since the old code is still on disk in `.next/standalone/` (the build step overwrites it, but pm2 has the OLD process still in memory until step 10 stops it — and even after stop, the OLD `.next/standalone/` is gone after rebuild).

**The gotcha:** after `git pull`, the OLD code is replaced on disk. To roll back to a specific commit:

```bash
cd /app/flowops
git log --oneline -10                    # Find the commit to roll back to
git checkout <commit-hash>               # Detached HEAD at old commit
bun run build                              # Rebuild the OLD code
./deploy.sh                                # Deploy old code to the idle port
# (if old code is healthy, swap nginx back to it)
git checkout main                         # Return to main branch
```

See §5 for the full rollback procedure.

### 3.6 Zero-downtime for migrations

Migrations are the hardest part of zero-downtime because schema changes can break the running old version of the app (which expects the old schema).

**Rules:**

| Migration type | Safe for zero-downtime? | Strategy |
|---|---|---|
| Add a new column (nullable, with default) | ✅ Yes | Apply before deploy. Old app ignores the new column. New app uses it. |
| Add a new table | ✅ Yes | Apply before deploy. |
| Add a non-nullable column | ⚠️ Tricky | Add as nullable first (deploy 1), backfill rows (deploy 2), add NOT NULL constraint (deploy 3). |
| Rename a column | ❌ No | Add new column (deploy 1), dual-write to both (deploy 2), drop old column (deploy 3). |
| Drop a column | ❌ No | Stop using it in code (deploy 1), wait a week, drop the column (deploy 2). |
| Add an index | ✅ Yes (use `CREATE INDEX CONCURRENTLY`) | Apply before deploy. |
| Drop an index | ✅ Yes | Apply after deploy. |
| Add a CHECK constraint | ⚠️ Tricky | Apply after deploy, with `NOT VALID` first, then `VALIDATE CONSTRAINT` later. |

**The pattern for risky migrations:** expand → migrate → contract.

1. **Expand** (deploy 1): add the new column / table. Old + new code can coexist.
2. **Migrate** (between deploys): backfill data, dual-write.
3. **Contract** (deploy N): drop the old column / constraint.

### 3.7 What you CAN'T do zero-downtime

- **Major Next.js version upgrades** (e.g., 15 → 16): always require a brief restart. Do these during low-traffic hours.
- **Prisma 7+ upgrade**: schema.prisma syntax changes can require `prisma generate` + `bun install` + rebuild. Brief downtime.
- **Supabase project pause / region change**: 1-5 minutes of DB unavailability.

---

## 4. Data Loss Prevention Checklist

### 4.1 BEFORE any migration — backup the DB

**Method 1 — Supabase Dashboard (recommended):**

1. Go to https://supabase.com → your production project
2. **Settings** → **Database** → **Backups**
3. Click **Create backup** → name it `pre-migration-<date>`
4. Wait for the backup to complete (usually < 1 minute for small DBs)
5. Note the backup timestamp — you'll need it for restore

**Method 2 — `pg_dump` from the server:**

```bash
# Set the production DB URL in your shell
export DATABASE_URL="postgresql://postgres.[PROD-REF]:[PROD-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres"

# Dump to a file
pg_dump "$DATABASE_URL" --no-owner --no-privileges --format=plain \
  > /app/backups/flowops-prod-$(date +%Y%m%d-%H%M%S).sql

# Verify the dump is non-trivial
ls -la /app/backups/
wc -l /app/backups/flowops-prod-*.sql | tail -n 5
```

**Method 3 — Schema only (for verifying migrations without data):**

```bash
pg_dump "$DATABASE_URL" --schema-only --no-owner > /tmp/schema-$(date +%Y%m%d).sql
```

### 4.2 Verify the backup before proceeding

```bash
# Restore the backup to a TEMPORARY Supabase project (or local Postgres)
# Run a sanity query against the restored copy:
psql "$TEMP_DB_URL" -c "SELECT COUNT(*) FROM \"Order\";"
psql "$TEMP_DB_URL" -c "SELECT COUNT(*) FROM \"Customer\";"
psql "$TEMP_DB_URL" -c "SELECT COUNT(*) FROM \"InventoryPool\";"

# Compare counts with production
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM \"Order\";"
```

If the counts match, the backup is good. If they don't, do NOT proceed with the migration — investigate.

### 4.3 AFTER the migration — verify data integrity

```bash
# 1. The migration didn't drop any data
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM \"Order\";"
# Should match the count from §4.2

# 2. The migration didn't break any constraints
psql "$DATABASE_URL" -c "
SELECT conname, conrelid::regclass
FROM pg_constraint
WHERE contype = 'c'
  AND connamespace = 'public'::regnamespace
ORDER BY conrelid::regclass::text, conname;
"

# 3. The migration didn't break any unique indexes
psql "$DATABASE_URL" -c "
SELECT indexname, tablename
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexdef LIKE '%UNIQUE%'
ORDER BY tablename, indexname;
"

# 4. All SQL functions still exist (migrations sometimes drop+recreate)
psql "$DATABASE_URL" -c "
SELECT proname
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
ORDER BY proname;
"
# Should include: generate_order_number, normalize_phone, match_or_create_customer,
#                 recompute_order_status, get_next_sequence_number, etc.
```

### 4.4 The data-loss-prevention checklist (copy this for every migration)

- [ ] **Backup taken** (Supabase dashboard OR `pg_dump`)
- [ ] **Backup verified** (restored to temp DB + row counts match)
- [ ] **Migration tested on DEV** (apply to DEV, run brute-force tests, verify)
- [ ] **Migration is idempotent** (`IF NOT EXISTS` / `CREATE OR REPLACE` / `DO $$ ... BEGIN ... END $$`)
- [ ] **Migration doesn't drop existing columns or tables** (if it does, flag for expand-contract)
- [ ] **Migration doesn't lock the DB for > 1 second** (use `CONCURRENTLY` for indexes; check for `ACCESS EXCLUSIVE` locks)
- [ ] **Applied via Supabase SQL Editor** (not psql — easier to monitor + log)
- [ ] **Verified after application** (schema matches expected, functions exist, constraints pass)
- [ ] **App still works after migration** (smoke test: login, dashboard, create order — see §8)
- [ ] **Rollback plan written** (which backup to restore, who to notify, expected downtime)

---

## 5. Rollback Procedure

### 5.1 When to roll back

| Situation | Roll back? | How |
|---|---|---|
| Health check fails after deploy | ✅ Yes — immediately | `./deploy.sh` (auto-swaps to old instance) |
| Users report broken feature within 10 min | ✅ Yes | `./deploy.sh` (swap to old) |
| Users report broken feature after 1 hour | ⚠️ Maybe | Investigate first — the old instance is still running idle, swap is cheap |
| App is healthy but a specific flow is broken | ❌ No — fix forward | Investigate on DEV, fix, deploy normally |
| Migration broke the DB | ❌ No app rollback — restore DB | See §5.4 |
| Data corruption | ❌ No app rollback — restore DB | See §5.4 |

### 5.2 Quick rollback — app only

```bash
cd /app/flowops
./deploy.sh
```

The deploy script (§3.3) detects which instance is live, deploys the OLD code to the OTHER port, and swaps nginx back. Total time: ~30-60 seconds (build + health check + swap).

If you need to roll back to a SPECIFIC older commit (not just the previous one):

```bash
# 1. Find the commit to roll back to
git log --oneline -20

# 2. Check out that commit (detached HEAD — fine for deploy)
git checkout <commit-hash>

# 3. Build + deploy
bun run build
./deploy.sh

# 4. If healthy, swap is done. Return to main branch:
git checkout main
```

### 5.3 Rollback — code + dependencies

If the rollback requires going back to an older `package.json` (e.g., a dependency broke something):

```bash
cd /app/flowops
git checkout <commit-hash>
bun install                    # Reinstall old deps
bunx prisma generate            # Regenerate client (in case schema.prisma also changed)
bun run build
./deploy.sh
git checkout main               # Return to main
```

### 5.4 Rollback — DB (last resort)

If a migration broke the DB and the app can't function:

```bash
# 1. Take the app offline IMMEDIATELY (put up a maintenance page)
sudo mv /etc/nginx/sites-enabled/flowops /etc/nginx/sites-enabled/flowops.disabled
sudo systemctl reload nginx
# OR: pm2 stop flowops-blue flowops-green

# 2. Restore the backup taken BEFORE the migration
# Via Supabase Dashboard:
#   Settings → Database → Backups → select pre-migration-<date> → Restore

# OR via psql (drop + recreate + restore from dump):
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql "$DATABASE_URL" -f /app/backups/flowops-prod-<timestamp>.sql

# 3. Verify the restore (row counts should match pre-migration)
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM \"Order\";"

# 4. Restart the OLD app version (the one that worked with the old schema)
cd /app/flowops
git checkout <commit-before-migration>
bun install
bunx prisma generate
bun run build
./deploy.sh

# 5. Bring the app back online
sudo mv /etc/nginx/sites-enabled/flowops.disabled /etc/nginx/sites-enabled/flowops
sudo systemctl reload nginx

# 6. Notify users that the system is back
```

### 5.5 Rollback testing (DEV only — never run on production)

Test the rollback procedure on DEV before you need it in production:

```bash
# On DEV sandbox:
cd /home/z/my-project
git log --oneline -5
# Pretend the latest commit broke something:
git checkout HEAD~1
./start.sh   # Verify old version runs
# Then test the deploy.sh swap (if pm2 is installed on DEV)
```

---

## 6. Environment Variable Management (DEV vs PROD)

### 6.1 The full env var reference

| Variable | DEV (.env in sandbox) | PROD (.env on Hostinger) | MUST be same? | MUST be different? |
|---|---|---|---|---|
| `DATABASE_URL` | DEV Supabase URL | PROD Supabase URL | ❌ No (different DBs) | ✅ Yes |
| `DIRECT_URL` | Same as DEV `DATABASE_URL` | Same as PROD `DATABASE_URL` | ❌ No | ✅ Yes |
| `INTEGRATION_ENCRYPTION_KEY` | `1fbf4fd279d9476183566c878e38907764feac7e7843d16ac60065720a451951` | `1fbf4fd279d9476183566c878e38907764feac7e7843d16ac60065720a451951` | ✅ **YES** | ❌ No |
| `SESSION_SECRET` | `flowops-session-secret-v1-...` | Generate a NEW strong 32+ char secret | ❌ No | ✅ Yes |
| `CRON_SECRET` | `flowops-cron-secret-v1-...` | Generate a NEW strong secret | ❌ No | ✅ Yes |
| `APP_URL` | `http://localhost:3000` | `https://yourdomain.com` | ❌ No | ✅ Yes |
| `NODE_ENV` | (not set — dev mode) | `production` | ❌ No | ✅ Yes |

### 6.2 Why `INTEGRATION_ENCRYPTION_KEY` must be the same

Courier integration credentials (Leopard API key/secret, PostEx token) are stored in the `CompanyIntegration.credentials` JSON column, encrypted with AES-256-GCM using `INTEGRATION_ENCRYPTION_KEY`. The encryption is one-way — without the same key, the credentials cannot be decrypted.

If you set a different `INTEGRATION_ENCRYPTION_KEY` on production:

- The DEV credentials (which you encrypted on DEV) cannot be decrypted on production → integration tests fail
- More importantly: if you ever need to COPY an integration credential from DEV to PROD (e.g., during emergency debugging), it won't decrypt

> ⚠️ **If you've already deployed with a different key on production:** generate new credentials from Leopard/PostEx directly in the production app (Settings → Integrations → Connect). The old encrypted values are useless.

### 6.3 Why `SESSION_SECRET` should be different

The `SESSION_SECRET` is used to sign the `flowops_session` cookie. If the production secret leaks, an attacker can forge a session cookie for any user. Using a different secret on production means a DEV leak doesn't compromise production.

**Generate a new production secret:**

```bash
# 32-char alphanumeric (use openssl for portability)
openssl rand -base64 24 | tr -d '/+=' | head -c 32
# Or with bun:
bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 6.4 Why `CRON_SECRET` should be different

The `CRON_SECRET` is checked in the header `X-Cron-Secret` of every `/api/cron/*` route. If it leaks, an attacker can trigger the cron jobs (e.g., poll Leopard) repeatedly, exhausting API rate limits.

### 6.5 Setting env vars on Hostinger (cPanel)

If on shared hosting with cPanel:

1. cPanel → **Setup Node.js App** → your app
2. Scroll to **Environment variables**
3. Add each variable as key/value
4. Click **Save** + **Restart App**

If on VPS:

```bash
# Edit the .env file directly
nano /app/flowops/.env
# Restart pm2 to pick up the new values:
pm2 restart flowops-blue flowops-green
```

### 6.6 Verifying env vars are loaded

After restarting, verify the app picked up the env vars:

```bash
# Check the running process's env (Linux)
cat /proc/$(pgrep -f "next/standalone/server.js" | head -n 1)/environ | tr '\0' '\n' | grep -E "^(DATABASE_URL|NODE_ENV|APP_URL)"

# Should print:
# DATABASE_URL=postgresql://postgres.[PROD-REF]...
# NODE_ENV=production
# APP_URL=https://yourdomain.com

# Hit the health endpoint (verifies DB connection):
curl https://yourdomain.com/api/health
# Should return: {"status":"healthy","db":"connected",...}
```

### 6.7 The `.env` should NEVER be in git

Verify `.env` is in `.gitignore`:

```bash
cd /app/flowops
grep -E "^\.env" .gitignore
# Should print: .env, .env.local, .env.*.local, etc.
```

If `.env` was accidentally committed, remove it from history:

```bash
# ⚠️ This rewrites git history — coordinate with all contributors first
git filter-branch --force --index-filter \
  'git rm --cached --ignore-unmatch .env' \
  --prune-empty --tag-name-filter cat -- --all
git push origin --force --all
# Then ROTATE all secrets that were in .env (DB password, session secret, etc.)
```

---

## 7. Migration Application Guide

### 7.1 Where migrations live

Migration SQL files live in `/home/z/my-project/supabase/migrations/` on DEV and at `/app/flowops/supabase/migrations/` on the server (after `git pull`). The naming convention is:

```
supabase/migrations/0NN_short_description.sql
```

Current migrations: `001_oms_schema.sql` through `029_order_status_check.sql` (with `015` and `017` skipped — merged into earlier ones).

### 7.2 Apply a migration to PRODUCTION via Supabase SQL Editor

> **Always apply via Supabase SQL Editor (not psql)** — easier to monitor, easier to roll back via the "Restore" button if the SQL fails partway through.

1. **Test on DEV first** (see `TESTING_GUIDELINES.md` §3 + §7.1):
   ```bash
   # On DEV sandbox:
   psql "$DATABASE_URL" -f supabase/migrations/030_my_new_migration.sql
   # Run brute-force tests to verify the migration is safe
   ```

2. **Backup production DB** (see §4.1).

3. **Open Supabase SQL Editor:**
   - https://supabase.com → your production project
   - Left sidebar → **SQL Editor**
   - Click **New query**

4. **Paste the migration SQL:**
   - Open the migration file (e.g., `030_my_new_migration.sql`) — `cat /app/flowops/supabase/migrations/030_my_new_migration.sql`
   - Copy the entire contents
   - Paste into the SQL Editor

5. **Review the SQL:**
   - Look for `DROP TABLE` / `DROP COLUMN` statements — these are destructive
   - Look for `ALTER TABLE ... ALTER COLUMN ... TYPE` — these can fail if data doesn't fit
   - Look for `CREATE INDEX` without `CONCURRENTLY` — these lock the table

6. **Click Run** (Ctrl+Enter):
   - Watch the output panel for errors
   - If it says "Success. No rows returned." → migration applied
   - If it shows an error → STOP, do NOT retry, see §7.4

7. **Verify the migration applied correctly** (see §4.3).

8. **Mark the migration as applied** — add an entry to the `_migrations` table (if using Prisma Migrate) OR just record the deploy in `worklog.md`.

### 7.3 The expand-contract pattern for risky migrations

For migrations that change existing columns (rename, drop, type change), use the expand-contract pattern. Example: renaming `Customer.phone` to `Customer.primaryPhone`.

**Expand (migration 030):**

```sql
-- Add the new column (nullable, no data yet)
ALTER TABLE "Customer" ADD COLUMN "primaryPhone" TEXT;

-- Backfill from old column
UPDATE "Customer" SET "primaryPhone" = "phone" WHERE "primaryPhone" IS NULL;

-- Create an index on the new column (CONCURRENTLY = no lock)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "customer_primaryPhone_idx"
  ON "Customer" ("primaryPhone");
```

**Deploy 1:** Code writes to BOTH columns (dual-write). Old code still reads from `phone`.

**Migrate (migration 031, deploy 2):**

```sql
-- Add a CHECK constraint to ensure both columns stay in sync
ALTER TABLE "Customer"
  ADD CONSTRAINT "customer_phone_sync_chk"
  CHECK ("phone" = "primaryPhone") NOT VALID;

-- Validate the constraint (CONCURRENTLY = no lock)
ALTER TABLE "Customer" VALIDATE CONSTRAINT "customer_phone_sync_chk";

-- Make the new column NOT NULL
ALTER TABLE "Customer" ALTER COLUMN "primaryPhone" SET NOT NULL;
```

**Deploy 2:** Code reads from `primaryPhone`, writes only to `primaryPhone`.

**Contract (migration 032, deploy 3):**

```sql
-- Drop the old column
ALTER TABLE "Customer" DROP COLUMN "phone";

-- Drop the sync constraint
ALTER TABLE "Customer" DROP CONSTRAINT "customer_phone_sync_chk";
```

**Deploy 3:** Code is clean — only `primaryPhone` exists.

### 7.4 If a migration fails partway through

**DO NOT retry the same migration.** If it failed, the DB might be in a half-applied state. Steps:

1. **Stop** — do not run any more migrations
2. **Check the error message** — Supabase SQL Editor shows it in the output panel
3. **Check the DB state** — what tables / columns / constraints actually exist?
   ```sql
   \d "Customer"
   -- or
   SELECT column_name, data_type, is_nullable
   FROM information_schema.columns
   WHERE table_name = 'Customer';
   ```
4. **Decide:**
   - **If the migration is salvageable** (e.g., only the last statement failed): write a NEW migration that fixes the broken part
   - **If the migration is fundamentally broken**: restore the DB backup (§5.4), write a NEW corrected migration, apply it

5. **NEVER** modify the original migration file. Create a new one (`031_fix_my_broken_migration.sql`) that fixes forward.

### 7.5 Migration numbering convention

| Range | Purpose |
|---|---|
| `001`-`029` | Existing migrations (already applied to DEV, need to apply to PROD on first deploy) |
| `030+` | New migrations (developed after the rewrite) |

When creating a new migration:

```bash
# Determine the next number
ls /home/z/my-project/supabase/migrations/ | sort | tail -n 5

# Create the new migration file
NEXT_NUM=030
touch /home/z/my-project/supabase/migrations/${NEXT_NUM}_my_change_description.sql
```

---

## 8. Post-Deployment Verification Checklist

Run this checklist after EVERY deploy (including zero-downtime swaps). Skip nothing.

### 8.1 Health check

```bash
# Verify the new instance is healthy
curl -s https://yourdomain.com/api/health | bun -e "
const j=JSON.parse(await Bun.stdin.text());
console.log('status:', j.status, '| db:', j.db, '| timestamp:', j.timestamp);
if (j.status !== 'healthy' || j.db !== 'connected') {
  console.error('❌ UNHEALTHY');
  process.exit(1);
}
console.log('✅ healthy');
"
```

### 8.2 Smoke test the API

Run from your local machine (or the server):

```bash
# Login (production credentials — your real account)
curl -s -c /tmp/c-prod.txt -X POST https://yourdomain.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"your-real-email","password":"your-real-password"}' \
  -o /dev/null -w "login: %{http_code} (time: %{time_total}s)\n"

# Smoke test key GET endpoints
for path in \
  /api/auth/me \
  /api/dashboard \
  /api/products \
  /api/orders?status=pending \
  /api/inventory/dashboard \
  /api/customers \
  /api/integrations ; do
  code=$(curl -s -b /tmp/c-prod.txt -o /dev/null -w "%{http_code}" "https://yourdomain.com$path")
  printf "%-50s %s\n" "$path" "$code"
done
```

**Pass criteria:** every endpoint returns `200`. Any `500` → roll back (§5.2).

### 8.3 Verify UI rendering

Open the production URL in a browser and click through:

- [ ] Login page renders (no console errors)
- [ ] Dashboard loads with stats (orders, revenue, stock)
- [ ] Products → All Products renders the product list
- [ ] Orders → All Orders renders the order list
- [ ] Orders → Create Order — the customer autocomplete works (type a phone number)
- [ ] Inventory → Dashboard renders the stock value
- [ ] Settings → Integrations shows connected Leopard integration
- [ ] Audit Log shows recent entries

### 8.4 Verify cron jobs (within 1 hour of deploy)

The 5 cron jobs (defined in `vercel.json` — but on Hostinger, set up via cPanel Cron Jobs OR a systemd timer):

| Job | Schedule | Endpoint | What it does |
|---|---|---|---|
| Sync cities | Every 3 hours | `POST /api/cron/sync-cities` | Refreshes Leopard city list |
| Poll PostEx | Every 30 min | `POST /api/cron/poll-postex` | Pulls status updates from PostEx |
| Poll Leopard (safety net) | Every hour | `POST /api/cron/poll-leopard-safety-net` | Pulls status updates from Leopard |
| Generate scan reports | 1 AM daily | `POST /api/cron/generate-scan-reports` | Daily scan report PDFs |
| Refresh exchange rates | 2 AM daily | `POST /api/cron/refresh-exchange-rates` | Refreshes USD↔PKR rates |

Each must be called with the `X-Cron-Secret: $CRON_SECRET` header.

**Verify on Hostinger:**

```bash
# Trigger each cron manually:
for path in sync-cities poll-postex poll-leopard-safety-net generate-scan-reports refresh-exchange-rates; do
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "https://yourdomain.com/api/cron/$path" \
    -H "X-Cron-Secret: $CRON_SECRET")
  printf "%-40s %s\n" "$path" "$code"
done
```

**Pass criteria:** each returns `200`. `401` → cron secret is wrong. `500` → check `server.log`.

### 8.5 Verify file uploads work

```bash
# Upload a test logo (DELETE IT AFTER — don't pollute production)
curl -s -b /tmp/c-prod.txt -X POST https://yourdomain.com/api/companies/.../logo \
  -F "file=@/tmp/test-logo.png" \
  -w "upload: %{http_code}\n"
# 200 = upload worked, filesystem is writable
```

If this fails with `500`, the uploads directory isn't writable:

```bash
# On the server:
ls -ld /app/flowops/public/uploads/
# Should be owned by flowops:flowops and writable
chmod -R u+rwX /app/flowops/public/uploads/
chown -R flowops:flowops /app/flowops/public/uploads/
```

### 8.6 Verify PDF generation

```bash
# Trigger a self-fulfilled slip PDF for an existing order
curl -s -b /tmp/c-prod.txt "https://yourdomain.com/api/orders/<order-id>/self-fulfilled-slip" \
  -o /tmp/test-slip.pdf -w "slip: %{http_code} (size: %{size_download} bytes)\n"

# Verify it's a valid PDF
file /tmp/test-slip.pdf
# Should print: PDF document, version 1.x
```

If this fails, `@react-pdf/renderer` or `jsbarcode` has an issue (usually missing system libraries on the server):

```bash
# Install missing libs:
sudo apt install -y libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
```

### 8.7 Post-deploy checklist (copy this for every deploy)

- [ ] Health endpoint returns `200` + `db: connected`
- [ ] Login works (production credentials)
- [ ] All smoke-test endpoints return `200`
- [ ] No `5xx` errors in `server.log` since deploy
- [ ] Dashboard renders in browser (no console errors)
- [ ] At least one create/update operation succeeds (e.g., edit a customer's name)
- [ ] Audit log shows the edit from the previous step
- [ ] All 5 cron endpoints respond `200` when manually triggered
- [ ] File upload works (test logo or PDF slip generation)
- [ ] If a migration was applied: row counts match pre-migration backup
- [ ] Notify users (if downtime was visible) that the system is back

---

## 9. Monitoring Guide

### 9.1 What to watch on the server

#### `server.log` (live tail)

```bash
# SSH into the server
ssh flowops@your-hostinger-vps

# Tail the production server log
pm2 logs flowops-blue --lines 50

# OR if using a single instance:
tail -f /app/flowops/server.log
```

**Patterns to watch for:**

| Pattern | Meaning | Severity |
|---|---|---|
| `✓ Ready in` | Server started cleanly | ✅ OK |
| `GET /api/...` 200 | Normal traffic | ✅ OK |
| `GET /api/...` 4xx | Auth failures, not-found (normal) | ✅ OK |
| `GET /api/...` 5xx | Server-side exception | ❌ Investigate |
| `Error: ` | Unhandled exception | ❌ Investigate |
| `PrismaClientKnownRequestError` | DB constraint violation (usually app-layer bug) | ❌ Investigate |
| `PrismaClientInitializationError` | DB unreachable | 🚨 Critical |
| `ECONNREFUSED` | External API down OR DB unreachable | 🚨 Critical |
| `FATAL: max clients reached` | DB connection pool exhausted | ⚠️ High |
| `Worker exceeded memory limit` | Memory leak — restart server | ⚠️ High |

#### Auto-restart on crash

pm2 auto-restarts the process on crash. Verify:

```bash
pm2 status
# Should show "restarts: 0" — if restarts > 0, the server has been crashing
# Check pm2 logs for the crash reason
pm2 logs flowops-blue --err --lines 100
```

#### Memory + CPU

```bash
pm2 monit
# Or:
pm2 list
# Watch the "memory" column — should stay under 500 MB
# If it grows steadily over hours → memory leak
```

### 9.2 What to watch in Supabase Dashboard

#### Health

1. https://supabase.com → your production project
2. **Dashboard** → top of the page shows project status (Healthy / Paused / Restarting)

#### Database connections

1. **Database** → **Connection pooler**
2. Watch "Active connections" — should stay under 10 (free tier limit is 15)
3. If approaching 15: check for long-running queries, idle transactions, or query loops

#### Database size

1. **Settings** → **Database** → **Disk size**
2. Should grow slowly (orders + audit logs + scan reports grow ~10 MB/month for a small business)
3. If growing fast (> 100 MB in a day): investigate — likely a runaway audit log or uncleaned-up scan report

#### Slow queries

1. **Database** → **Query Performance** (or **Logs** → **Postgres logs**)
2. Sort by "Total time" — look for queries taking > 1 second
3. Common culprits:
   - Missing index (add one via migration)
   - Full table scan (add a `WHERE` clause or `LIMIT`)
   - N+1 query (batch the Prisma `findMany` with `include`)

#### API logs (auth + storage + realtime)

1. **Logs** → **API logs**
2. Watch for `401` spikes — could mean the encryption key is wrong (credentials can't decrypt)
3. Watch for `429` (rate limit) — Supabase free tier limits API calls

### 9.3 What to watch on the Leopard / PostEx side

#### Leopard API rate limits

If `POST /api/booking-workbench/book` starts returning `429`:

1. Check `/app/flowops/server.log` for the Leopard API response
2. Login to Leopard's merchant portal — check the API usage dashboard
3. If hitting the limit, throttle bookings (add a queue) OR upgrade the Leopard plan

#### PostEx polling

The PostEx poller runs every 30 minutes via cron. If statuses stop updating:

1. Check `/app/flowops/server.log` for `poll-postex` errors
2. Trigger the cron manually: `curl -X POST https://yourdomain.com/api/cron/poll-postex -H "X-Cron-Secret: $CRON_SECRET"`
3. Check PostEx dashboard — is the API token still valid?

### 9.4 Set up alerts (optional but recommended)

#### Uptime monitoring (free)

- Use **UptimeRobot** (free tier: 50 monitors, 5-minute interval)
- Monitor: `GET https://yourdomain.com/api/health`
- Alert on: status != 200 OR response time > 5s

#### Error rate monitoring

- Use **Sentry** (free tier: 5000 errors/month) — add to `next.config.js`:
  ```bash
  bun add @sentry/nextjs
  bunx @sentry/wizard@latest -i nextjs
  ```
- This captures every unhandled exception in `server.log` AND every browser-side error

#### Supabase内置 alerts

1. Supabase Dashboard → **Settings** → **Notifications**
2. Add alert for: "Database disk space > 80%"
3. Add alert for: "Project paused due to inactivity" (free tier)

### 9.5 Daily / weekly health checks

**Daily (1 minute):**

```bash
# Quick health check
curl -s -o /dev/null -w "health: %{http_code} (time: %{time_total}s)\n" https://yourdomain.com/api/health
```

**Weekly (10 minutes):**

- [ ] `pm2 status` — no crashes, memory stable
- [ ] Supabase Dashboard — DB connections < 10, disk usage < 60%
- [ ] `server.log` — no new error patterns since last week
- [ ] Manual smoke test: login, create test order (then immediately cancel), verify audit log
- [ ] Leopard + PostEx integrations responding (Settings → Integrations → Logs)
- [ ] Latest backup exists in Supabase Dashboard (auto-backup runs daily on Supabase Pro plan; manual on free tier)

---

## 10. Common Deployment Pitfalls

### 10.1 The `.env` file in the wrong directory

**Symptom:** `bun run start` fails with `URL must start with the protocol postgresql://`

**Cause:** `.env` is in `/app/flowops/.env` but the standalone server runs from `/app/flowops/.next/standalone/`. Next.js standalone doesn't copy `.env` to the standalone dir.

**Fix:** Either copy `.env` to `.next/standalone/.env`, OR run the server with the env vars loaded from the parent dir:

```bash
# Option A: copy .env to standalone
cp /app/flowops/.env /app/flowops/.next/standalone/.env

# Option B: use pm2 with --env-file
pm2 start ".next/standalone/server.js" --name flowops-blue \
  --cwd /app/flowops/.next/standalone \
  --env-file /app/flowops/.env
```

### 10.2 The dev `.env` was deployed to production

**Symptom:** Production app has test data, test users, test orders. Real orders are mixed with test data.

**Cause:** `git pull` brought in the dev `.env` (it shouldn't — `.env` is in `.gitignore` — but if someone forced-committed it, it can happen).

**Fix:**

1. **STOP** the production app immediately (`pm2 stop flowops-blue flowops-green`)
2. Overwrite `.env` with the production values
3. Restart the app
4. **Audit** the DB for any test data created between the bad deploy and the fix — manually delete test customers, orders, products (be careful)
5. **Rotate** all secrets (`SESSION_SECRET`, `CRON_SECRET`) — they leaked to git history
6. Add a pre-commit hook to prevent `.env` from being committed again:
   ```bash
   # In .git/hooks/pre-commit
   if git diff --cached --name-only | grep -q "^\.env$"; then
     echo "❌ .env is in .gitignore — refusing to commit"
     exit 1
   fi
   ```

### 10.3 The build ran out of memory

**Symptom:** `bun run build` fails with `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`

**Cause:** Next.js build uses ~1 GB RAM for a project this size. Hostinger VPS with 1 GB RAM is borderline.

**Fix:**

```bash
# Option A: increase Node heap size
NODE_OPTIONS="--max-old-space-size=1536" bun run build

# Option B: build on a different machine and copy .next/standalone/ to the server
# (build locally with NODE_ENV=production, then scp the .next/standalone/ folder)
scp -r .next/standalone/ flowops@your-server:/app/flowops/.next/

# Option C: upgrade the VPS plan (1 GB → 2 GB RAM)
```

### 10.4 Prisma client not generated after schema change

**Symptom:** App crashes with `Cannot read property 'findMany' of undefined` or `Unknown column X`

**Cause:** `schema.prisma` changed, but `bunx prisma generate` wasn't run.

**Fix:**

```bash
cd /app/flowops
bunx prisma generate
bun run build     # rebuild with the new client
./deploy.sh       # zero-downtime swap
```

### 10.5 Migration applied to DEV Supabase instead of PROD

**Symptom:** Production app fails after deploy — schema mismatch

**Cause:** You ran `psql "$DATABASE_URL" -f migration.sql` while `$DATABASE_URL` was set to DEV.

**Fix:**

1. **Verify** which DB you actually applied to:
   ```bash
   psql "$DATABASE_URL" -c "SELECT current_database();"
   ```
2. If DEV: apply to PROD via Supabase SQL Editor (§7.2)
3. If PROD by accident: roll back using the pre-migration backup (§5.4)
4. **Prevention:** Always use Supabase SQL Editor for production migrations (you have to log into the production Supabase project, which is a deliberate action)

### 10.6 Filesystem uploads lost after deploy

**Symptom:** Old courier slip PDFs / company logos disappear after a deploy

**Cause:** The uploads live in `public/uploads/` which is INSIDE the repo. A `git pull` + rebuild can overwrite them.

**Fix:**

1. **Before deploy**, snapshot the uploads:
   ```bash
   tar czf /app/backups/uploads-$(date +%Y%m%d).tar.gz /app/flowops/public/uploads/
   ```
2. **After deploy**, restore if missing:
   ```bash
   if [ ! -d /app/flowops/public/uploads/companies ]; then
     tar xzf /app/backups/uploads-*.tar.gz -C /
   fi
   ```
3. **Long-term fix:** symlink `public/uploads/` to a directory OUTSIDE the repo:
   ```bash
   mv /app/flowops/public/uploads /app/uploads
   ln -s /app/uploads /app/flowops/public/uploads
   chown -R flowops:flowops /app/uploads
   ```

### 10.7 The cron secret is wrong

**Symptom:** Cron jobs return `401 Unauthorized`

**Cause:** `.env` on the server has the old `CRON_SECRET`, but the cPanel cron jobs (or systemd timers) have the new one — or vice versa.

**Fix:**

1. Verify the secret in `.env`:
   ```bash
   grep CRON_SECRET /app/flowops/.env
   ```
2. Verify what the cron jobs are sending:
   ```bash
   # cPanel: Cron Jobs → view the command
   # systemd: cat /etc/systemd/system/flowops-cron-*.service
   ```
3. Make them match. Restart the app + cron.

### 10.8 HTTPS redirect loop

**Symptom:** Browser says "Too many redirects" when accessing `https://yourdomain.com`

**Cause:** nginx is forwarding HTTPS traffic to the Next.js server as HTTP, but Next.js thinks it should redirect to HTTPS — infinite loop.

**Fix:** Make sure nginx sends the `X-Forwarded-Proto` header (already in the config in §2.8):

```nginx
proxy_set_header X-Forwarded-Proto $scheme;
```

And in `next.config.js` (if not already there), trust the proxy:

```js
module.exports = {
  // ...
  experimental: {
    trustHostHeader: true,
  },
}
```

### 10.9 Deploying during peak traffic

**Symptom:** Users report 500 errors during the deploy window

**Cause:** Even with blue-green, the build step uses 1+ GB RAM — if the server is already at 80% memory from the live instance, the build can OOM-kill the live instance.

**Fix:**

- Build on a separate machine, copy `.next/standalone/` to the server (see §10.3 Option B)
- OR schedule deploys during low-traffic hours (2-4 AM PKT)
- OR upgrade the VPS to 4 GB RAM

### 10.10 pm2 doesn't restart on reboot

**Symptom:** Server rebooted (Hostinger maintenance, kernel update) and the app didn't come back up

**Fix:**

```bash
# Re-run the pm2 startup command
pm2 startup
# (it will print a command to run as root — copy + paste it)

# Save the current pm2 process list
pm2 save

# Verify:
sudo reboot
# (after reboot, wait 60s, then:)
ssh flowops@your-server
pm2 status
# Should show flowops-blue + flowops-green as "online"
```

---

## 11. Git Workflow for Deployment

### 11.1 Branch strategy

| Branch | Purpose | Merged into |
|---|---|---|
| `main` | Production-ready code. Always deployable. | — (deployed to Hostinger) |
| `dev` | Active development. May be broken. | `main` (after testing) |
| `feature/<task-id>` | One feature per branch. | `dev` (after PR review) |
| `hotfix/<task-id>` | Emergency fix for production. Branched from `main`. | `main` AND `dev` |

### 11.2 The DEV → git → production flow

```
┌──────────────────────────────────────────────────────────────────┐
│  DEV SANDBOX (this machine)                                        │
│                                                                    │
│   1. Make code changes in src/                                      │
│   2. Test on DEV server (./start.sh)                              │
│   3. Brute-force test (TESTING_GUIDELINES.md §3)                  │
│   4. Lint check (bun run lint — 0 errors required)               │
│   5. Commit to git on feature/<task-id> branch                    │
│   6. Push to GitHub: git push origin feature/<task-id>            │
│                                                                    │
│                    ↓ Pull request: feature → dev                    │
│                                                                    │
│   7. PR reviewed + merged into dev                                 │
│   8. Verify on DEV with the dev branch checked out                │
│   9. PR: dev → main                                                │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
                                  ↓
┌──────────────────────────────────────────────────────────────────┐
│  PRODUCTION (Hostinger VPS)                                        │
│                                                                    │
│   1. cd /app/flowops                                                │
│   2. ./deploy.sh  (does git pull + build + blue-green swap)       │
│   3. Apply any new migrations via Supabase SQL Editor             │
│   4. Run post-deploy verification checklist (§8)                   │
│   5. Watch server.log for 1 hour                                   │
│                                                                    │
│   ⚠️ NO test scripts, NO brute-force, NO seed data                  │
│   ⚠️ NO `bun run dev` — only `bun run build` + `bun run start`    │
│   ⚠️ NO direct DB edits — only via migrations or the app           │
└──────────────────────────────────────────────────────────────────┘
```

### 11.3 Commit message convention

Follow this format for every commit (so `git log` is readable + deploy notes are auto-generated):

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**

- `feat` — new feature (user-facing)
- `fix` — bug fix (user-facing)
- `refactor` — code change that neither fixes a bug nor adds a feature
- `perf` — performance improvement
- `docs` — documentation only
- `test` — adding tests
- `chore` — build, deps, config, etc.
- `migration` — database migration (must be paired with the SQL file)

**Examples:**

```
feat(orders): add bulk booking UI in workbench

Adds a multi-select checkbox to the Booking Workbench so users can
book 10+ orders at once. Uses the new /api/booking-workbench/book-batch
endpoint.

Refs: BOOKING-WORKBENCH-V2
```

```
fix(inventory): stock loss not recorded on damaged return

The return_scan source module was creating an InventoryTransaction
but not a StockLossRecord. This meant damaged returns weren't
appearing in the Losses & Write-offs view.

Adds insertStockLossRecord() call in src/lib/actions/order.actions.ts
when condition === 'damaged'.

Fixes: STOCKLOSS-INVESTIGATE issue #3
```

```
migration(stock-loss): add sourceModule column

Adds sourceModule TEXT column to StockLossRecord, backfills existing
rows with 'unknown', and adds a partial unique index
stock_loss_orderitem_dedup_idx to prevent duplicate loss records
for the same order item.

Tested on DEV: applied, brute-force run passed, verified no dupes.
```

### 11.4 Tagging releases

Tag every production deploy:

```bash
# On the dev sandbox (after merging dev → main):
git checkout main
git pull origin main
git tag -a v0.2.0-prod -m "Production deploy 2026-09-04: bulk booking + stock-loss fix"
git push origin v0.2.0-prod
```

On the server, you can deploy a specific tag:

```bash
cd /app/flowops
git fetch --tags
git checkout v0.2.0-prod
./deploy.sh
```

### 11.5 Hotfix workflow (production is broken)

When production is broken and needs a fix NOW:

```
main (broken) ──────────────────────────────────►
        \
         \─ hotfix/URGENT-issue-X ──► PR to main + dev
```

```bash
# On DEV sandbox:
git checkout main
git pull origin main
git checkout -b hotfix/URGENT-issue-X

# Make the fix (small, surgical — don't bundle other changes)
# Test on DEV
# Lint
# Commit + push
git push origin hotfix/URGENT-issue-X

# Open PR: hotfix/URGENT-issue-X → main
# Review + merge

# On production server:
cd /app/flowops
./deploy.sh    # Pulls main, which now has the hotfix

# Back on DEV:
git checkout dev
git merge main   # Bring the hotfix into dev
git push origin dev
```

### 11.6 What NEVER to commit

- ❌ `.env` (any environment)
- ❌ `node_modules/`
- ❌ `.next/` (build output)
- ❌ `db/custom.db` (SQLite file — should not exist in production anyway)
- ❌ `dev.log`, `server.log`
- ❌ `public/uploads/*` (user-uploaded files — only the directory itself)
- ❌ Production database credentials (in code, comments, or commit messages)
- ❌ `.DS_Store`, `Thumbs.db`, editor backup files

---

## 12. Emergency Procedures

### 12.1 If production breaks after a deploy

```bash
# 1. Roll back immediately (don't try to fix forward first)
cd /app/flowops
./deploy.sh    # Swaps to the previous (working) instance

# 2. Verify the rollback worked
curl https://yourdomain.com/api/health

# 3. Investigate on DEV what broke
# (ssh into dev sandbox, reproduce the bug, fix, test, redeploy)

# 4. Do NOT revert migrations — they're forward-only. Fix forward with a new migration.
```

### 12.2 If production DB is corrupted

```bash
# 1. Take the app offline IMMEDIATELY
pm2 stop flowops-blue flowops-green
# Put up a maintenance page in nginx

# 2. Restore from the latest Supabase backup
# (Supabase Dashboard → Settings → Database → Backups → Restore)

# 3. Verify the restore
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM \"Order\";"
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM \"Customer\";"

# 4. Restart the app
pm2 start flowops-blue flowops-green

# 5. Notify users of downtime + investigate root cause on DEV
```

### 12.3 If a migration fails on production

```bash
# 1. STOP — do not retry the migration
# 2. Check the error message in Supabase SQL Editor
# 3. Check the DB state — what got applied, what didn't:
psql "$DATABASE_URL" -c "\d <affected-table>"

# 4a. If the migration is salvageable (e.g., only the last statement failed):
#     Write a NEW migration (031_fix_my_broken_migration.sql) that
#     completes the work. Apply via Supabase SQL Editor.

# 4b. If the migration is fundamentally broken:
#     Restore the DB from the pre-migration backup (§5.4)
#     Write a NEW corrected migration. Test on DEV first. Apply to PROD.

# 5. NEVER modify the original migration file (it's already in git history)
# 6. NEVER try to "undo" a partial migration by running the reverse SQL
```

### 12.4 If credentials leak

If any of these leak (committed to git, posted in chat, visible in a screenshot):

| Secret | Action |
|---|---|
| `DATABASE_URL` (Supabase password) | Rotate Supabase DB password → update `.env` on Hostinger → restart app |
| `SESSION_SECRET` | Generate new secret → update `.env` → restart app → all users get logged out (acceptable) |
| `CRON_SECRET` | Generate new secret → update `.env` → update cPanel/systemd cron → restart app |
| `INTEGRATION_ENCRYPTION_KEY` | ⚠️ Tricky — rotating this invalidates all encrypted Leopard/PostEx credentials. Generate new key → update `.env` → in the app, re-connect Leopard + PostEx with fresh credentials (Settings → Integrations → Disconnect → Connect) |
| Leopard API key/secret | Rotate in Leopard merchant portal → re-connect in the app |
| PostEx token | Rotate in PostEx dashboard → re-connect in the app |

### 12.5 If the server is unreachable

```bash
# 1. Try SSH
ssh flowops@your-hostinger-vps
# If timeout → server is down (Hostinger maintenance?) → check Hostinger status page

# 2. If SSH works but app is down:
pm2 status
# If flowops-blue + flowops-green are both stopped:
pm2 restart flowops-blue flowops-green

# 3. If pm2 shows them as online but health endpoint fails:
pm2 logs flowops-blue --lines 50 --err
# Look for the error, fix, restart

# 4. If nginx is down:
sudo systemctl status nginx
sudo systemctl restart nginx

# 5. If the disk is full:
df -h
# Find the big files:
du -sh /var/log/* /app/flowops/server.log /app/flowops/public/uploads/* 2>/dev/null | sort -h
# Clean up:
sudo journalctl --vacuum-time=7d
truncate -s 0 /app/flowops/server.log
```

---

## 13. Deployment Quick Reference

### 13.1 First-time deploy (initial setup)

```bash
# On Hostinger VPS:
# 1. Provision server (§2.2)
# 2. Clone repo + install deps (§2.3)
# 3. Configure .env (§2.4 + §6)
# 4. Push schema (§2.5)
# 5. Apply migrations via Supabase SQL Editor (§7)
# 6. Build (§2.6)
# 7. Start with pm2 (§2.7)
# 8. Configure nginx + TLS (§2.8)
# 9. Verify health (§8.1)
# 10. First user onboarding (create org → company → owner)
# 11. Connect real Leopard integration
# 12. Sync cities
# 13. Import shippers
# 14. You're live!
```

### 13.2 Subsequent deploys (after DEV testing passes)

```bash
# On Hostinger VPS:
cd /app/flowops
./deploy.sh    # Zero-downtime blue-green swap (§3)

# If new migrations exist (deploy.sh will pause + tell you):
# Apply each via Supabase SQL Editor (§7)

# Run post-deploy verification (§8)
```

### 13.3 Emergency rollback

```bash
cd /app/flowops
./deploy.sh    # Swaps back to the previous instance
# If that doesn't fix it:
git checkout <last-known-good-commit>
bun install
bunx prisma generate
bun run build
./deploy.sh
```

### 13.4 Critical URLs (fill in for your deployment)

| What | URL |
|---|---|
| Production app | `https://yourdomain.com` |
| Health check | `https://yourdomain.com/api/health` |
| Supabase dashboard | `https://supabase.com/dashboard/project/[PROD-REF]` |
| Supabase SQL Editor | `https://supabase.com/dashboard/project/[PROD-REF]/sql/new` |
| Hostinger VPS panel | `https://hpanel.hostinger.com` |
| Leopard merchant portal | `https://www.leopardscourier.com/merchant/` |
| PostEx dashboard | `https://api.postex.pk/` (or your specific URL) |

### 13.5 Critical commands cheat sheet

```bash
# Server management
pm2 status                                  # Check process status
pm2 logs flowops-blue --lines 50            # Tail live logs
pm2 restart flowops-blue                    # Restart instance
pm2 monit                                   # Live CPU/memory monitor

# Deploy
cd /app/flowops && ./deploy.sh               # Zero-downtime deploy

# Health
curl -s https://yourdomain.com/api/health    # Quick health check

# DB
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM \"Order\";"
pg_dump "$DATABASE_URL" > /app/backups/backup-$(date +%Y%m%d).sql

# Nginx
sudo nginx -t                               # Test config
sudo systemctl reload nginx                 # Reload without dropping connections

# TLS
sudo certbot renew                          # Renew Let's Encrypt cert (set up as cron)
sudo certbot certificates                   # List all certs + expiry dates
```

---

## Appendix A — Migration checklist (for each new migration)

Before applying to production:

- [ ] Migration tested on DEV DB
- [ ] Migration is idempotent (`IF NOT EXISTS` / `CREATE OR REPLACE` / `DO $$ ... BEGIN ... END $$`)
- [ ] Migration doesn't drop any existing columns or tables
- [ ] Migration doesn't lock the database for extended periods (uses `CONCURRENTLY` for indexes)
- [ ] Backup taken before applying (§4.1)
- [ ] Applied via Supabase SQL Editor (not psql — easier to monitor)
- [ ] Verified after application (§4.3 — schema matches, functions exist, constraints pass)
- [ ] App still works after migration (§8 smoke tests pass)

## Appendix B — Code change checklist (for each new feature/fix)

Before deploying to production:

- [ ] Code tested on DEV sandbox (brute-force protocol — `TESTING_GUIDELINES.md` §3)
- [ ] `bun run lint` passes (0 errors)
- [ ] All module pages render (no 500s — `TESTING_GUIDELINES.md` §2.3)
- [ ] No runtime errors in `dev.log` (`TESTING_GUIDELINES.md` §2.5)
- [ ] No hardcoded dev credentials in code
- [ ] No `console.log` debug statements in production paths
- [ ] `NODE_ENV=production` doesn't break anything (run `bun run build` locally)
- [ ] Git committed with clear message (§11.3)
- [ ] No `.env` file committed to git
- [ ] If new env vars needed → documented in §6 of this guide
- [ ] If new migration needed → tested on DEV + added to Appendix A checklist

## Appendix C — Roles + responsibilities

| Who | What they do |
|---|---|
| **AI assistant (DEV sandbox)** | Develops + tests all changes on DEV. Commits to git. NEVER touches production. |
| **User (deploy day)** | Creates production Supabase project. Sets `.env` on Hostinger. Applies schema + migrations. Deploys the app. Creates the first (owner) account. Connects real Leopard/PostEx. NEVER shares production credentials in chat. |
| **User (subsequent deploys)** | SSH into Hostinger. Runs `./deploy.sh`. Applies migrations via Supabase SQL Editor. Runs post-deploy checklist. Watches `server.log` for 1 hour. |
| **User (emergency)** | Runs rollback (`./deploy.sh` or `git checkout <good-commit>`). Restores DB backup if needed. Rotates secrets if leaked. Notifies users of downtime. |

---

*End of PRODUCTION_DEPLOYMENT_GUIDE.md. This document is the single source of truth for deployment + development rules. Update it whenever the workflow changes — a stale deployment guide causes downtime and lost data.*
