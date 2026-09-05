# FlowOps ERP — Testing Guidelines (DEV Sandbox)

> **Audience** — developers + AI agents working on FlowOps in the dev sandbox before any code is pushed to production.
>
> **Goal** — every code change must pass this checklist before it is committed to git and definitely before it reaches the Hostinger production server. "It works on my machine" is not a deploy gate; "it passes the brute-force protocol" is.
>
> **Companion documents**:
> - `PRODUCTION_DEPLOYMENT_GUIDE.md` — what happens AFTER this guide passes (the prod side)
> - `FLOWOPS_BRIEFING.md` — architecture, module catalog, key systems
> - `INTERNAL_API_GUIDE.md` — every API route's contract
> - `DATABASE_GUIDE.md` — schema, functions, migrations
> - `FRONTEND_GUIDE.md` — routing, components, state
>
> **Last updated**: September 2026 (DOCS-TESTING-DEPLOY task)

---

## Table of Contents

1. [Sandbox Environment](#1-sandbox-environment)
2. [Pre-Deployment Testing Checklist](#2-pre-deployment-testing-checklist)
3. [Brute-Force Testing Protocol](#3-brute-force-testing-protocol)
4. [API Testing with curl](#4-api-testing-with-curl)
5. [Browser Testing with Agent Browser](#5-browser-testing-with-agent-browser)
6. [What NOT to Test in Production](#6-what-not-to-test-in-production)
7. [Common Test Data Setup](#7-common-test-data-setup)
8. [Error Detection](#8-error-detection)
9. [Performance Testing](#9-performance-testing)

---

## 1. Sandbox Environment

### 1.1 What this machine is

The dev sandbox is a Linux containerized workspace that runs the FlowOps Next.js 16 app in development mode against a **remote Supabase Postgres** instance (DEV project). It is NOT a production environment — it is for development, testing, and brute-force experimentation only.

| Component | Value |
|---|---|
| Working directory | `/home/z/my-project` |
| Runtime | Bun 1.3+ |
| Framework | Next.js 16 (Turbopack) |
| Database | Supabase Postgres (DEV project — test data only) |
| Dev server URL | `http://localhost:3000` |
| Dev server port | `3000` (hardcoded in `package.json` — `next dev -p 3000`) |
| Test login (existing dev seed) | `usman@flowops.pk` / `Test1234!` |

### 1.2 The `.env` reverts to SQLite on restart — known sandbox issue

**THIS IS THE #1 GOTCHA.** Every time the sandbox container restarts, the `.env` file at `/home/z/my-project/.env` reverts to:

```
DATABASE_URL=file:/home/z/my-project/db/custom.db
```

That is the OLD SQLite URL from when the project was first scaffolded. If you start the dev server in this state, Prisma will silently fall back to the empty SQLite file and **every API route will return 0 records or crash with "column does not exist"** — because the SQLite file has none of the Supabase schema.

**How to verify the current state:**

```bash
cat /home/z/my-project/.env
```

If you see `file:` → broken. If you see `postgresql://postgres.` → good.

### 1.3 How to fix the `.env` after a restart

Replace the contents of `.env` with the DEV Supabase connection string. Use the EXACT values below (do not add quotes, do not add `?pgbouncer=true`, do not add blank lines):

```bash
cat > /home/z/my-project/.env <<'EOF'
DATABASE_URL=postgresql://postgres.gobwxqkzfulbwhzbbsdj:123%40Usman123%40@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
DIRECT_URL=postgresql://postgres.gobwxqkzfulbwhzbbsdj:123%40Usman123%40@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
INTEGRATION_ENCRYPTION_KEY=1fbf4fd279d9476183566c878e38907764feac7e7843d16ac60065720a451951
SESSION_SECRET=flowops-session-secret-v1-change-in-production-please-32-chars-min
CRON_SECRET=flowops-cron-secret-v1-change-in-production
APP_URL=http://localhost:3000
EOF
```

Then clear any stale shell env vars (they can OVERRIDE the `.env` file):

```bash
unset DATABASE_URL
unset DIRECT_URL
```

Verify both are empty:

```bash
echo "DATABASE_URL=$DATABASE_URL"
echo "DIRECT_URL=$DIRECT_URL"
# Both should print empty
```

> ⚠️ **Note**: the `%40` in the password is the URL-encoded form of `@`. The Supabase password contains `@` characters and MUST be URL-encoded or the connection string is invalid. NEVER put a raw `@` in the URL.

### 1.4 The `start.sh` helper (handles the env fix automatically)

A helper script `start.sh` exists at the repo root. It runs `unset DATABASE_URL DIRECT_URL`, validates `.env` has a `postgresql://` URL (refuses to start if it still has `custom.db`), and then starts `bun run dev`:

```bash
cd /home/z/my-project
./start.sh
```

**Prefer `./start.sh` over `bun run dev` directly** — it catches the SQLite regression before the server starts.

### 1.5 The `predev` hook in `package.json`

`package.json` has a `predev` script that validates `.env` BEFORE `next dev` runs:

```json
"predev": "node -e \"const fs=require('fs');const e=fs.readFileSync('.env','utf8');if(e.includes('file:')||!e.includes('postgresql://')){console.error('❌ .env has invalid DATABASE_URL — must be postgresql://, not file:. Fix .env before starting.');process.exit(1);}console.log('✅ .env verified — using PostgreSQL');\""
```

If `.env` is broken, `bun run dev` (and therefore `./start.sh`) will exit with this error message and refuse to start. Fix `.env` and try again.

### 1.6 Starting + stopping the dev server

**Start (foreground, output to terminal — best for interactive testing):**

```bash
cd /home/z/my-project
./start.sh
# or, if you've manually unset env vars:
bun run dev
```

You should see within ~5 seconds:

```
✅ .env verified — using PostgreSQL
🚀 Starting FlowOps dev server...
▲ Next.js 16.1.x (Turbopack)
- Local: http://localhost:3000
✓ Ready in ~1s
```

Open `http://localhost:3000` in a browser or via `curl http://localhost:3000/api/health`.

**Stop:** press `Ctrl+C` in the terminal where `bun run dev` is running.

**Start in background (with dev.log output capture — for scripted testing):**

```bash
cd /home/z/my-project
unset DATABASE_URL DIRECT_URL
nohup ./node_modules/.bin/next dev -p 3000 > dev.log 2>&1 &
echo "server PID: $!"

# Wait for ready (poll health endpoint up to 40s)
for i in $(seq 1 40); do
  curl -s -o /dev/null --max-time 2 http://127.0.0.1:3000/api/health && break
  sleep 1
done
echo "server ready"
```

**Stop the background server:**

```bash
# Find the process listening on port 3000
lsof -ti:3000 | xargs -r kill -9
# Or by name:
pkill -f "next dev"
```

### 1.7 How to check `dev.log`

When you start the dev server in the background with `> dev.log 2>&1`, all stdout + stderr is captured to `/home/z/my-project/dev.log`. This file is your primary signal for runtime errors.

```bash
# Tail live while testing (run in a separate terminal):
tail -f /home/z/my-project/dev.log

# Check the last 100 lines after a test run:
tail -n 100 /home/z/my-project/dev.log

# Find all errors since the server started:
grep -E "(\[ERROR\]|Error:|TypeError|ReferenceError|PrismaClient)" /home/z/my-project/dev.log

# Find all 500-status responses (Next.js logs each request):
grep -E " (GET|POST|PATCH|DELETE) /api/" /home/z/my-project/dev.log | grep -E " 5[0-9]{2}"
```

See [§8 Error Detection](#8-error-detection) for the full grep cheat sheet.

### 1.8 Database connection limits

Supabase free tier limits **15 concurrent connections** on the session pooler (port 5432). If you open multiple dev server instances, multiple test scripts, or leave idle terminals running, you will hit `FATAL: max clients reached in session mode`.

**Recovery:**

```bash
pkill -f "next dev"        # Kill all dev servers
pkill -f "bun"              # Kill stray bun processes
sleep 60                    # Wait for connections to clear
./start.sh                  # Restart
```

---

## 2. Pre-Deployment Testing Checklist

Run this checklist **before EVERY `git push` to a branch that will reach production**. The full brute-force protocol in [§3](#3-brute-force-testing-protocol) is a superset — this checklist is the minimum bar.

### 2.1 Server starts cleanly (no compile errors)

```bash
cd /home/z/my-project
./start.sh
```

**Pass criteria:**

- [ ] Server prints `✓ Ready in ~Ns` (no compile errors)
- [ ] `http://localhost:3000/api/health` returns `200` with `{"status":"healthy","db":"connected",...}`
- [ ] `http://localhost:3000/` returns `200` (HTML — the app shell)

**Fail indicators:**

- ❌ `Failed to compile` in the terminal → fix the TypeScript / import error before continuing
- ❌ `Error: URL must start with the protocol postgresql://` → `.env` is broken, see [§1.3](#13-how-to-fix-the-env-after-a-restart)
- ❌ `prismaClientInitializationError` → DB unreachable; check Supabase project status + connection string

### 2.2 `bun run lint` passes (0 errors)

```bash
cd /home/z/my-project
bun run lint
```

**Pass criteria:**

- [ ] Exit code `0`
- [ ] Output ends with `✖ N problems (0 errors, N warnings)` — **0 errors is mandatory**; warnings are tolerated (the codebase has ~12 pre-existing warnings from `any` types in audit code)

**If lint fails:** fix the errors. Do NOT disable the rule with `// eslint-disable-next-line` unless absolutely necessary and documented in a comment.

### 2.3 All module pages render (no 500s)

The app is a single-page app with query-string navigation (see `FRONTEND_GUIDE.md` §2). Hitting the root URL renders the app shell; views are loaded client-side. To check that the SERVER can render every entry point, the simplest check is to verify the API routes that back each module return 200.

Quick smoke test (with cookie — see [§4.2](#42-step-1--login-and-save-the-cookie)):

```bash
# Smoke every read-only GET endpoint in sequence:
for path in \
  /api/auth/me \
  /api/dashboard \
  /api/products \
  /api/customers \
  /api/orders?status=pending \
  /api/orders/pending \
  /api/orders/backordered \
  /api/orders/ready-to-dispatch \
  /api/orders/awaiting-production \
  /api/orders/cancelled \
  /api/orders/returns \
  /api/inventory/dashboard \
  /api/inventory/summary \
  /api/inventory-locations \
  /api/suppliers \
  /api/purchase-orders \
  /api/production-orders \
  /api/stock-loss \
  /api/cycle-counts \
  /api/supplier-returns \
  /api/integrations \
  /api/employees \
  /api/roles \
  /api/payroll \
  /api/audit-logs \
  /api/workspaces ; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -b /tmp/cookies.txt "http://localhost:3000$path")
  printf "%-50s %s\n" "$path" "$code"
done
```

**Pass criteria:**

- [ ] Every endpoint returns `200` (or `404` only if the underlying route legitimately doesn't exist yet)
- [ ] NO endpoint returns `500` — `500` means a server-side exception, must be investigated before deploy

### 2.4 Key API endpoints respond 200

The minimum set that proves the system is alive end-to-end:

| Endpoint | Why it matters |
|---|---|
| `GET /api/health` | DB pool alive |
| `POST /api/auth/login` | Auth + sessions + bcrypt + Profile table |
| `GET /api/auth/me` | Session validation + workspace hydration |
| `GET /api/dashboard` | Multi-table joins (orders, inventory, audit, metrics) |
| `GET /api/inventory/summary` | Prisma aggregation across pools + locations |
| `GET /api/orders/pending` | Order queue + status filter |
| `GET /api/products` | Org-catalog join with company pricing |
| `GET /api/customers` | Customer table + phone normalization |
| `GET /api/integrations` | Encrypted credential read (encryption key valid) |

### 2.5 No runtime errors in `dev.log`

After running the smoke tests above, scan `dev.log`:

```bash
grep -E "(\[ERROR\]|Error:|TypeError|ReferenceError|PrismaClient|Unhandled|unhandledRejection)" /home/z/my-project/dev.log
```

**Pass criteria:**

- [ ] Zero matches (warnings about Turbopack / SWC are OK; actual errors are not)
- [ ] Zero `5xx` HTTP responses in the request log

---

## 3. Brute-Force Testing Protocol

The brute-force protocol is the systematic, end-to-end testing methodology used in this session. Each module is exercised through its full state machine — not just the happy path. The goal is to catch invariant violations (stock numbers, audit trail, status transitions) before they reach production.

### 3.1 Setup before any brute-force run

```bash
# 1. Ensure .env points at DEV Supabase (see §1.3)
cat /home/z/my-project/.env | head -n 1   # MUST start with postgresql://

# 2. Clear stale env vars
unset DATABASE_URL DIRECT_URL

# 3. Start the dev server in background with dev.log capture
cd /home/z/my-project
nohup ./node_modules/.bin/next dev -p 3000 > dev.log 2>&1 &

# 4. Wait for ready
for i in $(seq 1 40); do
  curl -s -o /dev/null --max-time 2 http://127.0.0.1:3000/api/health && break
  sleep 1
done

# 5. Login + save cookie (see §4.2 for the full sequence)
curl -s -c /tmp/cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"usman@flowops.pk","password":"Test1234!"}' \
  -o /dev/null -w "login: %{http_code}\n"
```

### 3.2 Product module

| Step | Action | Expected outcome |
|---|---|---|
| 1 | `POST /api/products` with `{name, sku, category_id, basePrice, baseCost}` | `201` — product created, returned with `id` |
| 2 | `GET /api/products/<id>` | `200` — product details render |
| 3 | `PATCH /api/products/<id>` — change `name` | `200` — name updated, `updatedAt` advanced |
| 4 | `POST /api/products/<id>/variants` — add a variant (e.g., size M) | `201` — variant created with generated SKU suffix |
| 5 | `POST /api/products/<id>/variants/<variantId>/override-price` with `{salePrice: 1999}` | `200` — `CompanyVariantPricing.salePrice` overwritten; `isPriceOverridden=true` |
| 6 | `POST /api/products` with the SAME `sku` as step 1 | `409` — duplicate SKU rejected |
| 7 | `PATCH /api/products/<id>/variants/<variantId>/toggle` with `{enabled: false}` | `200` — variant disabled; no longer appears in order-create dropdowns |

**Assertions to run after step 7:**

```bash
# Product + variant exist with the override flag set
curl -s -b /tmp/cookies.txt "http://localhost:3000/api/products/<id>" | bun -e "
const j=JSON.parse(await Bun.stdin.text());
console.log('product:', j.product.name);
const v=j.product.variants[0];
console.log('variant:', v.sku, '| overridden:', v.companyPricing?.[0]?.isPriceOverridden, '| price:', v.companyPricing?.[0]?.salePrice);
"
```

### 3.3 Inventory module

| Step | Action | Expected outcome |
|---|---|---|
| 1 | Get a `location_id` + `variant_id` (from §3.2 step 4) | — |
| 2 | `POST /api/inventory/adjust` with `{location_id, variant_id, delta: +50, reason: 'opening_stock', reference: 'BFRT-001'}` | `200` — `onHand` increased by 50, `InventoryTransaction` row created (type=`manual_in`) |
| 3 | `GET /api/inventory/summary?product_id=<pid>` — verify `onHand=50`, `avgCost` populated | — |
| 4 | `POST /api/inventory/adjust` with `{delta: -3, reason: 'damaged'}` | `200` — `onHand=47`; **a `StockLossRecord` row is created** (sourceModule=`adjust_stock`) |
| 5 | `GET /api/stock-loss?source=adjust_stock` | `200` — the loss record from step 4 is listed |
| 6 | `POST /api/inventory/transfers` with `{from_location_id, to_location_id, items: [{variant_id, quantity: 10}]}` | `200` — source pool `onHand` decreases by 10, target pool `onHand` increases by 10; **two** `InventoryTransaction` rows (`transfer_out` + `transfer_in`); `StockTransfer` row created |
| 7 | `GET /api/inventory/summary?product_id=<pid>` — verify totals unchanged (transfer is net-zero across pools) | Total `onHand` equals 47 (50 - 3 damaged), split across two pools |

**Pool consistency invariant** (the key check):

```bash
# Sum of onHand across all locations for a variant
curl -s -b /tmp/cookies.txt "http://localhost:3000/api/inventory/summary?product_id=<pid>" | bun -e "
const j=JSON.parse(await Bun.stdin.text());
for(const v of j.variants||[]) {
  const totalLocations = (v.locations||[]).reduce((s,l)=>s+l.onHand, 0);
  console.log('variant:', v.sku);
  console.log('  summary.totalOnHand:', v.totalOnHand);
  console.log('  sum of locations:  ', totalLocations);
  console.log('  MATCH:', v.totalOnHand === totalLocations ? '✓' : '❌ MISMATCH');
}
"
```

### 3.4 Order lifecycle

This is the most important brute-force run — it covers the full `Order.status` state machine and the stock-reservation side effects at every transition. Use a fresh variant with `onHand=20` (set in §3.3) before starting.

| Step | Action | Expected outcome |
|---|---|---|
| 1 | `POST /api/orders` — create an order with 2 units of the variant | `201` — order created with `status='pending'`; `OrderItem.status='pending'`; **inventory reserved** (`InventoryTransaction` type=`reserve`, pool `reserved` increased, `available` decreased) |
| 2 | `GET /api/inventory/summary?product_id=<pid>` — verify `reserved=2`, `available=18`, `onHand` unchanged at 20 | — |
| 3 | `POST /api/orders/<id>/cancel` | `200` — order `status='cancelled'`; **stock released** (transaction type=`release`, `reserved` back to 0) |
| 4 | `GET /api/inventory/summary?product_id=<pid>` — verify `reserved=0`, `available=20` | — |
| 5 | `POST /api/orders/<id>/un-cancel` | `200` — order back to `pending`; **stock re-reserved** (transaction type=`reserve`, `reserved=2`) |
| 6 | `POST /api/orders/<id>/confirm` (if two-step confirmation is enabled) | `200` — order `status='confirmed'` |
| 7 | `POST /api/orders/<id>/dispatch` (with a fake tracking number — set `courier_provider='self'` to skip the live booking API) | `200` — order `status='dispatched'`; **`onHand` decreases by 2** (transaction type=`dispatch_out`); `reserved` returns to 0 |
| 8 | `GET /api/inventory/summary?product_id=<pid>` — verify `onHand=18`, `reserved=0` | — |
| 9 | `POST /api/orders/<id>/returns` with `{items: [{order_item_id, quantity: 1, condition: 'perfect'}]}` | `200` — return recorded; **`onHand` increases by 1** (transaction type=`return_in`) |
| 10 | `GET /api/inventory/summary?product_id=<pid>` — verify `onHand=19` | — |
| 11 | Repeat step 9 with `condition: 'damaged'` for the remaining unit | `200` — return recorded; **`onHand` does NOT increase** (damaged items are written off); **a `StockLossRecord` row is created** (sourceModule=`return_scan`, damageType set, responsibleParty set) |
| 12 | `GET /api/stock-loss?source=return_scan` | `200` — the loss record from step 11 is listed |
| 13 | `GET /api/orders/<id>` — verify `status='returned'` or terminal per business rules | — |

### 3.5 Courier booking

Uses the Booking Workbench — exercised via the Leopard adapter.

| Step | Action | Expected outcome |
|---|---|---|
| 1 | `POST /api/booking-workbench/book` with `{order_id, courier_provider: 'leopard', pickup_address_id, ...}` | `200` — booking succeeds; `Order.trackingNumber` populated; `Order.courierStatus='booked'`; `IntegrationActionLog` row created (action=`book`) |
| 2 | `GET /api/orders/<id>` — verify `trackingNumber` is set | — |
| 3 | `GET /api/orders/<id>/self-fulfilled-slip` (if self-fulfilled) OR `GET /api/booking-workbench/load-sheet?ids=<order_id>` | `200` — PDF returned (`Content-Type: application/pdf`) |
| 4 | `POST /api/booking-workbench/book-batch` with `{order_ids: [id1, id2, id3, id4, id5]}` — bulk booking | `200` with `{results: [{order_id, success: true, tracking_number}...]}` — **every booking succeeds**; verify each order has a tracking number |

**Pre-requisite:** the Leopard integration must be connected (Settings → Integrations → Connect). In the dev sandbox, the integration is already configured with sandbox credentials — but the live Leopard API must be reachable from the sandbox. If bookings fail with `ECONNREFUSED` or `401`, check integration credentials + city sync (Settings → Integrations → Sync Cities).

### 3.6 Cancel flows

The order/courier cancellation matrix has several branches. Test each:

| Step | Action | Expected outcome |
|---|---|---|
| 1 | Create + book an order (§3.5 steps 1-2). Then `POST /api/orders/<id>/cancel` (internal cancel) | `200` — order `status='cancelled'`; stock released (if not yet dispatched); `Order.courierStatus='cancelled'`; **and** `POST /api/courier-cancel` is called internally → booking cancelled at Leopard; `IntegrationActionLog` row (action=`cancel_booking`) |
| 2 | Create + book a SECOND order. Then `POST /api/courier-cancel` directly (courier-only cancel — keep the order alive) | `200` — `Order.courierStatus='cancelled'`; `Order.status` unchanged (still `pending`); tracking number kept but flagged cancelled; `IntegrationActionLog` row created |
| 3 | Create + book + dispatch a THIRD order (`POST /api/orders/<id>/dispatch`). Then `POST /api/orders/<id>/cancel` | **Expected: `409`** — "Cannot cancel a dispatched order. Use RTO flow instead." If the API returns 200, the invariant is violated — file a bug |
| 4 | Take the cancelled order from step 1. `POST /api/orders/<id>/cancel` AGAIN | **Expected: `409`** — "Order already cancelled." If the API returns 200, idempotency is broken — file a bug |

### 3.7 Cross-module invariants

After any brute-force run that touches orders + inventory + returns, verify:

| Invariant | How to check |
|---|---|
| Customer stats auto-update | `GET /api/customers/<id>` — `totalOrders`, `totalSpent`, `lastOrderAt` reflect the orders just created/cancelled. If stale, the `backfill-stats` job or trigger is broken |
| Audit logs recorded | `GET /api/audit-logs?action=order.create&action=order.cancel&action=order.dispatch` — every state change has a corresponding audit row |
| Stock-loss linked | For each return with `condition='damaged'`, `GET /api/stock-loss?orderId=<id>` — a loss record exists with `sourceModule='return_scan'` and the correct `orderItemId` (not just a free-text `orderReferenceId`) |
| Idempotency keys dedupe | Repeat any POST with header `Idempotency-Key: <uuid>` — the second response should be the cached first response (status `200`, not `201`) |
| Workspace cache invalidates | After creating a product via API, immediately load the Products page in the browser — the new product should appear within 60s (the workspace cache TTL). If it never appears, the cache invalidation hook is broken |

---

## 4. API Testing with curl

### 4.1 Why curl

curl gives you a clean, repeatable, scriptable way to test API routes without browser overhead. Every endpoint can be exercised this way; the brute-force protocol in [§3](#3-brute-force-testing-protocol) is built on curl sequences.

### 4.2 Step 1 — login and save the cookie

FlowOps uses dual-channel auth: a signed `flowops_session` cookie (httpOnly) AND a `sessionToken` in the JSON response (for iframe contexts). For curl testing, the cookie is enough.

```bash
# Login — saves cookie jar to /tmp/cookies.txt
curl -s -c /tmp/cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"usman@flowops.pk","password":"Test1234!"}' \
  -o /tmp/login-response.json -w "login: %{http_code}\n"

# Verify the cookie file has the session cookie
grep flowops_session /tmp/cookies.txt
# Should print a line like:
# localhost  FALSE  /  FALSE  ...  flowops_session  <token>

# Verify the response includes sessionToken + workspace payload
bun -e "const j=JSON.parse(require('fs').readFileSync('/tmp/login-response.json','utf8')); console.log('user:', j.user?.fullName, '| org:', j.organization?.name, '| company:', j.activeCompany?.name, '| role:', j.employee?.roleName, '| elevated:', j.employee?.isElevated);"
```

### 4.3 Step 2 — make authenticated GET requests

```bash
# Reuse the cookie jar on every subsequent request:
curl -s -b /tmp/cookies.txt http://localhost:3000/api/auth/me | bun -e "
const j=JSON.parse(await Bun.stdin.text());
console.log('user:', j.user?.email, '| company:', j.activeCompany?.name);
"
```

### 4.4 Step 3 — make authenticated POST requests

```bash
# Create a customer:
curl -s -b /tmp/cookies.txt -X POST http://localhost:3000/api/customers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Customer",
    "phone": "+923001234567",
    "addresses": [{
      "line1": "House 12, Street 5",
      "city": "Lahore",
      "province": "Punjab",
      "country_code": "PK"
    }]
  }' \
  -w "\ncreate-customer: %{http_code}\n"
```

### 4.5 Step 4 — make authenticated PATCH requests

```bash
curl -s -b /tmp/cookies.txt -X PATCH http://localhost:3000/api/customers/<id> \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Customer Updated"}' \
  -w "\npatch-customer: %{http_code}\n"
```

### 4.6 Step 5 — make authenticated DELETE requests

```bash
# Delete a customer (only works if no orders reference them)
curl -s -b /tmp/cookies.txt -X DELETE http://localhost:3000/api/customers/<id> \
  -w "\ndelete-customer: %{http_code}\n"
```

### 4.7 Step 6 — Idempotency-Key header (for create operations)

POST routes that create resources or have external side effects (booking, dispatch, return, cancel) accept an `Idempotency-Key` header. If the same key is replayed within 24h, the original response is returned instead of executing again.

```bash
# Generate a UUID once, reuse it for retries:
KEY=$(uuidgen)

# First call — creates the order
curl -s -b /tmp/cookies.txt -X POST http://localhost:3000/api/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $KEY" \
  -d '{...}' -w "\nfirst: %{http_code}\n"

# Retry with same key — returns cached response, NOT a new order
curl -s -b /tmp/cookies.txt -X POST http://localhost:3000/api/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $KEY" \
  -d '{...}' -w "\nretry: %{http_code}\n"
# Both should return the SAME order ID
```

### 4.8 Useful curl flags

| Flag | What it does |
|---|---|
| `-s` | Silent (no progress bar) |
| `-b /tmp/cookies.txt` | Send cookies from jar |
| `-c /tmp/cookies.txt` | Save cookies to jar (login only) |
| `-X POST/PATCH/DELETE` | HTTP method (GET is default) |
| `-H "Content-Type: application/json"` | JSON body |
| `-H "Idempotency-Key: $KEY"` | Idempotency support |
| `-d '{...}'` | Request body |
| `-o /tmp/out.json` | Save response body to file |
| `-w "code: %{http_code} time: %{time_total}s\n"` | Print status + timing |
| `--max-time 30` | Timeout (seconds) |

### 4.9 Full example script — Order lifecycle in one shot

Save this as `/tmp/test-order-lifecycle.sh` and run with `bash /tmp/test-order-lifecycle.sh`:

```bash
#!/bin/bash
set -e
BASE="http://localhost:3000"

# Login
curl -s -c /tmp/c.txt -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"usman@flowops.pk","password":"Test1234!"}' -o /dev/null

# Get a variant ID with stock
VAR_ID=$(curl -s -b /tmp/c.txt "$BASE/api/inventory/summary" | bun -e "
const j=JSON.parse(await Bun.stdin.text());
const v=j.variants?.find(v=>v.totalOnHand>2);
console.log(v?.id||'');
")
echo "variant: $VAR_ID"

# Create order
ORDER_RESP=$(curl -s -b /tmp/c.txt -X POST "$BASE/api/orders" \
  -H "Content-Type: application/json" \
  -d "{
    \"customer_name\":\"Brute Force Test\",
    \"customer_phone\":\"+923000000000\",
    \"city\":\"Lahore\",
    \"items\":[{\"org_variant_id\":\"$VAR_ID\",\"quantity\":1,\"unit_price\":1000}]
  }")
ORDER_ID=$(echo "$ORDER_RESP" | bun -e "const j=JSON.parse(await Bun.stdin.text()); console.log(j.order?.id||j.id||'')")
echo "order: $ORDER_ID"

# Cancel
curl -s -b /tmp/c.txt -X POST "$BASE/api/orders/$ORDER_ID/cancel" -o /dev/null -w "cancel: %{http_code}\n"

# Un-cancel
curl -s -b /tmp/c.txt -X POST "$BASE/api/orders/$ORDER_ID/un-cancel" -o /dev/null -w "un-cancel: %{http_code}\n"

# Dispatch (self-fulfilled)
curl -s -b /tmp/c.txt -X POST "$BASE/api/orders/$ORDER_ID/dispatch" \
  -H "Content-Type: application/json" \
  -d '{"courier_provider":"self","tracking_number":"SF-TEST-001"}' \
  -o /dev/null -w "dispatch: %{http_code}\n"

# Verify stock decreased
curl -s -b /tmp/c.txt "$BASE/api/inventory/summary?variant_id=$VAR_ID" | bun -e "
const j=JSON.parse(await Bun.stdin.text());
console.log('onHand after dispatch:', j.totalOnHand, '| reserved:', j.totalReserved);
"
```

---

## 5. Browser Testing with Agent Browser

### 5.1 Why use the browser

curl can't catch:

- React hydration errors
- Client-side rendering bugs (Zustand state, TanStack Query cache)
- CSS / layout breakage
- Accessibility regressions (keyboard nav, ARIA)
- File download flows (PDF slip generation)

For these, use `agent-browser` — a Rust-based headless browser automation CLI.

### 5.2 Install + start

```bash
# Install (one-time)
npm install -g agent-browser
agent-browser install --with-deps
```

### 5.3 The four-step workflow

Every browser test follows the same pattern:

1. **Open** the page
2. **Snapshot** — get interactive elements with `@eN` refs
3. **Interact** — click/fill using refs
4. **Re-snapshot** — confirm the result (refs change after navigation!)

### 5.4 Login flow — full example

```bash
# Open the app
agent-browser open http://localhost:3000

# Wait for the auth shell to render
agent-browser wait --load networkidle

# Snapshot interactive elements (textbox + button)
agent-browser snapshot -i
# Output:
#   textbox "Email" [ref=e1]
#   textbox "Password" [ref=e2]
#   button "Sign in" [ref=e3]

# Fill the form (fill clears first, type doesn't)
agent-browser fill @e1 "usman@flowops.pk"
agent-browser fill @e2 "Test1234!"

# Click the sign-in button
agent-browser click @e3

# Wait for the dashboard to load
agent-browser wait --url "/?view=dashboard" --timeout 15000

# Verify we're logged in
agent-browser snapshot -i | head -n 20
# Should show sidebar nav items (Products, Inventory, Orders, etc.)
```

### 5.5 Navigate to a view

FlowOps uses query-string routing: `/?view=<name>&id=<id>&token=<token>`. To navigate, just open the URL.

```bash
# Go to Products view
agent-browser open "http://localhost:3000/?view=products"

# Go to a specific product detail
agent-browser open "http://localhost:3000/?view=product-detail&id=<product-id>"

# Go to Orders → Create Order
agent-browser open "http://localhost:3000/?view=order-create"

# Go to Inventory → Adjust Stock
agent-browser open "http://localhost:3000/?view=inv-adjust"
```

### 5.6 Click + fill a form (e.g., create a product)

```bash
# Open the create-product view
agent-browser open "http://localhost:3000/?view=product-create"
agent-browser wait --load networkidle

# Snapshot to find form fields
agent-browser snapshot -i
# Output:
#   textbox "Product name" [ref=e1]
#   textbox "SKU" [ref=e2]
#   combobox "Category" [ref=e3]
#   textbox "Base price" [ref=e4]
#   button "Save" [ref=e5]

agent-browser fill @e1 "Brute Force Test Product"
agent-browser fill @e2 "BFT-001"
agent-browser fill @e4 "1500"
# (select category from dropdown)
agent-browser click @e3
agent-browser wait --text "Apparel"
agent-browser press Escape

# Click save
agent-browser click @e5

# Wait for toast or redirect
agent-browser wait --text "Product created" --timeout 10000

# Screenshot for the record
agent-browser screenshot /tmp/test-product-create.png --full
```

### 5.7 Take a screenshot

```bash
# Visible viewport only
agent-browser screenshot /tmp/dashboard.png

# Full page (recommended — captures the whole form even if it scrolls)
agent-browser screenshot /tmp/order-create-full.png --full
```

### 5.8 Verify a UI element rendered

```bash
# Get the text of the page header
agent-browser get text @e1

# Get the count of products in the list
agent-browser get count "tr[data-product-id]"

# Check the page URL after a navigation
agent-browser get url
```

### 5.9 Reuse the auth state across sessions

Login once, save the cookies + localStorage, reuse on every subsequent browser run:

```bash
# After logging in (step 5.4)
agent-browser state save /tmp/flowops-auth.json

# Later — skip login entirely
agent-browser state load /tmp/flowops-auth.json
agent-browser open "http://localhost:3000/?view=dashboard"
```

### 5.10 Check for browser console errors

```bash
# View console messages (after a test run)
agent-browser console

# View uncaught page errors
agent-browser errors
```

Any `TypeError`, `ReferenceError`, or `Unhandled promise rejection` here is a bug — investigate before deploy.

---

## 6. What NOT to Test in Production

> Read this section twice. Then read it again before every production deploy.

### 6.1 NO test data

The production database starts EMPTY (only schema — no rows except the IntegrationProvider seed). The first user creates the org → company → owner via the onboarding wizard. After that, only real business data is in there.

**Never do these against production:**

- ❌ Create test customers (`POST /api/customers` with `"name":"Test Customer"`)
- ❌ Create test products (`POST /api/products` with `"sku":"TEST-001"`)
- ❌ Create test orders (`POST /api/orders` with fake phone numbers)
- ❌ Adjust stock to test values (`POST /api/inventory/adjust` with `delta:+50` "just to see")
- ❌ Connect test/sandbox Leopard credentials (the production account must use real credentials)
- ❌ Run `bun scripts/seed-default-roles.ts` against production (roles are auto-created by the onboarding wizard)

### 6.2 NO brute-force runs

The brute-force protocol in [§3](#3-brute-force-testing-protocol) is for DEV ONLY. Running it against production would:

- Create hundreds of fake orders + customers
- Move real stock with fake adjustments
- Book real courier shipments (which cost money)
- Cancel real orders to test the cancel flow
- Pollute the audit log with fake entries (impossible to cleanly separate from real activity)
- Possibly trigger real Leopard API rate limits

### 6.3 NO seed scripts

The repo contains seed/test scripts:

- `scripts/seed-default-roles.ts` — seeds default roles (super-admin, manager, etc.) for a company. The onboarding wizard does this automatically. NEVER run against production.
- `scripts/test-sprint2.sh`, `scripts/test-inventory.sh` — full brute-force scripts that register users, create orgs, push inventory. NEVER run against production.
- `scripts/cleanup.ts` — destroys data. NEVER run against production.
- `scripts/backfill-dispatch-inventory.ts` — one-time backfill. NEVER run against production unless explicitly approved (and only after a backup).

### 6.4 NO `bun run dev` on production

`bun run dev` runs Turbopack with hot reload + verbose logging + no caching + source maps. It is ~5-10× slower than the production build and not hardened. Production must use:

```bash
bun run build    # Compiles + bundles + outputs to .next/standalone/
bun run start    # Runs the standalone server (NODE_ENV=production)
```

### 6.5 NO `prisma db push` on production

`prisma db push` can drop columns and tables that have been removed from `schema.prisma` since the last push. On production, this is **data loss**. Use `prisma migrate` for schema changes (creates forward-only migration SQL files) — see `PRODUCTION_DEPLOYMENT_GUIDE.md` for the migration workflow.

### 6.6 NO direct DB edits

Never run raw `UPDATE`, `DELETE`, or `INSERT` against the production Supabase database via SQL Editor, psql, or any other client. All mutations must go through the app's API routes (which enforce permission checks, audit logs, and stock invariants). The only exception is applying a migration SQL file (which is reviewed + tested on DEV first).

---

## 7. Common Test Data Setup

When the dev sandbox has been reset (or you want a clean test run), set up the minimum data needed to exercise every module.

### 7.1 Reset the sandbox DB to clean state (DEV ONLY — never production)

```bash
# WARNING: This destroys ALL data in the DEV Supabase project.
# Only do this if you have a clean backup or you don't care about the test data.
cd /home/z/my-project

# 1. Drop all data (keeps schema)
bunx prisma db push --force-reset
# 2. Regenerate the client (schema may have changed)
bunx prisma generate
# 3. Re-apply SQL functions (migrations) — needed because db push only handles tables
psql "$DATABASE_URL" -f supabase/functions-only.sql
```

### 7.2 Register the owner + create the org + company

```bash
# Register the first user (becomes org owner)
curl -s -c /tmp/c.txt -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "fullName":"Usman Test",
    "email":"usman@flowops.pk",
    "password":"Test1234!",
    "confirmPassword":"Test1234!"
  }' -o /dev/null -w "register: %{http_code}\n"

# Create organization + first company
curl -s -b /tmp/c.txt -X POST http://localhost:3000/api/organizations/create \
  -H "Content-Type: application/json" \
  -d '{
    "org_name":"Test Org",
    "company_name":"Test Boutique",
    "base_currency":"PKR",
    "country_code":"PK",
    "province":"Punjab",
    "city":"Lahore",
    "timezone":"Asia/Karachi",
    "fiscal_year_start":1
  }' -o /dev/null -w "create-org: %{http_code}\n"
```

### 7.3 Create a product

```bash
# Get a category first (created by the catalog seed)
CAT_ID=$(curl -s -b /tmp/c.txt http://localhost:3000/api/categories | bun -e "
const j=JSON.parse(await Bun.stdin.text());
console.log(j.categories?.[0]?.id || '');
")

# Create the product
curl -s -b /tmp/c.txt -X POST http://localhost:3000/api/products \
  -H "Content-Type: application/json" \
  -d "{
    \"name\":\"Test T-Shirt\",
    \"sku\":\"TST-TS-001\",
    \"category_id\":\"$CAT_ID\",
    \"basePrice\":1500,
    \"baseCost\":800,
    \"fulfillment_type\":\"self_fulfilled\"
  }" -o /tmp/product.json -w "create-product: %{http_code}\n"

PRODUCT_ID=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/product.json','utf8')).product?.id||'')")
echo "product: $PRODUCT_ID"
```

### 7.4 Add a variant + set stock

```bash
# Create a variant (size M)
curl -s -b /tmp/c.txt -X POST "http://localhost:3000/api/products/$PRODUCT_ID/variants" \
  -H "Content-Type: application/json" \
  -d '{"sku_suffix":"M","attributes":{"size":"M"}}' \
  -o /tmp/variant.json -w "create-variant: %{http_code}\n"

VAR_ID=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/variant.json','utf8')).variant?.id||'')")
echo "variant: $VAR_ID"

# Get a location
LOC_ID=$(curl -s -b /tmp/c.txt http://localhost:3000/api/inventory-locations | bun -e "
const j=JSON.parse(await Bun.stdin.text());
console.log(j.locations?.[0]?.id||'');
")
echo "location: $LOC_ID"

# Add 100 units of stock (via opening-stock endpoint — sets initial onHand + avgCost)
curl -s -b /tmp/c.txt -X POST http://localhost:3000/api/inventory/opening-stock \
  -H "Content-Type: application/json" \
  -d "{
    \"location_id\":\"$LOC_ID\",
    \"items\":[{\"org_variant_id\":\"$VAR_ID\",\"quantity\":100,\"cost_per_unit\":800}]
  }" -o /dev/null -w "opening-stock: %{http_code}\n"
```

### 7.5 Create a customer

```bash
curl -s -b /tmp/c.txt -X POST http://localhost:3000/api/customers \
  -H "Content-Type: application/json" \
  -d '{
    "name":"Test Customer",
    "phone":"+923001234567",
    "addresses":[{
      "line1":"House 1, Street 1",
      "city":"Lahore",
      "province":"Punjab",
      "country_code":"PK"
    }]
  }' -o /tmp/customer.json -w "create-customer: %{http_code}\n"

CUSTOMER_ID=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/customer.json','utf8')).customer?.id||'')")
echo "customer: $CUSTOMER_ID"
```

### 7.6 Create an order

```bash
curl -s -b /tmp/c.txt -X POST http://localhost:3000/api/orders \
  -H "Content-Type: application/json" \
  -d "{
    \"customer_id\":\"$CUSTOMER_ID\",
    \"city\":\"Lahore\",
    \"items\":[{\"org_variant_id\":\"$VAR_ID\",\"quantity\":2,\"unit_price\":1500}],
    \"payment_type\":\"cod\",
    \"payment_amount\":3000
  }" -o /tmp/order.json -w "create-order: %{http_code}\n"

ORDER_ID=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/order.json','utf8')).order?.id||'')")
echo "order: $ORDER_ID"
```

### 7.7 Connect Leopard integration (already done in dev sandbox)

```bash
# Connect Leopard with sandbox credentials
curl -s -b /tmp/c.txt -X POST http://localhost:3000/api/integrations \
  -H "Content-Type: application/json" \
  -d '{
    "provider_key":"leopard",
    "credentials":{
      "api_key":"<sandbox-api-key>",
      "api_secret":"<sandbox-api-secret>"
    }
  }' -o /dev/null -w "connect-leopard: %{http_code}\n"

# Sync cities (so city autocomplete works in order create)
curl -s -b /tmp/c.txt -X POST http://localhost:3000/api/couriers/sync-cities \
  -H "Content-Type: application/json" \
  -d '{"provider_key":"leopard"}' \
  -o /dev/null -w "sync-cities: %{http_code}\n"
```

You are now ready to run the brute-force protocol in [§3](#3-brute-force-testing-protocol).

---

## 8. Error Detection

### 8.1 Where to look

| Source | File | What it shows |
|---|---|---|
| Next.js dev server | `/home/z/my-project/dev.log` (or terminal output if foreground) | All HTTP requests, server-side errors, Prisma queries, console.log output |
| Production server | `/home/z/my-project/server.log` (created by `bun run start` via `tee`) | Same as above but for production builds |
| Browser | DevTools Console (or `agent-browser console` + `agent-browser errors`) | Client-side errors, hydration warnings, network failures |
| Supabase | Dashboard → Logs → Postgres logs | DB-level errors (constraint violations, query timeouts) |
| Supabase | Dashboard → Logs → API logs | Pooler connection errors |

### 8.2 Patterns to grep for in `dev.log`

```bash
# 1. Any server-side exception
grep -E "(\[ERROR\]|Error:|TypeError|ReferenceError|PrismaClient)" /home/z/my-project/dev.log

# 2. Unhandled promise rejections (silent killers)
grep -E "(Unhandled|unhandledRejection|UnhandledPromise)" /home/z/my-project/dev.log

# 3. Prisma errors specifically (constraint violations, etc.)
grep -E "PrismaClient(Initialization|Known|Unknown)Error" /home/z/my-project/dev.log

# 4. 5xx HTTP responses in the request log
grep -E " (GET|POST|PATCH|DELETE) /api/" /home/z/my-project/dev.log | grep -E " 5[0-9]{2}"

# 5. 4xx HTTP responses (auth failures are expected; unexpected 4xx means a bug)
grep -E " (GET|POST|PATCH|DELETE) /api/" /home/z/my-project/dev.log | grep -E " 4[0-9]{2}"

# 6. Database connection issues
grep -E "(FATAL|connection refused|ECONNREFUSED|too many clients|max clients)" /home/z/my-project/dev.log

# 7. Hot-reload / compile errors
grep -E "(Failed to compile|Module not found|SyntaxError)" /home/z/my-project/dev.log

# 8. Migration errors (if running prisma commands)
grep -E "(migration|Migration)" /home/z/my-project/dev.log | grep -iE "error|fail"
```

### 8.3 Common errors + what they mean

| Error | Root cause | Fix |
|---|---|---|
| `URL must start with the protocol postgresql://` | `.env` reverted to SQLite OR stale shell env var | See [§1.3](#13-how-to-fix-the-env-after-a-restart) |
| `FATAL: max clients reached in session mode` | Supabase free-tier 15-connection limit hit | Kill stray processes: `pkill -f "next dev" && sleep 60` |
| `column X does not exist` | Schema drift — code references a column that's not in the DB | Run `bun run db:push && bun run db:generate` (DEV only) |
| `Cannot find module '@prisma/client'` | Prisma client not generated | `bun run db:generate` |
| `relation X does not exist` | Schema not pushed | `bun run db:push` |
| `PrismaClientKnownRequestError: P2002` | Unique constraint violation (duplicate SKU, email, etc.) | Application-layer bug — should be caught + returned as `409` |
| `PrismaClientKnownRequestError: P2025` | Record not found | Usually a missing `404` check; application bug if returned as `500` |
| `Error: Invalid enum value` | Schema/code mismatch on an enum field | Run `bun run db:push && bun run db:generate` |
| `TypeError: Cannot read property 'X' of null` | Code accessed `.X` on a nullable Prisma result without checking | Application bug — fix the null check |
| `TypeError: e.className.split is not a function` | Usually a TanStack Query deserialization issue | Check the API response shape — likely the route is returning a string where the client expects JSON |
| `hydration mismatch` (browser) | Server-rendered HTML doesn't match client-rendered HTML | Usually a date / locale / random-value render mismatch; wrap in `useEffect` |
| `ECONNREFUSED 127.0.0.1:3000` | Dev server isn't running | `./start.sh` |
| `fetch failed` (when calling Leopard/PostEx) | External API down OR sandbox network blocked | Test with `curl -v https://<courier-api-url>/health` |

### 8.4 Turn on verbose Prisma logging (DEV only)

Add to `.env` temporarily:

```bash
# In .env (DEV ONLY — remove before deploy):
# LOG_LEVEL=debug
# QUERY_LOGGING=true
```

Or pass on the command line:

```bash
# Show every SQL query Prisma runs (very noisy — DEV only)
DEBUG=prisma:query ./start.sh
```

### 8.5 Verify the audit log records every mutation

```bash
# After any brute-force run, check that audit log entries exist for every action
curl -s -b /tmp/c.txt "http://localhost:3000/api/audit-logs?limit=50" | bun -e "
const j=JSON.parse(await Bun.stdin.text());
for(const e of j.logs||[]) {
  console.log(e.createdAt, '|', e.action, '|', e.entityType, '|', e.entityId);
}
"
```

Every create/update/delete on a business entity (Order, Product, Customer, InventoryPool, etc.) should have a corresponding row. If any are missing, the route's `insertAuditLog()` call was skipped — that's a bug.

---

## 9. Performance Testing

### 9.1 Why measure

FlowOps is a multi-tenant ERP with customers in Pakistan. The Supabase region is `ap-south-1 (Mumbai)` — closest to Pakistan. API latency targets are:

| Endpoint type | Target | Hard ceiling |
|---|---|---|
| Auth check (`GET /api/auth/me`) | < 200 ms | 1 s |
| Cached list endpoints (`GET /api/products`, `/api/customers`, `/api/orders?status=...`) | < 500 ms (warm) | 2 s |
| Cold cache (first load after restart) | < 2 s | 5 s |
| Heavy aggregations (`GET /api/dashboard`, `/api/inventory/summary`, `/api/orders/revenue-summary`) | < 1 s (warm) | 3 s |
| Mutations (`POST /api/orders`, `POST /api/inventory/adjust`) | < 1 s | 3 s |
| External API calls (`POST /api/booking-workbench/book` to Leopard) | < 5 s | 15 s |

### 9.2 Measure API latency with `curl -w`

The `curl -w` flag writes a format string to stdout after the request. Useful timing fields:

| Variable | Meaning |
|---|---|
| `%{http_code}` | HTTP status code |
| `%{time_namelookup}` | DNS resolution |
| `%{time_connect}` | TCP connect |
| `%{time_appconnect}` | TLS handshake |
| `%{time_pretransfer}` | All pre-transfer steps |
| `%{time_starttransfer}` | Time-to-first-byte (TTFB) — **most important** |
| `%{time_total}` | Total request time |

### 9.3 Measure a single endpoint

```bash
# Measure the dashboard endpoint (heavy aggregation)
curl -s -b /tmp/c.txt http://localhost:3000/api/dashboard \
  -o /dev/null \
  -w "code: %{http_code} | ttfb: %{time_starttransfer}s | total: %{time_total}s\n"
```

### 9.4 Measure cold vs warm cache

The first request after a dev-server restart hits cold cache (Prisma client init, JIT compilation, etc.). The second request is warm.

```bash
echo "=== COLD (first request after restart) ==="
curl -s -b /tmp/c.txt http://localhost:3000/api/dashboard -o /dev/null \
  -w "cold  → ttfb: %{time_starttransfer}s | total: %{time_total}s\n"

echo "=== WARM (subsequent requests) ==="
for i in 1 2 3 4 5; do
  curl -s -b /tmp/c.txt http://localhost:3000/api/dashboard -o /dev/null \
    -w "warm$i → ttfb: %{time_starttransfer}s | total: %{time_total}s\n"
done
```

### 9.5 Measure a battery of endpoints

```bash
echo "endpoint                                            ttfb     total    code"
echo "-------------------------------------------------- -------- -------- ----"
for path in \
  /api/auth/me \
  /api/dashboard \
  /api/products \
  /api/orders?status=pending \
  /api/inventory/dashboard \
  /api/inventory/summary \
  /api/customers \
  /api/integrations \
  /api/audit-logs ; do
  result=$(curl -s -b /tmp/c.txt "http://localhost:3000$path" -o /dev/null \
    -w "%{time_starttransfer} %{time_total} %{http_code}")
  ttfb=$(echo $result | cut -d' ' -f1)
  total=$(echo $result | cut -d' ' -f2)
  code=$(echo $result | cut -d' ' -f3)
  printf "%-50s %6.3fs %6.3fs %s\n" "$path" "$ttfb" "$total" "$code"
done
```

### 9.6 Interpret results

- **TTFB > 2 s on a warm request** → DB query is slow. Check the Prisma query (likely missing an index, or N+1 query). Run `EXPLAIN ANALYZE` on the raw SQL in Supabase SQL Editor.
- **Total time ≈ TTFB + small delta** → server is the bottleneck, not the network.
- **Total time >> TTFB** → response body is large. Add pagination (`?limit=50`) or field selection.
- **`500` status** → server-side exception. Investigate `dev.log`.
- **`502`/`503` status** → server crashed or DB unreachable. Check health endpoint.
- **Same endpoint has wildly different times across runs (> 2× variance)** → DB connection pool exhaustion. Check Supabase dashboard for active connections; consider switching to transaction pooler (port 6543).

### 9.7 Compare against the perf baseline

A baseline file exists at `/home/z/my-project/perf-baseline.md` and `/home/z/my-project/perf-results.md` — compare your run against these numbers. Significant regressions (> 2× the baseline TTFB) should be flagged before deploy.

### 9.8 Load testing (optional — for major releases)

For major releases (new module, schema change), run a 60-second load test:

```bash
# Requires Apache Bench (ab) — install with: sudo apt install apache2-utils
# Extract the session cookie value
COOKIE=$(grep flowops_session /tmp/c.txt | awk '{print $7}')

# Hammer the dashboard endpoint with 20 concurrent requests for 60s
ab -n 1000 -c 20 -H "Cookie: flowops_session=$COOKIE" \
  http://localhost:3000/api/dashboard

# Look for:
# - Requests per second (should be > 5 for the dashboard)
# - 99th percentile latency (should be < 3s)
# - Failed requests (should be 0)
# - Any non-2xx / non-4xx responses (5xx = crash)
```

---

## Appendix A — Quick reference card

| What | Value |
|---|---|
| Dev server URL | `http://localhost:3000` |
| Health endpoint | `GET /api/health` |
| Test login (existing dev seed) | `usman@flowops.pk` / `Test1234!` |
| Start dev server | `./start.sh` (foreground) or `nohup ./node_modules/.bin/next dev -p 3000 > dev.log 2>&1 &` (background) |
| Stop dev server | `Ctrl+C` (foreground) or `pkill -f "next dev"` (background) |
| Check `dev.log` | `tail -f /home/z/my-project/dev.log` |
| Lint | `bun run lint` (0 errors required) |
| DB push (DEV only) | `bun run db:push` |
| Generate Prisma client | `bun run db:generate` |
| Cookie jar (after login) | `/tmp/cookies.txt` (or `/tmp/c.txt`) |
| Browser test tool | `agent-browser` (see [§5](#5-browser-testing-with-agent-browser)) |

## Appendix B — Test data IDs cheat sheet

After running [§7 Common Test Data Setup](#7-common-test-data-setup), save these IDs to `/tmp/test-ids.env` for reuse in test scripts:

```bash
cat > /tmp/test-ids.env <<'EOF'
PRODUCT_ID=<fill-in>
VARIANT_ID=<fill-in>
LOCATION_ID=<fill-in>
CUSTOMER_ID=<fill-in>
ORDER_ID=<fill-in>
EOF

# Source in any test script:
source /tmp/test-ids.env
echo "Testing with product=$PRODUCT_ID variant=$VARIANT_ID"
```

---

*End of TESTING_GUIDELINES.md. Update this document whenever the testing workflow changes — a stale testing guide produces false confidence and missed regressions.*
