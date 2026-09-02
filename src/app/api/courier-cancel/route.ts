import { NextRequest } from 'next/server'
import { handleError, readBody } from '@/lib/workspace'
import { cancelCourierBooking } from '@/lib/actions/courier-cancel.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/courier-cancel
 *
 * Cancels a courier booking on both the courier side (PostEx) and in FlowOps.
 * Only available while the shipment hasn't been physically picked up
 * (courierSubStatus must be 'slip_generated' or 'pickup_requested').
 *
 * Body: { entityType: 'order' | 'exchange_shipment', entityId: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await readBody<{ entityType: 'order' | 'exchange_shipment'; entityId: string }>(req)
    if (!body.entityType || !body.entityId) {
      return Response.json(
        { error: 'entityType and entityId are required' },
        { status: 400 },
      )
    }
    const result = await cancelCourierBooking(body.entityType, body.entityId)
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
