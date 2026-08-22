import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'
import { bookOrderWithCourier } from '@/lib/actions/booking.actions'
import { decryptCredentials } from '@/lib/utils/encryption'
import { getCourierAdapter } from '@/lib/integrations/registry'
import { executeLoggedIntegrationAction } from '@/lib/integrations/logged-call'
import { revalidateCityAtBookingTime } from '@/lib/integrations/city-matcher'
import { determinePostExOrderType } from '@/lib/integrations/couriers/postex.order-type'
import { calculateOrderWeightKg } from '@/lib/utils/order-weight'
import type { BookShipmentInput, BookShipmentResult } from '@/lib/integrations/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface BookRequest {
  // One of these must be provided
  orderId?: string
  shipmentId?: string
  companyIntegrationId: string
  // Editable overrides from the Workbench UI
  customerName?: string
  customerPhone?: string
  deliveryAddress?: string
  deliveryCity?: string
  codAmount?: number
  orderType?: string
  transactionNotes?: string
  itemDescription?: string
  orderRefNumber?: string
  pickupAddressCode?: string
}

/**
 * POST /api/booking-workbench/book
 *
 * Books a single order OR exchange shipment with the selected courier.
 * Called per-row from the Booking Workbench UI.
 *
 * For ORDERS: delegates to bookOrderWithCourier() server action (shared
 * with the auto-booking flow).
 *
 * For EXCHANGE SHIPMENTS: handles inline (the exchange-shipment booking
 * path is not used by auto-booking, so it stays in the route for now).
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

    const body = await readBody<BookRequest>(req)
    if (!body.companyIntegrationId) {
      return Response.json({ error: 'companyIntegrationId is required' }, { status: 400 })
    }
    if (!body.orderId && !body.shipmentId) {
      return Response.json({ error: 'Either orderId or shipmentId is required' }, { status: 400 })
    }

    // ── ORDER booking: delegate to the server action ──
    if (body.orderId) {
      const result = await bookOrderWithCourier({
        orderId: body.orderId,
        companyIntegrationId: body.companyIntegrationId,
        customerName: body.customerName,
        customerPhone: body.customerPhone,
        deliveryAddress: body.deliveryAddress,
        deliveryCity: body.deliveryCity,
        codAmount: body.codAmount,
        orderType: body.orderType,
        transactionNotes: body.transactionNotes,
        itemDescription: body.itemDescription,
        orderRefNumber: body.orderRefNumber,
        pickupAddressCode: body.pickupAddressCode,
      })

      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 })
      }
      return Response.json(result.data)
    }

    // ── EXCHANGE SHIPMENT booking: handled inline ──
    return await bookExchangeShipment(body, companyId, orgId)
  } catch (err) {
    return handleError(err)
  }
}

/**
 * Book an exchange shipment with the selected courier.
 */
