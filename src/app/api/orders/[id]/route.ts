import { db } from '@/lib/db'
import {
  ApiError,
  handleError,
  getWorkspace,
  requirePermission,
  getOrdersDataScope,
} from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'

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
    await requirePermission(ctx, PERMISSIONS.ORDERS_VIEW)
    const { id } = await params

    // Phase 2: Order ownership scoping — employees with role.ordersDataScope='own'
    // can only fetch orders they created (salesEmployeeId === ctx.employee.id).
    // Elevated roles + roles with ordersDataScope='all' see every company order.
    const ownScope = getOrdersDataScope(ctx) === 'own'

    const order = await db.order.findFirst({
      where: {
        id,
        companyId: ctx.company.id,
        ...(ownScope ? { salesEmployeeId: ctx.employee.id } : {}),
      },
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
        // Phase 3: sales attribution — who sold this order
        salesEmployee: {
          select: {
            id: true,
            designation: true,
            user: { select: { fullName: true } },
          },
        },
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
        deliveryCountry: order.deliveryCountry,
        // Self-fulfilled channel (Phase B1)
        fulfillmentChannel: order.fulfillmentChannel,
        selfFulfilledReferenceNumber: order.selfFulfilledReferenceNumber,
        // Phase D3: market resolution issue (external orders)
        marketResolutionIssue: order.marketResolutionIssue,
        courierName: order.courierName,
        trackingNumber: order.trackingNumber,
        courierCompanyIntegrationId: order.courierCompanyIntegrationId,
        courierBookingStatus: order.courierBookingStatus,
        courierBookingFailureReason: order.courierBookingFailureReason,
        courierCityStatus: order.courierCityStatus,
        courierSubStatus: order.courierSubStatus,
        needsShipperAdvice: order.needsShipperAdvice,
        unrecognizedCourierStatus: order.unrecognizedCourierStatus,
        lastPolledAt: order.lastPolledAt?.toISOString() ?? null,
        notesForCourier: order.notesForCourier,
        // Universal courier reference fields (migration 015)
        orderRefNumber: order.orderRefNumber,
        orderDetail: order.orderDetail,
        pickupAddressId: order.pickupAddressId,
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

        // Phase 3: sales attribution — who sold this order.
        // Null for webhook-imported orders (Shopify/Daraz) which have no
        // human salesperson to attribute to.
        salesEmployeeId: order.salesEmployeeId,
        salesEmployee: order.salesEmployee
          ? {
              id: order.salesEmployee.id,
              name: order.salesEmployee.user.fullName,
              designation: order.salesEmployee.designation,
            }
          : null,
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
          originalUnitPrice: item.originalUnitPrice ? Number(item.originalUnitPrice) : null,
          discountType: item.discountType,
          discountValue: item.discountValue ? Number(item.discountValue) : null,
          lineTotal: Number(item.lineTotal),
          fulfillmentStatus: item.fulfillmentStatus,
          fulfillmentTypeSnapshot: item.fulfillmentTypeSnapshot,
          returnedStitchedUsed: item.returnedStitchedUsed,
          needsReview: item.needsReview,
          needsReviewReason: item.needsReviewReason,
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
