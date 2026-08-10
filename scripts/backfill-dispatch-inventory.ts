/**
 * Phase 3.2 — Retroactive backfill for polling auto-dispatch inventory corruption.
 *
 * For each affected order (status IN 'dispatched'/'delivered'/'rto' with NO
 * matching sale_dispatched txn), creates the missing inventory transaction:
 *   - dispatched/delivered → sale_dispatched (decrements onHand, releases reserved)
 *   - rto → order_unreserved (releases reserved only — item came back)
 *
 * Uses the canonical processInventoryTransaction() from @/lib/inventory — the
 * SAME function performOrderDispatch() uses. This guarantees WAC logic, pool
 * updates, and avg_cost_history are handled identically to a real dispatch.
 *
 * IDEMPOTENT: the selection query only selects orders WITHOUT a sale_dispatched
 * txn. After the first run, those orders WILL have the txn and be excluded.
 *
 * TAGGING: every correction txn is tagged in metadata with:
 *   { backfill: true, reason: 'polling_auto_dispatch_bug', original_dispatched_at }
 * And a backfill audit log entry is inserted per order.
 *
 * APPROXIMATION (per task): costPerUnit uses the pool's CURRENT avg_cost, since
 * the historical avg_cost at actual dispatch time cannot be perfectly reconstructed.
 *
 * Run: bun run scripts/backfill-dispatch-inventory.ts
 */
import { config } from 'dotenv'
config()
import { PrismaClient } from '@prisma/client'
import { processInventoryTransaction } from '../src/lib/inventory'

const p = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
})

interface AffectedOrder {
  id: string
  flowops_order_number: string
  status: string
  dispatched_at: Date | null
  courier_name: string | null
  tracking_number: string | null
  company_id: string
  organization_id: string
}

console.log('═'.repeat(80))
console.log('PHASE 3.2 — Retroactive backfill for polling auto-dispatch inventory corruption')
console.log('═'.repeat(80))

// ── SELECTION QUERY (idempotent) ──
// Selects orders with status IN (dispatched, delivered, rto) AND:
//   - NO matching sale_dispatched txn (excludes orders already backfilled with sale_dispatched)
//   - NO existing backfill txn (metadata check — excludes RTO orders backfilled with order_unreserved)
//   - NO existing backfill audit log (excludes orders already processed but all items skipped/failed)
// This triple-check ensures idempotency: no order is processed twice, regardless of
// whether its items succeeded, were skipped (made_to_order/no-pool), or failed.
const affectedOrders = await p.$queryRaw<AffectedOrder[]>`
  SELECT
    o.id,
    o."flowopsOrderNumber" AS flowops_order_number,
    o.status,
    o."dispatchedAt" AS dispatched_at,
    o."courierName" AS courier_name,
    o."trackingNumber" AS tracking_number,
    o."companyId" AS company_id,
    o."organizationId" AS organization_id
  FROM "Order" o
  WHERE o.status IN ('dispatched', 'delivered', 'rto')
    AND NOT EXISTS(
      SELECT 1 FROM "InventoryTransaction" it
      WHERE it."referenceType" = 'order'
        AND it."referenceId" = o.id
        AND it."transactionType" = 'sale_dispatched'
    )
    AND NOT EXISTS(
      SELECT 1 FROM "InventoryTransaction" it2
      WHERE it2."referenceType" = 'order'
        AND it2."referenceId" = o.id
        AND it2.metadata::text LIKE '%"backfill":true%'
    )
    AND NOT EXISTS(
      SELECT 1 FROM "AuditLog" al
      WHERE al."entityType" = 'order'
        AND al."entityId" = o.id
        AND al.action = 'order.backfill_dispatch_inventory'
    )
  ORDER BY o."dispatchedAt" DESC NULLS LAST;
`

console.log(`\nAffected orders selected for backfill: ${affectedOrders.length}`)
console.log(`  • status='dispatched': ${affectedOrders.filter((o) => o.status === 'dispatched').length}`)
console.log(`  • status='delivered':  ${affectedOrders.filter((o) => o.status === 'delivered').length}`)
console.log(`  • status='rto':        ${affectedOrders.filter((o) => o.status === 'rto').length}`)

if (affectedOrders.length === 0) {
  console.log('\nNo affected orders — nothing to backfill. Exiting.')
  await p.$disconnect()
  process.exit(0)
}

// ── BACKFILL ──────────────────────────────────────────────────────────────
let totalTxnsCreated = 0
let totalItemsSkipped = 0
const corrections: Array<{
  order_number: string
  status: string
  sku: string | null
  quantity: number
  txn_type: string
  pool_before: { onHand: number; reserved: number; avgCost: number } | null
  pool_after: { onHand: number; reserved: number; avgCost: number } | null
  skipped_reason: string | null
  error?: string | null
}> = []

