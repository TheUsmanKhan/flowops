import { ApiError, handleError, readBody } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { markExchangeAsNotReturned } from '@/lib/actions/exchange.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/exchanges/[id]/mark-not-returned — terminal "customer did not return" outcome. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await readBody<Record<string, unknown>>(req)
    const result = await markExchangeAsNotReturned({
      exchange_id: id,
      not_returned_reason: String(body.not_returned_reason ?? ''),
      recovery_status: body.recovery_status as 'pending' | 'recovered' | 'written_off',
      recovery_amount: body.recovery_amount ? Number(body.recovery_amount) : undefined,
    })
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed to mark as not returned')
    return Response.json({ ok: true })
  } catch (err) {
    return handleError(err)
  }
}
