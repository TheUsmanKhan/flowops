import { NextRequest } from 'next/server'
import { handleError } from '@/lib/workspace'
import { unCancelOrder } from '@/lib/actions/order.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/orders/[id]/un-cancel
 *
 * Reverses a cancellation — restores the order to its pre-cancel status
 * (confirmed or pending), re-reserves stock, and clears cancellation fields.
 *
 * Only works if the order is currently 'cancelled'. Does NOT re-book
 * the courier — if the courier booking was cancelled, the user must
 * re-book via Booking Workbench.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const result = await unCancelOrder(id)
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
