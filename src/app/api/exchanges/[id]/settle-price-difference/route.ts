import { ApiError, handleError, readBody } from '@/lib/workspace'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/exchanges/[id]/settle-price-difference — settle the price difference. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { settlePriceDifference } = await import('@/lib/actions/exchange.actions')
    const body = await readBody<Record<string, unknown>>(req)
    const result = await settlePriceDifference({
      exchange_id: id,
      settled_amount: Number(body.settled_amount ?? 0),
      settlement_type: body.settlement_type as 'collected_from_customer' | 'refunded_to_customer',
    })
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed to settle price difference')
    return Response.json({ ok: true })
  } catch (err) {
    return handleError(err)
  }
}
