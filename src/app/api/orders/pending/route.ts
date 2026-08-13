import { db } from '@/lib/db'
import { handleError } from '@/lib/workspace'
import { resolveOrderScope } from '@/lib/order-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** List orders WHERE status='pending' for the active company. */
export async function GET() {
  try {
    const { ctx, scopeFilter } = await resolveOrderScope()

    const orders = await db.order.findMany({
      where: { companyId: ctx.company.id, status: 'pending', ...scopeFilter },
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
        _count: { select: { items: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    })

    const totalValueAtRisk = orders.reduce((s, o) => s + Number(o.totalOrderValue), 0)

    return Response.json({
      orders: orders.map((o) => ({
        id: o.id,
        flowopsOrderNumber: o.flowopsOrderNumber,
        orderSource: o.orderSource,
        status: o.status,
        paymentType: o.paymentType,
        paymentStatus: o.paymentStatus,
        totalOrderValue: Number(o.totalOrderValue),
        itemCount: o._count.items,
        customerName: o.customer.name,
        customerPhone: o.customer.phones[0]?.phoneRaw ?? null,
        createdAt: o.createdAt.toISOString(),
      })),
      stats: {
        count: orders.length,
        totalValueAtRisk,
      },
    })
  } catch (err) {
    return handleError(err)
  }
}
