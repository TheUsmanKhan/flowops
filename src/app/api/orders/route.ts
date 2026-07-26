import { ApiError, handleError, readBody } from '@/lib/workspace'
import {
  listOrders,
  createManualOrder,
} from '@/lib/actions/order.actions'
import type { CreateManualOrderInput } from '@/lib/validations/order.schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Parse a query parameter that may be either comma-separated
 * ("statuses=pending,confirmed") or repeated ("statuses=pending&statuses=confirmed")
 * into a string[].
 */
function parseArrayParam(url: URL, key: string): string[] {
  const all = url.searchParams.getAll(key)
  if (all.length === 0) return []
  const out: string[] = []
  for (const v of all) {
    if (!v) continue
    for (const part of v.split(',')) {
      const trimmed = part.trim()
      if (trimmed) out.push(trimmed)
    }
  }
  return out
}

/**
 * GET /api/orders
 * List orders for the active company.
 *
 * Supported query params:
 *   - Multi-select (comma-separated OR repeated):
 *       statuses, payment_types, payment_statuses, order_sources, courier_names
 *   - Single-value (backward compat):
 *       status, payment_type, payment_status, order_source, courier_name
 *   - Range:
 *       amount_min, amount_max (numbers — total_order_value >= / <=)
 *       date_from, date_to (ISO date strings)
 *   - Scalar:
 *       customer_id, org_variant_id, search, limit, offset
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)

    // Multi-select filters (preferred)
    const statuses = parseArrayParam(url, 'statuses')
    const paymentTypes = parseArrayParam(url, 'payment_types')
    const paymentStatuses = parseArrayParam(url, 'payment_statuses')
    const orderSources = parseArrayParam(url, 'order_sources')
    const courierNames = parseArrayParam(url, 'courier_names')

    // Single-value backward-compat filters
    const status = url.searchParams.get('status') ?? ''
    const paymentType = url.searchParams.get('payment_type') ?? ''
    const paymentStatus = url.searchParams.get('payment_status') ?? ''
    const orderSource = url.searchParams.get('order_source') ?? ''
    const courierName = url.searchParams.get('courier_name') ?? ''

    // Scalar filters
    const customerId = url.searchParams.get('customer_id') ?? ''
    const orgVariantId = url.searchParams.get('org_variant_id') ?? ''
    const search = url.searchParams.get('search') ?? ''
    const dateFrom = url.searchParams.get('date_from') ?? ''
    const dateTo = url.searchParams.get('date_to') ?? ''

    // Range filters
    const amountMinRaw = url.searchParams.get('amount_min')
    const amountMaxRaw = url.searchParams.get('amount_max')
    const amountMin = amountMinRaw ? Number(amountMinRaw) : undefined
    const amountMax = amountMaxRaw ? Number(amountMaxRaw) : undefined

    const limit = url.searchParams.get('limit')
      ? Number(url.searchParams.get('limit'))
      : undefined
    const offset = url.searchParams.get('offset')
      ? Number(url.searchParams.get('offset'))
      : undefined

    const result = await listOrders({
      // Multi-select (preferred)
      statuses: statuses.length > 0 ? statuses : undefined,
      paymentTypes: paymentTypes.length > 0 ? paymentTypes : undefined,
      paymentStatuses: paymentStatuses.length > 0 ? paymentStatuses : undefined,
      orderSources: orderSources.length > 0 ? orderSources : undefined,
      courierNames: courierNames.length > 0 ? courierNames : undefined,
      // Single-value backward compat
      status: status || undefined,
      paymentType: paymentType || undefined,
      paymentStatus: paymentStatus || undefined,
      orderSource: orderSource || undefined,
      courierName: courierName || undefined,
      // Scalar
      customerId: customerId || undefined,
      orgVariantId: orgVariantId || undefined,
      search: search || undefined,
      // Range
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      amountMin: amountMin !== undefined && !Number.isNaN(amountMin) ? amountMin : undefined,
      amountMax: amountMax !== undefined && !Number.isNaN(amountMax) ? amountMax : undefined,
      // Pagination
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
