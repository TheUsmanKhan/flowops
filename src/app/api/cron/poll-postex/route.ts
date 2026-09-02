import { NextRequest } from 'next/server'
import { pollPostExOrderStatuses } from '@/lib/actions/postex-status-poll.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/cron/poll-postex
 *
 * Recurring PostEx status polling job — intended to be called every 30
 * minutes by an external scheduler (Vercel Cron, systemd timer, etc.).
 *
 * Polls ALL active PostEx integrations across ALL companies, fetches
 * tracking status from PostEx's bulk-track API, and updates each order's
 * courierSubStatus + lastPolledAt. Transitions order status:
 *   - "Picked By PostEx" → dispatched
 *   - "Delivered" → delivered
 *   - "Returned" → rto
 *
 * AUTH: shared secret in x-cron-secret header (same as sync-cities).
 * Set CRON_SECRET env var for this to function.
 *
 * ASYNC: returns immediately with "polling started" — the actual polling
 * runs in the background (PostEx's API can take 30-60s per batch).
 */
export async function POST(req: NextRequest) {
  try {
    const cronSecret = process.env.CRON_SECRET
    if (!cronSecret) {
      console.error('[cron/poll-postex] CRON_SECRET env var is not set — refusing to run.')
      return Response.json(
        { error: 'Server misconfiguration: CRON_SECRET is not set.' },
        { status: 500 },
      )
    }

    const providedSecret = req.headers.get('x-cron-secret') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (providedSecret !== cronSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Fire-and-forget: run the polling in the background so the HTTP
    // response doesn't time out (PostEx API can be slow).
    ;(async () => {
      try {
        console.log('[cron/poll-postex] Starting status polling...')
        const result = await pollPostExOrderStatuses()
        if (result.success) {
          console.log(`[cron/poll-postex] Polling complete:`, result.data)
        } else {
          console.error(`[cron/poll-postex] Polling failed:`, result.error)
        }
      } catch (err) {
        console.error('[cron/poll-postex] Fatal error:', err)
      }
    })()

    return Response.json({
      success: true,
      message: 'PostEx status polling started in the background.',
    })
  } catch (err) {
    console.error('[cron/poll-postex] Fatal error:', err)
    return Response.json(
      { error: err instanceof Error ? err.message : 'Polling failed' },
      { status: 500 },
    )
  }
}

export async function GET(req: NextRequest) {
  return POST(req)
}
