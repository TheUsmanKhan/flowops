/**
 * PART3-SECTION C — Correct pre-existing drift pools.
 *
 * Background (from PART2 worklog):
 *   - 13 drift pools were identified in PART2 (investigation-only).
 *   - 1 ACTIVE VIOLATION (ghost pool): cmrsfkgmw003btdochj7jvi6b
 *       onHand=2, reserved=3, ZERO matching OrderItems → fully ghost reservation
 *       (excluded — needs manual review).
 *   - 12 drift pools where pool.reserved < actual SUM(OrderItem.quantity
 *       WHERE fulfillmentStatus='reserved'). Root cause: cancelOrder() pre-fix
 *       didn't always unreserve — historical artifacts.
 *
 * This script classifies the 12 non-ghost pools into:
 *   - SAFE (10 pools): new reserved value (SUM) <= onHand. Correcting them
 *       does NOT create a new active violation. Update reserved, write audit
 *       log.
 *   - AMBIGUOUS (2 pools): new reserved value (SUM) > onHand. Setting
 *       reserved = SUM would CAUSE a new active violation. Skip with a
 *       documented audit log (the pool is left uncorrected pending manual
 *       review — likely the order items reference stock that doesn't exist
 *       in InventoryPool.onHand, e.g. backordered items mistakenly tagged
 *       'reserved' or made_to_order items with NULL onHand).
 *
 * Ghost pool is excluded entirely (no audit log written for it from this
 * script — it requires its own data-repair decision).
 *
 * Run: bun run scripts/correct-drift-pools.ts
 *
 * IDEMPOTENT: The script only updates pools where pool.reserved != SUM
 * (the drift condition). After the first run, safe pools will have
 * reserved == SUM and be excluded on subsequent runs. Ambiguous + ghost
 * pools remain in their drift state on every run (idempotent re-runs are
 * safe — they will not re-process already-corrected pools).
 *
 * Audit log action: 'inventory_pool.drift_corrected' (safe)
 *                   'inventory_pool.drift_skipped_ambiguous' (ambiguous)
 *
 * All audit logs include:
 *   - poolId, orgVariantId, locationId
 *   - oldReserved, newReserved (or skippedNewReserved for ambiguous)
 *   - onHand, currentAvailable
 *   - reason: 'cancel_order_historical_drift'
 *   - correctedAt (ISO timestamp)
 */
import { config } from 'dotenv'
config()
import { PrismaClient } from '@prisma/client'

const p = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
})

const GHOST_POOL_ID = 'cmrsfkgmw003btdochj7jvi6b'

interface DriftPool {
  id: string
  org_variant_id: string
  location_id: string
  organization_id: string
  on_hand: number
  reserved: number
  actual_reserved_sum: bigint
}

console.log('═'.repeat(80))
console.log('PART3-SECTION C — Drift pool correction (10 safe + 2 ambiguous + 1 ghost)')
console.log('═'.repeat(80))

// ── Step 1: Query ALL drift pools (reserved != SUM of active OrderItem.reserved)
//
// A drift pool = one whose `reserved` value does not equal the sum of
// OrderItem.quantity for items tagged fulfillmentStatus='reserved' at
// (orgVariantId, reservedLocationId). This includes:
//   - reserved > SUM (over-reserved; SUM could be 0 → ghost reservation)
//   - reserved < SUM (under-reserved; typical historical cancelOrder() leak)
//
// We then split:
//   - Ghost pool (excluded entirely)
//   - Safe: new_value = SUM, new_value <= onHand (safe to correct)
//   - Ambiguous: new_value = SUM, new_value > onHand (would create violation)
//
// NOTE: InventoryPool has no companyId column — only organizationId. The
// audit log companyId will be looked up via Company.organizationId (one
// company per organization in this schema).
const driftPools = await p.$queryRaw<DriftPool[]>`
  SELECT
    p.id,
    p."orgVariantId" AS org_variant_id,
    p."locationId" AS location_id,
    p."organizationId" AS organization_id,
    p."onHand" AS on_hand,
    p.reserved,
    COALESCE((
      SELECT SUM(oi.quantity)::bigint FROM "OrderItem" oi
      WHERE oi."orgVariantId" = p."orgVariantId"
        AND oi."reservedLocationId" = p."locationId"
        AND oi."fulfillmentStatus" = 'reserved'
    ), 0) AS actual_reserved_sum
  FROM "InventoryPool" p
  WHERE p.reserved != COALESCE((
      SELECT SUM(oi.quantity) FROM "OrderItem" oi
      WHERE oi."orgVariantId" = p."orgVariantId"
        AND oi."reservedLocationId" = p."locationId"
        AND oi."fulfillmentStatus" = 'reserved'
    ), 0)
  ORDER BY p.id;
`

