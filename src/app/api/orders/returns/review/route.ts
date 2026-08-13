import { db } from '@/lib/db'
import { handleError } from '@/lib/workspace'
import { resolveOrderItemScope } from '@/lib/order-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** List order_items WHERE needsReview=true (exception review queue). */
export async function GET() {
  try {
    const { ctx, orderScopeFilter } = await resolveOrderItemScope()

    const items = await db.orderItem.findMany({
      where: { needsReview: true, order: { companyId: ctx.company.id, ...orderScopeFilter } },
      include: {
        order: {
          select: { id: true, flowopsOrderNumber: true, returnedAt: true, status: true },
        },
        orgVariant: {
          select: { id: true, sku: true, product: { select: { title: true } } },
        },
      },
      orderBy: { updatedAt: 'asc' },
      take: 200,
    })

    return Response.json({
      items: items.map((item) => ({
        id: item.id,
        orderId: item.order.id,
        flowopsOrderNumber: item.order.flowopsOrderNumber,
        variantId: item.orgVariant.id,
        sku: item.orgVariant.sku,
        productTitle: item.orgVariant.product.title,
        quantity: item.quantity,
        fulfillmentTypeSnapshot: item.fulfillmentTypeSnapshot,
        autoProcessedAsPerfect: item.autoProcessedAsPerfect,
        // For display: auto-processed condition (perfect/resellable)
        autoProcessedCondition:
          item.fulfillmentTypeSnapshot === 'made_to_order' ? 'perfect' : 'resellable',
        returnedAt: item.order.returnedAt?.toISOString() ?? null,
      })),
      stats: { count: items.length },
    })
  } catch (err) {
    return handleError(err)
  }
}
