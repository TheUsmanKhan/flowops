import { db } from '@/lib/db'
import {
  getWorkspace,
  getOrdersDataScope,
  handleError,
  readBody,
  ApiError,
} from '@/lib/workspace'
import type { Prisma } from '@prisma/client'

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
 * This route uses `db` directly instead of importing from order.actions.ts
 * (which is 2800+ lines and pulls in a massive transitive dependency tree
 * that causes module loading failures on Hostinger's production environment).
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
 *       customer_id, org_variant_id, delivery_city, search, limit, offset
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)

    // ── Parse query params ──
    const statuses = parseArrayParam(url, 'statuses')
    const paymentTypes = parseArrayParam(url, 'payment_types')
    const paymentStatuses = parseArrayParam(url, 'payment_statuses')
    const orderSources = parseArrayParam(url, 'order_sources')
    const courierNames = parseArrayParam(url, 'courier_names')

    const status = url.searchParams.get('status') ?? ''
    const paymentType = url.searchParams.get('payment_type') ?? ''
    const paymentStatus = url.searchParams.get('payment_status') ?? ''
    const orderSource = url.searchParams.get('order_source') ?? ''
    const courierName = url.searchParams.get('courier_name') ?? ''

    const customerId = url.searchParams.get('customer_id') ?? ''
    const orgVariantId = url.searchParams.get('org_variant_id') ?? ''
    const deliveryCity = url.searchParams.get('delivery_city') ?? ''
    const search = url.searchParams.get('search') ?? ''
    const dateFrom = url.searchParams.get('date_from') ?? ''
    const dateTo = url.searchParams.get('date_to') ?? ''

    const amountMinRaw = url.searchParams.get('amount_min')
    const amountMaxRaw = url.searchParams.get('amount_max')
    const amountMin = amountMinRaw ? Number(amountMinRaw) : undefined
    const amountMax = amountMaxRaw ? Number(amountMaxRaw) : undefined

    const limit = Math.min(
      url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50,
      100,
    )
    const offset = url.searchParams.get('offset')
      ? Number(url.searchParams.get('offset'))
      : 0

    // ── Auth + workspace context ──
    const ctx = await getWorkspace()

    // ── Build Prisma where clause ──
    const where: Prisma.OrderWhereInput = {
      companyId: ctx.company.id,
    }

    // Phase 4 — Server-side scoping: if the caller's role has
    // ordersDataScope='own', filter to only their attributed orders.
    if (getOrdersDataScope(ctx) === 'own') {
      where.salesEmployeeId = ctx.employee.id
    }

    // Status filter
    if (statuses.length > 0) {
      where.status = { in: statuses }
    } else if (status) {
      where.status = status
    }

    // Payment type filter
    if (paymentTypes.length > 0) {
      where.paymentType = { in: paymentTypes }
    } else if (paymentType) {
      where.paymentType = paymentType
    }

    // Payment status filter
    if (paymentStatuses.length > 0) {
      where.paymentStatus = { in: paymentStatuses }
    } else if (paymentStatus) {
      where.paymentStatus = paymentStatus
    }

    // Order source filter
    if (orderSources.length > 0) {
      where.orderSource = { in: orderSources }
    } else if (orderSource) {
      where.orderSource = orderSource
    }

    // Courier filter
    if (courierNames.length > 0) {
      where.courierName = { in: courierNames }
    } else if (courierName) {
      where.courierName = courierName
    }

    if (customerId) where.customerId = customerId

    if (deliveryCity) {
      where.deliveryCity = { contains: deliveryCity, mode: 'insensitive' }
    }

    if (dateFrom || dateTo) {
      where.createdAt = {}
      if (dateFrom) where.createdAt.gte = new Date(dateFrom)
      if (dateTo) {
        const end = new Date(dateTo)
        end.setHours(23, 59, 59, 999)
        where.createdAt.lte = end
      }
    }

    if (amountMin !== undefined || amountMax !== undefined) {
      where.totalOrderValue = {}
      if (amountMin !== undefined && !Number.isNaN(amountMin))
        where.totalOrderValue.gte = amountMin
      if (amountMax !== undefined && !Number.isNaN(amountMax))
        where.totalOrderValue.lte = amountMax
    }

    if (orgVariantId) {
      where.items = { some: { orgVariantId } }
    }

    if (search) {
      where.OR = [
        { flowopsOrderNumber: { contains: search, mode: 'insensitive' } },
        { externalOrderReference: { contains: search, mode: 'insensitive' } },
        { customer: { name: { contains: search, mode: 'insensitive' } } },
        {
          customer: {
            phones: {
              some: { phoneRaw: { contains: search, mode: 'insensitive' } },
            },
          },
        },
      ]
    }

    // ── Execute query ──
    const [orders, total] = await Promise.all([
      db.order.findMany({
        where,
        include: {
          customer: {
            select: {
              name: true,
              phones: {
                where: { isPrimary: true },
                take: 1,
                select: { phoneRaw: true },
              },
            },
          },
          salesEmployee: {
            select: {
              id: true,
              user: { select: { fullName: true } },
            },
          },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.order.count({ where }),
    ])

    // ── Map results (same shape as listOrders) ──
    return Response.json({
      orders: orders.map((o) => ({
        id: o.id,
        flowopsOrderNumber: o.flowopsOrderNumber,
        externalOrderReference: o.externalOrderReference,
        externalOrderId: o.externalOrderId,
        orderSource: o.orderSource,
        status: o.status,
        paymentType: o.paymentType,
        paymentStatus: o.paymentStatus,
        paymentSource: o.paymentSource,
        subtotal: Number(o.subtotal),
        discountAmount: o.discountAmount ? Number(o.discountAmount) : null,
        courierCharges: o.courierCharges ? Number(o.courierCharges) : null,
        estimatedDeliveryCharge: o.estimatedDeliveryCharge
          ? Number(o.estimatedDeliveryCharge)
          : null,
        actualDeliveryCharge: o.actualDeliveryCharge
          ? Number(o.actualDeliveryCharge)
          : null,
        taxAmount: o.taxAmount ? Number(o.taxAmount) : null,
        taxLabel: o.taxLabel ?? null,
        totalOrderValue: Number(o.totalOrderValue),
        advanceAmount: o.advanceAmount ? Number(o.advanceAmount) : null,
        remainingCodAmount: o.remainingCodAmount
          ? Number(o.remainingCodAmount)
          : Math.max(
              0,
              Number(o.totalOrderValue) -
                (o.advanceAmount ? Number(o.advanceAmount) : 0),
            ),
        codCollected: o.codCollected,
        courierName: o.courierName,
        trackingNumber: o.trackingNumber,
        courierCompanyIntegrationId: o.courierCompanyIntegrationId,
        courierBookingStatus: o.courierBookingStatus,
        courierBookingFailureReason: o.courierBookingFailureReason,
        courierCityStatus: o.courierCityStatus,
        courierSubStatus: o.courierSubStatus,
        needsShipperAdvice: o.needsShipperAdvice,
        dispatchLocationId: o.dispatchLocationId,
        customerId: o.customerId,
        deliveryAddress: o.deliveryAddress,
        deliveryCity: o.deliveryCity,
        deliveryCountry: o.deliveryCountry,
        orderRefNumber: o.orderRefNumber,
        orderDetail: o.orderDetail,
        notesForCourier: o.notesForCourier,
        confirmedAt: o.confirmedAt,
        dispatchedAt: o.dispatchedAt,
        deliveredAt: o.deliveredAt,
        createdAt: o.createdAt,
        customerName: o.customer.name,
        customerPhone: o.customer.phones[0]?.phoneRaw ?? null,
        itemCount: o._count.items,
        salesEmployeeId: o.salesEmployeeId,
        salesEmployeeName: o.salesEmployee?.user?.fullName ?? null,
      })),
      total,
    })
  } catch (err) {
    return handleError(err)
  }
}

/**
 * POST /api/orders
 * Create a manual order.
 *
 * Uses dynamic import() for order.actions.ts so the heavy 2800-line module
 * (and its transitive deps) only loads when POST is actually called — NOT at
 * route module initialization time.
 */
export async function POST(req: Request) {
  try {
    const body = await readBody(req)
    const idempotencyKey = req.headers.get('Idempotency-Key')

    // Dynamic import — only loads createManualOrder when POST is called
    const { createManualOrder } = await import('@/lib/actions/order.actions')

    if (idempotencyKey) {
      const ctx = await getWorkspace()
      const { withIdempotency } = await import('@/lib/idempotency')
      const { result, wasReplay } = await withIdempotency({
        key: idempotencyKey,
        companyId: ctx.company.id,
        employeeId: ctx.employee.id,
        actionType: 'order.create',
        fn: async () => {
          const res = await createManualOrder(body)
          if (!res.success) {
            throw new ApiError(400, res.error ?? 'Failed to create order')
          }
          return res.data
        },
      })
      return Response.json(result, { status: wasReplay ? 200 : 201 })
    }

    const result = await createManualOrder(body)
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to create order')
    }
    return Response.json(result.data, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
