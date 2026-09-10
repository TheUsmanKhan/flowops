/**
 * Weekly drift-detection sweep — shared library function.
 *
 * Used by:
 *   - src/app/api/cron/detect-inventory-drift/route.ts (HTTP entrypoint)
 *   - instrumentation.ts (in-process scheduler for long-lived Bun servers
 *     where Vercel cron never fires)
 *
 * Same pattern as `pollPostExOrderStatuses()` in
 * `src/lib/actions/postex-status-poll.actions.ts`: a single function
 * that does the work, called from both the HTTP route and the in-process
 * scheduler.
 *
 * DETECTION-ONLY: this function writes audit log entries for new drift
 * pools but does NOT auto-correct. Auto-correction remains the
 * responsibility of the operator (via `scripts/correct-drift-pools.ts`
 * for known-safe pools) or manual data repair (for ambiguous/ghost
 * pools).
 *
 * Audit log action: `inventory_pool.drift_detected_scheduled`
 *   - Per-pool entry for each NEW drift pool (not previously logged
 *     within the past 14 days).
 *   - Single "clean_run" summary entry if zero new drift (covers both
 *     "system is fully clean" AND "drift exists but all already known
 *     from prior sweep runs — operator hasn't acted yet").
 */
import { db } from '@/lib/db'

export interface DriftDetectionResult {
  /** Total InventoryPool rows checked. */
  checked: number
  /** Total drift pools found in this sweep. */
  drifted: number
  /** Drift pools NOT previously logged as detected in the past 14 days. */
  newDrift: number
  /** Drift pools already logged as detected in the past 14 days (not re-logged). */
  knownDrift: number
  /** Number of audit log entries successfully written. */
  auditLogSuccess: number
  /** Number of audit log entries that failed to write. */
  auditLogFailure: number
}

interface DriftPoolRow {
  id: string
  org_variant_id: string
  location_id: string
  organization_id: string
  on_hand: number
  reserved: number
  actual_reserved_sum: bigint
}

/** Lookback window for "known drift" suppression (covers 2 weekly runs). */
const KNOWN_DRIFT_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Run the weekly drift-detection sweep.
 *
 * @returns Summary counts for the response/audit-log.
 */
