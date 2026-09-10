import { NextRequest } from 'next/server'
import { ApiError, handleError, readBody, getWorkspace, requirePermission } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'
import { bookOrderWithCourier, bookExchangeShipmentWithCourier } from '@/lib/actions/booking.actions'

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
 * For EXCHANGE SHIPMENTS: delegates to bookExchangeShipmentWithCourier()
 * server action (shared with batch-booking + auto-booking paths).
 */
export async function POST(req: NextRequest) {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)

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

    // ── EXCHANGE SHIPMENT booking: delegate to the unified action ──
    // ORD-016 FIX: previously called bookExchangeShipmentWithCourier with 3
    // positional args (body.entity_id, body.courier_company_integration_id,
    // body.pickup_address_id) — but the function expects a SINGLE options
    // object with named fields. The positional call passed `undefined` for
    // every argument, breaking every exchange-shipment booking from the
    // Booking Workbench. Now passes a proper options object.
    const shipmentResult = await bookExchangeShipmentWithCourier({
      shipmentId: body.shipmentId!,
      companyIntegrationId: body.companyIntegrationId,
      pickupAddressCode: body.pickupAddressCode,
      // Pass through the editable overrides from the Workbench UI (same
      // set of fields the order-booking path above exposes).
      customerName: body.customerName,
      customerPhone: body.customerPhone,
      deliveryAddress: body.deliveryAddress,
      deliveryCity: body.deliveryCity,
      codAmount: body.codAmount,
      orderType: body.orderType,
      transactionNotes: body.transactionNotes,
      itemDescription: body.itemDescription,
      orderRefNumber: body.orderRefNumber,
    })
    if (!shipmentResult.success) {
      throw new ApiError(400, shipmentResult.error ?? 'Failed to book exchange shipment')
    }
    return Response.json(shipmentResult.data)
  } catch (err) {
    return handleError(err)
  }
}
