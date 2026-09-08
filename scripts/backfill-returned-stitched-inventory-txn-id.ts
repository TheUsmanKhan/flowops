/**
 * PO-005 fix — Backfill 2 legacy NULL `ReturnedStitchedInventory.inventoryTxnId` rows.
 *
 * Background (from PO_PRODUCTION_AUDIT_FINAL.md PO-005):
 *   - 2 ReturnedStitchedInventory rows exist with
 *       status='available' AND inventoryTxnId IS NULL.
 *   - These are pre-INV-002-fix legacy rows — the current code always
 *     creates a `return_stitched_received` InventoryTransaction when a
 *     returned-stitched record is created, and stores its id in
 *     inventoryTxnId to keep the register + ledger in sync (migration 027).
 *   - These 2 rows need a one-time backfill so the register ↔ ledger link
 *     is complete for historical data.
 *
 * What this script does (for each NULL-inventoryTxnId returned-stitched row):
 *   1. Finds the matching `return_stitched_received` InventoryTransaction by
 *        orgVariantId + locationId + approximate createdAt
 *      (within a ±5 minute window centered on the returned-stitched row's
 *       `receivedAt` timestamp — matches the way the route creates both rows
 *       in the same request).
 *   2. If a unique match is found, sets inventoryTxnId = matching transaction id.
 *   3. Writes an audit log entry documenting the backfill.
 *   4. If NO match or AMBIGUOUS match (multiple), skips + writes a failure
 *      audit log so a human can manually resolve.
 *
 * IDEMPOTENT: re-runs are safe. Rows whose inventoryTxnId is already set
 * are skipped (idempotency check).
 *
 * Audit log action: 'returned_stitched_inventory.inventory_txn_id_backfilled'
 *
 * Run: bun run scripts/backfill-returned-stitched-inventory-txn-id.ts
 */
import { config } from 'dotenv'
// override:true ensures the .env value takes precedence over any shell
// environment variable (e.g. if DATABASE_URL=file:...db/custom.db is set in
// the shell, dotenv would otherwise NOT override it, and Prisma would
// reject the SQLite URL).
config({ override: true })
import { PrismaClient } from '@prisma/client'

const p = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
})

// ── Time window for matching: ±5 minutes centered on receivedAt ──
// (The create-return route writes both rows in the same request, so the
// gap should be a few milliseconds — 5 min is generous.)
const MATCH_WINDOW_MS = 5 * 60 * 1000

console.log('═'.repeat(80))
console.log('PO-005 — Backfill NULL inventoryTxnId on ReturnedStitchedInventory rows')
console.log('═'.repeat(80))

// ── Find all affected rows ──
const affectedRows = await p.returnedStitchedInventory.findMany({
  where: {
    status: 'available',
    inventoryTxnId: null,
  },
  select: {
    id: true,
    organizationId: true,
    companyId: true,
    orgVariantId: true,
    quantity: true,
    condition: true,
    totalCost: true,
    originalOrderReference: true,
    receivedAt: true,
    createdAt: true,
  },
})

console.log(
  `\nFound ${affectedRows.length} ReturnedStitchedInventory row(s) with status='available' AND inventoryTxnId IS NULL.`,
)

if (affectedRows.length === 0) {
  console.log('\nNo matching rows. Exiting.')
  await p.$disconnect()
  process.exit(0)
}

let backfilledCount = 0
let skippedNoMatchCount = 0
let skippedAmbiguousCount = 0
let auditLogSuccess = 0
let auditLogFailure = 0

