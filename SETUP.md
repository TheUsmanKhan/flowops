# FlowOps ERP — Bulletproof Setup Guide (macOS & Windows)

> **Goal:** Set up FlowOps on your local machine with a **permanent, unbreakable** connection to the Supabase database — no lost connections, no SQLite fallback, no stale env vars.

---

## ⚠️ THE #1 ISSUE THIS GUIDE PREVENTS

The `.env` file keeps reverting to an old SQLite URL (`file:.../custom.db`). This happens because:
1. The project was originally initialized with SQLite
2. Some build scripts overwrite `.env` with the SQLite default
3. Shell environment variables get "stuck" with the old value

**This guide permanently fixes all three causes.**

---

## Step 1: Install Prerequisites

### macOS
```bash
# Install Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Node.js + Git + Bun
brew install node git
curl -fsSL https://bun.sh/install | bash

# Close and reopen terminal, then verify
node -v   # v20+
bun -v    # 1.1+
git -v
```

### Windows (WSL2 — recommended)
```powershell
# In PowerShell as Admin:
wsl --install
# Restart PC, open Ubuntu terminal, then:
sudo apt update && sudo apt install -y nodejs npm git
curl -fsSL https://bun.sh/install | bash
# Close and reopen terminal
```

### Windows (Native)
```powershell
# Install from websites:
# - Git: https://git-scm.com/download/win
# - Node.js 20 LTS: https://nodejs.org
# - Bun: 
powershell -c "irm bun.sh/install.ps1 | iex"
```

---

## Step 2: Clone & Enter the Project

```bash
git clone <your-repo-url> flowops
cd flowops
```

---

## Step 3: CREATE THE `.env` FILE (CRITICAL — DO NOT SKIP)

Create a file named exactly **`.env`** in the project root (same folder as `package.json`).

### ⚠️ DO NOT use quotes around the URLs
### ⚠️ DO NOT add `?pgbouncer=true` or any query parameters
### ⚠️ DO NOT leave any blank lines or spaces

**Copy and paste EXACTLY this content:**

```env
DATABASE_URL=postgresql://postgres.flafcggvqfgyafzekxzk:123%40Usman123%40@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres
DIRECT_URL=postgresql://postgres.flafcggvqfgyafzekxzk:123%40Usman123%40@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres
```

### Verify the `.env` file:
```bash
cat .env
```

You should see EXACTLY:
```
DATABASE_URL=postgresql://postgres.flafcggvqfgyafzekxzk:123%40Usman123%40@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres
DIRECT_URL=postgresql://postgres.flafcggvqfgyafzekxzk:123%40Usman123%40@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres
```

**If you see `file:/...custom.db` — you did not save the file correctly. Delete it and recreate it.**

---

## Step 4: CLEAR STALE SHELL ENVIRONMENT VARIABLES (CRITICAL)

Your terminal may have old `DATABASE_URL` values "stuck" in memory from a previous session. These **override** the `.env` file and will break everything.

### macOS / Linux / WSL:
```bash
unset DATABASE_URL
unset DIRECT_URL

# Verify they're empty (should print nothing):
echo "DATABASE_URL=$DATABASE_URL"
echo "DIRECT_URL=$DIRECT_URL"
```

### Windows (PowerShell):
```powershell
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:DIRECT_URL -ErrorAction SilentlyContinue

# Verify:
echo $env:DATABASE_URL
echo $env:DIRECT_URL
```

**If the echo commands print anything other than empty — run `unset` again.**

> ⚠️ **You must do this EVERY TIME you open a new terminal.** See Step 8 for a permanent fix.

---

## Step 5: Install Dependencies

```bash
bun install
```

This installs Next.js, Prisma, shadcn/ui, TanStack Query, and all other packages.

---

## Step 6: Push Database Schema to Supabase

```bash
bun run db:push
```

You should see:
```
🚀 Your database is now in sync with your Prisma schema.
```

If you see an error about "URL must start with postgresql://":
- Your `.env` file is wrong (go back to Step 3)
- OR your shell has stale env vars (go back to Step 4)

---

## Step 7: Generate Prisma Client

```bash
bun run db:generate
```

---

## Step 8: CREATE A STARTUP SCRIPT (PERMANENT FIX)

To avoid having to manually `unset` env vars every time, create a helper script:

### macOS / Linux / WSL:

Create a file called `start.sh` in the project root:

```bash
#!/bin/bash
# FlowOps startup script — always uses Supabase, never SQLite

# Clear any stale shell env vars that would override .env
unset DATABASE_URL
unset DIRECT_URL

# Verify .env has the correct Supabase URL
if grep -q "custom.db" .env 2>/dev/null; then
  echo "❌ ERROR: .env still has the old SQLite URL!"
  echo "Fix: Replace .env contents with the Supabase PostgreSQL URL."
  exit 1
fi

if ! grep -q "postgresql://" .env 2>/dev/null; then
  echo "❌ ERROR: .env does not have a PostgreSQL URL!"
  exit 1
fi

echo "✅ .env verified — using Supabase PostgreSQL"
echo "🚀 Starting FlowOps dev server..."
exec bun run dev
```

Make it executable:
```bash
chmod +x start.sh
```

**From now on, start the server with:**
```bash
./start.sh
```

### Windows (PowerShell):

Create a file called `start.ps1` in the project root:

