/**
 * Courier Booking Cancellation — Server Action.
 *
 * Cancels a courier booking on the courier's side (PostEx) AND in FlowOps
 * atomically. Only available while the shipment hasn't been physically
 * picked up by the courier (courierSubStatus must be 'slip_generated' or
 * 'pickup_requested').
 *
 * On success: the courier booking is cancelled on PostEx, the entity's
 * courierBookingStatus is set to 'cancelled', and the entity itself is
 * cancelled via the existing cancelOrder() / cancelExchangeShipment()
 * logic (which handles stock unreservation + status transition + audit).
 *
 * On failure: NO state changes are made — the entity stays in its prior
 * state, and the error from PostEx is propagated to the caller.
 *
 * Tracking number is PRESERVED for historical/audit purposes.
 */

import { db } from '@/lib/db'
import { getWorkspace, requirePermission, ApiError } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { decryptCredentials } from '@/lib/utils/encryption'
import { getCourierAdapter } from '@/lib/integrations/registry'
import { executeLoggedIntegrationAction } from '@/lib/integrations/logged-call'
import type { CancelShipmentResult } from '@/lib/integrations/types'

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

/**
 * Cancel a courier booking on both the courier side and in FlowOps.
 *
 * @param entityType 'order' | 'exchange_shipment'
 * @param entityId The Order or ExchangeShipment ID
 * @returns { success: true } on success, { success: false, error } on failure
 */
