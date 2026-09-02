import { ApiError, handleError } from '@/lib/workspace'
import { markOrderDelivered } from '@/lib/actions/order.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/orders/[id]/delivered — mark a dispatched order as delivered. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const result = await markOrderDelivered(id)
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to mark order as delivered')
    }
    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
