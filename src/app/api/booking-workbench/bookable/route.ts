import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, getOrdersDataScope } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/booking-workbench/bookable
 *
 * Returns bookable orders AND exchange shipments for the Booking Workbench.
 * Both are returned in separate arrays so the frontend can render them in tabs.
 *
 * Bookable = status confirms stock is reserved (not backordered) AND
 * courierBookingStatus != 'booked'.
 */
export async function GET(_req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    const orgId = settings?.activeOrgId
    if (!companyId || !orgId) throw new ApiError(403, 'No active company')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')

    // Phase 4 — Defensive scoping: if a custom role with ordersDataScope='own'
    // + booking permissions ever exists, filter bookable orders to only the
    // caller's attributed orders. Currently no default role combines these,
    // but the check exists defensively for future custom roles.
    const callerScope =
      caller.role.roleTier === 'elevated'
        ? 'all'
        : caller.role.ordersDataScope === 'own'
          ? 'own'
          : 'all'
    const salesEmployeeFilter =
      callerScope === 'own' ? { salesEmployeeId: caller.id } : {}

    // ── Bookable Orders ──
    // Status IN ('confirmed', 'processing'), courierBookingStatus != 'booked',
    // AND all order items have fulfillmentStatus='reserved' (no backordered items).
    const allCandidateOrders = await db.order.findMany({
      where: {
        companyId,
        status: { in: ['confirmed', 'processing'] },
        courierBookingStatus: { not: 'booked' },
        ...salesEmployeeFilter,
      },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phones: { select: { id: true, phoneRaw: true, isPrimary: true }, orderBy: { isPrimary: 'desc' } },
          },
        },
        items: {
          include: {
            orgVariant: {
              select: {
                id: true,
                sku: true,
                weightKg: true,
                fulfillmentType: true,
                product: { select: { title: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    // Filter: exclude orders with ANY backordered item
    const bookableOrders = allCandidateOrders.filter(
      (o) => !o.items.some((i) => i.fulfillmentStatus === 'backordered'),
    )

    const orders = bookableOrders.map((o) => ({
      id: o.id,
      type: 'order' as const,
      referenceNumber: o.flowopsOrderNumber,
      orderSource: o.orderSource,
      status: o.status,
      customerName: o.customer.name,
      customerPhone: o.customer.phones[0]?.phoneRaw ?? '',
      customerId: o.customer.id,
      deliveryAddress: o.deliveryAddress ?? '',
      deliveryCity: o.deliveryCity ?? '',
      codAmount: o.remainingCodAmount
        ? Number(o.remainingCodAmount)
        : Number(o.totalOrderValue),
      recommendedCourierCompanyIntegrationId: o.recommendedCourierCompanyIntegrationId,
      courierBookingStatus: o.courierBookingStatus,
      // Universal courier reference fields (migration 015) — pre-fill the
      // Workbench per-row inputs so staff can see/edit the stored values.
      orderRefNumber: o.orderRefNumber ?? o.flowopsOrderNumber,
      orderDetail: o.orderDetail ?? '',
      notesForCourier: o.notesForCourier ?? '',
      createdAt: o.createdAt.toISOString(),
      items: o.items.map((i) => ({
        variantId: i.orgVariant.id,
        sku: i.orgVariant.sku,
        productTitle: i.orgVariant.product.title,
        quantity: i.quantity,
        weightKg: i.orgVariant.weightKg ? Number(i.orgVariant.weightKg) : null,
        fulfillmentType: i.orgVariant.fulfillmentType,
      })),
    }))

    // ── Bookable Exchange Shipments ──
    // Status = 'confirmed' (not backordered, not dispatched), courierBookingStatus != 'booked'
    const bookableShipments = await db.exchangeShipment.findMany({
      where: {
        companyId,
        status: 'confirmed',
        courierBookingStatus: { not: 'booked' },
      },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phones: { select: { id: true, phoneRaw: true, isPrimary: true }, orderBy: { isPrimary: 'desc' } },
          },
        },
        shippingAddress: { select: { address: true, city: true } },
        shippingPhone: { select: { phoneRaw: true } },
        newOrgVariant: {
          select: {
            id: true,
            sku: true,
            weightKg: true,
            fulfillmentType: true,
            product: { select: { title: true } },
          },
        },
        orderExchange: {
          select: {
            id: true,
            exchangeMethod: true,
            originalOrder: { select: { flowopsOrderNumber: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    const shipments = bookableShipments.map((s) => ({
      id: s.id,
      type: 'exchange_shipment' as const,
      referenceNumber: s.exchangeShipmentNumber,
      orderSource: 'exchange',
      status: s.status,
      customerName: s.customer.name,
      customerPhone: s.shippingPhone?.phoneRaw ?? s.customer.phones[0]?.phoneRaw ?? '',
      customerId: s.customer.id,
      deliveryAddress: s.shippingAddress?.address ?? '',
      deliveryCity: s.shippingAddress?.city ?? s.shippingCityOverride ?? '',
      codAmount: Number(s.invoiceAmount),
      recommendedCourierCompanyIntegrationId: s.recommendedCourierCompanyIntegrationId,
      courierBookingStatus: s.courierBookingStatus,
      // Universal courier reference fields (migration 015) — exchange shipments
      // have no notesForCourier column, so we omit it (the book route will
      // default transactionNotes to '' for exchange shipments).
      orderRefNumber: s.orderRefNumber ?? s.exchangeShipmentNumber,
      orderDetail: s.orderDetail ?? '',
      notesForCourier: '',
      createdAt: s.createdAt.toISOString(),
      exchangeMethod: s.orderExchange.exchangeMethod,
      originalOrderNumber: s.orderExchange.originalOrder.flowopsOrderNumber,
      items: [{
        variantId: s.newOrgVariant.id,
        sku: s.newOrgVariant.sku,
        productTitle: s.newOrgVariant.product.title,
        quantity: s.quantity,
        weightKg: s.newOrgVariant.weightKg ? Number(s.newOrgVariant.weightKg) : null,
        fulfillmentType: s.newOrgVariant.fulfillmentType,
      }],
    }))

    return Response.json({ orders, shipments })
  } catch (err) {
    return handleError(err)
  }
}
