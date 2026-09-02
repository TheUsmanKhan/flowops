import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { cancelOrder } from '@/lib/actions/order.actions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Cancel an order. Releases any reserved stock. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const { id } = await params
    const body = await readBody<{ cancellation_reason?: string }>(req)
    const reason = (body.cancellation_reason ?? '').trim()
    if (reason.length < 3) {
      throw new ApiError(400, 'Cancellation reason must be at least 3 characters')
    }

    const result = await cancelOrder({ order_id: id, cancellation_reason: reason })
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to cancel order')
    }
    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
