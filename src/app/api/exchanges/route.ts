import { ApiError, handleError, readBody, getWorkspace } from '@/lib/workspace'
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
    const idempotencyKey = req.headers.get('Idempotency-Key')
    const body = await readBody<Record<string, unknown>>(req)

    // Build the action input up-front so both paths use identical data.
    const input = {
      original_order_item_id: String(body.original_order_item_id ?? ''),
      new_org_variant_id: String(body.new_org_variant_id ?? ''),
      exchange_method: body.exchange_method as 'courier_replacement' | 'customer_self_return',
      reason: String(body.reason ?? ''),
    }

    // Core creation logic — calls the action function and throws on failure
    // so withIdempotency marks the ticket as 'failed' (allowing genuine retry).
    const runCreate = async () => {
      const result = await createExchangeRequest(input)
      if (!result.success) {
        throw new ApiError(400, result.error ?? 'Failed to create exchange')
      }
      return result.data
    }

    if (idempotencyKey) {
      // Resolve workspace at the route layer so we have companyId/employeeId
      // to scope the idempotency key. The action function re-resolves the
      // same workspace internally — that's a single extra JOIN, acceptable.
      const ctx = await getWorkspace()
      const { withIdempotency } = await import('@/lib/idempotency')
      const { result, wasReplay } = await withIdempotency({
        key: idempotencyKey,
        companyId: ctx.company.id,
        employeeId: ctx.employee.id,
        actionType: 'exchange.create',
        fn: runCreate,
      })
      return Response.json(result, { status: wasReplay ? 200 : 201 })
    }

    // No idempotency key — normal flow (backwards-compatible)
    const data = await runCreate()
    return Response.json(data, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
