import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** List orders WHERE status='pending' for the active company. */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const orders = await db.order.findMany({
      where: { companyId, status: 'pending' },
      include: {
        customer: { select: { name: true, phone: true } },
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
        customerPhone: o.customer.phone,
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
