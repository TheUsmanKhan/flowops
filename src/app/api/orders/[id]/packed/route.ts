import { ApiError, handleError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/orders/[id]/packed — mark a confirmed/processing order as packed. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { markOrderPacked } = await import('@/lib/actions/order.actions')
    const result = await markOrderPacked(id)
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to mark order as packed')
    }
    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
