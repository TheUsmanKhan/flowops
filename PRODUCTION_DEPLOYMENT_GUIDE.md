# FlowOps ERP — Master Deployment, Database & Development Guide

> **SINGLE SOURCE OF TRUTH** — Keep this document updated whenever infrastructure or workflow changes.  
> **Target Domain:** https://op.muzammaldatabase.com  
> **GitHub Repository:** `git@github.com:TheUsmanKhan/flowops.git` (Branch: `main`)  
> **Last Updated:** 2026-09-04  

---

## 🏗️ 1. ARCHITECTURE OVERVIEW

```
┌─────────────────────────────────────────────────────────────┐
│                 LOCAL WORKSPACE (Your Mac)                  │
│                                                             │
│  .env → DEV Supabase Database (Dummy / Testing Data)       │
│  • Make code changes & bug fixes                            │
│  • Test with local dev/prod server (`bun run start`)        │
│  • Run brute-force tests & build verification               │
│  • SSH Key: ~/.ssh/id_ed25519_usman                         │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼ git push origin main
┌─────────────────────────────────────────────────────────────┐
│                    GITHUB REPOSITORY                        │
│                 TheUsmanKhan/flowops                        │
│                                                             │
│  • Clean application code only                              │
│  • ZERO secrets / ZERO database passwords (.env ignored)    │
│  • Both bun.lock & package-lock.json maintained             │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼ Pull / Webhook
┌─────────────────────────────────────────────────────────────┐
│                HOSTINGER CLOUD (Production)                 │
│              https://op.muzammaldatabase.com                │
│                                                             │
│  Environment Variables → NEW Production Supabase DB         │
│  • Framework: Next.js (Node 22.x)                           │
│  • Clean live database (Real users, orders, money)          │
│  • 100% isolated from development machine                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚨 2. GOLDEN RULES (NON-NEGOTIABLE)

### Rule 1: Two Databases — NEVER Mix Them
| Property | Development Database (Local) | Production Database (Hostinger) |
|---|---|---|
| **Environment** | Local Mac / Dev Testing | Hostinger Live Server |
| **Supabase Project** | `gobwxqkzfulbwhzbbsdj` | `phketufsvxqghkdgixli` |
| **Data Type** | Test users, fake products, test orders | REAL users, REAL customers, REAL revenue |
| **Connection Location** | Local `.env` file | Hostinger Environment Variables |
| **Rule** | NEVER connect live code here | NEVER run test scripts or seeds here |

### Rule 2: Local Changes NEVER Affect Production Directly
- Changing code on your Mac has **0% impact** on Hostinger.
- Hostinger only updates when code is verified locally, committed, and pushed to GitHub `main`.

### Rule 3: Database URL Encoding (`@` in Passwords)
- If a database password contains `@` (e.g. `123@Shinein123@`), it **MUST** be URL-encoded as `%40` (`123%40Shinein123%40`).
- Failing to encode `@` causes PostgreSQL connection strings to split incorrectly, crashing Prisma.

---

## 🗄️ 3. DATABASE CONFIGURATIONS

### A. Development / Testing Database (Used in local `.env`)
```env
DATABASE_URL="postgresql://postgres.gobwxqkzfulbwhzbbsdj:123%40Usman123%40@aws-0-ap-south-1.pooler.supabase.com:5432/postgres"
DIRECT_URL="postgresql://postgres.gobwxqkzfulbwhzbbsdj:123%40Usman123%40@aws-0-ap-south-1.pooler.supabase.com:5432/postgres"
```

### B. Production Database (Configured on Hostinger)
- **Supabase Project Ref:** `phketufsvxqghkdgixli`
- **Region:** `aws-0-ap-south-1` (Mumbai)
- **Password (raw):** `123@Shinein123@`
- **Password (encoded for URL):** `123%40Shinein123%40`
- **Port:** `5432` (Session Pooler)
- **Schema Status:** 68 tables synchronized via Prisma + migrations 025, 026, 028, 029 applied.
```env
DATABASE_URL=postgresql://postgres.phketufsvxqghkdgixli:123%40Shinein123%40@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
DIRECT_URL=postgresql://postgres.phketufsvxqghkdgixli:123%40Shinein123%40@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
```

---

## ⚙️ 4. HOSTINGER PRODUCTION SETTINGS

### Build Settings
| Setting Name | Exact Value | Notes |
|---|---|---|
| **Framework preset** | `Next.js` | Auto-detected |
| **Branch** | `main` | Production branch |
| **Node version** | `22.x` | Modern LTS |
| **Root directory** | `./` | Root of repository |
| **Build command** | `npm run build` | Builds standalone Next.js bundle |
| **Package manager** | `npm` | `package-lock.json` is committed |
| **Output directory** | `.next` | Default Next.js output |

### Hostinger Environment Variables (Key-Value Pairs)
Enter these in the **"Set environment variables"** section:

1. **`DATABASE_URL`**
   ```text
   postgresql://postgres.phketufsvxqghkdgixli:123%40Shinein123%40@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   ```
