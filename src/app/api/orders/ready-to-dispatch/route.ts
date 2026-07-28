import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * List orders ready to dispatch — status IN ('confirmed','processing') AND
 * every order_item has fulfillment_status='reserved' (no backordered items).
 */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const orders = await db.order.findMany({
      where: { companyId, status: { in: ['confirmed', 'processing'] } },
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

    const ready = orders.filter(
      (o) => o.items.length > 0 && o.items.every((i) => i.fulfillmentStatus === 'reserved'),
    )

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
