import { NextRequest } from 'next/server'
import { detectInventoryDrift } from '@/lib/actions/detect-inventory-drift'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/cron/detect-inventory-drift
 *
 * Weekly drift-detection sweep for the Inventory Core module.
 *
 * WHAT IT DOES
 * ------------
 * Runs the same drift-detection SQL query used by
 * `scripts/correct-drift-pools.ts`:
 *
 *   SELECT pools WHERE pool.reserved != SUM(OrderItem.quantity
 *     WHERE orgVariantId+locationId match AND fulfillmentStatus='reserved')
 *
 * For each NEW drift pool found (one not previously logged as
 * `inventory_pool.drift_detected_scheduled` in the past 14 days), writes
 * a per-pool AuditLog entry with:
 *   - action       = 'inventory_pool.drift_detected_scheduled'
 *   - entityType   = 'inventory_pool'
 *   - entityId     = pool.id
 *   - oldValues    = { onHand, reserved, available, orgVariantId, locationId }
 *   - newValues    = { onHand, reserved, actualReservedSum, available, ... }
 *   - metadata     = { reason, detectedAt, actualReservedSum, delta, note }
 *
 * If ZERO new drift is found (either because there is no drift at all,
 * or because all current drift pools were already logged in a prior run),
 * writes a single "clean run" summary AuditLog entry instead:
 *   - entityId = 'none'
 *   - metadata = { summary: 'clean_run', driftedPools, newDrift, knownDrift, ... }
 *
 * IMPORTANT: This route is DETECTION-ONLY. It does not auto-correct drift
 * pools. Auto-correction remains the responsibility of the operator (via
 * `scripts/correct-drift-pools.ts` for known-safe pools) or manual data
 * repair (for ambiguous / ghost pools). The sweep surfaces drift; humans
 * decide what to do about it.
 *
 * AUTH
 * ----
 * Shared secret in `x-cron-secret` header (same as the other 4 cron routes).
 * Set `CRON_SECRET` env var. GET requests are also supported for manual
 * browser triggers (useful for ad-hoc verification).
 *
 * SCHEDULE
 * --------
 * - vercel.json: `"0 3 * * 0"` (every Sunday at 03:00 UTC)
 * - instrumentation.ts: ENABLE_IN_PROCESS_DRIFT_CHECK env var (default
 *   'true') starts a 7-day interval in-process for long-lived Bun/Node
 *   servers (where Vercel cron never fires). Same pattern as PostEx poller
 *   and FX refresh.
 *
 * RESPONSE
 * --------
 * {
 *   success: true,
 *   checked:    <number>  // total InventoryPool rows in the DB
 *   drifted:    <number>  // total drift pools found in this sweep
 *   newDrift:   <number>  // drift pools NOT previously logged in prior 14 days
 *   knownDrift: <number>  // drift pools already logged in prior 14 days
 * }
 *
 * The detection logic lives in `src/lib/actions/detect-inventory-drift.ts`
 * so that BOTH this HTTP route and the in-process scheduler in
 * `instrumentation.ts` use the exact same code path. Same pattern as
 * `pollPostExOrderStatuses()` in `src/lib/actions/postex-status-poll.actions.ts`.
 */
export async function POST(req: NextRequest) {
  try {
    // ── Auth: shared secret (same pattern as refresh-exchange-rates) ──
    const cronSecret = process.env.CRON_SECRET
    if (!cronSecret) {
      console.error('[cron/detect-inventory-drift] CRON_SECRET env var is not set — refusing to run.')
      return Response.json(
        { error: 'Server misconfiguration: CRON_SECRET is not set.' },
        { status: 500 },
      )
    }

    const providedSecret = req.headers.get('x-cron-secret') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (providedSecret !== cronSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Delegate to the shared lib function (also called by instrumentation.ts).
    const result = await detectInventoryDrift()

    return Response.json({
      success: true,
      checked: result.checked,
      drifted: result.drifted,
      newDrift: result.newDrift,
      knownDrift: result.knownDrift,
      auditLogSuccess: result.auditLogSuccess,
      auditLogFailure: result.auditLogFailure,
    })
  } catch (err) {
    console.error('[cron/detect-inventory-drift] Fatal error:', err)
    return Response.json(
      { error: err instanceof Error ? err.message : 'Drift detection failed' },
      { status: 500 },
    )
  }
}

/** Also support GET for simple health-check / manual browser triggers. */
export async function GET(req: NextRequest) {
  return POST(req)
}