2. **`DIRECT_URL`**
   ```text
   postgresql://postgres.phketufsvxqghkdgixli:123%40Shinein123%40@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   ```
3. **`INTEGRATION_ENCRYPTION_KEY`**
   ```text
   1fbf4fd279d9476183566c878e38907764feac7e7843d16ac60065720a451951
   ```
   *(Must match across dev and prod so encrypted courier credentials decrypt correctly)*
4. **`APP_URL`**
   ```text
   https://op.muzammaldatabase.com
   ```
5. **`NODE_ENV`**
   ```text
   production
   ```
6. **`SESSION_SECRET`**
   ```text
   flowops-production-session-secret-live-32c
   ```
7. **`CRON_SECRET`**
   ```text
   flowops-cron-secret-live-production
   ```
8. **`ENABLE_IN_PROCESS_POLLER`**
   ```text
   true
   ```

---

## 💻 5. LOCAL DEVELOPMENT & GIT WORKFLOW

### A. SSH Key for GitHub
This Mac has multiple GitHub accounts. This repository specifically uses `TheUsmanKhan`'s key:
```bash
git config core.sshCommand "ssh -i ~/.ssh/id_ed25519_usman -o IdentitiesOnly=yes"
```
Verify authentication anytime with:
```bash
ssh -i ~/.ssh/id_ed25519_usman -o IdentitiesOnly=yes -T git@github.com
# Expected output: Hi TheUsmanKhan! You've successfully authenticated...
```

### B. Standard Feature / Bug Fix Routine
1. Make code changes in local files (`src/`, `prisma/`, etc.).
2. Test against local Dev Database:
   - Run dev server: `bun run dev` (or `npm run dev`)
   - Test production build: `npm run build` and `bun run start`
   - Test health check: `curl http://localhost:3000/api/health`
3. Check git status to ensure `.env` and `.pid` are never staged:
   ```bash
   git status
   ```
4. Commit and push:
   ```bash
   git add -A
   git commit -m "feat/fix: description of change"
   git push origin main
   ```
5. Hostinger automatically rebuilds or user triggers redeploy.

---

## 🔄 6. DATABASE MIGRATION PROTOCOL

If a feature requires a schema change (e.g., new table, column, index):
1. Update `prisma/schema.prisma`.
2. Generate client: `bunx prisma generate`.
3. Push to DEV DB first:
   ```bash
   bunx prisma db push
   ```
4. If a custom SQL migration is needed:
   - Create `supabase/migrations/0XX_description.sql` (numbering continues from 030+).
   - Test SQL on Dev DB first.
   - Apply to Production DB via Supabase SQL Editor or `pg` script.
5. Commit and push code.

---

## 🛠️ 7. KNOWN GOTCHAS & TROUBLESHOOTING

| Issue | Cause | Permanent Fix Implemented |
|---|---|---|
| **`Cannot find package '@next/bundle-analyzer'`** | `NODE_ENV=production` causes npm to omit `devDependencies`. | Removed `@next/bundle-analyzer` from `next.config.mjs` and moved build packages (`tailwindcss`, `typescript`, `@types/*`) into `dependencies`. |
| **Prisma DB Connection Refused / Invalid URL** | Password had raw `@` which broke URL parser. | Encoded `@` as `%40` in all connection strings (`123%40...`). |
| **Missing `package-lock.json`** | Repo only had `bun.lock`, causing npm builds on Hostinger to resolve ad-hoc. | Generated and committed `package-lock.json` so npm builds are deterministic and fast. |
| **GitHub Push Permission Denied** | Default SSH key was pointing to another user (`noorekhas01-dotcom`). | Configured `core.sshCommand` to use `~/.ssh/id_ed25519_usman`. |
| **Leopard Bulk Booking Fails** | Leopard API requires `special_instructions`. | Added fallback to `itemDescription` in `bookOrderWithCourier` so notes are never empty. |
