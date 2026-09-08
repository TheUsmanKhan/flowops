/**
 * PO-003 fix — Reset 3 stale `InventoryPool.incoming=500` rows + write audit logs.
 *
 * Background (from PO_PRODUCTION_SOLUTIONS.md PO-003):
 *   - 3 InventoryPool rows have `incoming=500` but ZERO open PurchaseOrders
 *     for those (orgVariantId, locationId) combos. The incoming projection
 *     is permanently inflated — warehouse shows "500 incoming" that will
 *     never arrive.
 *
 *   Root cause: legacy PO cancellation / receipt code did not always call
 *   `decrementIncomingStock()`. The INV-007 fix made this atomic for NEW
 *   POs (increment/decrement now share the same $transaction as the PO
 *   status update), so this can no longer happen for new POs. The 3 stale
 *   rows below are historical artifacts that need a one-time data repair.
 *
 *   Pool IDs to repair:
 *     1. cms1ns2vu000ptdjo7ool9nsn
 *     2. cms1ns324000rtdjoloh7rt6e
 *     3. cms1ns2k8000ntdjom0zi0gzl
 *
 * What this script does (for each pool):
 *   1. Reads the current state (incoming, onHand, reserved, organizationId,
 *      orgVariantId, locationId).
 *   2. Verifies there are NO open PurchaseOrders for this pool's
 *      (orgVariantId, locationId) — defensive check. If there ARE open
 *      POs, the script REFUSES to reset (skips with an audit log) because
 *      the incoming value may be legitimate.
 *   3. Updates `incoming=0`.
 *   4. Writes an audit log entry with before/after state + reason.
 *
 * IDEMPOTENT: re-runs are safe. Once `incoming=0`, the script's
 * pre-check (incoming > 0) skips the pool on subsequent runs.
 *
 * Audit log action: 'inventory_pool.incoming_reset_stale'
 *
 * Run: bun run scripts/reset-stale-incoming-pools.ts
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

const STALE_POOL_IDS = [
  'cms1ns2vu000ptdjo7ool9nsn',
  'cms1ns324000rtdjoloh7rt6e',
  'cms1ns2k8000ntdjom0zi0gzl',
]

interface PoolRow {
  id: string
  orgVariantId: string
  locationId: string
  organizationId: string
  onHand: number
  reserved: number
  incoming: number
}

console.log('═'.repeat(80))
console.log('PO-003 — Reset stale InventoryPool.incoming=500 rows (3 pools)')
console.log('═'.repeat(80))

// ── Look up companyId per organizationId (one company per org in this schema).
// InventoryPool has no companyId column. AuditLog.companyId is optional but
// we resolve it when possible for traceability.
const pools = await p.inventoryPool.findMany({
  where: { id: { in: STALE_POOL_IDS } },
  select: {
    id: true,
    orgVariantId: true,
    locationId: true,
    organizationId: true,
    onHand: true,
    reserved: true,
    incoming: true,
  },
})

console.log(`\nFound ${pools.length} of ${STALE_POOL_IDS.length} target pools in DB.`)
if (pools.length === 0) {
  console.log('\nNo matching pools. Exiting.')
  await p.$disconnect()
  process.exit(0)
}

const orgIds = [...new Set(pools.map((pool) => pool.organizationId))]
const companies = await p.company.findMany({
  where: { organizationId: { in: orgIds } },
  select: { id: true, organizationId: true },
})
const orgToCompany = new Map(companies.map((c) => [c.organizationId, c.id]))

let resetCount = 0
let skippedCount = 0
let auditLogSuccess = 0
let auditLogFailure = 0

for (const pool of pools) {
  console.log(`\n── Pool ${pool.id} ──`)
  console.log(
    `  current: incoming=${pool.incoming}, onHand=${pool.onHand}, reserved=${pool.reserved}`,
  )
  console.log(`  orgVariantId=${pool.orgVariantId}`)
  console.log(`  locationId=${pool.locationId}`)

  // ── Idempotency check ──
  if (pool.incoming === 0) {
    console.log(`  ⏭️  incoming already 0 — skipping (idempotent re-run).`)
    skippedCount++
    continue
  }

  // ── Defensive: verify there are NO open PurchaseOrders for this pool's
  // (orgVariantId, deliveryLocationId). If there ARE open POs (status in
  // 'ordered' or 'partially_received' with unreceived > 0), the incoming
  // value may be legitimate — refuse to reset.
  //
  // NOTE: PurchaseOrderItem links via `orgVariantId` and the PO links via
  // `deliveryLocationId`. We check both.
  const openPOItems = await p.purchaseOrderItem.findMany({
    where: {
      orgVariantId: pool.orgVariantId,
      purchaseOrder: {
        deliveryLocationId: pool.locationId,
        status: { in: ['ordered', 'partially_received'] },
      },
    },
    select: {
      orderedQuantity: true,
      receivedQuantity: true,
      purchaseOrder: { select: { id: true, poNumber: true, status: true } },
    },
  })

  const totalUnreceived = openPOItems.reduce(
    (sum, item) => sum + Math.max(0, item.orderedQuantity - item.receivedQuantity),
    0,
  )

  if (openPOItems.length > 0 && totalUnreceived > 0) {
    console.log(
      `  ⚠️  REFUSING to reset: found ${openPOItems.length} open PO item(s) with ${totalUnreceived} unreceived units at this (variant, location). Incoming value may be legitimate.`,
    )
    // Write audit log documenting the refusal
    try {
      await p.auditLog.create({
        data: {
          action: 'inventory_pool.incoming_reset_refused',
          entityType: 'inventory_pool',
          entityId: pool.id,
          companyId: orgToCompany.get(pool.organizationId) ?? null,
          organizationId: pool.organizationId,
          oldValues: JSON.stringify({
            incoming: pool.incoming,
            onHand: pool.onHand,
            reserved: pool.reserved,
            orgVariantId: pool.orgVariantId,
            locationId: pool.locationId,
          }),
          newValues: JSON.stringify({
            incoming: pool.incoming, // unchanged
            onHand: pool.onHand,
            reserved: pool.reserved,
            orgVariantId: pool.orgVariantId,
            locationId: pool.locationId,
          }),
          metadata: JSON.stringify({
            reason: 'open_purchase_orders_exist',
            openPOItemCount: openPOItems.length,
            totalUnreceived,
            openPOs: openPOItems.map((i) => ({
              poId: i.purchaseOrder.id,
              poNumber: i.purchaseOrder.poNumber,
              status: i.purchaseOrder.status,
              ordered: i.orderedQuantity,
              received: i.receivedQuantity,
            })),
            note: 'Reset refused because open PurchaseOrders exist for this (orgVariantId, locationId). Manual review required.',
            refusedAt: new Date().toISOString(),
          }),
        },
      })
      auditLogSuccess++
    } catch (e) {
      auditLogFailure++
      console.error(`  ⚠️  Failed to insert refusal audit log for pool ${pool.id}:`, e)
    }
    skippedCount++
    continue
  }

  // ── Reset incoming to 0 ──
  const beforeState = {
    incoming: pool.incoming,
    onHand: pool.onHand,
    reserved: pool.reserved,
    available: pool.onHand - pool.reserved,
  }

  await p.inventoryPool.update({
    where: { id: pool.id },
    data: { incoming: 0 },
  })
  resetCount++
  console.log(`  ✅ incoming ${pool.incoming} → 0`)

  const afterState = {
    incoming: 0,
    onHand: pool.onHand,
    reserved: pool.reserved,
    available: pool.onHand - pool.reserved,
  }

  // ── Audit log ──
  try {
    await p.auditLog.create({
      data: {
        action: 'inventory_pool.incoming_reset_stale',
        entityType: 'inventory_pool',
        entityId: pool.id,
        companyId: orgToCompany.get(pool.organizationId) ?? null,
        organizationId: pool.organizationId,
        oldValues: JSON.stringify({
          ...beforeState,
          orgVariantId: pool.orgVariantId,
          locationId: pool.locationId,
        }),
        newValues: JSON.stringify({
          ...afterState,
          orgVariantId: pool.orgVariantId,
          locationId: pool.locationId,
        }),
        metadata: JSON.stringify({
          reason: 'stale_incoming_no_open_purchase_orders',
          note: 'Pool had incoming > 0 but no open PurchaseOrders (status ordered/partially_received with unreceived > 0) for this (orgVariantId, locationId). Historical artifact from pre-INV-007-fix PO cancel/receive code that did not always call decrementIncomingStock(). Reset to 0 to deflate the permanently-inflated incoming projection.',
          openPOItemCount: openPOItems.length,
          totalUnreceived,
          resetAt: new Date().toISOString(),
        }),
      },
    })
    auditLogSuccess++
    console.log(`  📝 audit log written (inventory_pool.incoming_reset_stale)`)
  } catch (e) {
    auditLogFailure++
    console.error(`  ⚠️  Failed to insert audit log for pool ${pool.id}:`, e)
  }
}

// ── Summary ──
console.log('\n' + '═'.repeat(80))
console.log('PO-003 STALE INCOMING RESET COMPLETE')
console.log('═'.repeat(80))
console.log(`Target pool IDs:                  ${STALE_POOL_IDS.length}`)
console.log(`Pools found in DB:                ${pools.length}`)
console.log(`Pools reset (incoming → 0):       ${resetCount}`)
console.log(`Pools skipped (already 0 / open POs): ${skippedCount}`)
console.log(`Audit logs OK:                    ${auditLogSuccess}`)
console.log(`Audit logs FAIL:                  ${auditLogFailure}`)

// ── Idempotency check ──
const remaining = await p.inventoryPool.findMany({
  where: { id: { in: STALE_POOL_IDS }, incoming: { gt: 0 } },
  select: { id: true, incoming: true },
})
console.log(`\n── Idempotency check ──`)
console.log(
  `Remaining stale pools with incoming > 0: ${remaining.length}` +
    (remaining.length > 0
      ? `\n  (Expected: pools with open POs that were refused — see audit logs)`
      : '\n  (Expected: 0 — all stale pools reset successfully)'),
)

await p.$disconnect()
console.log('\nDone.')
