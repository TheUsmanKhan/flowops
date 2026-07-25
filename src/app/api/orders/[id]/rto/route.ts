import { ApiError, handleError, readBody } from '@/lib/workspace'
import { processOrderReturn } from '@/lib/actions/order-return.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/orders/[id]/rto — process a return-to-origin for a dispatched order. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await readBody<{ return_reason?: string }>(req)
    const reason = (body.return_reason ?? '').trim()
    if (reason.length < 3) {
      throw new ApiError(400, 'Return reason is required (min 3 chars)')
    }
    const result = await processOrderReturn(id, reason)
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to process return')
    }
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
