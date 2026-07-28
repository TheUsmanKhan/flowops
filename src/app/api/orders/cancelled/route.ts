import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** List cancelled orders (read-only history). */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const orders = await db.order.findMany({
      where: { companyId, status: 'cancelled' },
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
