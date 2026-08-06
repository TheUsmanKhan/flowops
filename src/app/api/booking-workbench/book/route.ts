import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'
import { decryptCredentials } from '@/lib/utils/encryption'
import { getCourierAdapter } from '@/lib/integrations/registry'
import { executeLoggedIntegrationAction } from '@/lib/integrations/logged-call'
import { revalidateCityAtBookingTime } from '@/lib/integrations/city-matcher'
import { determinePostExOrderType } from '@/lib/integrations/couriers/postex.order-type'
import { calculateOrderWeightKg } from '@/lib/utils/order-weight'
import type { BookShipmentInput, BookShipmentResult } from '@/lib/integrations/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface BookOrderRequest {
  orderId: string
  companyIntegrationId: string
  // Editable overrides from the Workbench UI
  customerName?: string
  customerPhone?: string
  deliveryAddress?: string
  deliveryCity?: string
  codAmount?: number
  orderType?: string // if not provided, auto-computed
  transactionNotes?: string
  itemDescription?: string
  pickupAddressCode?: string
}

/**
 * POST /api/booking-workbench/book
 *
 * Books a single order with the selected courier (currently PostEx only).
 * Called per-row from the Booking Workbench UI — each row submits independently.
 *
 * On success: updates the Order record with courierCompanyIntegrationId,
 * trackingNumber, courierCityStatus='matched', and courierSubStatus.
 */
export async function POST(req: NextRequest) {
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
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.ORDERS_FULFILL },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to fulfill orders.')

    const body = await readBody<BookOrderRequest>(req)
    if (!body.orderId || !body.companyIntegrationId) {
      return Response.json({ error: 'orderId and companyIntegrationId are required' }, { status: 400 })
    }

    // Fetch the integration
    const integration = await db.companyIntegration.findFirst({
      where: { id: body.companyIntegrationId, companyId, isActive: true },
      include: { provider: true },
    })
    if (!integration) {
      return Response.json({ error: 'Courier integration not found or inactive.' }, { status: 404 })
    }

    const providerKey = integration.provider.providerKey
    if (providerKey !== 'postex') {
      return Response.json({ error: `Booking not yet implemented for provider '${providerKey}'.` }, { status: 400 })
    }

    // Fetch the order with items + variant weights
    const order = await db.order.findFirst({
      where: { id: body.orderId, companyId },
      include: {
        customer: { select: { id: true, name: true, phones: { select: { id: true, phoneRaw: true, isPrimary: true } } } },
        items: {
          include: {
            orgVariant: {
              select: { id: true, sku: true, weightKg: true, product: { select: { title: true } } },
            },
          },
        },
      },
    })
    if (!order) {
      return Response.json({ error: 'Order not found.' }, { status: 404 })
    }

    // Use overrides from the Workbench or fall back to order data
    const customerName = body.customerName?.trim() || order.customer?.name || 'Customer'
    const customerPhone = body.customerPhone?.trim() || order.customer?.phones.find((p) => p.isPrimary)?.phoneRaw || order.customer?.phones[0]?.phoneRaw || ''
    const deliveryAddress = body.deliveryAddress?.trim() || order.deliveryAddress || ''
    const deliveryCity = body.deliveryCity?.trim() || order.deliveryCity || ''
    const codAmount = body.codAmount ?? Number(order.remainingCodAmount ?? order.totalOrderValue ?? 0)
    const itemDescription = body.itemDescription || order.items.map((i) => `${i.orgVariant.product.title} (${i.orgVariant.sku}) ×${i.quantity}`).join(', ')
    const transactionNotes = body.transactionNotes || ''

    if (!deliveryCity) {
      return Response.json({ error: 'Delivery city is required.' }, { status: 400 })
    }
    if (!customerPhone) {
      return Response.json({ error: 'Customer phone is required.' }, { status: 400 })
    }

    // Revalidate city at booking time (Prompt 2)
    const cityValid = await revalidateCityAtBookingTime(providerKey, deliveryCity)
    if (!cityValid) {
      // Update the order's courierCityStatus to 'unresolved'
      await db.order.update({
        where: { id: body.orderId },
        data: { courierCityStatus: 'unresolved' },
      })
      return Response.json({
        error: `City "${deliveryCity}" is not available for delivery with ${integration.provider.providerName}. Please resolve the city and try again.`,
      }, { status: 400 })
    }

    // Compute weight + orderType (Prompt 1 + Prompt 4)
    const weightResult = calculateOrderWeightKg(
      order.items.map((i) => ({
        quantity: i.quantity,
        variant: { weightKg: i.orgVariant.weightKg as { toNumber: () => number } | number | null },
      })),
    )

    const orderType = body.orderType || determinePostExOrderType(
      weightResult.totalWeightKg,
      weightResult.hasMissingWeight,
      false, // isExchangeReplacement=false for regular orders
    )

    // Get pickup address code from the integration's default pickup address
    let pickupAddressCode = body.pickupAddressCode
    if (!pickupAddressCode) {
      const defaultAddr = await db.courierPickupAddress.findFirst({
        where: { companyIntegrationId: integration.id, isDefault: true },
        select: { providerAddressCode: true },
      })
      pickupAddressCode = defaultAddr?.providerAddressCode
    }

    // Build the BookShipmentInput
    const bookInput: BookShipmentInput = {
      orderNumber: order.flowopsOrderNumber,
      recipientName: customerName,
      recipientPhone: customerPhone,
      deliveryAddress,
      deliveryCity,
      pickupLocationAddress: '',
      pickupLocationCity: '',
      weightGrams: Math.round(weightResult.totalWeightKg * 1000),
      codAmount,
      itemDescription,
      pickupAddressCode,
      orderType,
      quantity: order.items.reduce((sum, i) => sum + i.quantity, 0),
      transactionNotes,
    }

    // Decrypt credentials + get adapter
    const credentials = decryptCredentials(integration.credentialsEncrypted!)
    const adapter = getCourierAdapter(providerKey, credentials)

    // Call bookShipment via the logged wrapper
    const bookResult = await executeLoggedIntegrationAction<BookShipmentResult>({
      companyIntegrationId: integration.id,
      organizationId: orgId,
      actionType: 'book_shipment',
      direction: 'outbound',
      relatedEntityType: 'order',
      relatedEntityId: body.orderId,
      fn: async () => adapter.bookShipment(bookInput),
    })

    if (!bookResult.success || !bookResult.trackingNumber) {
      return Response.json({
        error: bookResult.error || 'PostEx booking failed — no tracking number returned.',
      }, { status: 400 })
    }

    // Update the Order with tracking + courier info + booking status
    await db.order.update({
      where: { id: body.orderId },
      data: {
        courierCompanyIntegrationId: integration.id,
        trackingNumber: bookResult.trackingNumber,
        courierCityStatus: 'matched',
        courierSubStatus: bookResult.providerStatus ?? null,
        courierName: integration.provider.providerName,
        courierBookingStatus: 'booked',
      },
    })

    return Response.json({
      success: true,
      trackingNumber: bookResult.trackingNumber,
      orderType,
      providerStatus: bookResult.providerStatus,
    })
  } catch (err) {
    return handleError(err)
  }
}
