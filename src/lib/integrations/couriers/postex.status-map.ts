/**
 * PostEx Status Mapping — pure, stateless function.
 *
 * Maps PostEx's `transactionStatus` string (from the track-order or
 * track-bulk-order API responses) to FlowOps' internal order/shipment
 * lifecycle states, including:
 *   - which OMS function to trigger (if any)
 *   - what subStatus to store for display
 *   - whether the record needs shipper advice
 *   - whether the status was unrecognized
 *
 * CRITICAL: once orderStatus reaches 'delivered' or 'rto' for a given
 * order/shipment, that record must NEVER be polled again. This is enforced
 * in the polling job (Phase 4), NOT here — this function is pure and
 * stateless.
 */

export interface PostExStatusMapping {
  /** The FlowOps order/shipment status to transition to (if any). */
  orderStatus: 'confirmed' | 'dispatched' | 'delivered' | 'rto' | 'cancelled' | 'no_change'
  /** A short machine-readable sub-status for display/audit. */
  courierSubStatus: string | null
  /** True if this status should trigger markOrderDelivered() / markExchangeShipmentDelivered(). */
  triggerDispatch: boolean
  /** True if this status should trigger markOrderDelivered() / markExchangeShipmentDelivered(). */
  triggerDelivered: boolean
  /** True if this status should trigger processOrderReturn() / the RTO flow. */
  triggerRto: boolean
  /** True if this status requires shipper advice (e.g. "Attempted", "Delivery Under Review"). */
  needsShipperAdvice: boolean
  /** True if the status string was not recognized — log a warning. */
  unrecognized: boolean
}

/**
 * Map a PostEx `transactionStatus` string to FlowOps' internal status mapping.
 *
 * Exact mapping (confirmed via live Postman testing + PostEx Order Status API docs):
 *
 *   Unbooked                        → no_change (stays confirmed), subStatus='slip_generated'
 *   Booked                          → no_change, subStatus='pickup_requested'
 *   Picked By PostEx                → dispatched, subStatus='picked_up', triggerDispatch=true
 *   PostEx WareHouse                → no_change (already dispatched), subStatus='at_warehouse'
 *   En-Route to PostEx warehouse    → no_change, subStatus='en_route'
 *   Out For Delivery                → no_change, subStatus='out_for_delivery'
 *   Delivered                       → delivered, triggerDelivered=true
 *   Returned                        → rto, triggerRto=true
 *   Out For Return                  → no_change, subStatus='out_for_return'
 *   Attempted                       → no_change, subStatus='attempted', needsShipperAdvice=true
 *   Delivery Under Review           → no_change, subStatus='under_review', needsShipperAdvice=true
 *   ANY OTHER VALUE                 → unrecognized=true, orderStatus='no_change'
 */
export function mapPostExStatus(postexStatus: string): PostExStatusMapping {
  // Normalize: trim + lowercase for case-insensitive comparison.
  // PostEx's API returns inconsistent casing (e.g. "UnBooked" vs "Unbooked",
  // "Picked By PostEx" vs "Picked by PostEx"). We lowercase everything
  // before comparing.
  const status = postexStatus.trim().toLowerCase()

  switch (status) {
    case 'unbooked':
      return {
        orderStatus: 'no_change',
        courierSubStatus: 'slip_generated',
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: false,
        unrecognized: false,
      }

    case 'booked':
      return {
        orderStatus: 'no_change',
        courierSubStatus: 'pickup_requested',
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: false,
        unrecognized: false,
      }

    case 'picked by postex':
      return {
        orderStatus: 'dispatched',
        courierSubStatus: 'picked_up',
        triggerDispatch: true,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: false,
        unrecognized: false,
      }

    case 'postex warehouse':
      return {
        orderStatus: 'no_change',
        courierSubStatus: 'at_warehouse',
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: false,
        unrecognized: false,
      }

    case 'en-route to postex warehouse':
      return {
        orderStatus: 'no_change',
        courierSubStatus: 'en_route',
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: false,
        unrecognized: false,
      }

    case 'out for delivery':
      return {
        orderStatus: 'no_change',
        courierSubStatus: 'out_for_delivery',
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: false,
        unrecognized: false,
      }

    case 'delivered':
      return {
        orderStatus: 'delivered',
        courierSubStatus: 'delivered',
        triggerDispatch: false,
        triggerDelivered: true,
        triggerRto: false,
        needsShipperAdvice: false,
        unrecognized: false,
      }

    case 'returned':
      return {
        orderStatus: 'rto',
        courierSubStatus: 'returned',
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: true,
        needsShipperAdvice: false,
        unrecognized: false,
      }

    case 'out for return':
      return {
        orderStatus: 'no_change',
        courierSubStatus: 'out_for_return',
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: false,
        unrecognized: false,
      }

    case 'attempted':
      return {
        orderStatus: 'no_change',
        courierSubStatus: 'attempted',
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: true,
        unrecognized: false,
      }

    case 'delivery under review':
      return {
        orderStatus: 'no_change',
        courierSubStatus: 'under_review',
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: true,
        unrecognized: false,
      }

    case 'un-assigned by me':
      // PostEx returns this status when the merchant cancels the order
      // directly on the PostEx portal. The courier booking is gone —
      // we need to cancel the order in FlowOps too.
      return {
        orderStatus: 'cancelled',
        courierSubStatus: 'cancelled_by_merchant',
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: false,
        unrecognized: false,
      }

    case 'expired':
      // PostEx returns this when the booking expires (e.g. wasn't picked
      // up within the time window). Treat like a cancellation — the
      // booking is no longer active.
      return {
        orderStatus: 'cancelled',
        courierSubStatus: 'expired',
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: false,
        unrecognized: false,
      }

    default:
      // Any other value (including "Expired", "Un-Assigned By Me", or any
      // future unknown string) → unrecognized, no state change
      console.warn(`[PostEx Adapter] Unrecognized status: "${status}"`)
      return {
        orderStatus: 'no_change',
        courierSubStatus: status, // store the raw string for audit
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: false,
        unrecognized: true,
      }
  }
}
