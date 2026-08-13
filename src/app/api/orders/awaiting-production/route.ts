import { db } from '@/lib/db'
import { handleError } from '@/lib/workspace'
import { resolveOrderItemScope } from '@/lib/order-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  fabric_reserved: 'Fabric Reserved',
  in_production: 'In Production',
  completed: 'Completed',
  dispatched: 'Dispatched',
  cancelled: 'Cancelled',
}
const STATUS_ORDER = ['pending', 'fabric_reserved', 'in_production']

/** List order items whose linked production order is NOT completed/cancelled/dispatched. */
export async function GET() {
  try {
    const { ctx, orderScopeFilter } = await resolveOrderItemScope()

    const items = await db.orderItem.findMany({
      where: {
        productionOrderId: { not: null },
        order: { companyId: ctx.company.id, ...orderScopeFilter },
        productionOrder: {
          status: { notIn: ['completed', 'cancelled', 'dispatched'] },
        },
      },
      include: {
        order: { select: { id: true, flowopsOrderNumber: true } },
        orgVariant: {
          select: { id: true, sku: true, product: { select: { title: true } } },
        },
        productionOrder: {
          select: {
            id: true,
            status: true,
            estimatedCompletionDate: true,
            assignedTailor: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    type Row = {
      orderItemId: string
      orderId: string
      flowopsOrderNumber: string
      variantId: string
      sku: string
      productTitle: string
      quantity: number
      productionOrderId: string
      productionStatus: string
      productionStatusLabel: string
      estimatedCompletionDate: string | null
      assignedTailor: string | null
    }

    const grouped: Record<string, { label: string; items: Row[] }> = {}
    for (const status of STATUS_ORDER) {
      grouped[status] = { label: STATUS_LABEL[status], items: [] }
    }

    for (const item of items) {
      const status = item.productionOrder?.status ?? 'pending'
      const row: Row = {
        orderItemId: item.id,
        orderId: item.order.id,
        flowopsOrderNumber: item.order.flowopsOrderNumber,
        variantId: item.orgVariant.id,
        sku: item.orgVariant.sku,
        productTitle: item.orgVariant.product.title,
        quantity: item.quantity,
        productionOrderId: item.productionOrder?.id ?? '',
        productionStatus: status,
        productionStatusLabel: STATUS_LABEL[status] ?? status,
        estimatedCompletionDate:
          item.productionOrder?.estimatedCompletionDate?.toISOString() ?? null,
        assignedTailor: item.productionOrder?.assignedTailor ?? null,
      }
      if (!grouped[status]) grouped[status] = { label: STATUS_LABEL[status] ?? status, items: [] }
      grouped[status].items.push(row)
    }

    const groups = Object.entries(grouped).map(([status, g]) => ({
      status,
      label: g.label,
      count: g.items.length,
      items: g.items,
    }))

    return Response.json({
      groups,
      stats: {
        totalItems: items.length,
        groupCount: groups.filter((g) => g.count > 0).length,
      },
    })
  } catch (err) {
    return handleError(err)
  }
}
