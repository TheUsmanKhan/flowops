#!/bin/bash
# FlowOps startup script — always uses Supabase, never SQLite
# Usage: ./start.sh

# Clear any stale shell env vars that would override .env
unset DATABASE_URL
unset DIRECT_URL

# Verify .env has the correct Supabase URL
if grep -q "custom.db" .env 2>/dev/null; then
  echo "❌ ERROR: .env still has the old SQLite URL!"
  echo "Fix: Replace .env contents with:"
  echo "  DATABASE_URL=postgresql://postgres.flafcggvqfgyafzekxzk:123%40Usman123%40@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"
  echo "  DIRECT_URL=postgresql://postgres.flafcggvqfgyafzekxzk:123%40Usman123%40@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"
  exit 1
fi

if ! grep -q "postgresql://" .env 2>/dev/null; then
  echo "❌ ERROR: .env does not have a PostgreSQL URL!"
  echo "Create .env with the Supabase connection string."
  exit 1
fi

echo "✅ .env verified — using Supabase PostgreSQL"
echo "🚀 Starting FlowOps dev server..."
echo ""
exec bun run dev
