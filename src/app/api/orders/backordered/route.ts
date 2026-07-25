import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** List backordered order items grouped by variant (FIFO by backorderedAt). */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const items = await db.orderItem.findMany({
      where: {
        fulfillmentStatus: 'backordered',
        order: { companyId, status: { notIn: ['cancelled', 'refunded'] } },
      },
      include: {
        order: {
          select: {
            id: true,
            flowopsOrderNumber: true,
            status: true,
            customer: { select: { name: true, phone: true } },
          },
        },
        orgVariant: {
          select: {
            id: true,
            sku: true,
            product: { select: { title: true } },
          },
        },
      },
      orderBy: { backorderedAt: 'asc' },
    })

    const now = Date.now()
    const daysSince = (iso: string | null) =>
      iso ? Math.max(0, Math.floor((now - new Date(iso).getTime()) / (1000 * 60 * 60 * 24))) : 0

    const groupedMap = new Map<
      string,
      {
        variantId: string
        sku: string
        productTitle: string
        orders: Array<{
          orderItemId: string
          orderId: string
          flowopsOrderNumber: string
          orderStatus: string
          customerName: string
          customerPhone: string
          quantity: number
          backorderedAt: string | null
          daysWaiting: number
        }>
        totalQuantity: number
        totalValue: number
        oldestDays: number
      }
    >()

    let totalBackorderedItems = 0
    let totalBackorderedValue = 0
    let oldestWaitDays = 0

    for (const item of items) {
      const key = item.orgVariantId
      if (!groupedMap.has(key)) {
        groupedMap.set(key, {
          variantId: item.orgVariant.id,
          sku: item.orgVariant.sku,
          productTitle: item.orgVariant.product.title,
          orders: [],
          totalQuantity: 0,
          totalValue: 0,
          oldestDays: 0,
        })
      }
      const group = groupedMap.get(key)!
      const days = daysSince(item.backorderedAt?.toISOString() ?? null)
      const lineValue = Number(item.lineTotal)
      group.orders.push({
        orderItemId: item.id,
        orderId: item.order.id,
        flowopsOrderNumber: item.order.flowopsOrderNumber,
        orderStatus: item.order.status,
        customerName: item.order.customer.name,
        customerPhone: item.order.customer.phone,
        quantity: item.quantity,
        backorderedAt: item.backorderedAt?.toISOString() ?? null,
        daysWaiting: days,
      })
      group.totalQuantity += item.quantity
      group.totalValue += lineValue
      group.oldestDays = Math.max(group.oldestDays, days)

      totalBackorderedItems += item.quantity
      totalBackorderedValue += lineValue
      oldestWaitDays = Math.max(oldestWaitDays, days)
    }

    const groups = Array.from(groupedMap.values()).sort((a, b) => b.oldestDays - a.oldestDays)

    return Response.json({
      groups,
      stats: {
        totalBackorderedItems,
        totalBackorderedValue,
        oldestWaitDays,
        variantCount: groups.length,
      },
    })
  } catch (err) {
    return handleError(err)
  }
}
