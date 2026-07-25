import { ApiError, handleError, readBody } from '@/lib/workspace'
import { markCodCollected } from '@/lib/actions/order.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/orders/[id]/cod-collected — mark COD as collected from the customer. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await readBody<{ collected_amount?: number }>(req)
    const collectedAmount = Number(body.collected_amount)
    if (!Number.isFinite(collectedAmount) || collectedAmount < 0) {
      throw new ApiError(400, 'collected_amount must be a non-negative number')
    }
    const result = await markCodCollected({
      order_id: id,
      collected_amount: collectedAmount,
    })
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to mark COD collected')
    }
    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
