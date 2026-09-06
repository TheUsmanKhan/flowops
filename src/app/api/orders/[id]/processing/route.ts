import { ApiError, handleError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/orders/[id]/processing — mark a confirmed order as processing. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { markOrderProcessing } = await import('@/lib/actions/order.actions')
    const result = await markOrderProcessing(id)
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to mark order as processing')
    }
    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
