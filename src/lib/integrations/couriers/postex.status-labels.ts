/**
 * PostEx Courier Sub-Status Labels — centralized mapping.
 *
 * Single source of truth for translating machine-readable courierSubStatus
 * values (stored in Order.courierSubStatus / ExchangeShipment.courierSubStatus)
 * to human-readable display strings.
 *
 * Used by ALL frontend surfaces that display courier status:
 *   - Orders list (orders-view.tsx)
 *   - Order detail (order-detail-view.tsx)
 *   - Exchange shipment tracking card
 *   - Booking Workbench (booking-workbench-view.tsx)
 *
 * No other file should contain ad-hoc label dictionaries for courier sub-statuses.
 */

const SUBSTATUS_LABELS: Record<string, string> = {
  slip_generated: 'Slip Generated',
  pickup_requested: 'Pickup Requested',
  picked_up: 'Picked Up',
  at_warehouse: 'At Warehouse',
  en_route: 'In-Route',
  out_for_delivery: 'Out for Delivery',
  delivered: 'Delivered',
  returned: 'Returned',
  out_for_return: 'Being Returned',
  attempted: 'Need Advice',
  under_review: 'Under Review',
  cancelled_by_merchant: 'Cancelled by Merchant',
  expired: 'Expired',
}

/**
 * Get the human-readable label for a courier sub-status value.
 *
 * @param subStatus The raw courierSubStatus string from the DB (e.g. 'picked_up', 'out_for_delivery')
 * @returns Human-readable label (e.g. "Picked Up", "Out for Delivery"), or '—' for null/unrecognized
 */
export function getCourierSubStatusLabel(subStatus: string | null | undefined): string {
  if (!subStatus) return '—'
  return SUBSTATUS_LABELS[subStatus] ?? subStatus // fall through to raw string for unrecognized
}

/**
 * Check if a courier sub-status means the shipment can still be cancelled
 * through the courier (i.e. it hasn't been physically picked up yet).
 *
 * Only 'slip_generated' and 'pickup_requested' are cancellable — once the
 * courier picks up the package, cancellation must go through customer support.
 */
export function isCancellableCourierStatus(subStatus: string | null | undefined): boolean {
  return subStatus === 'slip_generated' || subStatus === 'pickup_requested'
}
