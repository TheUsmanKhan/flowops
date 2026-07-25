import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { correctReturnItemCondition } from '@/lib/actions/order-return.actions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Correct an auto-processed return item's condition to 'damaged'.
 *
 * Reverses the auto-processed return transaction (which assumed the item was
 * perfect/resellable) and creates a proper stock_loss_records entry. Opens
 * a damage investigation on the linked variant.
 *
 * Path param `id` is the ORDER id; query must carry `item_id` (the order_item).
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

    const result = await correctReturnItemCondition(orderItemId, 'damaged')
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to correct item condition')
    }
    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