console.log(`\nTotal drift pools found: ${driftPools.length}`)

// ── Look up companyId per organizationId (one company per org) ──
// InventoryPool has no companyId column. AuditLog.companyId is optional,
// but we resolve it when possible for traceability.
const orgIds = [...new Set(driftPools.map((p) => p.organization_id))]
const companies = await p.company.findMany({
  where: { organizationId: { in: orgIds } },
  select: { id: true, organizationId: true },
})
const orgToCompany = new Map(companies.map((c) => [c.organizationId, c.id]))

// ── Classify ──
const ghostPool = driftPools.find((pool) => pool.id === GHOST_POOL_ID)
const nonGhost = driftPools.filter((pool) => pool.id !== GHOST_POOL_ID)

const safePools = nonGhost.filter((pool) => {
  const newReserved = Number(pool.actual_reserved_sum)
  return newReserved <= pool.on_hand
})

const ambiguousPools = nonGhost.filter((pool) => {
  const newReserved = Number(pool.actual_reserved_sum)
  return newReserved > pool.on_hand
})

console.log(`  • Ghost pool (excluded): ${ghostPool ? 1 : 0}`)
console.log(`  • Safe pools (will be corrected): ${safePools.length}`)
console.log(`  • Ambiguous pools (skipped + documented): ${ambiguousPools.length}`)

if (ghostPool) {
  console.log(`\n── Ghost pool (NOT TOUCHED) ──`)
  console.log(`  • id=${ghostPool.id}`)
  console.log(`    onHand=${ghostPool.on_hand}, reserved=${ghostPool.reserved}, actual_reserved_sum=${Number(ghostPool.actual_reserved_sum)}`)
  console.log(`    Reason: 0 matching OrderItems but reserved > 0 (fully ghost). Requires manual data-repair decision.`)
}

if (ambiguousPools.length > 0) {
  console.log(`\n── Ambiguous pools (NOT CORRECTED — documented reason) ──`)
  for (const pool of ambiguousPools) {
    const newReserved = Number(pool.actual_reserved_sum)
    console.log(`  • id=${pool.id}`)
    console.log(`    onHand=${pool.on_hand}, currentReserved=${pool.reserved}, wouldBeReserved=${newReserved}`)
    console.log(`    Reason: setting reserved=${newReserved} would exceed onHand=${pool.on_hand}, creating a new active violation. Skipped pending manual review.`)
  }
}

if (safePools.length === 0) {
  console.log('\nNo safe drift pools to correct. Exiting.')
  await p.$disconnect()
  process.exit(0)
}

console.log(`\n── Safe pools (will be corrected) ──`)
for (const pool of safePools) {
  const newReserved = Number(pool.actual_reserved_sum)
  console.log(`  • id=${pool.id} | onHand=${pool.on_hand} | reserved ${pool.reserved} → ${newReserved}`)
}

// ── Step 2: Correct each safe pool + write audit log ──
console.log(`\n── Correcting ${safePools.length} safe pools ──`)

let corrected = 0
let auditLogSuccess = 0
let auditLogFailure = 0

for (const pool of safePools) {
  const newReserved = Number(pool.actual_reserved_sum)
  const oldReserved = pool.reserved

  // Capture before-state for audit log
  const beforeState = {
    onHand: pool.on_hand,
    reserved: oldReserved,
    available: pool.on_hand - oldReserved,
  }

  // Update the pool.reserved to match the actual sum
  await p.inventoryPool.update({
    where: { id: pool.id },
    data: { reserved: newReserved },
  })
  corrected++

  const afterState = {
    onHand: pool.on_hand,
    reserved: newReserved,
    available: pool.on_hand - newReserved,
  }

  console.log(
    `  ✅ id=${pool.id} | reserved ${oldReserved} → ${newReserved} | available ${beforeState.available} → ${afterState.available}`,
  )

  // Fire-and-forget audit log entry
  try {
    await p.auditLog.create({
      data: {
        action: 'inventory_pool.drift_corrected',
        entityType: 'inventory_pool',
        entityId: pool.id,
        companyId: orgToCompany.get(pool.organization_id) ?? null,
        organizationId: pool.organization_id,
        oldValues: JSON.stringify({
          ...beforeState,
          orgVariantId: pool.org_variant_id,
          locationId: pool.location_id,
        }),
        newValues: JSON.stringify({
          ...afterState,
          orgVariantId: pool.org_variant_id,
          locationId: pool.location_id,
        }),
        metadata: JSON.stringify({
          reason: 'cancel_order_historical_drift',
          note: 'Historical cancelOrder() leaked reservations pre-atomicity-fix. Reserved value corrected to match actual sum of OrderItem.quantity for fulfillmentStatus=reserved items.',
          correctedAt: new Date().toISOString(),
          ghostPoolExcluded: GHOST_POOL_ID,
        }),
      },
    })
    auditLogSuccess++
  } catch (e) {
    auditLogFailure++
    console.error(`  ⚠️  Failed to insert audit log for pool ${pool.id}:`, e)
  }
}

