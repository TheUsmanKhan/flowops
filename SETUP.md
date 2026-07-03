# FlowOps — Local Setup Guide

A production-grade, multi-tenant SaaS ERP for Pakistani e-commerce businesses.
Built with Next.js 16, TypeScript, Tailwind CSS, shadcn/ui, Prisma, and Supabase Postgres.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Get the Project Files](#2-get-the-project-files)
3. [Install Dependencies](#3-install-dependencies)
4. [Configure Environment](#4-configure-environment)
5. [Set Up the Database](#5-set-up-the-database)
6. [Run the Dev Server](#6-run-the-dev-server)
7. [Use the App](#7-use-the-app)
8. [Useful Scripts](#8-useful-scripts)
9. [Project Structure](#9-project-structure)
10. [Troubleshooting](#10-troubleshooting)
11. [Architecture Notes](#11-architecture-notes)

---

## 1. Prerequisites

Install these on your PC (one-time setup).

### Node.js 20+

Download from <https://nodejs.org/> and install the LTS version.

Verify:

```bash
node --version   # should print v20.x or higher
npm --version
```

### Bun (recommended, faster than npm)

Install Bun — it's a drop-in replacement for npm that's significantly faster:

**macOS / Linux:**
```bash
curl -fsSL https://bun.sh/install | bash
```

**Windows (PowerShell):**
```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

**Windows (npm fallback):**
```powershell
npm install -g bun
```

Verify:
```bash
bun --version
```

> You can use `npm` for every command in this guide — just replace `bun` with `npm` and `bunx` with `npx`.

### Supabase Account

You need a Supabase project with a Postgres database. Sign up at <https://supabase.com> if you don't have one. This project uses:

- **Database host:** `aws-0-ap-northeast-1.pooler.supabase.com`
- **Port:** `5432` (session-mode pooler — required for Prisma transactions)
- **Database user:** `postgres.flafcggvqfgyafzekxzk`
- **Database password:** `123@Usman123@`

---

## 2. Get the Project Files

The full project lives in the workspace at `/home/z/my-project`. Copy these folders and files to a local directory (e.g. `C:\Users\YourName\flowops` on Windows, or `~/flowops` on macOS/Linux):

### Copy these (keep the structure):

```
src/                    # all application code
prisma/                 # database schema
public/                 # static assets
package.json
tsconfig.json
next.config.ts
tailwind.config.ts
postcss.config.mjs
eslint.config.mjs
components.json
next-env.d.ts
```

### Skip these (regenerated or sandbox-only):

```
node_modules/           # reinstall with bun install / npm install
.next/                  # build output, regenerated
db/                     # old SQLite db, not needed (we use Supabase)
dev.log                 # dev server log
Caddyfile               # sandbox gateway config
examples/               # sandbox demos
skills/                 # sandbox AI skills
upload/                 # sandbox uploads
download/               # sandbox downloads
tool-results/           # sandbox tool output
```

> Create a fresh `.env` file in the project root (see Step 4).

---

## 3. Install Dependencies

Open a terminal in your project folder and run:

```bash
# With Bun (recommended)
bun install

# OR with npm
npm install
```

This installs Next.js 16, React 19, Prisma, shadcn/ui, Tailwind CSS, Zustand, TanStack Query, React Hook Form, Zod, and all other dependencies listed in `package.json`.

---

## 4. Configure Environment

Create a file named `.env` in the **project root** (same folder as `package.json`) with the following content:

```env
# FlowOps — Supabase Postgres
# Session-mode pooler (port 5432) — supports Prisma interactive transactions
DATABASE_URL="postgresql://postgres.flafcggvqfgyafzekxzk:123%40Usman123%40@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"

# Same session pooler — used by Prisma for migrations / db push
DIRECT_URL="postgresql://postgres.flafcggvqfgyafzekxzk:123%40Usman123%40@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"

# Session signing secret (HMAC cookie sessions)
# Change this to a random 32+ character string for production
SESSION_SECRET="flowops-dev-secret-change-in-production-32b"
```

### ⚠️ Critical notes

1. **Keep the `%40` encoding in the password.** The `@` character in `123@Usman123@` must be URL-encoded as `%40`, otherwise Prisma will fail to parse the connection string.

2. **Use port 5432, not 6543.** The transaction-mode pooler on port 6543 (with `?pgbouncer=true`) does **not** support Prisma interactive transactions and will crash the server on multi-write operations. The session-mode pooler on port 5432 works correctly.

3. **Don't set `DATABASE_URL` in your shell.** Shell environment variables override the `.env` file. If you have a stale `DATABASE_URL` set globally, unset it before running the dev server:
   ```bash
   # macOS / Linux
   unset DATABASE_URL
   unset DIRECT_URL

   # Windows PowerShell
   Remove-Item Env:DATABASE_URL
   Remove-Item Env:DIRECT_URL
   ```

4. **Never commit `.env` to git.** Add it to `.gitignore`.

---

## 5. Set Up the Database

Push the Prisma schema to your Supabase Postgres database. This creates all 10 tables with their relations, unique constraints, and indexes:

```bash
bun run db:push
# or: npx prisma db push
```

You should see:

```
🚀 Your database is now in sync with your Prisma schema. Done in ~5s
```

Then generate the Prisma client (this creates the typed database client used throughout the app):

```bash
bun run db:generate
# or: npx prisma generate
```

### Tables created

The schema (`prisma/schema.prisma`) defines these 10 tables:

| Table | Purpose |
|---|---|
| `Profile` | Registered users (email, password hash, name) |
| `Organization` | Top-level tenant (umbrella for companies) |
| `Company` | Legal operating entity (all business data lives here) |
| `Role` | Company-scoped roles (system elevated + custom) |
| `RolePermission` | Permission keys assigned to custom roles |
| `Employee` | Employment records (one user can have many, per company) |
| `Invitation` | Token-based email invitations to join a company |
| `UserSetting` | Active workspace context + preferences per user |
| `AuditLog` | Immutable append-only event log |
| `MetricEvent` | Raw numeric events for future KPI dashboards |

### Resetting the database (⚠️ destructive)

If you ever want a completely fresh database (deletes all data):

```bash
bun run db:reset
```

---

## 6. Run the Dev Server

```bash
bun run dev
# or: npm run dev
```

You should see:

```
▲ Next.js 16.1.3 (Turbopack)
- Local:        http://localhost:3000
✓ Ready in ~1s
```

Open **<http://localhost:3000>** in your browser.

> The first page load takes ~8-10 seconds while Turbopack compiles the routes. Subsequent loads are instant.

---

## 7. Use the App

### Option A — Use the existing test account

An account is already set up in the database from our verification:

- **Email:** `usman@flowops.pk`
- **Password:** `Test1234!`

This account is already onboarded with a company called "Usman Commerce". Just sign in and you'll land on the dashboard.

### Option B — Register a fresh account

1. On the login screen, click **"Create an account"**
2. Fill in your full name, email, and password (min 8 characters)
3. You'll be taken through the **3-step onboarding wizard**:
   - **Step 1 — Organization:** Enter an organization name (umbrella for your companies)
   - **Step 2 — Company:** Enter company name, NTN/STRN, province, city, address
   - **Step 3 — Review:** Confirm and click "Create workspace"
4. You become the **Owner** of a new company. Four system roles are seeded automatically: Owner, Founder, Co-Founder, Investor (all elevated).

### Features you can test

| Feature | Where to find it |
|---|---|
| Dashboard (KPI cards, recent activity, quick actions) | Landing page after login |
| Employee directory (search, filter by status/role) | Sidebar → **Employees** |
| Invite an employee by email | Employees → **Invite employee** button |
| View employee detail (role, department, status) | Click any employee row |
| Suspend / terminate / reactivate an employee | Employee detail → **Employment status** |
| Roles & Permissions management | Sidebar → **Roles & Permissions** |
| Create a custom role with granular permissions | Roles → **New role** |
| Edit role permissions (24 keys across 8 modules) | Roles → **Edit** |
| Switch between companies (if you have multiple) | Navbar → workspace dropdown (top-left) |
| Company settings (tax info, address, currency) | Sidebar → **Settings** → Company settings |
| Organization overview | Sidebar → **Organization** |
| Immutable audit log (filterable, paginated) | Sidebar → **Audit Log** |
| Personal settings | Sidebar → **Settings** |
| Sign out | Navbar → user menu (top-right) → **Sign out** |

### Testing the invitation flow

To test accepting an invitation:

1. Sign in as `usman@flowops.pk`
2. Go to **Employees → Invite employee**
3. Invite a second email you control (e.g. `colleague@example.com`)
4. Register a new account with that email
5. On the new account's onboarding screen, the pending invitation will appear — accept it to join "Usman Commerce" as the assigned role

---

## 8. Useful Scripts

| Command | What it does |
|---|---|
| `bun run dev` | Start the dev server on <http://localhost:3000> |
| `bun run build` | Create a production build |
| `bun run start` | Run the production build |
| `bun run lint` | Check code quality with ESLint |
| `bun run db:push` | Push schema changes to Supabase |
| `bun run db:generate` | Regenerate the Prisma client (after schema changes) |
| `bun run db:reset` | ⚠️ Drop & recreate all tables (loses all data) |

---

## 9. Project Structure

```
flowops/
├── prisma/
│   └── schema.prisma              # 10-table multi-tenant schema
├── src/
│   ├── app/
│   │   ├── page.tsx               # Single SPA route (view router)
│   │   ├── layout.tsx             # Root layout + providers
│   │   ├── globals.css            # Emerald-primary design system
│   │   └── api/                   # All REST API routes
│   │       ├── auth/              # register, login, logout, me, forgot/reset
│   │       ├── onboarding/        # create-company, invitations, accept-invite
│   │       ├── workspace/         # switch active company
│   │       ├── employees/         # list, invite, detail, terminate
│   │       ├── roles/             # list, create, update, delete
│   │       ├── audit-logs/        # paginated audit trail
│   │       ├── company/           # company settings get/patch
│   │       └── dashboard/         # KPI overview
│   ├── components/
│   │   ├── auth/                  # Login, Register, Forgot, Reset forms
│   │   ├── onboarding/            # Wizard, selector, invite card
│   │   ├── layout/                # Sidebar, Navbar, WorkspaceSwitcher
│   │   ├── dashboard/             # Dashboard home
│   │   ├── employees/             # Directory, invite, detail
│   │   ├── roles/                 # Roles list, editor, permission selector
│   │   ├── settings/              # Org, company, personal, audit views
│   │   └── ui/                    # shadcn/ui components
│   ├── lib/
│   │   ├── db.ts                  # Prisma client
│   │   ├── session.ts             # HMAC signed-cookie sessions
│   │   ├── auth.ts                # scrypt password hashing
│   │   ├── workspace.ts           # getWorkspace, hasPermission, requirePermission
│   │   ├── permissions.ts         # 24 permission keys across 8 modules
│   │   ├── audit.ts               # insertAuditLog helper
│   │   ├── metrics.ts             # insertMetricEvent helper
│   │   ├── session-payload.ts     # builds full session response
│   │   ├── slugify.ts             # URL-safe slug generator
│   │   ├── types.ts               # shared TypeScript types
│   │   ├── api-client.ts          # frontend fetch helpers
│   │   └── validations/           # Zod schemas (auth, company, employee, invitation)
│   ├── stores/
│   │   └── app-store.ts           # Zustand: session + SPA view routing
│   └── hooks/
├── .env                           # Supabase credentials (create this)
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

Your `.env` file isn't being loaded. Fixes:

- Make sure `.env` is in the **project root** (same folder as `package.json`), not in a subfolder.
- Restart the dev server after creating/editing `.env`.
- Don't set `DATABASE_URL` in your shell — it overrides the `.env` file. Unset it:
  ```bash
  unset DATABASE_URL DIRECT_URL   # macOS/Linux
  Remove-Item Env:DATABASE_URL, Env:DIRECT_URL   # Windows
  ```

### Connection refused / can't reach Supabase

- Confirm your PC has internet access.
- Check that your Supabase project isn't **paused** (free-tier projects auto-pause after ~1 week of inactivity). Wake it from the Supabase dashboard: <https://supabase.com/dashboard>
- Verify the pooler host and port: `aws-0-ap-northeast-1.pooler.supabase.com:5432`

### Prisma crashes on multi-write operations (transactions)

You're probably using the transaction-mode pooler (port 6543 with `?pgbouncer=true`). Switch to the **session-mode pooler on port 5432** (no `pgbouncer` param) in your `.env`. See [Step 4](#4-configure-environment).

### "A pending invitation already exists for this email"

An invite was already sent to that email. Either:
- Use a different email, or
- Revoke the existing invitation from the Supabase dashboard (Table Editor → `Invitation` table → set `status` to `revoked`), or
- Run `bun run db:reset` to wipe all data (⚠️ destructive).

### Forgot password flow doesn't send an email

By design — the sandbox had no outbound SMTP, so the `/api/auth/forgot-password` endpoint records the request but doesn't actually send email. The UI shows a "check your email" confirmation regardless.

To enable real email recovery, wire the endpoint to an email provider:
- **Resend:** <https://resend.com>
- **SendGrid:** <https://sendgrid.com>
- **Supabase Auth's `resetPasswordForEmail`:** if you migrate to Supabase Auth

The file to edit is `src/app/api/auth/forgot-password/route.ts`.

### Port 3000 already in use

Edit `package.json` and change the dev script:
```json
"dev": "next dev -p 3001 2>&1 | tee dev.log"
```
Or run with a custom port:
```bash
bunx next dev -p 3001
```

### "Cannot find module '@prisma/client'"

You need to generate the Prisma client after installing dependencies:
```bash
bun run db:generate
```

### Changes to `prisma/schema.prisma` aren't reflected

After editing the schema, always run:
```bash
bun run db:push      # apply changes to the database
bun run db:generate  # regenerate the typed client
```
Then restart the dev server.

### TypeScript errors on `bun run build`

The `next.config.ts` has `typescript.ignoreBuildErrors: true`, so builds won't fail on type errors. For type-checking during development, run:
```bash
bunx tsc --noEmit
```

---

## 11. Architecture Notes

### Single SPA route

The app lives on a single route (`/`). Navigation between "pages" (dashboard, employees, roles, etc.) is handled client-side by a Zustand store (`src/stores/app-store.ts`) using a `route` state object. This keeps the app always reachable from the root URL.

### Multi-tenant isolation

Enforced in the **application layer** (since Prisma doesn't have Postgres RLS):

- `getWorkspace()` in `src/lib/workspace.ts` resolves the caller's active company from their session.
- `hasPermission(ctx, key)` checks the user's role permissions (elevated roles bypass all checks).
- `requirePermission(ctx, key)` throws a 403 if the user lacks the permission.
- Every company-scoped API route resolves the active company from the session — **never** from client input.

### Authentication

HMAC-signed cookies (no external auth service). See `src/lib/session.ts`:
- `createSessionToken(userId)` — creates `userId.timestamp.hmac`
- `verifySessionToken(token)` — validates the HMAC and checks expiry (30 days)
- Passwords are hashed with Node's built-in `scrypt` (`src/lib/auth.ts`)

### Audit logging

Every mutating API route calls `insertAuditLog()` from `src/lib/audit.ts`. The `AuditLog` table is **append-only** — no update or delete operations are exposed. This is the foundation for the future KPI system.

### Permissions

24 permission keys across 8 modules, defined as typed constants in `src/lib/permissions.ts`:

- Inventory (view, create, adjust, delete)
- Orders (view, create, fulfill, cancel)
- Employees (view, invite, terminate, manage)
- Finance (view, manage)
- Reports (view, export)
- Settings (company view/edit, roles manage)
- Integrations (view, manage)
- KPI & Audit (view, manage, audit view)

Never hardcode permission strings — always import from `src/lib/permissions.ts`.

### Database connection

Prisma + Supabase Postgres, using the **session-mode pooler** (port 5432). The transaction-mode pooler (port 6543 + PgBouncer) doesn't support Prisma's interactive transactions, so all multi-write operations use sequential `await` calls instead of `db.$transaction()`.

---

## Quick Start (TL;DR)

```bash
# 1. Install deps
bun install

# 2. Create .env (see Step 4)

# 3. Push schema to Supabase + generate client
bun run db:push
bun run db:generate

# 4. Start dev server
bun run dev
```

Open <http://localhost:3000> → sign in with `usman@flowops.pk` / `Test1234!` → or register a new account.

---

**Built with:** Next.js 16 · React 19 · TypeScript 5 · Tailwind CSS 4 · shadcn/ui · Prisma 6 · Supabase Postgres · Zustand · TanStack Query · React Hook Form · Zod · Sonner · date-fns · Lucide

**FlowOps** — the operating system for Pakistani e-commerce.
