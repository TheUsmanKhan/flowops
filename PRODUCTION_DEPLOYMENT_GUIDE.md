# FlowOps ERP — Production Deployment Guide & Development Safety Rules

> **CRITICAL DOCUMENT** — Read this BEFORE deploying to Hostinger or making any changes after deployment.
> Last Updated: 2026-09-04

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
- On Hostinger (production), the `.env` will be set once and persist
- **DEV .env**: points to DEV Supabase (current credentials)
- **PRODUCTION .env**: points to PRODUCTION Supabase (new credentials — set on Hostinger)
- **NEVER** commit `.env` to git (it's in `.gitignore`)

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
- Only after DEV testing passes, changes are deployed to Hostinger production
- **NEVER** make code changes directly on the Hostinger server
- **NEVER** run `bun run dev` on Hostinger — use `bun run build` + `bun run start`

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

### Step 3: Configure Hostinger
1. Deploy the Next.js app to Hostinger (VPS or shared hosting with Node.js)
2. Set environment variables in Hostinger panel:
   ```
   DATABASE_URL=postgresql://postgres.[prod-ref]:[prod-password]@...
   DIRECT_URL=postgresql://postgres.[prod-ref]:[prod-password]@...
   INTEGRATION_ENCRYPTION_KEY=[same key as dev — 64-char hex]
   SESSION_SECRET=[NEW strong secret — 32+ chars — different from dev]
   CRON_SECRET=[NEW strong secret — different from dev]
   APP_URL=https://yourdomain.com
   NODE_ENV=production
   ```
3. Build: `bun run build`
4. Start: `bun run start`
5. Verify: visit `https://yourdomain.com/api/health` → should return `{"status":"healthy","db":"connected"}`

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

### Development Session Workflow (what you + I do):

1. **User requests a change** → I implement on DEV sandbox
2. **I test on DEV** → brute-force test, lint, verify
3. **I commit to git** → code is version-controlled
4. **User deploys to Hostinger** → `git pull` → `bun run build` → `bun run start`
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
4. ❌ Never modify production `.env` (user does this on Hostinger)
5. ❌ Never run `prisma db push` on production (schema-destructive)
6. ❌ Never apply a migration to production without testing on DEV first

### What I (AI) WILL do:
1. ✅ Develop + test all changes on the DEV sandbox
2. ✅ Write migrations as idempotent SQL (IF NOT EXISTS)
3. ✅ Test migrations on DEV DB before declaring them ready
4. ✅ Commit all changes to git with clear commit messages
5. ✅ Provide exact commands for the user to run on Hostinger
6. ✅ Flag any breaking changes that require special deployment steps

### What the USER must do:
1. 🔧 Create the production Supabase project
2. 🔧 Set production `.env` on Hostinger (I'll provide exact values)
3. 🔧 Apply schema + migrations to production DB (I'll provide exact SQL)
4. 🔧 Deploy the app on Hostinger (build + start)
5. 🔧 Create the first (owner) account with real credentials
6. 🔧 Connect real Leopard/PostEx credentials in the production app
7. 🔧 NEVER share production database credentials in chat
8. 🔧 Backup production DB before applying any migration

---

## 📦 DEPLOYMENT COMMANDS (for Hostinger)

### Initial Deployment:
```bash
# On Hostinger server:
git clone [repo-url] /app/flowops
cd /app/flowops
bun install
bunx prisma generate

# Set production .env (via Hostinger panel or nano .env)
# ... set DATABASE_URL, DIRECT_URL, etc. ...

# Push schema to production DB (FIRST TIME ONLY)
bunx prisma db push

# Apply SQL migrations (via Supabase SQL Editor — paste each file)
# 001 through 029

# Build for production
bun run build

# Start the production server
bun run start
```

### Subsequent Updates (when I make changes):
```bash
# On Hostinger server:
cd /app/flowops
git pull origin main
bun install  # if package.json changed
bunx prisma generate  # if schema.prisma changed

# If new migrations exist, apply them via Supabase SQL Editor

# Rebuild + restart
bun run build
# Restart the server process (pm2 restart / systemctl restart / etc.)
```

### Database Backup (BEFORE any migration):
```bash
# Via Supabase Dashboard:
# Settings → Database → Backup → Create backup

# OR via pg_dump:
pg_dump "postgresql://postgres.[prod-ref]:[prod-password]@..." > backup-$(date +%Y%m%d).sql
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

### PRODUCTION (.env on Hostinger — user fills in):
```
DATABASE_URL=postgresql://postgres.[PROD-PROJECT-REF]:[PROD-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
DIRECT_URL=postgresql://postgres.[PROD-PROJECT-REF]:[PROD-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
INTEGRATION_ENCRYPTION_KEY=1fbf4fd279d9476183566c878e38907764feac7e7843d16ac60065720a451951
SESSION_SECRET=[NEW-STRONG-SECRET-32-CHARS-MIN-GENERATE-A-NEW-ONE]
CRON_SECRET=[NEW-STRONG-SECRET-GENERATE-A-NEW-ONE]
APP_URL=https://yourdomain.com
NODE_ENV=production
```

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
