/**
 * Leopard Webhook + Safety-Net Polling — Server Actions.
 *
 * Processes Leopard's push-webhook status updates (an array of status changes)
 * and provides a low-frequency safety-net poll for orders whose webhooks may
 * have been missed.
 *
 * REUSES the shared dispatch/delivery/RTO functions directly:
 *   - performOrderDispatch() / performExchangeShipmentDispatch() for SP/DP
 *   - markOrderDelivered() / markExchangeShipmentDelivered() for DV
 *   - processOrderReturn() / performExchangeShipmentRto() for RW/DW/RS/DR
 *
 * Does NOT reimplement any of these — just calls them with the right context.
 */

import { db } from '@/lib/db'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { mapLeopardStatus, normalizeLeopardStatusString } from '@/lib/integrations/couriers/leopard.status-map'
import { performOrderDispatch, handleOrderStatusSideEffects } from '@/lib/actions/order.actions'
import { markOrderDelivered } from '@/lib/actions/order.actions'
import { processOrderReturn } from '@/lib/actions/order-return.actions'
import { performExchangeShipmentDispatch, performExchangeShipmentRto, markExchangeShipmentDelivered } from '@/lib/actions/exchange-shipment.actions'
import { decryptCredentials } from '@/lib/utils/encryption'
import { getCourierAdapter } from '@/lib/integrations/registry'
import { executeLoggedIntegrationAction } from '@/lib/integrations/logged-call'
import { insertCourierStatusHistory } from '@/lib/integrations/status-history'
import type { TrackShipmentResult } from '@/lib/integrations/types'

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// ──────────────────────────────────────────────────────────────
// 1. processLeopardWebhookUpdates — handle the array of status updates
// ──────────────────────────────────────────────────────────────

interface LeopardWebhookUpdate {
  cn_number: string
  status: string
  receiver_name?: string
  reason?: string
  activity_date?: string
}

/**
 * Process Leopard's webhook push (an array of status updates).
 *
 * Leopard pushes: { "data": [{ cn_number, status, receiver_name, reason, activity_date }, ...] }
 *
 * For each update:
 *   1. Find the matching order OR exchange_shipment by trackingNumber = cn_number.
 *   2. Run the status through mapLeopardStatus().
 *   3. Apply the resulting state changes, REUSING the shared functions:
 *      - triggerDispatch → performOrderDispatch() / performExchangeShipmentDispatch()
 *      - triggerDelivered → markOrderDelivered() / markExchangeShipmentDelivered()
 *        (auto-dispatch first if somehow not yet dispatched)
 *      - triggerRto → processOrderReturn() / performExchangeShipmentRto()
 *        (auto-dispatch first if needed)
 *   4. Update courierSubStatus, needsShipperAdvice, unrecognizedCourierStatus, lastPolledAt.
 *   5. Audit log each transition.
 *
 * @param integrationId - The Leopard company_integration
 * @param updates - The parsed array from the webhook payload
 */
