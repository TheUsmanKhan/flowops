import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { listOverdueExchanges } from '@/lib/actions/exchange.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/exchanges/overdue?days_threshold=7 — list overdue exchanges for alerts. */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const daysThreshold = url.searchParams.get('days_threshold')
      ? Number(url.searchParams.get('days_threshold'))
      : 7
    const result = await listOverdueExchanges(daysThreshold)
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed to list overdue exchanges')
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
