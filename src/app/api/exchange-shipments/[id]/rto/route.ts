import { ApiError, handleError, readBody } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { markExchangeShipmentRto } from '@/lib/actions/exchange-shipment.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/exchange-shipments/[id]/rto
 *
 * Manually mark an exchange shipment as RTO (returned by courier).
 * Mirrors the order-level RTO flow but scoped to exchange_shipments:
 *   - Restores inventory (return_resellable or return_stitched_received)
 *   - Sets status='rto', returnedAt=now()
 *   - Sets parent order_exchanges.status='exchange_item_returned' (terminal)
 *
 * INTENTIONALLY TERMINAL: no automatic re-exchange/refund is triggered.
 * Staff must manually decide what to do next.
 *
 * Body: { returnReason?: string }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await readBody<Record<string, unknown>>(req).catch(() => ({}))
    const returnReason =
      typeof body?.returnReason === 'string' ? body.returnReason : undefined

    const result = await markExchangeShipmentRto(id, returnReason)
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to mark as RTO')
    }
    return Response.json({ ok: true, ...result.data })
  } catch (err) {
    return handleError(err)
  }
}
