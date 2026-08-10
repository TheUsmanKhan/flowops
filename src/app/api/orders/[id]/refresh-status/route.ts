import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { trackSingleOrderStatus } from '@/lib/actions/postex-status-poll.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/orders/[id]/refresh-status
 *
 * Manually refresh a SINGLE order's courier status via the adapter's
 * trackShipment() method (NOT the bulk polling job). This is the per-order
 * immediate check wired to the "Refresh Courier Status" button on the Order
 * Detail page.
 *
 * Faster and cheaper than POST /api/couriers/postex/poll (which iterates all
 * active orders). Uses the single-tracking endpoint (GET /v1/track-order/{tn}).
 *
 * Applies the same status transitions as the bulk poll (auto-dispatch on
 * in_transit, mark delivered, RTO handling).
 *
 * Response: { success, data: { status, subStatus, updated } }
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const result = await trackSingleOrderStatus(id)
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to refresh status')
    }
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