for (const row of affectedRows) {
  console.log(`\n── ReturnedStitchedInventory ${row.id} ──`)
  console.log(
    `  qty=${row.quantity}, condition=${row.condition}, totalCost=${row.totalCost}`,
  )
  console.log(
    `  orgVariantId=${row.orgVariantId}, receivedAt=${row.receivedAt.toISOString()}`,
  )

  // ── The returned-stitched route does NOT pass a locationId into the
  // ReturnedStitchedInventory table (the table has no locationId column).
  // The matching `return_stitched_received` InventoryTransaction was created
  // by the route — typically using the dispatchLocationId of the original
  // order, or a default warehouse location.
  //
  // Strategy:
  //   1. Search by orgVariantId + organizationId + transactionType
  //      'return_stitched_received' within ±5min window of receivedAt.
  //   2. If exactly one match: use it.
  //   3. If multiple matches: try to disambiguate by quantity (the txn
  //      quantity should equal the row's quantity).
  //   4. If still ambiguous or zero matches: skip + write failure audit log.

  const windowStart = new Date(row.receivedAt.getTime() - MATCH_WINDOW_MS)
  const windowEnd = new Date(row.receivedAt.getTime() + MATCH_WINDOW_MS)

  const candidateTxns = await p.inventoryTransaction.findMany({
    where: {
      transactionType: 'return_stitched_received',
      orgVariantId: row.orgVariantId,
      organizationId: row.organizationId,
      recordedAt: { gte: windowStart, lte: windowEnd },
    },
    select: {
      id: true,
      locationId: true,
      quantity: true,
      costPerUnit: true,
      referenceType: true,
      referenceId: true,
      recordedAt: true,
      // Exclude txns already linked to another returned-stitched row (the
      // link is 1:1 — can't reuse the same txn for two rows).
      returnedStitchedRecords: { select: { id: true } },
    },
  })

  // Filter out txns already linked to a (different) returned-stitched row.
  const freeCandidates = candidateTxns.filter(
    (t) => t.returnedStitchedRecords.length === 0,
  )

  console.log(
    `  found ${candidateTxns.length} candidate(s) in ±5min window, ${freeCandidates.length} unlinked.`,
  )

  let chosenTxnId: string | null = null
  let chosenTxnInfo: (typeof freeCandidates)[number] | null = null

  if (freeCandidates.length === 0) {
    console.log(
      `  ⚠️  No unlinked return_stitched_received txn found in ±5min window. Skipping.`,
    )
    skippedNoMatchCount++
  } else if (freeCandidates.length === 1) {
    chosenTxnId = freeCandidates[0]!.id
    chosenTxnInfo = freeCandidates[0]!
  } else {
    // Multiple candidates — try disambiguation by quantity.
    const byQty = freeCandidates.filter((t) => Math.abs(t.quantity) === row.quantity)
    if (byQty.length === 1) {
      chosenTxnId = byQty[0]!.id
      chosenTxnInfo = byQty[0]!
      console.log(`  ℹ️  Disambiguated by quantity (${row.quantity}).`)
    } else {
      console.log(
        `  ⚠️  ${freeCandidates.length} candidate(s) in window, ${byQty.length} match quantity — ambiguous. Skipping.`,
      )
      skippedAmbiguousCount++
    }
  }

  if (!chosenTxnId || !chosenTxnInfo) {
    // ── Audit log documenting the inability to backfill ──
    try {
      await p.auditLog.create({
        data: {
          action: 'returned_stitched_inventory.inventory_txn_id_backfill_failed',
          entityType: 'returned_stitched_inventory',
          entityId: row.id,
          companyId: row.companyId,
          organizationId: row.organizationId,
          oldValues: JSON.stringify({ inventoryTxnId: null }),
          newValues: JSON.stringify({ inventoryTxnId: null }),
          metadata: JSON.stringify({
            reason:
              skippedAmbiguousCount > skippedNoMatchCount
                ? 'ambiguous_match'
                : 'no_match',
            note: 'Could not backfill inventoryTxnId because no unambiguous return_stitched_received InventoryTransaction was found in the ±5min window around receivedAt. Manual review required.',
            returnedStitchedInventoryId: row.id,
            orgVariantId: row.orgVariantId,
            quantity: row.quantity,
            receivedAt: row.receivedAt.toISOString(),
            windowStart: windowStart.toISOString(),
            windowEnd: windowEnd.toISOString(),
            candidateCount: candidateTxns.length,
            unlinkedCandidateCount: freeCandidates.length,
            attemptedAt: new Date().toISOString(),
          }),
        },
      })
      auditLogSuccess++
    } catch (e) {
      auditLogFailure++
      console.error(`  ⚠️  Failed to insert failure audit log for row ${row.id}:`, e)
    }
    continue
  }

  console.log(
    `  ✅ matched InventoryTransaction ${chosenTxnId} (qty=${chosenTxnInfo.quantity}, locationId=${chosenTxnInfo.locationId}, recordedAt=${chosenTxnInfo.recordedAt.toISOString()})`,
  )

  // ── Update inventoryTxnId ──
  await p.returnedStitchedInventory.update({
    where: { id: row.id },
    data: { inventoryTxnId: chosenTxnId },
  })
  backfilledCount++
  console.log(`  ✅ inventoryTxnId set to ${chosenTxnId}`)

  // ── Audit log ──
  try {
    await p.auditLog.create({
      data: {
        action: 'returned_stitched_inventory.inventory_txn_id_backfilled',
        entityType: 'returned_stitched_inventory',
        entityId: row.id,
        companyId: row.companyId,
        organizationId: row.organizationId,
        oldValues: JSON.stringify({ inventoryTxnId: null }),
        newValues: JSON.stringify({ inventoryTxnId: chosenTxnId }),
        metadata: JSON.stringify({
          reason: 'legacy_null_inventory_txn_id_backfill',
          note: 'Backfilled inventoryTxnId from the matching return_stitched_received InventoryTransaction (matched by orgVariantId + transactionType + ±5min window around receivedAt). Pre-INV-002-fix / pre-migration-027 legacy row — current code always links both records at creation time.',
          matchedTransactionId: chosenTxnId,
          matchedTransactionType: 'return_stitched_received',
          matchedTransactionLocationId: chosenTxnInfo.locationId,
          matchedTransactionQuantity: chosenTxnInfo.quantity,
          matchedTransactionRecordedAt: chosenTxnInfo.recordedAt.toISOString(),
          matchWindowMs: MATCH_WINDOW_MS,
          backfilledAt: new Date().toISOString(),
        }),
      },
    })
    auditLogSuccess++
    console.log(`  📝 audit log written (returned_stitched_inventory.inventory_txn_id_backfilled)`)
  } catch (e) {
    auditLogFailure++
    console.error(`  ⚠️  Failed to insert audit log for row ${row.id}:`, e)
  }
}