export async function detectInventoryDrift(): Promise<DriftDetectionResult> {
  // ── Step 1: Run the drift-detection query (same SQL as scripts/correct-drift-pools.ts) ──
  // A drift pool = one whose `reserved` value does not equal the sum of
  // OrderItem.quantity for items tagged fulfillmentStatus='reserved' at
  // (orgVariantId, reservedLocationId). Includes both over-reserved
  // (reserved > SUM, ghost possible) and under-reserved (reserved < SUM,
  // typical historical cancelOrder() leak).
  const driftPools = await db.$queryRaw<DriftPoolRow[]>`
    SELECT
      p.id,
      p."orgVariantId"  AS org_variant_id,
      p."locationId"    AS location_id,
      p."organizationId" AS organization_id,
      p."onHand"        AS on_hand,
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

  const totalPools = await db.inventoryPool.count()
  console.log(`[drift-detect] Checked ${totalPools} pools; found ${driftPools.length} drift pools`)

  // ── Step 2: Split drift pools into NEW vs KNOWN ──
  // A drift pool is "known" if a prior weekly sweep already wrote an
  // `inventory_pool.drift_detected_scheduled` audit log entry for it
  // within the past 14 days. New drift pools get a fresh per-pool audit
  // log; known drift pools are not re-logged (avoids audit log spam every
  // week for the same chronic drift pool — e.g. the 4 ambiguous pools
  // that are pending manual review).
  const fourteenDaysAgo = new Date(Date.now() - KNOWN_DRIFT_LOOKBACK_MS)
  const priorDriftLogs = await db.auditLog.findMany({
    where: {
      action: 'inventory_pool.drift_detected_scheduled',
      createdAt: { gte: fourteenDaysAgo },
    },
    select: { entityId: true },
  })
  const knownPoolIds = new Set(
    priorDriftLogs
      .map((log) => log.entityId)
      .filter((id): id is string => id !== null),
  )

  const newDriftPools = driftPools.filter((p) => !knownPoolIds.has(p.id))
  const knownDriftPools = driftPools.filter((p) => knownPoolIds.has(p.id))

  // ── Step 3: Resolve companyId per organizationId (one company per org) ──
  // InventoryPool has no companyId column. AuditLog.companyId is optional,
  // but we resolve it when possible for traceability — same pattern as
  // scripts/correct-drift-pools.ts.
  const orgIds = [...new Set(driftPools.map((p) => p.organization_id))]
  const companies = orgIds.length > 0
    ? await db.company.findMany({
        where: { organizationId: { in: orgIds } },
        select: { id: true, organizationId: true },
      })
    : []
  const orgToCompany = new Map(companies.map((c) => [c.organizationId, c.id]))

  // ── Step 4: Write audit logs ──
  let auditLogSuccess = 0
  let auditLogFailure = 0

  if (newDriftPools.length === 0) {
    // Zero new drift — write a single "clean run" summary audit log.
    // Includes the case where drifted == 0 (system is fully clean) AND
    // the case where drifted > 0 but all drift is already known (chronic
    // drift — operator hasn't acted yet, but no NEW drift since last sweep).
    try {
      await db.auditLog.create({
        data: {
          action: 'inventory_pool.drift_detected_scheduled',
          entityType: 'inventory_pool',
          entityId: 'none',
          companyId: null,
          organizationId: null,
          oldValues: null,
          newValues: null,
          metadata: JSON.stringify({
            summary: 'clean_run',
            checkedPools: totalPools,
            driftedPools: driftPools.length,
            newDrift: 0,
            knownDrift: knownDriftPools.length,
            detectedAt: new Date().toISOString(),
            note:
              driftPools.length === 0
                ? 'Weekly drift-detection sweep found zero drift pools. All InventoryPool.reserved values match SUM(OrderItem.quantity WHERE fulfillmentStatus=reserved).'
                : `Weekly drift-detection sweep found ${driftPools.length} drift pool(s), but all were already logged in a prior 14-day window. No NEW drift to report. Operator review of known drift still pending.`,
          }),
        },
      })
      auditLogSuccess++
    } catch (e) {
      auditLogFailure++
      console.error('[drift-detect] Failed to write clean-run summary audit log:', e)
    }

    console.log(
      `[drift-detect] Clean run — 0 new drift pools (drifted=${driftPools.length}, known=${knownDriftPools.length}). Summary audit log written.`,
    )
  } else {
    // One audit log per NEW drift pool only.
    for (const pool of newDriftPools) {
      const actualSum = Number(pool.actual_reserved_sum)
      const delta = actualSum - pool.reserved
      const companyId = orgToCompany.get(pool.organization_id) ?? null

      try {
        await db.auditLog.create({
          data: {
            action: 'inventory_pool.drift_detected_scheduled',
            entityType: 'inventory_pool',
            entityId: pool.id,
            companyId,
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
              reserved: pool.reserved,
              actualReservedSum: actualSum,
              available: pool.on_hand - pool.reserved,
              orgVariantId: pool.org_variant_id,
              locationId: pool.location_id,
            }),
            metadata: JSON.stringify({
              reason: 'weekly_drift_detection_sweep',
              detectedAt: new Date().toISOString(),
              actualReservedSum: actualSum,
              delta,
              note:
                'Drift detected by weekly scheduled sweep. Detection only — no auto-correction applied. Operator review required (run scripts/correct-drift-pools.ts for safe pools, manual data-repair for ambiguous/ghost pools).',
            }),
          },
        })
        auditLogSuccess++
      } catch (e) {
        auditLogFailure++
        console.error(`[drift-detect] Failed to write audit log for pool ${pool.id}:`, e)
      }
    }

    console.log(
      `[drift-detect] Wrote ${auditLogSuccess} new drift audit log(s) (${knownDriftPools.length} known drift pools already logged in prior 14-day window, not re-logged).`,
    )
  }

  return {
    checked: totalPools,
    drifted: driftPools.length,
    newDrift: newDriftPools.length,
    knownDrift: knownDriftPools.length,
    auditLogSuccess,
    auditLogFailure,
  }
}