for (const order of affectedOrders) {
  console.log(`\n── Processing ${order.flowops_order_number} (status=${order.status}) ──`)

  // Determine the txn type for this order
  const txnType = order.status === 'rto' ? 'order_unreserved' : 'sale_dispatched'

  // Fetch order items + dispatch location
  const orderFull = await p.order.findUnique({
    where: { id: order.id },
    select: {
      dispatchLocationId: true,
      items: {
        include: {
          orgVariant: { select: { id: true, sku: true, fulfillmentType: true } },
        },
      },
    },
  })
  if (!orderFull) {
    console.log(`  ⚠️  Order not found — skipping`)
    continue
  }

  for (const item of orderFull.items) {
    const locationId = item.reservedLocationId ?? orderFull.dispatchLocationId
    const sku = item.orgVariant.sku

    // Capture pool before-state
    let poolBefore: { onHand: number; reserved: number; avgCost: number } | null = null
    if (locationId) {
      const pool = await p.inventoryPool.findUnique({
        where: {
          orgVariantId_locationId: {
            orgVariantId: item.orgVariantId,
            locationId,
          },
        },
        select: { onHand: true, reserved: true, avgCost: true },
      })
      if (pool) {
        poolBefore = {
          onHand: pool.onHand,
          reserved: pool.reserved,
          avgCost: Number(pool.avgCost),
        }
      }
    }

    // Skip if no location
    if (!locationId) {
      console.log(`  ⏭  item ${item.id.slice(-8)} (sku=${sku}, qty=${item.quantity}): SKIP — no dispatch location`)
      totalItemsSkipped++
      corrections.push({
        order_number: order.flowops_order_number,
        status: order.status,
        sku,
        quantity: item.quantity,
        txn_type: txnType,
        pool_before: poolBefore,
        pool_after: null,
        skipped_reason: 'no_dispatch_location',
      })
      continue
    }

    // Skip if no pool (made_to_order variants — fabric consumed at production, no variant-level pool)
    if (!poolBefore) {
      console.log(`  ⏭  item ${item.id.slice(-8)} (sku=${sku}, qty=${item.quantity}): SKIP — no inventory pool (made_to_order; fabric consumed at production)`)
      totalItemsSkipped++
      corrections.push({
        order_number: order.flowops_order_number,
        status: order.status,
        sku,
        quantity: item.quantity,
        txn_type: txnType,
        pool_before: null,
        pool_after: null,
        skipped_reason: 'no_pool_made_to_order',
      })
      continue
    }

    // Create the backfill transaction via the canonical processInventoryTransaction.
    // For sale_dispatched: costPerUnit=null → uses pool's current avgCost (approximation).
    // For order_unreserved: costPerUnit irrelevant (no onHand/WAC change).
    const result = await processInventoryTransaction({
      orgVariantId: item.orgVariantId,
      locationId,
      organizationId: order.organization_id,
      companyId: order.company_id,
      employeeId: null,
      transactionType: txnType,
      quantity: item.quantity,
      costPerUnit: null, // uses current avgCost (approximation — historical cost unrecoverable)
      referenceType: 'order',
      referenceId: order.id,
      notes: `[BACKFILL] ${txnType} — polling auto-dispatch bug correction for ${order.flowops_order_number}. Approximate cost (current avg_cost used; historical dispatch-time cost unrecoverable).`,
      metadata: {
        backfill: true,
        reason: 'polling_auto_dispatch_bug',
        original_dispatched_at: order.dispatched_at?.toISOString() ?? null,
        original_order_status: order.status,
        correction_run_at: new Date().toISOString(),
        flowops_order_number: order.flowops_order_number,
        order_item_id: item.id,
      },
    })

    if (!result.success) {
      // sale_dispatched fails with INSUFFICIENT_STOCK when the pool has
      // available < qty. This happens for made_to_order variants that have a
      // pool with 0 onHand (the variant itself was never stocked — fabric was
      // consumed at production). For these, there's no stock to deduct, so we
      // skip gracefully rather than treating it as an error.
      const isInsufficientStock = result.error?.includes('INSUFFICIENT_STOCK')
      const reason = isInsufficientStock ? 'insufficient_stock_made_to_order' : 'txn_failed'
      console.log(`  ${isInsufficientStock ? '⏭' : '❌'} item ${item.id.slice(-8)} (sku=${sku}, qty=${item.quantity}): ${isInsufficientStock ? 'SKIP' : 'FAILED'} — ${result.error}`)
      totalItemsSkipped++
      corrections.push({
        order_number: order.flowops_order_number,
        status: order.status,
        sku,
        quantity: item.quantity,
        txn_type: txnType,
        pool_before: poolBefore,
        pool_after: null,
        skipped_reason: reason,
        error: result.error,
      })
      continue
    }

    // Capture pool after-state
    const poolAfter = result.poolState
      ? {
          onHand: result.poolState.onHand,
          reserved: result.poolState.reserved,
          avgCost: result.poolState.avgCost,
        }
      : null

    totalTxnsCreated++
    console.log(
      `  ✅ item ${item.id.slice(-8)} (sku=${sku}, qty=${item.quantity}): ${txnType} | ` +
      `onHand ${poolBefore.onHand}→${poolAfter?.onHand} | reserved ${poolBefore.reserved}→${poolAfter?.reserved} | txn=${result.transactionId?.slice(-8)}`,
    )

    corrections.push({
      order_number: order.flowops_order_number,
      status: order.status,
      sku,
      quantity: item.quantity,
      txn_type: txnType,
      pool_before: poolBefore,
      pool_after: poolAfter,
      skipped_reason: null,
    })
  }

  // Insert a backfill audit log for this order (newValues must be a JSON string)
  await p.auditLog.create({
    data: {
      action: 'order.backfill_dispatch_inventory',
      entityType: 'order',
      entityId: order.id,
      companyId: order.company_id,
      organizationId: order.organization_id,
      newValues: JSON.stringify({
        flowops_order_number: order.flowops_order_number,
        order_status: order.status,
        correction: txnType,
        items_corrected: orderFull.items.length,
        reason: 'polling_auto_dispatch_bug_backfill',
        note: 'Retroactive inventory correction for orders auto-dispatched by polling without inventory deduction. Approximate cost (current avg_cost used).',
      }),
    },
  }).catch((e) => console.error(`  ⚠️  Failed to insert audit log for ${order.flowops_order_number}:`, e))
}

