import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Dismiss an auto-processed return review item — confirms the
 * auto-assumed condition (perfect / resellable) was correct after physical
 * spot-check. Removes the item from the review queue.
 *
 * Path param `id` is the ORDER id; query/body must carry the order_item id
 * because the dismiss action targets a single line item.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const { id: _orderId } = await params
    void _orderId
    const url = new URL(req.url)
    const orderItemId = url.searchParams.get('item_id')
    if (!orderItemId) {
      throw new ApiError(400, 'item_id query parameter is required')
    }

    const { dismissReturnReview } = await import('@/lib/actions/order-return.actions')
    const result = await dismissReturnReview(orderItemId)
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to dismiss review')
    }
    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