async function bookExchangeShipment(
  body: BookRequest,
  companyId: string,
  orgId: string,
): Promise<Response> {
  const integration = await db.companyIntegration.findFirst({
    where: { id: body.companyIntegrationId!, companyId, isActive: true },
    include: { provider: true },
  })
  if (!integration) {
    return Response.json({ error: 'Courier integration not found or inactive.' }, { status: 404 })
  }

  const providerKey = integration.provider.providerKey
  if (providerKey !== 'postex') {
    return Response.json({ error: `Booking not yet implemented for provider '${providerKey}'.` }, { status: 400 })
  }

  const shipment = await db.exchangeShipment.findFirst({
    where: { id: body.shipmentId!, companyId },
    include: {
      customer: {
        select: {
          id: true, name: true,
          phones: { select: { id: true, phoneRaw: true, isPrimary: true }, orderBy: { isPrimary: 'desc' } },
        },
      },
      shippingAddress: { select: { address: true, city: true, country: true } },
      shippingPhone: { select: { phoneRaw: true } },
      newOrgVariant: {
        select: { id: true, sku: true, weightKg: true, product: { select: { title: true } } },
      },
      orderExchange: {
        select: { id: true, exchangeMethod: true, originalOrder: { select: { flowopsOrderNumber: true } } },
      },
    },
  })
  if (!shipment) {
    return Response.json({ error: 'Exchange shipment not found.' }, { status: 404 })
  }

  const customerName = body.customerName?.trim() || shipment.customer?.name || 'Customer'
  const customerPhone =
    body.customerPhone?.trim() ||
    shipment.shippingPhone?.phoneRaw ||
    shipment.customer?.phones.find((p) => p.isPrimary)?.phoneRaw ||
    shipment.customer?.phones[0]?.phoneRaw || ''
  const deliveryAddress = body.deliveryAddress?.trim() || shipment.shippingAddress?.address || ''
  const deliveryCity = body.deliveryCity?.trim() || shipment.shippingAddress?.city || shipment.shippingCityOverride || ''
  const codAmount = body.codAmount ?? Number(shipment.invoiceAmount)
  const orderRefNumber =
    body.orderRefNumber?.trim() ||
    (shipment.orderRefNumber && shipment.orderRefNumber.trim()) ||
    shipment.exchangeShipmentNumber
  const itemDescription =
    body.itemDescription?.trim() ||
    (shipment.orderDetail && shipment.orderDetail.trim()) ||
    `${shipment.newOrgVariant.product.title} (${shipment.newOrgVariant.sku}) ×${shipment.quantity}`
  const transactionNotes = body.transactionNotes?.trim() || ''
  const isExchangeReplacement = shipment.orderExchange.exchangeMethod === 'courier_replacement'

  if (!deliveryCity) {
    return Response.json({ error: 'Delivery city is required.' }, { status: 400 })
  }
  if (!customerPhone) {
    return Response.json({ error: 'Customer phone is required.' }, { status: 400 })
  }

  const cityValid = await revalidateCityAtBookingTime(providerKey, deliveryCity, integration.id, shipment.shippingAddress?.country ?? undefined)
  if (!cityValid) {
    await db.exchangeShipment.update({
      where: { id: shipment.id },
      data: { courierCityStatus: 'unresolved' },
    })
    return Response.json({
      error: `City "${deliveryCity}" is not available for delivery with ${integration.provider.providerName}.`,
    }, { status: 400 })
  }

  const weightResult = calculateOrderWeightKg([
    {
      quantity: shipment.quantity,
      variant: { weightKg: shipment.newOrgVariant.weightKg ? Number(shipment.newOrgVariant.weightKg) : null },
    },
  ])

  const orderType = body.orderType || determinePostExOrderType(
    weightResult.totalWeightKg,
    weightResult.hasMissingWeight,
    isExchangeReplacement,
  )

  let pickupAddressCode = body.pickupAddressCode
  if (!pickupAddressCode) {
    const defaultAddr = await db.courierPickupAddress.findFirst({
      where: { companyIntegrationId: integration.id, isDefault: true },
      select: { providerAddressCode: true },
    })
    pickupAddressCode = defaultAddr?.providerAddressCode
  }

  const bookInput: BookShipmentInput = {
    orderNumber: orderRefNumber,
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
    quantity: shipment.quantity,
    transactionNotes,
  }

  const credentials = decryptCredentials(integration.credentialsEncrypted!)
  const adapter = getCourierAdapter(providerKey, credentials)

  const bookResult = await executeLoggedIntegrationAction<BookShipmentResult>({
    companyIntegrationId: integration.id,
    organizationId: orgId,
    actionType: 'book_shipment',
    direction: 'outbound',
    relatedEntityType: 'exchange_shipment',
    relatedEntityId: shipment.id,
    fn: async () => adapter.bookShipment(bookInput),
  })

  if (!bookResult.success || !bookResult.trackingNumber) {
    return Response.json({
      error: bookResult.error || 'Booking failed — no tracking number returned.',
    }, { status: 400 })
  }

  // Update the shipment — note: ExchangeShipment has no courierName column
  // (courier is identified by courierCompanyIntegrationId + the provider name
  // is looked up via the relation). We set the integration ID + tracking +
  // booking status.
  // Map the PostEx providerStatus through the status map for canonical subStatus
  const { mapPostExStatus } = await import('@/lib/integrations/couriers/postex.status-map')
  const mappedBookingStatus = bookResult.providerStatus
    ? mapPostExStatus(bookResult.providerStatus)
    : null

  await db.exchangeShipment.update({
    where: { id: shipment.id },
    data: {
      courierCompanyIntegrationId: integration.id,
      trackingNumber: bookResult.trackingNumber,
      courierCityStatus: 'matched',
      courierSubStatus: mappedBookingStatus?.courierSubStatus ?? null,
      courierBookingStatus: 'booked',
    },
  })

  return Response.json({
    success: true,
    trackingNumber: bookResult.trackingNumber,
    orderType,
    providerStatus: bookResult.providerStatus,
  })
}
