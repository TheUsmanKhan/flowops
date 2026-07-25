import { ApiError, handleError } from '@/lib/workspace'
import { markOrderPacked } from '@/lib/actions/order.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/orders/[id]/packed — mark a confirmed/processing order as packed. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const result = await markOrderPacked(id)
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to mark order as packed')
    }
    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
