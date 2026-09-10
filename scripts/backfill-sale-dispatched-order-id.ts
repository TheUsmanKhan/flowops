/**
 * ORD-011 — Backfill NULL orderId on sale_dispatched InventoryTransactions.
 *
 * Bug: when the dispatch flow created `sale_dispatched` inventory transactions,
 * it set `referenceType='order'` + `referenceId=<orderId>` but left
 * `orderId` NULL. The `orderId` FK is what the Order detail view joins on
 * to display "transactions for this order", so those 18 transactions were
 * invisible from the order's ledger.
 *
 * Fix: copy `referenceId` → `orderId` for sale_dispatched rows where
 * `referenceType='order'`, `referenceId` IS NOT NULL, and `orderId` IS NULL.
 *
 * Idempotent: the WHERE clause filters to NULL orderId rows only — re-running
 * the script after a successful run is a no-op.
 *
 * Run: bun run scripts/backfill-sale-dispatched-order-id.ts
 */
import { config } from 'dotenv'
// override:true ensures the .env value takes precedence over any shell
// environment variable (e.g. if a stale DATABASE_URL is set in the shell,
// dotenv would otherwise NOT override it and Prisma would reject the URL).
config({ override: true })
import { PrismaClient } from '@prisma/client'

const p = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
})

console.log('═'.repeat(80))
console.log('ORD-011 — Backfill NULL orderId on sale_dispatched InventoryTransactions')
console.log('═'.repeat(80))

// ── DRY RUN: count affected rows first ──────────────────────────────────
const affected = await p.$queryRaw<{ count: bigint }[]>`
  SELECT COUNT(*)::bigint AS count
  FROM "InventoryTransaction"
  WHERE "transactionType" = 'sale_dispatched'
    AND "referenceType" = 'order'
    AND "referenceId" IS NOT NULL
    AND "orderId" IS NULL
`
const affectedCount = Number(affected[0]?.count ?? 0)
console.log(`\nAffected rows (sale_dispatched, referenceType=order, referenceId NOT NULL, orderId NULL): ${affectedCount}`)

if (affectedCount === 0) {
  console.log('\nNo rows to backfill — nothing to do. Exiting.')
  await p.$disconnect()
  process.exit(0)
}

// ── SAMPLE: show up to 10 affected rows for verification ───────────────
const sample = await p.$queryRaw<Array<{ id: string; referenceId: string; orderId: string | null; transactionType: string; referenceType: string }>>`
  SELECT id, "referenceId", "orderId", "transactionType", "referenceType"
  FROM "InventoryTransaction"
  WHERE "transactionType" = 'sale_dispatched'
    AND "referenceType" = 'order'
    AND "referenceId" IS NOT NULL
    AND "orderId" IS NULL
  LIMIT 10
`
console.log('\n── SAMPLE (first 10 affected rows) ──')
for (const row of sample) {
  console.log(`  • txn ${row.id.slice(-8)} → referenceId=${row.referenceId.slice(-8)} (currently orderId=NULL)`)
}

// ── BACKFILL ─────────────────────────────────────────────────────────────
// NOTE: only update rows where referenceId matches an existing Order.id —
// the FK constraint "InventoryTransaction_orderId_fkey" enforces this.
// (Some legacy rows have referenceId values that don't match any Order —
// those are skipped with a warning so the operator can investigate them
// manually. Diagnose via scripts/diagnose-ord-011.ts.)
const result = await p.$executeRaw`
  UPDATE "InventoryTransaction" t
  SET "orderId" = t."referenceId"
  WHERE t."transactionType" = 'sale_dispatched'
    AND t."referenceType" = 'order'
    AND t."referenceId" IS NOT NULL
    AND t."orderId" IS NULL
    AND EXISTS (SELECT 1 FROM "Order" o WHERE o.id = t."referenceId")
`
console.log(`\n✅ Rows updated: ${result}`)

// ── VERIFY ──────────────────────────────────────────────────────────────
const remaining = await p.$queryRaw<{ count: bigint }[]>`
  SELECT COUNT(*)::bigint AS count
  FROM "InventoryTransaction"
  WHERE "transactionType" = 'sale_dispatched'
    AND "referenceType" = 'order'
    AND "referenceId" IS NOT NULL
    AND "orderId" IS NULL
`
const remainingCount = Number(remaining[0]?.count ?? 0)
console.log(`\n── VERIFY ──`)
console.log(`Remaining rows with NULL orderId (should be 0): ${remainingCount}`)

if (remainingCount === 0) {
  console.log('✅ All sale_dispatched transactions now have a non-NULL orderId.')
} else {
  console.log('⚠️  Some rows still have NULL orderId — investigate manually.')
}

await p.$disconnect()
console.log('\nDone.')
