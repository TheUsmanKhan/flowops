import { db } from '@/lib/db'
import { handleError } from '@/lib/workspace'
import { resolveOrderScope } from '@/lib/order-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * List RTO orders for the active company, with items-needing-review counts
 * for the "Needs Review" filter on the returns page.
 */
export async function GET(req: Request) {
  try {
    const { ctx, scopeFilter } = await resolveOrderScope()

    const url = new URL(req.url)
    const needsReviewOnly = url.searchParams.get('filter') === 'needs_review'

    let orders = await db.order.findMany({
      where: { companyId: ctx.company.id, status: 'rto', ...scopeFilter },
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
        items: {
          select: {
            id: true,
            needsReview: true,
            quantity: true,
            lineTotal: true,
          },
        },
      },
      orderBy: { returnedAt: 'desc' },
      take: 200,
    })

    if (needsReviewOnly) {
      orders = orders.filter((o) => o.items.some((i) => i.needsReview))
    }

    const totalRtoCount = orders.length
    const totalRtoValue = orders.reduce((s, o) => s + Number(o.totalOrderValue), 0)
    const itemsNeedingReview = orders.reduce(
      (s, o) => s + o.items.filter((i) => i.needsReview).length,
      0,
    )

    return Response.json({
      orders: orders.map((o) => {
        const reviewCount = o.items.filter((i) => i.needsReview).length
        return {
          id: o.id,
          flowopsOrderNumber: o.flowopsOrderNumber,
          status: o.status,
          totalOrderValue: Number(o.totalOrderValue),
          customerName: o.customer.name,
          customerPhone: o.customer.phones[0]?.phoneRaw ?? null,
          itemCount: o.items.length,
          itemsNeedingReview: reviewCount,
          needsReview: reviewCount > 0,
          returnedAt: o.returnedAt?.toISOString() ?? null,
        }
      }),
      stats: {
        totalRtoCount,
        totalRtoValue,
        itemsNeedingReview,
      },
    })
  } catch (err) {
    return handleError(err)
  }
}