```powershell
# FlowOps startup script — always uses Supabase, never SQLite

# Clear stale env vars
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:DIRECT_URL -ErrorAction SilentlyContinue

# Verify .env
$envContent = Get-Content .env -Raw
if ($envContent -match "custom\.db") {
    Write-Host "❌ ERROR: .env still has the old SQLite URL!" -ForegroundColor Red
    exit 1
}
if ($envContent -notmatch "postgresql://") {
    Write-Host "❌ ERROR: .env does not have a PostgreSQL URL!" -ForegroundColor Red
    exit 1
}

Write-Host "✅ .env verified — using Supabase PostgreSQL" -ForegroundColor Green
Write-Host "🚀 Starting FlowOps dev server..." -ForegroundColor Cyan
bun run dev
```

**From now on, start the server with:**
```powershell
.\start.ps1
```

---

## Step 9: Start the Dev Server

### Using the startup script (recommended):
```bash
# macOS / Linux / WSL
./start.sh

# Windows PowerShell
.\start.ps1
```

### Or manually (if you skipped Step 8):
```bash
# macOS / Linux / WSL
unset DATABASE_URL DIRECT_URL
bun run dev

# Windows PowerShell
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:DIRECT_URL -ErrorAction SilentlyContinue
bun run dev
```

You should see:
```
▲ Next.js 16.1.3 (Turbopack)
- Local: http://localhost:3000
✓ Ready in ~1s
```

Open **http://localhost:3000** in your browser.

---

## Step 10: Verify Everything Works

### Login with the test account:
- **Email:** `usman@flowops.pk`
- **Password:** `Test1234!`

### Quick feature checklist (click through the sidebar):
- [ ] Dashboard loads with stats
- [ ] Products → All Products shows 19 products
- [ ] Products → Catalog Settings shows attributes
- [ ] Inventory → Dashboard shows stock value
- [ ] Inventory → Locations shows 15 locations
- [ ] Inventory → Cycle Counts shows 11 counts
- [ ] Orders → All Orders shows 92 orders
- [ ] Orders → Create Order works (can create a customer)
- [ ] Customers shows 5 customers with flat addresses
- [ ] Audit Log shows 187+ entries

### If any page shows an error:
1. Check the server terminal for error messages
2. If you see "URL must start with postgresql://" → your `.env` or shell env is wrong (go back to Steps 3-4)
3. If you see "max clients reached" → too many DB connections; wait 60s and restart
4. If you see "column does not exist" → run `bun run db:push && bun run db:generate` again

---

## TROUBLESHOOTING

### "URL must start with the protocol postgresql://"
**Cause:** Shell has stale `DATABASE_URL=file:...custom.db` OR `.env` file has wrong content.
**Fix:**
```bash
# Check what's in the shell:
echo $DATABASE_URL
# If it shows the SQLite path:
unset DATABASE_URL
unset DIRECT_URL
# Then verify .env:
cat .env
# If .env also has SQLite, recreate it (Step 3)
```

### "FATAL: max clients reached in session mode"
**Cause:** Supabase free tier limits 15 concurrent connections on the session pooler (port 5432). Too many tabs/terminals opened.
**Fix:**
```bash
# Kill all Node processes
pkill -f node    # macOS/Linux
taskkill /F /IM node.exe    # Windows

# Wait 60 seconds for connections to clear
sleep 60

# Restart with the startup script
./start.sh
```

### "Cannot find module '@prisma/client'"
**Cause:** Prisma client not generated.
**Fix:**
```bash
bun run db:generate
```

### "column `Customer.addresses` does not exist"
**Cause:** Old code referencing the removed `addresses` column.
**Fix:** Make sure you have the latest code:
```bash
git pull
bun install
bun run db:push
bun run db:generate
```

### First page load is very slow (8-10 seconds)
**This is normal.** Turbopack compiles all routes on first access. Subsequent loads are instant.

### Port 3000 already in use
```bash
# Find and kill the process using port 3000
lsof -ti:3000 | xargs kill -9    # macOS/Linux
netstat -ano | findstr :3000     # Windows (then taskkill /PID <pid> /F)
```

---

## DAILY WORKFLOW (after initial setup)

Every time you sit down to work on FlowOps:

```bash
# 1. Open terminal
cd flowops

# 2. Start the server (uses the startup script that clears stale env vars)
./start.sh          # macOS/Linux/WSL
.\start.ps1         # Windows PowerShell

# 3. Open http://localhost:3000
# 4. Login with usman@flowops.pk / Test1234!

# 5. When done: Ctrl+C to stop the server
```

**That's it.** The startup script handles the env vars automatically. You never need to think about SQLite vs Supabase again.

---

## QUICK REFERENCE CARD

| What | Value |
|---|---|
| **Supabase URL** | `postgresql://postgres.flafcggvqfgyafzekxzk:123%40Usman123%40@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres` |
| **Test Email** | `usman@flowops.pk` |
| **Test Password** | `Test1234!` |
| **Dev Server** | `http://localhost:3000` |
| **Start Command** | `./start.sh` (macOS) or `.\start.ps1` (Windows) |
| **DB Push** | `bun run db:push` |
| **Prisma Generate** | `bun run db:generate` |
| **Lint** | `bun run lint` |

---

**FlowOps ERP** — the operating system for Pakistani e-commerce.