// ── Step 3: Write audit logs for ambiguous pools (documented reason) ──
console.log(`\n── Writing audit logs for ${ambiguousPools.length} ambiguous pools (no correction) ──`)

let ambiguousAuditSuccess = 0
let ambiguousAuditFailure = 0

for (const pool of ambiguousPools) {
  const newReserved = Number(pool.actual_reserved_sum)
  try {
    await p.auditLog.create({
      data: {
        action: 'inventory_pool.drift_skipped_ambiguous',
        entityType: 'inventory_pool',
        entityId: pool.id,
        companyId: orgToCompany.get(pool.organization_id) ?? null,
        organizationId: pool.organization_id,
        oldValues: JSON.stringify({
          onHand: pool.on_hand,
          reserved: pool.reserved,
          available: pool.on_hand - pool.reserved,
          orgVariantId: pool.org_variant_id,
          locationId: pool.location_id,
        }),
        newValues: JSON.stringify({
          onHand: pool.on_hand,
          reserved: pool.reserved, // unchanged
          available: pool.on_hand - pool.reserved,
          orgVariantId: pool.org_variant_id,
          locationId: pool.location_id,
        }),
        metadata: JSON.stringify({
          reason: 'cancel_order_historical_drift_ambiguous',
          wouldBeReserved: newReserved,
          onHand: pool.on_hand,
          note: `Drift detected but correction skipped: setting reserved=${newReserved} would exceed onHand=${pool.on_hand}, creating a new active violation (reserved > onHand). Likely cause: order items tagged 'reserved' but no matching physical stock at this location (made_to_order variant with NULL pool, or backordered items mistakenly tagged reserved). Manual review required.`,
          skippedAt: new Date().toISOString(),
          ghostPoolExcluded: GHOST_POOL_ID,
        }),
      },
    })
    ambiguousAuditSuccess++
    console.log(`  📝 audit log written for ambiguous pool ${pool.id} (wouldBeReserved=${newReserved} > onHand=${pool.on_hand})`)
  } catch (e) {
    ambiguousAuditFailure++
    console.error(`  ⚠️  Failed to insert audit log for ambiguous pool ${pool.id}:`, e)
  }
}

// ── Summary ──
console.log('\n' + '═'.repeat(80))
console.log('DRIFT POOL CORRECTION COMPLETE')
console.log('═'.repeat(80))
console.log(`Total drift pools found:        ${driftPools.length}`)
console.log(`Ghost pool (excluded):          ${ghostPool ? 1 : 0}  (id=${GHOST_POOL_ID})`)
console.log(`Ambiguous pools (skipped):      ${ambiguousPools.length}`)
console.log(`Safe pools corrected:           ${corrected}`)
console.log(`  - safe-pool audit logs OK:    ${auditLogSuccess}`)
console.log(`  - safe-pool audit logs FAIL:  ${auditLogFailure}`)
console.log(`  - ambiguous audit logs OK:    ${ambiguousAuditSuccess}`)
console.log(`  - ambiguous audit logs FAIL:  ${ambiguousAuditFailure}`)

// ── Idempotency check ──
const remainingDrift = await p.$queryRaw<{ count: bigint }[]>`
  SELECT COUNT(*)::bigint AS count FROM "InventoryPool" p
  WHERE p.reserved != COALESCE((
      SELECT SUM(oi.quantity) FROM "OrderItem" oi
      WHERE oi."orgVariantId" = p."orgVariantId"
        AND oi."reservedLocationId" = p."locationId"
        AND oi."fulfillmentStatus" = 'reserved'
    ), 0);
`
console.log(`\n── Idempotency check ──`)
console.log(`Remaining drift pools after correction: ${Number(remainingDrift[0]?.count ?? 0)}`)
console.log(`  (Expected: ghost pool (1) + ambiguous pools (${ambiguousPools.length}) = ${1 + ambiguousPools.length})`)

await p.$disconnect()
console.log('\nDone.')
