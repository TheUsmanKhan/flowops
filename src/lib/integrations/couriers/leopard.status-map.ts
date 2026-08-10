/**
 * Leopard Status Mapping — pure, stateless function.
 *
 * Maps Leopard's short status codes (from webhook pushes and tracking API
 * responses) to FlowOps' internal order/shipment lifecycle states.
 *
 * Leopard uses 2-character status codes:
 *   RC = Consignment Booked
 *   SP = Shipment Picked
 *   DP = Dispatched
 *   AR = Arrived At Station
 *   AC = Out For Delivery
 *   DV = Delivered (terminal)
 *   PN1/PN2 = Attempt 1/2 Forward
 *   RO = Being Return
 *   RN1/RN2 = Attempt 1/2 Reverse
 *   NR = Ready for Return
 *   RW/DW/RS/DR = terminal return variants (RTO)
 *
 * CRITICAL: once orderStatus reaches 'delivered' or 'rto' for a given
 * order/shipment, that record must NEVER be processed again. This is enforced
 * in the webhook handler / polling job, NOT here — this function is pure and
 * stateless.
 */

export interface LeopardStatusMapping {
  /** The FlowOps order/shipment status to transition to (if any). */
  orderStatus: 'confirmed' | 'dispatched' | 'delivered' | 'rto' | 'cancelled' | 'no_change'
  /** A short machine-readable sub-status for display/audit. */
  courierSubStatus: string | null
  /** True if this status should trigger performOrderDispatch() / performExchangeShipmentDispatch(). */
  triggerDispatch: boolean
  /** True if this status should trigger markOrderDelivered() / markExchangeShipmentDelivered(). */
  triggerDelivered: boolean
  /** True if this status should trigger processOrderReturn() / performExchangeShipmentRto(). */
  triggerRto: boolean
  /** True if this status requires shipper advice (e.g. "Attempted", "Ready for Return"). */
  needsShipperAdvice: boolean
  /** True if the status string was not recognized — log a warning. */
  unrecognized: boolean
}

/**
 * Map a Leopard short status code to FlowOps' internal status mapping.
 *
 * Exact mapping (per the confirmed Leopard status code table):
 *
 *   RC (Consignment Booked)       → no_change, subStatus='slip_generated'
 *   SP (Shipment Picked)           → dispatched, subStatus='picked_up', triggerDispatch=true
 *   DP (Dispatched)                 → dispatched, subStatus='dispatched', triggerDispatch=true
 *   AR (Arrived At Station)            → no_change, subStatus='at_warehouse'
 *   AC (Out For Delivery)                 → no_change, subStatus='out_for_delivery'
 *   DV (Delivered - terminal)                → delivered, triggerDelivered=true, subStatus='delivered'
 *   PN1/PN2 (Attempt 1/2 Forward)                → needsShipperAdvice=true, subStatus='attempted'
 *   RO (Being Return)                               → no_change, subStatus='out_for_return'
 *   RN1/RN2 (Attempt 1/2 Reverse)                      → needsShipperAdvice=true, subStatus='attempted'
 *   NR (Ready for Return)                                 → subStatus='under_review', needsShipperAdvice=true
 *   RW/DW/RS/DR (terminal-return variants)               → rto, triggerRto=true, subStatus='returned'
 *   ANY OTHER VALUE                                                → unrecognized=true, orderStatus='no_change'
 */
