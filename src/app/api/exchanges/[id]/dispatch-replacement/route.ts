import { NextRequest } from 'next/server'
import { handleError, readBody } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface DispatchReplacementBody {
  // Universal courier reference fields (migration 015) — optional overrides
  orderRefNumber?: string
  orderDetail?: string
}

/**
 * POST /api/exchanges/[id]/dispatch-replacement
 *
 * customer_self_return path — dispatch the replacement shipment AFTER the
 * old item has been manually verified as received.
 *
 * Body (all optional):
 *   - orderRefNumber: overrides the default EXCH-##### reference
 *   - orderDetail: overrides the auto-generated item summary
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { dispatchReplacementForSelfReturnExchange } = await import('@/lib/actions/exchange.actions')
    let body: DispatchReplacementBody = {}
    try {
      body = await readBody<DispatchReplacementBody>(req)
    } catch {
      // No JSON body — that's fine, use defaults
    }
    const result = await dispatchReplacementForSelfReturnExchange(id, {
      orderRefNumber: body.orderRefNumber,
      orderDetail: body.orderDetail,
    })
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json(result.data, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
