import { db } from '@/lib/db'
import { handleError } from '@/lib/workspace'
import { resolveOrderScope } from '@/lib/order-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** List cancelled orders (read-only history). */
export async function GET() {
  try {
    const { ctx, scopeFilter } = await resolveOrderScope()

    const orders = await db.order.findMany({
      where: { companyId: ctx.company.id, status: 'cancelled', ...scopeFilter },
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
      },
      orderBy: { cancelledAt: 'desc' },
      take: 200,
    })

    return Response.json({
      orders: orders.map((o) => ({
        id: o.id,
        flowopsOrderNumber: o.flowopsOrderNumber,
        orderSource: o.orderSource,
        status: o.status,
        totalOrderValue: Number(o.totalOrderValue),
        customerName: o.customer.name,
        customerPhone: o.customer.phones[0]?.phoneRaw ?? null,
        cancellationReason: o.cancellationReason ?? '—',
        cancelledAt: o.cancelledAt?.toISOString() ?? null,
        createdAt: o.createdAt.toISOString(),
      })),
      stats: { count: orders.length },
    })
  } catch (err) {
    return handleError(err)
  }
}
