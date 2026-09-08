/**
 * PO-004 fix — Backfill 4 legacy NULL `InventoryTransaction.referenceId` rows
 * where transactionType='fabric_consumed_for_stitching'.
 *
 * Background (from PO_PRODUCTION_AUDIT_FINAL.md PO-004):
 *   - 4 InventoryTransaction rows exist with
 *       transactionType='fabric_consumed_for_stitching' AND referenceId IS NULL.
 *   - These are pre-INV-004-fix legacy rows — the current code always sets
 *     referenceId to the ProductionOrder.id when consuming fabric for stitching
 *     (the ProductionOrder.fabricTxnId field stores the inverse link).
 *   - These 4 rows need a one-time backfill so audit-trail queries that join
 *     on referenceId don't silently drop them.
 *
 * What this script does (for each NULL-referenceId fabric_consumed_for_stitching txn):
 *   1. Finds the matching ProductionOrder via
 *        ProductionOrder.fabricTxnId = transaction.id
 *   2. Updates transaction.referenceId = ProductionOrder.id
 *   3. Writes an audit log entry documenting the backfill.
 *
 * IDEMPOTENT: re-runs are safe. Rows whose referenceId is already set are
 * skipped (idempotency check).
 *
 * Audit log action: 'inventory_transaction.reference_id_backfilled'
 *
 * Run: bun run scripts/backfill-fabric-txn-reference-id.ts
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

console.log('═'.repeat(80))
console.log('PO-004 — Backfill NULL referenceId on fabric_consumed_for_stitching txns')
console.log('═'.repeat(80))

// ── Find all affected rows ──
const affectedTxns = await p.inventoryTransaction.findMany({
  where: {
    transactionType: 'fabric_consumed_for_stitching',
    referenceId: null,
  },
  select: {
    id: true,
    orgVariantId: true,
    locationId: true,
    organizationId: true,
    companyId: true,
    quantity: true,
    costPerUnit: true,
    createdAt: true,
    recordedAt: true,
    referenceType: true,
  },
})

console.log(
  `\nFound ${affectedTxns.length} fabric_consumed_for_stitching txn(s) with NULL referenceId.`,
)

if (affectedTxns.length === 0) {
  console.log('\nNo matching rows. Exiting.')
  await p.$disconnect()
  process.exit(0)
}

// ── Resolve companyId for audit log (InventoryTransaction.companyId may be NULL
// for org-level events; fall back to Company table lookup by organizationId).
const orgIds = [...new Set(affectedTxns.map((t) => t.organizationId))]
const companies = await p.company.findMany({
  where: { organizationId: { in: orgIds } },
  select: { id: true, organizationId: true },
})
const orgToCompany = new Map(companies.map((c) => [c.organizationId, c.id]))

let backfilledCount = 0
let skippedNoProductionOrderCount = 0
let auditLogSuccess = 0
let auditLogFailure = 0

for (const txn of affectedTxns) {
  console.log(`\n── Transaction ${txn.id} ──`)
  console.log(
    `  type=fabric_consumed_for_stitching, qty=${txn.quantity}, cost/unit=${txn.costPerUnit}`,
  )
  console.log(
    `  orgVariantId=${txn.orgVariantId}, locationId=${txn.locationId}, recordedAt=${txn.recordedAt.toISOString()}`,
  )

  // ── Find the matching ProductionOrder via fabricTxnId ──
  const productionOrder = await p.productionOrder.findFirst({
    where: { fabricTxnId: txn.id },
    select: {
      id: true,
      organizationId: true,
      companyId: true,
      stitchedVariantId: true,
      fabricVariantId: true,
      status: true,
      quantity: true,
    },
  })

  if (!productionOrder) {
    console.log(
      `  ⚠️  No ProductionOrder found with fabricTxnId=${txn.id}. Cannot backfill referenceId. Skipping.`,
    )
    skippedNoProductionOrderCount++

    // ── Audit log documenting the inability to backfill ──
    try {
      await p.auditLog.create({
        data: {
          action: 'inventory_transaction.reference_id_backfill_failed',
          entityType: 'inventory_transaction',
          entityId: txn.id,
          companyId: txn.companyId ?? orgToCompany.get(txn.organizationId) ?? null,
          organizationId: txn.organizationId,
          oldValues: JSON.stringify({ referenceId: null }),
          newValues: JSON.stringify({ referenceId: null }),
          metadata: JSON.stringify({
            reason: 'no_matching_production_order',
            note: 'Could not backfill referenceId because no ProductionOrder has fabricTxnId = this transaction. Manual review required.',
            transactionType: 'fabric_consumed_for_stitching',
            orgVariantId: txn.orgVariantId,
            locationId: txn.locationId,
            attemptedAt: new Date().toISOString(),
          }),
        },
      })
      auditLogSuccess++
    } catch (e) {
      auditLogFailure++
      console.error(`  ⚠️  Failed to insert failure audit log for txn ${txn.id}:`, e)
    }
    continue
  }

  console.log(
    `  ✅ matched ProductionOrder ${productionOrder.id} (status=${productionOrder.status}, qty=${productionOrder.quantity})`,
  )

  // ── Update referenceId ──
  await p.inventoryTransaction.update({
    where: { id: txn.id },
    data: {
      referenceId: productionOrder.id,
      // Ensure referenceType is set to 'production_order' (was likely NULL too on legacy rows).
      referenceType: txn.referenceType ?? 'production_order',
    },
  })
  backfilledCount++
  console.log(`  ✅ referenceId set to ${productionOrder.id}`)

  // ── Audit log ──
  try {
    await p.auditLog.create({
      data: {
        action: 'inventory_transaction.reference_id_backfilled',
        entityType: 'inventory_transaction',
        entityId: txn.id,
        companyId: txn.companyId ?? orgToCompany.get(txn.organizationId) ?? null,
        organizationId: txn.organizationId,
        oldValues: JSON.stringify({
          referenceId: null,
          referenceType: txn.referenceType,
        }),
        newValues: JSON.stringify({
          referenceId: productionOrder.id,
          referenceType: txn.referenceType ?? 'production_order',
        }),
        metadata: JSON.stringify({
          reason: 'legacy_null_reference_id_backfill',
          note: 'Backfilled referenceId from matching ProductionOrder.fabricTxnId. Pre-INV-004-fix legacy row — current code always sets referenceId when consuming fabric for stitching.',
          transactionType: 'fabric_consumed_for_stitching',
          productionOrderId: productionOrder.id,
          productionOrderStatus: productionOrder.status,
          productionOrderQuantity: productionOrder.quantity,
          stitchedVariantId: productionOrder.stitchedVariantId,
          fabricVariantId: productionOrder.fabricVariantId,
          backfilledAt: new Date().toISOString(),
        }),
      },
    })
    auditLogSuccess++
    console.log(`  📝 audit log written (inventory_transaction.reference_id_backfilled)`)
  } catch (e) {
    auditLogFailure++
    console.error(`  ⚠️  Failed to insert audit log for txn ${txn.id}:`, e)
  }
}

// ── Summary ──
console.log('\n' + '═'.repeat(80))
console.log('PO-004 REFERENCE_ID BACKFILL COMPLETE')
console.log('═'.repeat(80))
console.log(`Affected txns found:                              ${affectedTxns.length}`)
console.log(`Backfilled (referenceId set):                     ${backfilledCount}`)
console.log(`Skipped (no matching ProductionOrder):            ${skippedNoProductionOrderCount}`)
console.log(`Audit logs OK:                                    ${auditLogSuccess}`)
console.log(`Audit logs FAIL:                                  ${auditLogFailure}`)

// ── Idempotency check ──
const remaining = await p.inventoryTransaction.findMany({
  where: {
    transactionType: 'fabric_consumed_for_stitching',
    referenceId: null,
  },
  select: { id: true },
})
console.log(`\n── Idempotency check ──`)
console.log(
  `Remaining fabric_consumed_for_stitching txns with NULL referenceId: ${remaining.length}` +
    (remaining.length > 0
      ? `\n  (Expected: rows with no matching ProductionOrder — see failure audit logs)`
      : '\n  (Expected: 0 — all backfilled successfully)'),
)

await p.$disconnect()
console.log('\nDone.')