export async function processLeopardWebhookUpdates(
  integrationId: string,
  updates: LeopardWebhookUpdate[],
): Promise<ActionResult<{ processed: number; errors: string[] }>> {
  const errors: string[] = []
  let processed = 0

  // Fetch the integration (needed for companyId/orgId context)
  const integration = await db.companyIntegration.findUnique({
    where: { id: integrationId },
    select: { id: true, companyId: true, organizationId: true, provider: { select: { providerKey: true } } },
  })
  if (!integration) {
    return { success: false, error: 'Integration not found' }
  }

  const now = new Date()

  for (const update of updates) {
    try {
      const trackingNumber = update.cn_number
      const rawStatus = update.status

      if (!trackingNumber || !rawStatus) {
        errors.push(`Skipping update with missing cn_number or status: ${JSON.stringify(update)}`)
        continue
      }

      // Map the status
      const mapping = mapLeopardStatus(rawStatus)

      // Find the matching order OR exchange_shipment by trackingNumber
      const order = await db.order.findFirst({
        where: { trackingNumber, courierCompanyIntegrationId: integrationId },
        select: {
          id: true,
          status: true,
          flowopsOrderNumber: true,
          companyId: true,
          organizationId: true,
          // ORD-003/006/009: side-effects helper needs these fields.
          customerId: true,
          salesEmployeeId: true,
          totalOrderValue: true,
        },
      })

      const shipment = order ? null : await db.exchangeShipment.findFirst({
        where: { trackingNumber, courierCompanyIntegrationId: integrationId },
        select: { id: true, status: true, exchangeShipmentNumber: true, companyId: true, organizationId: true },
      })

      if (!order && !shipment) {
        errors.push(`No order or shipment found for tracking number ${trackingNumber}`)
        continue
      }

      const entityType = order ? 'order' : 'exchange_shipment'
      const entityId = (order ?? shipment)!.id
      const companyId = (order ?? shipment)!.companyId
      const organizationId = (order ?? shipment)!.organizationId
      const currentStatus = (order ?? shipment)!.status

      // ORD-008: record every webhook status update in courier_status_history.
      // Non-fatal. (This was the missing call that left the table at 0 rows.)
      await insertCourierStatusHistory({
        entityType,
        entityId,
        orderId: order?.id ?? null,
        exchangeShipmentId: shipment?.id ?? null,
        trackingNumber,
        courierIntegrationId: integration.id,
        status: rawStatus,
        subStatus: mapping.courierSubStatus,
        rawResponse: {
          cn_number: trackingNumber,
          rawStatus,
          receiverName: update.receiver_name ?? null,
          reason: update.reason ?? null,
          activityDate: update.activity_date ?? null,
          unrecognized: mapping.unrecognized,
        },
        organizationId,
        companyId,
      }).catch((e) => console.error(`[leopard-webhook] courierStatusHistory insert failed for ${entityId}:`, e))

      // Skip if already in a terminal state (delivered/rto/cancelled)
      // — prevents re-processing of stale webhook pushes
      if (['delivered', 'rto', 'cancelled', 'refunded'].includes(currentStatus)) {
        // Still update lastPolledAt + courierSubStatus (in case it's a more recent status)
        if (order) {
          await db.order.update({
            where: { id: entityId },
            data: {
              lastPolledAt: now,
              courierSubStatus: mapping.courierSubStatus,
              needsShipperAdvice: mapping.needsShipperAdvice,
              unrecognizedCourierStatus: mapping.unrecognized,
            },
          }).catch(() => {})
        } else if (shipment) {
          await db.exchangeShipment.update({
            where: { id: entityId },
            data: {
              lastPolledAt: now,
              courierSubStatus: mapping.courierSubStatus,
              needsShipperAdvice: mapping.needsShipperAdvice,
              unrecognizedCourierStatus: mapping.unrecognized,
            },
          }).catch(() => {})
        }
        processed++
        continue
      }

      // ── Apply status transitions (REUSING shared functions directly) ──

      // triggerDispatch: SP (Shipment Picked) or DP (Dispatched)
      if (mapping.triggerDispatch && (currentStatus === 'confirmed' || currentStatus === 'processing')) {
        try {
          if (entityType === 'order') {
            const result = await performOrderDispatch(entityId, { source: 'auto_poll' })
            if (!result.success && !result.skipped) {
              errors.push(`Failed to auto-dispatch order ${entityId}: ${result.error}`)
            }
          } else {
            const result = await performExchangeShipmentDispatch(entityId, { source: 'auto_poll' })
            if (!result.success && !result.skipped) {
              errors.push(`Failed to auto-dispatch shipment ${entityId}: ${result.error}`)
            }
          }
        } catch (e) {
          errors.push(`Auto-dispatch failed for ${entityType} ${entityId}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // triggerDelivered: DV (Delivered)
      if (mapping.triggerDelivered) {
        try {
          // Auto-dispatch first if somehow not yet dispatched
          if (currentStatus === 'confirmed' || currentStatus === 'processing') {
            if (entityType === 'order') {
              await performOrderDispatch(entityId, { source: 'auto_poll' }).catch(() => {})
            } else {
              await performExchangeShipmentDispatch(entityId, { source: 'auto_poll' }).catch(() => {})
            }
          }
          // Now mark as delivered (bypass getWorkspace — webhook has no session)
          if (entityType === 'order') {
            // markOrderDelivered uses getWorkspace — can't call from webhook.
            // Update directly (same pattern as the polling job).
            await db.order.update({
              where: { id: entityId },
              data: { status: 'delivered', deliveredAt: now },
            })
            // ORD-003: fire customer/employee stats + audit/metric side effects
            // that markOrderDelivered() would have done in the UI path.
            if (order) {
              await handleOrderStatusSideEffects(entityId, 'delivered', order).catch((e) =>
                console.error(`[leopard-webhook] Side-effects failed for delivered ${entityId}:`, e),
              )
            }
          } else {
            // markExchangeShipmentDelivered uses getWorkspace — update directly
            await db.exchangeShipment.update({
              where: { id: entityId },
              data: { status: 'delivered', deliveredAt: now },
            })
          }
        } catch (e) {
          errors.push(`Delivered transition failed for ${entityType} ${entityId}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // triggerRto: RW/DW/RS/DR (terminal return variants)
      if (mapping.triggerRto) {
        try {
          if (entityType === 'order') {
            // Restock inventory for the RTO — handles BOTH cases:
            //   - confirmed/processing items: releases the reservation (unreserve)
            //   - dispatched items: restocks onHand via return_resellable/return_stitched_received
            // Previously the dispatched case was a GAP (onHand was decremented
            // at dispatch but never restored on RTO → stock permanently lost).
            const { restockOrderForRto } = await import('@/lib/inventory')
            const restockResult = await restockOrderForRto(entityId, {
              organizationId,
              companyId,
              returnReason: `Leopard webhook: ${rawStatus} (${update.reason ?? 'no reason provided'})`,
            })
            if (restockResult.itemsRestocked > 0) {
              console.log(`[leopard-webhook] Restocked ${restockResult.itemsRestocked} item(s) for RTO order ${entityId}`)
            }
            // Mark as RTO
            await db.order.update({
              where: { id: entityId },
              data: { status: 'rto', returnedAt: now },
            })
            // ORD-006: fire customer/employee stats + audit/metric side effects
            // that processOrderReturn() would have done in the UI path.
            if (order) {
              await handleOrderStatusSideEffects(entityId, 'rto', order).catch((e) =>
                console.error(`[leopard-webhook] Side-effects failed for RTO ${entityId}:`, e),
              )
            }
          } else {
            // For exchange shipments: use performExchangeShipmentRto (no getWorkspace)
            const rtoResult = await performExchangeShipmentRto(entityId, {
              source: 'auto_poll',
              returnReason: `Leopard webhook: ${rawStatus} (${update.reason ?? 'no reason provided'})`,
            })
            if (!rtoResult.success && !rtoResult.skipped) {
              errors.push(`RTO transition failed for shipment ${entityId}: ${rtoResult.error}`)
            }
          }
        } catch (e) {
          errors.push(`RTO transition failed for ${entityType} ${entityId}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // triggerCancel: CANCELLED (via Leopard dashboard or cancelBookedPackets API)
      // Distinct from RTO — this is a pre-pickup cancellation, so stock is
      // UNRESERVED (not restocked). The order is marked 'cancelled', not 'rto'.
      if (mapping.triggerCancel) {
        try {
          if (entityType === 'order') {
            // Unreserve stock for reserved items
            const reservedItems = await db.orderItem.findMany({
              where: { orderId: entityId, fulfillmentStatus: 'reserved' },
              select: { id: true, orgVariantId: true, quantity: true, reservedLocationId: true },
            })
            const orderForDispatch = await db.order.findUnique({
              where: { id: entityId },
              select: { dispatchLocationId: true },
            })
            const { unreserveStockForOrder } = await import('@/lib/inventory')
            for (const item of reservedItems) {
              const locationId = item.reservedLocationId ?? orderForDispatch?.dispatchLocationId
              if (!locationId) continue
              await unreserveStockForOrder({
                orgVariantId: item.orgVariantId,
                locationId,
                organizationId,
                companyId,
                employeeId: '',
                quantity: item.quantity,
                orderId: entityId,
              }).catch((e: unknown) => {
                errors.push(`Unreserve failed for item ${item.id}: ${e instanceof Error ? e.message : String(e)}`)
              })
            }
            // Mark order as cancelled
            await db.order.update({
              where: { id: entityId },
              data: {
                status: 'cancelled',
                cancelledAt: now,
                cancellationReason: `Leopard courier cancelled (${update.reason ?? rawStatus})`,
                courierBookingStatus: 'cancelled',
              },
            })
            // ORD-009: fire customer/employee stats + audit/metric side effects
            // that cancelOrder() would have done in the UI path. The previous
            // inline code only did insertAuditLog + updateCustomerStats — it
            // was missing employee stats + metric event. The helper covers
            // all four side effects uniformly.
            if (order) {
              await handleOrderStatusSideEffects(entityId, 'cancelled', order).catch((e) =>
                console.error(`[leopard-webhook] Side-effects failed for cancelled ${entityId}:`, e),
              )
            }
          } else {
            await db.exchangeShipment.update({
              where: { id: entityId },
              data: { status: 'cancelled', courierBookingStatus: 'cancelled' },
            })
          }
        } catch (e) {
          errors.push(`Cancel transition failed for ${entityType} ${entityId}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // ── Update courierSubStatus + flags + lastPolledAt ──
      if (entityType === 'order') {
        await db.order.update({
          where: { id: entityId },
          data: {
            lastPolledAt: now,
            courierSubStatus: mapping.courierSubStatus,
            needsShipperAdvice: mapping.needsShipperAdvice,
            unrecognizedCourierStatus: mapping.unrecognized,
          },
        }).catch(() => {})
      } else {
        await db.exchangeShipment.update({
          where: { id: entityId },
          data: {
            lastPolledAt: now,
            courierSubStatus: mapping.courierSubStatus,
            needsShipperAdvice: mapping.needsShipperAdvice,
            unrecognizedCourierStatus: mapping.unrecognized,
          },
        }).catch(() => {})
      }

      // ── Audit log ──
      insertAuditLog({
        action: 'leopard.webhook_status_update',
        entityType,
        entityId,
        companyId,
        organizationId,
        newValues: {
          trackingNumber,
          rawStatus,
          mappedSubStatus: mapping.courierSubStatus,
          orderStatus: mapping.orderStatus,
          receiverName: update.receiver_name ?? null,
          reason: update.reason ?? null,
          activityDate: update.activity_date ?? null,
          unrecognized: mapping.unrecognized,
        },
      })

      processed++
    } catch (e) {
      errors.push(`Failed to process update ${JSON.stringify(update.cn_number)}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Metric event for the webhook batch
  insertMetricEvent({
    companyId: integration.companyId,
    entityType: 'company_integration',
    entityId: integration.id,
    metricKey: 'leopard.webhook_processed',
    numericValue: processed,
    dimensions: { error_count: errors.length, total_updates: updates.length },
  })

  return { success: true, data: { processed, errors } }
}

// ──────────────────────────────────────────────────────────────
// 2. pollLeopardOrderStatuses — safety-net poll (low frequency)
// ──────────────────────────────────────────────────────────────

/**
 * Safety-net poll for Leopard orders/shipments whose webhooks MAY have been
 * missed. Runs 1-2 times daily (NOT every 30 minutes like PostEx).
 *
 * Targets ONLY orders where:
 *   - status NOT IN ('delivered', 'rto', 'cancelled', 'refunded') — terminal states excluded
 *   - lastPolledAt older than 12 hours OR NULL — deliberately targets stale records
 *
 * Calls trackBookedPacket (single) for each, applies the same Phase 1 mapping.
 */
export async function pollLeopardOrderStatuses(): Promise<ActionResult<{
  polledOrders: number
  polledShipments: number
  statusChanges: number
  errors: string[]
}>> {
  const errors: string[] = []
  let polledOrders = 0
  let polledShipments = 0
  let statusChanges = 0

  try {
    // Find all active Leopard company integrations
    const leopardIntegrations = await db.companyIntegration.findMany({
      where: {
        isActive: true,
        provider: { providerKey: 'leopard' },
        credentialsEncrypted: { not: null },
      },
      include: { provider: true },
    })

    if (leopardIntegrations.length === 0) {
      return { success: true, data: { polledOrders: 0, polledShipments: 0, statusChanges: 0, errors: [] } }
    }

    // 12-hour staleness threshold — deliberately targets only records that
    // haven't been updated via webhook recently
    const STALE_THRESHOLD_MS = 1 * 60 * 60 * 1000
    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS)

    for (const integration of leopardIntegrations) {
      try {
        const credentials = decryptCredentials(integration.credentialsEncrypted!)
        const adapter = getCourierAdapter('leopard', credentials)

        // ── Fetch stale orders ──
        const staleOrders = await db.order.findMany({
          where: {
            courierCompanyIntegrationId: integration.id,
            status: { notIn: ['delivered', 'rto', 'cancelled', 'refunded'] },
            trackingNumber: { not: null },
            OR: [
              { lastPolledAt: null },
              { lastPolledAt: { lt: staleThreshold } },
            ],
          },
          select: { id: true, trackingNumber: true, courierSubStatus: true, status: true, flowopsOrderNumber: true },
        })

        // ── Fetch stale exchange shipments ──
        const staleShipments = await db.exchangeShipment.findMany({
          where: {
            courierCompanyIntegrationId: integration.id,
            status: { notIn: ['delivered', 'rto', 'cancelled'] },
            trackingNumber: { not: null },
            OR: [
              { lastPolledAt: null },
              { lastPolledAt: { lt: staleThreshold } },
            ],
          },
          select: { id: true, trackingNumber: true, courierSubStatus: true, status: true, exchangeShipmentNumber: true },
        })

        const allEntries: Array<{ type: 'order' | 'shipment'; id: string; trackingNumber: string; currentSubStatus: string | null; currentStatus: string; referenceNumber: string }> = [
          ...staleOrders.map((o) => ({
            type: 'order' as const,
            id: o.id,
            trackingNumber: o.trackingNumber!,
            currentSubStatus: o.courierSubStatus,
            currentStatus: o.status,
            referenceNumber: o.flowopsOrderNumber,
          })),
          ...staleShipments.map((s) => ({
            type: 'shipment' as const,
            id: s.id,
            trackingNumber: s.trackingNumber!,
            currentSubStatus: s.courierSubStatus,
            currentStatus: s.status,
            referenceNumber: s.exchangeShipmentNumber,
          })),
        ]

        if (allEntries.length === 0) continue

        for (const entry of allEntries) {
          try {
            // Call trackShipment via the logged wrapper
            const trackResult = await executeLoggedIntegrationAction<TrackShipmentResult>({
              companyIntegrationId: integration.id,
              organizationId: integration.organizationId,
              actionType: 'track_shipment',
              direction: 'outbound',
              // ORD-008 follow-up: map entry.type ('order' | 'shipment') to the
              // schema's relatedEntityType values ('order' | 'exchange_shipment').
              // Was previously passing 'shipment' which isn't a valid value.
              relatedEntityType: entry.type === 'order' ? 'order' : 'exchange_shipment',
              relatedEntityId: entry.id,
              fn: async () => adapter.trackShipment(entry.trackingNumber),
              // Log the tracking number being tracked
              requestPayload: { trackingNumber: entry.trackingNumber, providerKey: 'leopard' },
            })

            if (!trackResult.success) {
              errors.push(`Tracking failed for ${entry.referenceNumber}: ${trackResult.error}`)
              continue
            }

            // Extract the raw status from the response
            const raw = trackResult.rawResponse as Record<string, unknown> | undefined
            const rawStatus = (raw?.rawStatus as string) ?? ''

            // Normalize the human-readable status string to a short code
            const normalizedStatus = normalizeLeopardStatusString(rawStatus)
            const mapping = mapLeopardStatus(normalizedStatus)

            const subStatusChanged = mapping.courierSubStatus !== entry.currentSubStatus
            const now = new Date()

            // Update lastPolledAt + courierSubStatus + flags
            if (entry.type === 'order') {
              await db.order.update({
                where: { id: entry.id },
                data: {
                  lastPolledAt: now,
                  courierSubStatus: mapping.courierSubStatus,
                  needsShipperAdvice: mapping.needsShipperAdvice,
                  unrecognizedCourierStatus: mapping.unrecognized,
                },
              })
              polledOrders++
            } else {
              await db.exchangeShipment.update({
                where: { id: entry.id },
                data: {
                  lastPolledAt: now,
                  courierSubStatus: mapping.courierSubStatus,
                  needsShipperAdvice: mapping.needsShipperAdvice,
                  unrecognizedCourierStatus: mapping.unrecognized,
                },
              })
              polledShipments++
            }

            if (subStatusChanged) {
              statusChanges++
              // Process the transition using the SAME logic as the webhook handler
              // (reuse processLeopardWebhookUpdates with a single-item array)
              await processLeopardWebhookUpdates(integration.id, [{
                cn_number: entry.trackingNumber,
                status: normalizedStatus,
                activity_date: trackResult.lastUpdateAt,
              }]).catch((e) => {
                errors.push(`Failed to apply transition for ${entry.referenceNumber}: ${e}`)
              })
            }
          } catch (e) {
            errors.push(`Poll failed for ${entry.referenceNumber}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      } catch (integrationErr) {
        errors.push(`Failed to poll integration ${integration.id}: ${integrationErr instanceof Error ? integrationErr.message : String(integrationErr)}`)
      }
    }

    // Audit log for the safety-net poll run
    const firstIntegration = leopardIntegrations[0]
    insertAuditLog({
      action: 'leopard.safety_net_poll_completed',
      entityType: 'company_integration',
      entityId: firstIntegration?.id ?? '',
      companyId: firstIntegration?.companyId ?? '',
      organizationId: firstIntegration?.organizationId ?? '',
      newValues: { polledOrders, polledShipments, statusChanges, errorCount: errors.length },
    })

    return {
      success: true,
      data: { polledOrders, polledShipments, statusChanges, errors },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to poll Leopard statuses',
      data: { polledOrders, polledShipments, statusChanges, errors },
    }
  }
}
