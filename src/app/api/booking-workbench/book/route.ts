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
  orderType?: string // if not provided, auto-computed
  transactionNotes?: string
  itemDescription?: string
  orderRefNumber?: string // universal courier reference (migration 015)
  pickupAddressCode?: string
}

/**
 * POST /api/booking-workbench/book
 *
 * Books a single order OR exchange shipment with the selected courier
 * (currently PostEx only). Called per-row from the Booking Workbench UI —
 * each row submits independently.
 *
 * Universal courier reference fields (migration 015):
 *   - orderRefNumber: defaults to flowopsOrderNumber / exchangeShipmentNumber,
 *     but the order/shipment stores a custom value (editable from the order
 *     create form). The Workbench UI can also override per-row.
 *   - itemDescription (a.k.a. orderDetail): defaults to the stored
 *     orderDetail string on the Order/ExchangeShipment; falls back to an
 *     auto-generated summary from the items.
 *   - transactionNotes: defaults to the stored notesForCourier on the
 *     Order (exchange shipments don't have notesForCourier, so '' is the
 *     fallback); the Workbench UI can override per-row.
 *
 * On success: updates the Order/ExchangeShipment with courierCompanyIntegrationId,
 * trackingNumber, courierCityStatus='matched', courierSubStatus, and
 * courierBookingStatus='booked'.
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

    // ── Resolve the row (Order or ExchangeShipment) ────────────────────────
    // We normalize to a common shape so the rest of the booking flow can be
    // identical for both. Universal courier reference fields (migration 015):
    //   - storedRefNumber: Order.orderRefNumber or ExchangeShipment.orderRefNumber
    //   - storedDetail: Order.orderDetail or ExchangeShipment.orderDetail
    //   - storedNotes: Order.notesForCourier (ExchangeShipment has no notes field)
    //   - defaultOrderNumber: flowopsOrderNumber or exchangeShipmentNumber
    //     (used as the orderRefNumber fallback when neither the stored value
    //      nor the per-row override is set)
    let rowType: 'order' | 'exchange_shipment'
    let rowId: string
    let defaultOrderNumber: string
    let storedRefNumber: string | null
    let storedDetail: string | null
    let storedNotes: string | null
    let customerNameDefault: string
    let customerPhoneDefault: string
    let deliveryAddressDefault: string
    let deliveryCityDefault: string
    let codAmountDefault: number
    let itemRows: Array<{
      quantity: number
      weightKg: number | null
      sku: string
      productTitle: string
    }>
    let isExchangeReplacement = false

    if (body.orderId) {
      rowType = 'order'
      rowId = body.orderId
      const order = await db.order.findFirst({
        where: { id: body.orderId, companyId },
        include: {
          customer: {
            select: {
              id: true, name: true,
              phones: { select: { id: true, phoneRaw: true, isPrimary: true }, orderBy: { isPrimary: 'desc' } },
            },
          },
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
      defaultOrderNumber = order.flowopsOrderNumber
      storedRefNumber = order.orderRefNumber
      storedDetail = order.orderDetail
      storedNotes = order.notesForCourier
      customerNameDefault = order.customer?.name || 'Customer'
      customerPhoneDefault =
        order.customer?.phones.find((p) => p.isPrimary)?.phoneRaw ||
        order.customer?.phones[0]?.phoneRaw || ''
      deliveryAddressDefault = order.deliveryAddress || ''
      deliveryCityDefault = order.deliveryCity || ''
      codAmountDefault = Number(order.remainingCodAmount ?? order.totalOrderValue ?? 0)
      itemRows = order.items.map((i) => ({
        quantity: i.quantity,
        weightKg: i.orgVariant.weightKg ? Number(i.orgVariant.weightKg) : null,
        sku: i.orgVariant.sku,
        productTitle: i.orgVariant.product.title,
      }))
    } else {
      rowType = 'exchange_shipment'
      rowId = body.shipmentId!
      const shipment = await db.exchangeShipment.findFirst({
        where: { id: body.shipmentId, companyId },
        include: {
          customer: {
            select: {
              id: true, name: true,
              phones: { select: { id: true, phoneRaw: true, isPrimary: true }, orderBy: { isPrimary: 'desc' } },
            },
          },
          shippingAddress: { select: { address: true, city: true } },
          shippingPhone: { select: { phoneRaw: true } },
          newOrgVariant: {
            select: {
              id: true, sku: true, weightKg: true,
              product: { select: { title: true } },
            },
          },
          orderExchange: {
            select: {
              id: true, exchangeMethod: true,
              originalOrder: { select: { flowopsOrderNumber: true } },
            },
          },
        },
      })
      if (!shipment) {
        return Response.json({ error: 'Exchange shipment not found.' }, { status: 404 })
      }
      defaultOrderNumber = shipment.exchangeShipmentNumber
      storedRefNumber = shipment.orderRefNumber
      storedDetail = shipment.orderDetail
      storedNotes = null // ExchangeShipment has no notesForCourier field
      customerNameDefault = shipment.customer?.name || 'Customer'
      customerPhoneDefault =
        shipment.shippingPhone?.phoneRaw ||
        shipment.customer?.phones.find((p) => p.isPrimary)?.phoneRaw ||
        shipment.customer?.phones[0]?.phoneRaw || ''
      deliveryAddressDefault = shipment.shippingAddress?.address || ''
      deliveryCityDefault = shipment.shippingAddress?.city || shipment.shippingCityOverride || ''
      codAmountDefault = Number(shipment.invoiceAmount)
      itemRows = [{
        quantity: shipment.quantity,
        weightKg: shipment.newOrgVariant.weightKg ? Number(shipment.newOrgVariant.weightKg) : null,
        sku: shipment.newOrgVariant.sku,
        productTitle: shipment.newOrgVariant.product.title,
      }]
      // courier_replacement exchanges map to PostEx's "Replacement" order type
      isExchangeReplacement = shipment.orderExchange.exchangeMethod === 'courier_replacement'
    }

    // ── Apply overrides + fallbacks (universal courier reference fields) ──
    const customerName = body.customerName?.trim() || customerNameDefault
    const customerPhone = body.customerPhone?.trim() || customerPhoneDefault
    const deliveryAddress = body.deliveryAddress?.trim() || deliveryAddressDefault
    const deliveryCity = body.deliveryCity?.trim() || deliveryCityDefault
    const codAmount = body.codAmount ?? codAmountDefault
    // orderRefNumber: per-row override > stored value > flowops/exch number
    const orderRefNumber =
      body.orderRefNumber?.trim() ||
      (storedRefNumber && storedRefNumber.trim()) ||
      defaultOrderNumber
    // itemDescription (a.k.a. orderDetail): per-row override > stored value >
    // auto-generated from items
    const itemDescription =
      body.itemDescription?.trim() ||
      (storedDetail && storedDetail.trim()) ||
      itemRows
        .map((i) => `${i.productTitle} (${i.sku}) ×${i.quantity}`)
        .join(', ')
    // transactionNotes: per-row override > stored notesForCourier (orders only)
    const transactionNotes =
      body.transactionNotes?.trim() || (storedNotes && storedNotes.trim()) || ''

    if (!deliveryCity) {
      return Response.json({ error: 'Delivery city is required.' }, { status: 400 })
    }
    if (!customerPhone) {
      return Response.json({ error: 'Customer phone is required.' }, { status: 400 })
    }

    // Revalidate city at booking time (Prompt 2)
    const cityValid = await revalidateCityAtBookingTime(providerKey, deliveryCity)
    if (!cityValid) {
      // Update the row's courierCityStatus to 'unresolved'
      if (rowType === 'order') {
        await db.order.update({
          where: { id: rowId },
          data: { courierCityStatus: 'unresolved' },
        })
      } else {
        await db.exchangeShipment.update({
          where: { id: rowId },
          data: { courierCityStatus: 'unresolved' },
        })
      }
      return Response.json({
        error: `City "${deliveryCity}" is not available for delivery with ${integration.provider.providerName}. Please resolve the city and try again.`,
      }, { status: 400 })
    }

    // Compute weight + orderType (Prompt 1 + Prompt 4)
    const weightResult = calculateOrderWeightKg(
      itemRows.map((i) => ({
        quantity: i.quantity,
        variant: { weightKg: i.weightKg },
      })),
    )

    const orderType = body.orderType || determinePostExOrderType(
      weightResult.totalWeightKg,
      weightResult.hasMissingWeight,
      isExchangeReplacement,
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
      orderNumber: orderRefNumber, // PostEx maps this to orderRefNumber in its API
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
      quantity: itemRows.reduce((sum, i) => sum + i.quantity, 0),
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
      relatedEntityType: rowType,
      relatedEntityId: rowId,
      fn: async () => adapter.bookShipment(bookInput),
    })

    if (!bookResult.success || !bookResult.trackingNumber) {
      return Response.json({
        error: bookResult.error || 'PostEx booking failed — no tracking number returned.',
      }, { status: 400 })
    }

    // Update the row with tracking + courier info + booking status
    const updateData = {
      courierCompanyIntegrationId: integration.id,
      trackingNumber: bookResult.trackingNumber,
      courierCityStatus: 'matched' as const,
      courierSubStatus: bookResult.providerStatus ?? null,
      courierName: integration.provider.providerName,
      courierBookingStatus: 'booked' as const,
    }
    if (rowType === 'order') {
      await db.order.update({ where: { id: rowId }, data: updateData })
    } else {
      await db.exchangeShipment.update({ where: { id: rowId }, data: updateData })
    }

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
