import { ApiError, handleError, readBody } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { cancelExchangeRequest } from '@/lib/actions/exchange.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/exchanges/[id]/cancel — cancel an exchange (only before dispatch). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await readBody<Record<string, unknown>>(req)
    const result = await cancelExchangeRequest({
      exchange_id: id,
      reason: String(body.reason ?? ''),
    })
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed to cancel exchange')
    return Response.json({ ok: true })
  } catch (err) {
    return handleError(err)
  }
}
