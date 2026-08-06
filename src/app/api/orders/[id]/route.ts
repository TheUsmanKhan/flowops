import { db } from '@/lib/db'
import { ApiError, handleError } from '@/lib/workspace'
import { getWorkspace } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/orders/[id]
 * Returns the full order detail with customer, items, dispatch location, and
 * additional payment / timeline fields needed by the OMS detail page.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getWorkspace()
    const { id } = await params

    const order = await db.order.findFirst({
      where: { id, companyId: ctx.company.id },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            email: true,
            isFlagged: true,
            flaggedReason: true,
            totalOrdersCount: true,
            totalRtoCount: true,
            // Customer Management System: phones live in customer_phones now.
            // Include the primary phone for display.
            phones: {
              where: { isPrimary: true },
              take: 1,
              select: { phoneRaw: true, phoneNormalized: true },
            },
          },
        },
        items: {
          include: {
            orgVariant: {
              select: {
                id: true,
                sku: true,
                attributeValues: true,
                fulfillmentType: true,
                product: { select: { title: true } },
              },
            },
            productionOrder: { select: { id: true, status: true, assignedTailor: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        dispatchLocation: { select: { id: true, name: true, city: true } },
      },
    })

    if (!order) throw new ApiError(404, 'Order not found')

    return Response.json({
      order: {
        id: order.id,
        flowopsOrderNumber: order.flowopsOrderNumber,
        externalOrderReference: order.externalOrderReference,
        externalOrderId: order.externalOrderId,
        orderSource: order.orderSource,
        status: order.status,
        paymentType: order.paymentType,
        paymentStatus: order.paymentStatus,
        paymentSource: order.paymentSource,

        subtotal: Number(order.subtotal),
        discountAmount: order.discountAmount ? Number(order.discountAmount) : null,
        discountReason: order.discountReason,
        courierCharges: order.courierCharges ? Number(order.courierCharges) : null,
        estimatedDeliveryCharge: order.estimatedDeliveryCharge ? Number(order.estimatedDeliveryCharge) : null,
        actualDeliveryCharge: order.actualDeliveryCharge ? Number(order.actualDeliveryCharge) : null,
        taxAmount: order.taxAmount ? Number(order.taxAmount) : null,
        taxLabel: order.taxLabel ?? null,
        totalOrderValue: Number(order.totalOrderValue),

        advanceAmount: order.advanceAmount ? Number(order.advanceAmount) : null,
        advancePaymentMethod: order.advancePaymentMethod,
        advancePaymentReference: order.advancePaymentReference,
        advancePaymentScreenshotUrl: order.advancePaymentScreenshotUrl,
        advancePaidAt: order.advancePaidAt?.toISOString() ?? null,

        remainingCodAmount: order.remainingCodAmount
          ? Number(order.remainingCodAmount)
          : null,
        codCollected: order.codCollected,
        codCollectedAmount: order.codCollectedAmount
          ? Number(order.codCollectedAmount)
          : null,
        codCollectedAt: order.codCollectedAt?.toISOString() ?? null,

        deliveryAddress: order.deliveryAddress,
        deliveryCity: order.deliveryCity,
        courierName: order.courierName,
        trackingNumber: order.trackingNumber,
        courierCompanyIntegrationId: order.courierCompanyIntegrationId,
        courierBookingStatus: order.courierBookingStatus,
        courierCityStatus: order.courierCityStatus,
        courierSubStatus: order.courierSubStatus,
        needsShipperAdvice: order.needsShipperAdvice,
        unrecognizedCourierStatus: order.unrecognizedCourierStatus,
        notesForCourier: order.notesForCourier,
        // Universal courier reference fields (migration 015)
        orderRefNumber: order.orderRefNumber,
        orderDetail: order.orderDetail,
        dispatchLocationId: order.dispatchLocationId,
        dispatchLocation: order.dispatchLocation
          ? {
              id: order.dispatchLocation.id,
              name: order.dispatchLocation.name,
              city: order.dispatchLocation.city,
            }
          : null,

        skippedConfirmation: order.skippedConfirmation,
        skippedPacking: order.skippedPacking,

        convertedBy: order.convertedBy,
        confirmedAt: order.confirmedAt?.toISOString() ?? null,
        packedAt: order.packedAt?.toISOString() ?? null,
        dispatchedAt: order.dispatchedAt?.toISOString() ?? null,
        deliveredAt: order.deliveredAt?.toISOString() ?? null,
        cancelledAt: order.cancelledAt?.toISOString() ?? null,
        cancellationReason: order.cancellationReason,
        returnedAt: order.returnedAt?.toISOString() ?? null,
        convertedAt: order.convertedAt?.toISOString() ?? null,

        createdAt: order.createdAt.toISOString(),
      },
      customer: {
        ...order.customer,
        // Convenience: flatten the primary phone for backwards-compatible
        // frontend consumption. The full phones array is also available.
        primaryPhone: order.customer.phones[0]?.phoneRaw ?? null,
      },
      items: order.items.map((item) => {
        let attributeValues: Record<string, string> = {}
        try {
          attributeValues = JSON.parse(item.orgVariant.attributeValues) as Record<string, string>
        } catch {
          attributeValues = {}
        }
        return {
          id: item.id,
          orgVariantId: item.orgVariantId,
          quantity: item.quantity,
          unitPrice: Number(item.unitPrice),
          lineTotal: Number(item.lineTotal),
          fulfillmentStatus: item.fulfillmentStatus,
          fulfillmentTypeSnapshot: item.fulfillmentTypeSnapshot,
          returnedStitchedUsed: item.returnedStitchedUsed,
          needsReview: item.needsReview,
          backorderedAt: item.backorderedAt?.toISOString() ?? null,
          fulfilledAt: item.fulfilledAt?.toISOString() ?? null,
          productionOrderId: item.productionOrderId,
          productionOrder: item.productionOrder
            ? {
                id: item.productionOrder.id,
                status: item.productionOrder.status,
                assignedTailor: item.productionOrder.assignedTailor,
              }
            : null,
          variant: {
            sku: item.orgVariant.sku,
            productTitle: item.orgVariant.product.title,
            attributeValues,
            fulfillmentType: item.orgVariant.fulfillmentType,
          },
        }
      }),
    })
  } catch (err) {
    return handleError(err)
  }
}