export function mapLeopardStatus(leopardStatus: string): LeopardStatusMapping {
  // Normalize: trim + uppercase for case-insensitive comparison.
  // Leopard's status codes are 2-4 character uppercase strings (RC, SP, PN1, etc.)
  const status = leopardStatus.trim().toUpperCase()

  switch (status) {
    case 'RC': // Consignment Booked
      return {
        orderStatus: 'no_change',
        courierSubStatus: 'slip_generated',
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: false,
        unrecognized: false,
      }

    case 'SP': // Shipment Picked
      return {
        orderStatus: 'dispatched',
        courierSubStatus: 'picked_up',
        triggerDispatch: true,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: false,
        unrecognized: false,
      }

    case 'DP': // Dispatched
      return {
        orderStatus: 'dispatched',
        courierSubStatus: 'dispatched',
        triggerDispatch: true,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: false,
        unrecognized: false,
      }

    case 'AR': // Arrived At Station
      return {
        orderStatus: 'no_change',
        courierSubStatus: 'at_warehouse',
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: false,
        unrecognized: false,
      }

    case 'AC': // Out For Delivery
      return {
        orderStatus: 'no_change',
        courierSubStatus: 'out_for_delivery',
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: false,
        unrecognized: false,
      }

    case 'DV': // Delivered (terminal)
      return {
        orderStatus: 'delivered',
        courierSubStatus: 'delivered',
        triggerDispatch: false,
        triggerDelivered: true,
        triggerRto: false,
        needsShipperAdvice: false,
        unrecognized: false,
      }

    case 'PN1': // Attempt 1 Forward
    case 'PN2': // Attempt 2 Forward
      return {
        orderStatus: 'no_change',
        courierSubStatus: 'attempted',
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: true,
        unrecognized: false,
      }

    case 'RO': // Being Return
      return {
        orderStatus: 'no_change',
        courierSubStatus: 'out_for_return',
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: false,
        unrecognized: false,
      }

    case 'RN1': // Attempt 1 Reverse
    case 'RN2': // Attempt 2 Reverse
      return {
        orderStatus: 'no_change',
        courierSubStatus: 'attempted', // same flag as forward attempts — return-leg variant
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: true,
        unrecognized: false,
      }

    case 'NR': // Ready for Return
      return {
        orderStatus: 'no_change',
        courierSubStatus: 'under_review',
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: true,
        unrecognized: false,
      }

    case 'RW': // Return Waiting
    case 'DW': // Dispatched Wrong
    case 'RS': // Return Sent
    case 'DR': // Dispatched Return
      // All terminal-return variants → RTO
      return {
        orderStatus: 'rto',
        courierSubStatus: 'returned',
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: true,
        needsShipperAdvice: false,
        unrecognized: false,
      }

    default:
      // Any other value → unrecognized, no state change
      console.warn(`[Leopard Adapter] Unrecognized status: "${leopardStatus}"`)
      return {
        orderStatus: 'no_change',
        courierSubStatus: leopardStatus, // store the raw string for audit
        triggerDispatch: false,
        triggerDelivered: false,
        triggerRto: false,
        needsShipperAdvice: false,
        unrecognized: true,
      }
  }
}

/**
 * Map a Leopard `booked_packet_status` human-readable string (from the
 * trackBookedPacket API response, NOT the webhook short codes) to a
 * Leopard short status code.
 *
 * The tracking API returns human-readable strings like "Pickup Request not Send",
 * "Delivered", "Returned", etc. The webhook pushes short codes (RC, SP, DP, etc.).
 * This function attempts to map the human-readable string to the closest
 * short code, so the same mapLeopardStatus() function can be used for both.
 *
 * This is a best-effort mapping — if the string doesn't match any known
 * pattern, it's passed through to mapLeopardStatus() which will flag it
 * as unrecognized.
 */
export function normalizeLeopardStatusString(statusString: string): string {
  const lower = statusString.trim().toLowerCase()

  // Booked / slip generated
  if (lower.includes('pickup request not send') || lower.includes('booked') || lower.includes('consignment booked')) {
    return 'RC'
  }
  // Picked up
  if (lower.includes('pickup') && !lower.includes('not send') || lower.includes('picked')) {
    return 'SP'
  }
  // Dispatched
  if (lower.includes('dispatched') && !lower.includes('return')) {
    return 'DP'
  }
  // Arrived at station / at warehouse
  if (lower.includes('arrived') || lower.includes('station') || lower.includes('warehouse')) {
    return 'AR'
  }
  // Out for delivery
  if (lower.includes('out for delivery') || lower.includes('out_for_delivery')) {
    return 'AC'
  }
  // Delivered
  if (lower.includes('deliver') && !lower.includes('undeliver')) {
    return 'DV'
  }
  // Attempted (forward)
  if (lower.includes('attempt') && !lower.includes('return') && !lower.includes('reverse')) {
    return 'PN1'
  }
  // Being return
  if (lower.includes('being return') || lower.includes('return pending')) {
    return 'RO'
  }
  // Attempted (reverse)
  if (lower.includes('return attempt') || lower.includes('reverse attempt')) {
    return 'RN1'
  }
  // Ready for return
  if (lower.includes('ready for return') || lower.includes('return ready')) {
    return 'NR'
  }
  // Terminal return variants
  if (lower.includes('returned') || lower.includes('rto') || lower.includes('return received')) {
    return 'RW'
  }
  // Cancelled
  if (lower.includes('cancel') || lower.includes('reject')) {
    return 'RW' // treat as RTO
  }

  // Unrecognized — return the original string so mapLeopardStatus flags it
  return statusString
}
