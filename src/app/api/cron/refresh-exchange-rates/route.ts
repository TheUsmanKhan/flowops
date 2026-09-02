import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { syncExchangeRates } from '@/lib/exchange-rates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/cron/refresh-exchange-rates
 *
 * Fetches current exchange rates for every distinct baseCurrency across all
 * companies + stores a daily snapshot. Used for display-only revenue
 * conversion. Follows the exact same auth pattern as the other 4 cron routes.
 *
 * If the FX API fetch fails, existing snapshots remain usable — the
 * per-currency breakdown works without rates (only the estimated total
 * is affected).
 */
export async function POST(req: NextRequest) {
  try {
    // ── Auth: shared secret ──
    const cronSecret = process.env.CRON_SECRET
    if (!cronSecret) {
      console.error('[cron/refresh-exchange-rates] CRON_SECRET env var is not set — refusing to run.')
      return Response.json(
        { error: 'Server misconfiguration: CRON_SECRET is not set.' },
        { status: 500 },
      )
    }

    const providedSecret = req.headers.get('x-cron-secret') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (providedSecret !== cronSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // ── Collect all distinct base currencies across ALL companies ──
    const companies = await db.company.findMany({
      select: { baseCurrency: true },
      distinct: ['baseCurrency'],
    })
    const currencies = companies.map((c) => c.baseCurrency)

    if (currencies.length === 0) {
      return Response.json({ success: true, message: 'No companies with currencies found.', stored: 0 })
    }

    // ── Fetch + store rates ──
    const result = await syncExchangeRates(currencies)

    console.log(`[cron/refresh-exchange-rates] Stored ${result.stored} rate snapshots for ${currencies.length} currencies. Errors: ${result.errors.length}`)

    return Response.json({
      success: true,
      currencies,
      stored: result.stored,
      errors: result.errors,
    })
  } catch (err) {
    console.error('[cron/refresh-exchange-rates] Fatal error:', err)
    return Response.json(
      { error: err instanceof Error ? err.message : 'Exchange rate refresh failed' },
      { status: 500 },
    )
  }
}

/** Also support GET for simple health-check / manual browser triggers. */
export async function GET(req: NextRequest) {
  return POST(req)
}
