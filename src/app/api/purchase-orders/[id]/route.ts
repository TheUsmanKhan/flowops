import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Get a single purchase order with items + receipts. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const { id } = await params
    const po = await db.purchaseOrder.findFirst({
      where: { id, companyId },
      include: {
        supplier: true,
        deliveryLocation: { select: { id: true, name: true } },
        items: {
          include: {
            orgVariant: {
              select: { id: true, sku: true, product: { select: { title: true } } },
            },
          },
        },
        receipts: {
          include: {
            items: true,
            receivedBy: { select: { id: true, user: { select: { fullName: true } } } },
          },
          orderBy: { receivedAt: 'desc' },
        },
      },
    })
    if (!po) throw new ApiError(404, 'Purchase order not found.')

    const totalItemsValue = po.items.reduce(
      (sum, item) => sum + Number(item.costPerUnit) * item.orderedQuantity,
      0,
    )

    return Response.json({
      order: {
        id: po.id,
        poNumber: po.poNumber,
        status: po.status,
        supplier: {
          id: po.supplier.id,
          name: po.supplier.name,
          contactPerson: po.supplier.contactPerson,
          phone: po.supplier.phone,
          paymentTerms: po.supplier.paymentTerms,
        },
        deliveryLocation: po.deliveryLocation,
        orderDate: po.orderDate.toISOString(),
        expectedDeliveryDate: po.expectedDeliveryDate?.toISOString() ?? null,
        advancePayment: Number(po.advancePayment),
        paymentMethod: po.paymentMethod,
        notes: po.notes,
        totalItemsValue,
        balanceDue: Math.max(0, totalItemsValue - Number(po.advancePayment)),
        items: po.items.map((item) => ({
          id: item.id,
          variant: {
            id: item.orgVariant.id,
            sku: item.orgVariant.sku,
            productTitle: item.orgVariant.product.title,
          },
          orderedQuantity: item.orderedQuantity,
          receivedQuantity: item.receivedQuantity,
          costPerUnit: Number(item.costPerUnit),
          lineTotal: Number(item.costPerUnit) * item.orderedQuantity,
          fullyReceived: item.receivedQuantity >= item.orderedQuantity,
        })),
        receipts: po.receipts.map((r) => ({
          id: r.id,
          receivedAt: r.receivedAt.toISOString(),
          receivedBy: r.receivedBy.user.fullName,
          notes: r.notes,
          items: r.items.map((ri) => ({
            id: ri.id,
            purchaseOrderItemId: ri.purchaseOrderItemId,
            receivedQuantity: ri.receivedQuantity,
            actualCostPerUnit: Number(ri.actualCostPerUnit),
            shortageQuantity: ri.shortageQuantity,
            shortageReason: ri.shortageReason,
          })),
        })),
      },
    })
  } catch (err) {
    return handleError(err)
  }
}
