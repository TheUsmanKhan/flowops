# FlowOps startup script — always uses Supabase, never SQLite
# Usage: .\start.ps1

# Clear stale env vars
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:DIRECT_URL -ErrorAction SilentlyContinue

# Verify .env
$envContent = Get-Content .env -Raw
if ($envContent -match "custom\.db") {
    Write-Host "❌ ERROR: .env still has the old SQLite URL!" -ForegroundColor Red
    Write-Host "Fix: Replace .env contents with:"
    Write-Host "  DATABASE_URL=postgresql://postgres.flafcggvqfgyafzekxzk:123%40Usman123%40@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"
    Write-Host "  DIRECT_URL=postgresql://postgres.flafcggvqfgyafzekxzk:123%40Usman123%40@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"
    exit 1
}
if ($envContent -notmatch "postgresql://") {
    Write-Host "❌ ERROR: .env does not have a PostgreSQL URL!" -ForegroundColor Red
    exit 1
}

Write-Host "✅ .env verified — using Supabase PostgreSQL" -ForegroundColor Green
Write-Host "🚀 Starting FlowOps dev server..." -ForegroundColor Cyan
Write-Host ""
bun run dev
