import { NextRequest } from 'next/server'
import { syncAllCourierCities } from '@/lib/actions/city-sync.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/cron/sync-cities
 *
 * Recurring city sync job — intended to be called every 3 hours by an
 * external scheduler (Vercel Cron, systemd timer, etc.).
 *
 * AUTHENTICATION: protected by a shared secret passed in the
 * `x-cron-secret` header, checked against the CRON_SECRET env var. This
 * prevents public abuse while allowing any external scheduler to trigger
 * the job without a user session.
 *
 * EXTERNAL SCHEDULER SETUP (still required — cannot be done from within
 * this codebase alone):
 *   - Vercel: add to vercel.json (see the project's vercel.json file for
 *     the exact config — schedule "0 every-3-hours" path /api/cron/sync-cities).
 *     AND set CRON_SECRET in Vercel env vars. Vercel Cron automatically
 *     sends the secret in the Authorization header (configure it as a
 *     bearer token). See: https://vercel.com/docs/cron-jobs
 *   - Other hosts: configure a systemd timer, GitHub Actions scheduled
 *     workflow, or any scheduler that POSTs to this endpoint every 3h
 *     with header `x-cron-secret: <CRON_SECRET value>`.
 *
 * The CRON_SECRET env var MUST be set for this route to function. If it's
 * not set, the route returns 500 (misconfiguration) to make the gap obvious.
 */
export async function POST(req: NextRequest) {
  try {
    // ── Auth: shared secret ──
    const cronSecret = process.env.CRON_SECRET
    if (!cronSecret) {
      console.error('[cron/sync-cities] CRON_SECRET env var is not set — refusing to run.')
      return Response.json(
        { error: 'Server misconfiguration: CRON_SECRET is not set.' },
        { status: 500 },
      )
    }

    const providedSecret = req.headers.get('x-cron-secret') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (providedSecret !== cronSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // ── Run the sync ──
    const startTime = Date.now()
    console.log('[cron/sync-cities] Starting scheduled city sync...')
    const results = await syncAllCourierCities()
    const durationMs = Date.now() - startTime

    const summary = results.map((r) => ({
      provider: r.providerKey,
      success: r.success,
      fetched: r.fetchedCount,
      upserted: r.upsertedCount,
      disabled: r.disabledCount,
      error: r.error,
    }))

    console.log(`[cron/sync-cities] Completed in ${durationMs}ms`, summary)

    return Response.json({
      success: true,
      durationMs,
      results: summary,
    })
  } catch (err) {
    console.error('[cron/sync-cities] Fatal error:', err)
    return Response.json(
      { error: err instanceof Error ? err.message : 'Sync failed' },
      { status: 500 },
    )
  }
}

/** Also support GET for simple health-check / manual browser triggers. */
export async function GET(req: NextRequest) {
  return POST(req)
}
