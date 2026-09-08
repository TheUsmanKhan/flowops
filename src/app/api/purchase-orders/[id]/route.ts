import { db } from '@/lib/db'
import { ApiError, getWorkspace, handleError, requirePermission } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Get a single purchase order with items + receipts. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // PO-009 fix: previously used legacy `getCurrentUser()` pattern with no
    // permission check — any employee could read full PO detail incl. pricing.
    // Now uses getWorkspace() + requirePermission(INVENTORY_VIEW).
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.INVENTORY_VIEW)
    const companyId = ctx.company.id

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
