import { NextRequest } from 'next/server'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { dispatchExchangeNewItem } from '@/lib/actions/exchange.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface DispatchNewItemBody {
  // Universal courier reference fields (migration 015) — optional overrides
  orderRefNumber?: string
  orderDetail?: string
}

/**
 * POST /api/exchanges/[id]/dispatch-new-item
 *
 * courier_replacement path — dispatch the new replacement item immediately
 * (the courier collects the old item during this same delivery).
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
    // Body is optional — read silently if present (the modal sends it, the
    // immediate-dispatch button on the exchange detail page may not).
    let body: DispatchNewItemBody = {}
    try {
      body = await readBody<DispatchNewItemBody>(req)
    } catch {
      // No JSON body — that's fine, use defaults
    }
    const result = await dispatchExchangeNewItem(id, {
      orderRefNumber: body.orderRefNumber,
      orderDetail: body.orderDetail,
    })
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed to dispatch new item')
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