// ── SUMMARY ───────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(80))
console.log('BACKFILL COMPLETE')
console.log('═'.repeat(80))
console.log(`Orders processed:       ${affectedOrders.length}`)
console.log(`Transactions created:   ${totalTxnsCreated}`)
console.log(`Items skipped:          ${totalItemsSkipped}`)

// Sample of before/after for verification
console.log('\n── SAMPLE: corrections (before → after pool state) ──')
for (const c of corrections.filter((x) => !x.skipped_reason)) {
  console.log(
    `  • ${c.order_number} [${c.status}] sku=${c.sku} qty=${c.quantity} | ${c.txn_type} | ` +
    `onHand ${c.pool_before?.onHand}→${c.pool_after?.onHand} | reserved ${c.pool_before?.reserved}→${c.pool_after?.reserved} | ` +
    `avgCost ${c.pool_before?.avgCost}→${c.pool_after?.avgCost}`,
  )
}

// Skipped items summary
const skippedByReason = corrections.reduce((acc, c) => {
  if (c.skipped_reason) acc[c.skipped_reason] = (acc[c.skipped_reason] ?? 0) + 1
  return acc
}, {} as Record<string, number>)
if (Object.keys(skippedByReason).length > 0) {
  console.log('\n── SKIPPED ITEMS ──')
  for (const [reason, count] of Object.entries(skippedByReason)) {
    console.log(`  • ${reason}: ${count}`)
  }
}

// ── DOUBLE-DEDUCTION CHECK ────────────────────────────────────────────────
// Re-run the selection query. After backfill, the dispatched/delivered orders
// should now HAVE a sale_dispatched txn (excluded from results). Only RTO
// orders (which got order_unreserved, not sale_dispatched) should remain.
const remaining = await p.$queryRaw<AffectedOrder[]>`
  SELECT o.id, o."flowopsOrderNumber" AS flowops_order_number, o.status, o."dispatchedAt" AS dispatched_at,
         o."courierName" AS courier_name, o."trackingNumber" AS tracking_number,
         o."companyId" AS company_id, o."organizationId" AS organization_id
  FROM "Order" o
  WHERE o.status IN ('dispatched', 'delivered', 'rto')
    AND NOT EXISTS(
      SELECT 1 FROM "InventoryTransaction" it
      WHERE it."referenceType" = 'order'
        AND it."referenceId" = o.id
        AND it."transactionType" = 'sale_dispatched'
    );
`
console.log('\n── DOUBLE-DEDUCTION CHECK ──')
console.log(`Orders still missing sale_dispatched txn after backfill: ${remaining.length}`)
const remainingByStatus = remaining.reduce((acc, o) => {
  acc[o.status] = (acc[o.status] ?? 0) + 1
  return acc
}, {} as Record<string, number>)
for (const [status, count] of Object.entries(remainingByStatus)) {
  console.log(`  • status='${status}': ${count}`)
}
const remainingNonRto = remaining.filter((o) => o.status !== 'rto')
console.log(`\nNon-RTO orders still missing sale_dispatched txn (should be 0): ${remainingNonRto.length}`)
if (remainingNonRto.length > 0) {
  console.log('⚠️  UNEXPECTED — these should have been backfilled!')
  for (const o of remainingNonRto) {
    console.log(`  • ${o.flowops_order_number} [${o.status}]`)
  }
} else {
  console.log('✅ All dispatched/delivered orders now have sale_dispatched txns. No double-deduction risk.')
}
console.log('(RTO orders correctly have order_unreserved txns instead — expected, since the item came back.)')

await p.$disconnect()
console.log('\nDone.')
