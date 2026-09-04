import { db } from '@/lib/db'
import { handleError } from '@/lib/workspace'
import { resolveOrderScope } from '@/lib/order-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * List orders ready to dispatch — status IN ('confirmed','processing') AND
 * every order_item has fulfillment_status='reserved' (no backordered items).
 */
export async function GET() {
  try {
    const { ctx, scopeFilter } = await resolveOrderScope()

    // BUG FIX (H12): moved the "every item must be reserved" check from
    // JS filter to DB-level Prisma relation filter. This is more efficient
    // (DB does the filtering, no 200 rows loaded into memory just to filter
    // in JS) and correctly excludes orders with backordered items.
    const orders = await db.order.findMany({
      where: {
        companyId: ctx.company.id,
        status: { in: ['confirmed', 'processing'] },
        ...scopeFilter,
        items: { every: { fulfillmentStatus: 'reserved' } },
      },
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
        items: { select: { id: true, fulfillmentStatus: true, quantity: true, lineTotal: true } },
      },
      orderBy: { confirmedAt: 'asc' },
      take: 200,
    })

    // DB-level filter handles the "every item reserved" check now —
    // no need for JS filter. All returned orders are already ready to dispatch.
    const ready = orders

    const totalValue = ready.reduce((s, o) => s + Number(o.totalOrderValue), 0)

    return Response.json({
      orders: ready.map((o) => ({
        id: o.id,
        flowopsOrderNumber: o.flowopsOrderNumber,
        status: o.status,
        paymentType: o.paymentType,
        paymentStatus: o.paymentStatus,
        totalOrderValue: Number(o.totalOrderValue),
        itemCount: o.items.length,
        customerName: o.customer.name,
        customerPhone: o.customer.phones[0]?.phoneRaw ?? null,
        courierName: o.courierName,
        trackingNumber: o.trackingNumber,
        confirmedAt: o.confirmedAt?.toISOString() ?? null,
        packedAt: o.packedAt?.toISOString() ?? null,
        dispatchLocationId: o.dispatchLocationId,
      })),
      stats: { count: ready.length, totalValue },
    })
  } catch (err) {
    return handleError(err)
  }
}
