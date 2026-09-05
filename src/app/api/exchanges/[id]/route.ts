import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/exchanges/[id] — full exchange detail. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { getExchangeDetail } = await import('@/lib/actions/exchange.actions')
    const result = await getExchangeDetail(id)
    if (!result.success) throw new ApiError(404, result.error ?? 'Exchange not found')
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
