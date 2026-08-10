import { NextRequest } from 'next/server'
import { pollLeopardOrderStatuses } from '@/lib/actions/leopard-webhook.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/cron/poll-leopard-safety-net
 *
 * Low-frequency safety-net poll for Leopard orders/shipments whose webhooks
 * MAY have been missed. Runs 1-2 times daily (NOT every 30 minutes like PostEx,
 * since Leopard's primary status mechanism is push-webhooks, not polling).
 *
 * Targets ONLY orders where lastPolledAt is older than 12 hours OR NULL —
 * deliberately a backstop, not a routine full-sweep.
 *
 * AUTH: shared secret in x-cron-secret header (same as poll-postex).
 */
export async function POST(req: NextRequest) {
  try {
    const cronSecret = process.env.CRON_SECRET
    if (!cronSecret) {
      console.error('[cron/poll-leopard-safety-net] CRON_SECRET env var is not set — refusing to run.')
      return Response.json(
        { error: 'Server misconfiguration: CRON_SECRET is not set.' },
        { status: 500 },
      )
    }

    const providedSecret = req.headers.get('x-cron-secret') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (providedSecret !== cronSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Fire-and-forget: run the polling in the background
    ;(async () => {
      try {
        console.log('[cron/poll-leopard-safety-net] Starting safety-net polling...')
        const result = await pollLeopardOrderStatuses()
        if (result.success) {
          console.log(`[cron/poll-leopard-safety-net] Polling complete:`, result.data)
        } else {
          console.error(`[cron/poll-leopard-safety-net] Polling failed:`, result.error)
        }
      } catch (err) {
        console.error('[cron/poll-leopard-safety-net] Fatal error:', err)
      }
    })()

    return Response.json({
      success: true,
      message: 'Leopard safety-net polling started in the background.',
    })
  } catch (err) {
    console.error('[cron/poll-leopard-safety-net] Fatal error:', err)
    return Response.json(
      { error: err instanceof Error ? err.message : 'Polling failed' },
      { status: 500 },
    )
  }
}

export async function GET(req: NextRequest) {
  return POST(req)
}
