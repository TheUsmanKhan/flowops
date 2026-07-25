import { ApiError, handleError, readBody } from '@/lib/workspace'
import {
  listOrders,
  createManualOrder,
} from '@/lib/actions/order.actions'
import type { CreateManualOrderInput } from '@/lib/validations/order.schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/orders
 * List orders for the active company. Supports filters: status, payment_type,
 * order_source, search, customer_id, date_from, date_to, limit, offset.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const status = url.searchParams.get('status') ?? ''
    const paymentType = url.searchParams.get('payment_type') ?? ''
    const orderSource = url.searchParams.get('order_source') ?? ''
    const customerId = url.searchParams.get('customer_id') ?? ''
    const search = url.searchParams.get('search') ?? ''
    const dateFrom = url.searchParams.get('date_from') ?? ''
    const dateTo = url.searchParams.get('date_to') ?? ''
    const limit = url.searchParams.get('limit')
      ? Number(url.searchParams.get('limit'))
      : undefined
    const offset = url.searchParams.get('offset')
      ? Number(url.searchParams.get('offset'))
      : undefined

    const result = await listOrders({
      status: status || undefined,
      paymentType: paymentType || undefined,
      orderSource: orderSource || undefined,
      customerId: customerId || undefined,
      search: search || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      limit,
      offset,
    })

    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to list orders')
    }
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}

/**
 * POST /api/orders
 * Create a manual order. Wraps createManualOrder().
 */
export async function POST(req: Request) {
  try {
    const body = await readBody<CreateManualOrderInput>(req)
    const result = await createManualOrder(body)
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to create order')
    }
    return Response.json(result.data, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