// ── Summary ──
console.log('\n' + '═'.repeat(80))
console.log('PO-005 INVENTORY_TXN_ID BACKFILL COMPLETE')
console.log('═'.repeat(80))
console.log(`Affected rows found:                              ${affectedRows.length}`)
console.log(`Backfilled (inventoryTxnId set):                  ${backfilledCount}`)
console.log(`Skipped (no unlinked match in window):            ${skippedNoMatchCount}`)
console.log(`Skipped (ambiguous match):                        ${skippedAmbiguousCount}`)
console.log(`Audit logs OK:                                    ${auditLogSuccess}`)
console.log(`Audit logs FAIL:                                  ${auditLogFailure}`)

// ── Idempotency check ──
const remaining = await p.returnedStitchedInventory.findMany({
  where: {
    status: 'available',
    inventoryTxnId: null,
  },
  select: { id: true },
})
console.log(`\n── Idempotency check ──`)
console.log(
  `Remaining ReturnedStitchedInventory rows with NULL inventoryTxnId (status=available): ${remaining.length}` +
    (remaining.length > 0
      ? `\n  (Expected: rows with no/ambiguous match — see failure audit logs)`
      : '\n  (Expected: 0 — all backfilled successfully)'),
)

await p.$disconnect()
console.log('\nDone.')
