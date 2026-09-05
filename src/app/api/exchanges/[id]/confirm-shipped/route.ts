import { ApiError, handleError, readBody } from '@/lib/workspace'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/exchanges/[id]/confirm-shipped — customer_self_return: mark customer confirmed shipped. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { confirmCustomerShippedOldItem } = await import('@/lib/actions/exchange.actions')
    const body = await readBody<Record<string, unknown>>(req)
    const result = await confirmCustomerShippedOldItem({
      exchange_id: id,
      customer_return_tracking_number:
        typeof body.customer_return_tracking_number === 'string'
          ? body.customer_return_tracking_number
          : undefined,
      customer_return_courier:
        typeof body.customer_return_courier === 'string' ? body.customer_return_courier : undefined,
    })
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed to confirm shipment')
    return Response.json({ ok: true })
  } catch (err) {
    return handleError(err)
  }
}