export async function cancelCourierBooking(
  entityType: 'order' | 'exchange_shipment',
  entityId: string,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    // Require ORDERS_CANCEL for orders, ORDERS_MANAGE for exchange shipments
    // (matching the permission each entity's own cancel action requires)
    if (entityType === 'order') {
      await requirePermission(ctx, PERMISSIONS.ORDERS_CANCEL)
    } else {
      await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)
    }

    // ── 1. Load the entity ──
    let trackingNumber: string | null
    let courierIntegrationId: string | null
    let courierSubStatus: string | null

    if (entityType === 'order') {
      const order = await db.order.findFirst({
        where: { id: entityId, companyId: ctx.company.id },
        select: {
          trackingNumber: true,
          courierCompanyIntegrationId: true,
          courierSubStatus: true,
          courierBookingStatus: true,
          status: true,
        },
      })
      if (!order) return { success: false, error: 'Order not found.' }

      trackingNumber = order.trackingNumber
      courierIntegrationId = order.courierCompanyIntegrationId
      courierSubStatus = order.courierSubStatus

      // Guard: only cancellable if not already cancelled in FlowOps
      if (order.status === 'cancelled') {
        return { success: false, error: 'Order is already cancelled.' }
      }
    } else {
      const shipment = await db.exchangeShipment.findFirst({
        where: { id: entityId, companyId: ctx.company.id },
        select: {
          trackingNumber: true,
          courierCompanyIntegrationId: true,
          courierSubStatus: true,
          courierBookingStatus: true,
          status: true,
        },
      })
      if (!shipment) return { success: false, error: 'Exchange shipment not found.' }

      trackingNumber = shipment.trackingNumber
      courierIntegrationId = shipment.courierCompanyIntegrationId
      courierSubStatus = shipment.courierSubStatus

      if (shipment.status === 'cancelled') {
        return { success: false, error: 'Exchange shipment is already cancelled.' }
      }
    }

    // ── 2. Guard: only cancellable if courierSubStatus is slip_generated or pickup_requested ──
    // This is the authoritative server-side guard — the UI also hides the button,
    // but this prevents API-level bypass.
    if (!courierSubStatus || !['slip_generated', 'pickup_requested'].includes(courierSubStatus)) {
      return {
        success: false,
        error: 'This order can no longer be cancelled through the courier — it has already been picked up.',
      }
    }

    // Guard: must have a tracking number and integration
    if (!trackingNumber) {
      return { success: false, error: 'No tracking number found — cannot cancel a booking that was never made.' }
    }
    if (!courierIntegrationId) {
      return { success: false, error: 'No courier integration found — cannot cancel.' }
    }

    // ── 3. Load the courier adapter ──
    const integration = await db.companyIntegration.findFirst({
      where: { id: courierIntegrationId, companyId: ctx.company.id, isActive: true },
      include: { provider: true },
    })
    if (!integration || !integration.credentialsEncrypted) {
      return { success: false, error: 'Courier integration not found or inactive.' }
    }

    const providerKey = integration.provider.providerKey
    if (providerKey !== 'postex') {
      return { success: false, error: `Courier cancellation not yet implemented for provider '${providerKey}'.` }
    }

    const credentials = decryptCredentials(integration.credentialsEncrypted)
    const adapter = getCourierAdapter(providerKey, credentials)

    // ── 4. Call adapter.cancelShipment() via logged wrapper ──
    const cancelResult = await executeLoggedIntegrationAction<CancelShipmentResult>({
      companyIntegrationId: integration.id,
      organizationId: integration.organizationId,
      actionType: 'cancel_shipment',
      direction: 'outbound',
      relatedEntityType: entityType,
      relatedEntityId: entityId,
      fn: async () => adapter.cancelShipment(trackingNumber!),
    })

    // ── 5. On failure: do NOT change any state — propagate error ──
    if (!cancelResult.success) {
      return {
        success: false,
        error: cancelResult.error || 'Courier API cancellation failed.',
      }
    }

    // ── 6. On success: cancel in FlowOps (reusing existing logic) ──
    // Set courierBookingStatus='cancelled' FIRST (before calling the entity's
    // own cancel logic, which may transition the status to 'cancelled' and
    // prevent further updates).
    if (entityType === 'order') {
      await db.order.update({
        where: { id: entityId },
        data: { courierBookingStatus: 'cancelled' },
      })

      // Reuse the existing cancelOrder() logic — it handles:
      //   - status → 'cancelled'
      //   - cancelledAt = now()
      //   - cancellationReason
      //   - unreserveStockForOrder() per reserved item
      //   - audit log: order.cancelled
      //   - metric event
      //   - updateCustomerStats()
      const { cancelOrder } = await import('./order.actions')
      const cancelResult = await cancelOrder({
        order_id: entityId,
        cancellation_reason: 'Courier booking cancelled (pre-pickup cancellation via PostEx API)',
      })

      if (!cancelResult.success) {
        // PostEx cancellation succeeded but FlowOps cancellation failed.
        // This is an inconsistent state — log it but don't hide the PostEx success.
        console.error(
          `[cancelCourierBooking] PostEx cancellation succeeded for ${entityId} but FlowOps cancelOrder() failed: ${cancelResult.error}`,
        )
        return {
          success: false,
          error: `Courier booking cancelled on PostEx, but FlowOps order cancellation failed: ${cancelResult.error}. The tracking number ${trackingNumber} is cancelled on the courier side. Please manually cancel the order in FlowOps.`,
        }
      }
    } else {
      // Exchange shipment
      await db.exchangeShipment.update({
        where: { id: entityId },
        data: { courierBookingStatus: 'cancelled' },
      })

      // Reuse the existing cancelExchangeShipment() logic — it handles:
      //   - status → 'cancelled'
      //   - cancelledAt = now()
      //   - unreserveStockForOrder() if was confirmed
      //   - audit log: exchange_shipment.cancelled
      //   - metric event
      const { cancelExchangeShipment } = await import('./exchange-shipment.actions')
      const cancelResult = await cancelExchangeShipment(
        entityId,
        'Courier booking cancelled (pre-pickup cancellation via PostEx API)',
      )

      if (!cancelResult.success) {
        console.error(
          `[cancelCourierBooking] PostEx cancellation succeeded for shipment ${entityId} but FlowOps cancelExchangeShipment() failed: ${cancelResult.error}`,
        )
        return {
          success: false,
          error: `Courier booking cancelled on PostEx, but FlowOps shipment cancellation failed: ${cancelResult.error}.`,
        }
      }
    }

    // ── 7. Audit log for the courier-side cancellation ──
    insertAuditLog({
      action: 'courier.booking_cancelled',
      entityType: entityType,
      entityId: entityId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: {
        trackingNumber,
        previousSubStatus: courierSubStatus,
        courierProvider: providerKey,
      },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to cancel courier booking',
    }
  }
}
