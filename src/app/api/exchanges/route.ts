import { db } from '@/lib/db'
import { handleError, readBody, getWorkspace, ApiError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/exchanges — list exchanges with filters.
 *
 * Inlined from exchange.actions.ts to avoid loading the 1350-line module
 * (which has deep transitive deps that fail on Hostinger production).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const ctx = await getWorkspace()

    const limit = Math.min(
      url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50,
      100,
    )
    const offset = url.searchParams.get('offset')
      ? Number(url.searchParams.get('offset'))
      : 0

    const status = url.searchParams.get('status') ?? undefined
    const exchangeMethod = (url.searchParams.get('exchange_method') as
      | 'courier_replacement'
      | 'customer_self_return') ?? undefined
    const dateFrom = url.searchParams.get('date_from') ?? undefined
    const dateTo = url.searchParams.get('date_to') ?? undefined

    const where: {
      companyId: string
      status?: string
      exchangeMethod?: string
      requestedAt?: { gte?: Date; lte?: Date }
    } = {
      companyId: ctx.company.id,
    }
    if (status) where.status = status
    if (exchangeMethod) where.exchangeMethod = exchangeMethod
    if (dateFrom || dateTo) {
      where.requestedAt = {}
      if (dateFrom) where.requestedAt.gte = new Date(dateFrom)
      if (dateTo) where.requestedAt.lte = new Date(dateTo)
    }

    const [exchanges, total] = await Promise.all([
      db.orderExchange.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          originalOrder: { select: { flowopsOrderNumber: true } },
          newOrder: { select: { flowopsOrderNumber: true } },
          exchangeShipments: {
            select: {
              id: true,
              exchangeShipmentNumber: true,
              status: true,
              trackingNumber: true,
              courierSubStatus: true,
              dispatchedAt: true,
              deliveredAt: true,
              returnedAt: true,
              createdAt: true,
              invoiceAmount: true,
              quantity: true,
            },
            orderBy: { createdAt: 'desc' },
          },
        },
      }),
      db.orderExchange.count({ where }),
    ])

    return Response.json({
      exchanges: exchanges.map((e) => ({
        id: e.id,
        exchangeMethod: e.exchangeMethod,
        status: e.status,
        reason: e.reason,
        oldItemPrice: Number(e.oldItemPrice),
        newItemPrice: Number(e.newItemPrice),
        priceDifference: Number(e.priceDifference),
        priceDifferenceStatus: e.priceDifferenceStatus,
        requestedAt: e.requestedAt,
        completedAt: e.completedAt,
        originalOrderId: e.originalOrderId,
        originalOrder: e.originalOrder,
        newOrderId: e.newOrderId,
        newOrder: e.newOrder,
        exchangeShipments: e.exchangeShipments,
      })),
      total,
    })
  } catch (err) {
    return handleError(err)
  }
}

/** POST /api/exchanges — create a new exchange request. */
export async function POST(req: Request) {
  try {
    const idempotencyKey = req.headers.get('Idempotency-Key')
    const body = await readBody<Record<string, unknown>>(req)

    const input = {
      original_order_item_id: String(body.original_order_item_id ?? ''),
      new_org_variant_id: String(body.new_org_variant_id ?? ''),
      exchange_method: body.exchange_method as 'courier_replacement' | 'customer_self_return',
      reason: String(body.reason ?? ''),
    }

    // Dynamic import — exchange.actions.ts is 1350 lines with heavy transitive deps
    const { createExchangeRequest } = await import('@/lib/actions/exchange.actions')

    const runCreate = async () => {
      const result = await createExchangeRequest(input)
      if (!result.success) {
        throw new ApiError(400, result.error ?? 'Failed to create exchange')
      }
      return result.data
    }

    if (idempotencyKey) {
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

    const data = await runCreate()
    return Response.json(data, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
