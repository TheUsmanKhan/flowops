import { ApiError, handleError, readBody } from '@/lib/workspace'
import {
  createExchangeRequest,
  listExchanges,
} from '@/lib/actions/exchange.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/exchanges — list exchanges with filters. */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const result = await listExchanges({
      status: url.searchParams.get('status') ?? undefined,
      exchangeMethod:
        (url.searchParams.get('exchange_method') as 'courier_replacement' | 'customer_self_return') ??
        undefined,
      dateFrom: url.searchParams.get('date_from') ?? undefined,
      dateTo: url.searchParams.get('date_to') ?? undefined,
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
      offset: url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : undefined,
    })
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed to list exchanges')
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}

/** POST /api/exchanges — create a new exchange request. */
export async function POST(req: Request) {
  try {
    const body = await readBody<Record<string, unknown>>(req)
    const result = await createExchangeRequest({
      original_order_item_id: String(body.original_order_item_id ?? ''),
      new_org_variant_id: String(body.new_org_variant_id ?? ''),
      exchange_method: body.exchange_method as 'courier_replacement' | 'customer_self_return',
      reason: String(body.reason ?? ''),
    })
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed to create exchange')
    return Response.json(result.data, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
