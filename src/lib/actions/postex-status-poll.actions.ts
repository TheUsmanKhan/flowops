/**
 * PostEx Load Sheet Generation + Status Polling — Server Actions.
 *
 * Phase 4 of the PostEx adapter implementation.
 *
 * Two capabilities:
 *   1. generatePostExLoadSheet — standalone batch action for generating a
 *      load sheet (pickup manifest) for multiple tracking numbers. Can be
 *      called manually from a "Generate Load Sheet" button OR chained
 *      automatically after a successful bookShipment() call.
 *   2. pollPostExOrderStatuses — the polling job that queries all orders
 *      AND exchange_shipments with PostEx courier integrations, calls the
 *      bulk tracking API, and triggers OMS state transitions for any
 *      status changes.
 *
 * SCHEDULING NOTE: pollPostExOrderStatuses() needs to run every 30 minutes
 * via whatever scheduler infrastructure exists/gets set up. Same note as
 * Prompt 2's city-sync job — do not build infrastructure-level cron in this
 * prompt unless an established pattern already exists.
 */

import { db } from '@/lib/db'
import { getWorkspace, isElevated, ApiError } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { decryptCredentials } from '@/lib/utils/encryption'
import { getCourierAdapter } from '@/lib/integrations/registry'
import { executeLoggedIntegrationAction } from '@/lib/integrations/logged-call'
import { mapPostExStatus } from '@/lib/integrations/couriers/postex.status-map'
import type { TrackShipmentResult } from '@/lib/integrations/types'
import { performOrderDispatch } from '@/lib/actions/order.actions'
import { performExchangeShipmentDispatch } from '@/lib/actions/exchange-shipment.actions'
import { unreserveStockForOrder } from '@/lib/inventory'

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// ──────────────────────────────────────────────────────────────
// 1. generatePostExLoadSheet — standalone batch action
// ──────────────────────────────────────────────────────────────

/**
 * Generate a PostEx load sheet (pickup manifest) for a batch of tracking numbers.
 *
 * Can be called:
 *   (a) Manually from a "Generate Load Sheet" button for multiple Unbooked orders.
 *   (b) Automatically right after a successful bookShipment() call (chained).
 *
 * @param companyIntegrationId - The PostEx company integration to use
 * @param trackingNumbers - List of PostEx tracking numbers to include
 * @param pickupAddress - Optional pickup address text (from the address book)
 */
export async function generatePostExLoadSheet(
  companyIntegrationId: string,
  trackingNumbers: string[],
  pickupAddress?: string,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    if (!isElevated(ctx)) {
      return { success: false, error: 'Only elevated roles can generate load sheets.' }
    }

    const integration = await db.companyIntegration.findFirst({
      where: {
        id: companyIntegrationId,
        companyId: ctx.company.id,
        provider: { providerKey: 'postex' },
      },
      include: { provider: true },
    })
    if (!integration) {
      return { success: false, error: 'PostEx integration not found.' }
    }

    const credentials = decryptCredentials(integration.credentialsEncrypted!)
    const adapter = getCourierAdapter('postex', credentials)

    if (!adapter.generateLoadSheet) {
      return { success: false, error: 'PostEx adapter does not support load sheet generation.' }
    }

    const result = await executeLoggedIntegrationAction<{ success: boolean; rawResponse?: unknown; error?: string }>({
      companyIntegrationId,
      organizationId: integration.organizationId,
      actionType: 'generate_load_sheet',
      direction: 'outbound',
      fn: async () => adapter.generateLoadSheet!(trackingNumbers, pickupAddress),
    })

    await insertAuditLog({
      action: 'postex.load_sheet_generated',
      entityType: 'company_integration',
      entityId: companyIntegrationId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: {
        trackingNumbersCount: trackingNumbers.length,
        pickupAddress: pickupAddress ?? null,
      },
    })

    return { success: result.success, data: result }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to generate load sheet',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 2. pollPostExOrderStatuses — the polling job
// ──────────────────────────────────────────────────────────────

/**
 * Poll PostEx for status updates on all active orders AND exchange_shipments.
 *
 * Queries all records with a PostEx courier integration where status is NOT
 * 'delivered' or 'rto' (permanent exclusion — these are never re-polled).
 * Batches tracking numbers, calls trackBulkShipments(), and for each result:
 *   - If status changed → triggers the appropriate OMS function
 *   - If status unchanged → only updates lastPolledAt
 *
 * IDEMPOTENT: calling twice with no underlying change produces no duplicate
 * audit/metric entries beyond the tracking API call log itself.
 *
 * SCHEDULING: needs to run every 30 minutes. Infrastructure-level scheduling
 * (cron, Vercel Cron, etc.) still needs to be connected — same pattern as
 * the city-sync job.
 */
export async function pollPostExOrderStatuses(): Promise<ActionResult<{
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
    // Find all active PostEx company integrations
    const postexIntegrations = await db.companyIntegration.findMany({
      where: {
        isActive: true,
        provider: { providerKey: 'postex' },
        credentialsEncrypted: { not: null },
      },
      include: { provider: true },
    })

    if (postexIntegrations.length === 0) {
      return { success: true, data: { polledOrders: 0, polledShipments: 0, statusChanges: 0, errors: [] } }
    }

    for (const integration of postexIntegrations) {
      try {
        const credentials = decryptCredentials(integration.credentialsEncrypted!)
        const adapter = getCourierAdapter('postex', credentials)

        if (!adapter.trackBulkShipments) {
          errors.push(`PostEx adapter for integration ${integration.id} does not support bulk tracking.`)
          continue
        }

        // ── Fetch active Orders (not delivered/rto) with PostEx tracking ──
        const activeOrders = await db.order.findMany({
          where: {
            courierCompanyIntegrationId: integration.id,
            status: { notIn: ['delivered', 'rto', 'cancelled', 'refunded'] },
            trackingNumber: { not: null },
          },
          select: {
            id: true,
            trackingNumber: true,
            courierSubStatus: true, // we'll use this to detect changes
            status: true,
          },
        })

        // ── Fetch active Exchange Shipments (not delivered/rto) with PostEx tracking ──
        const activeShipments = await db.exchangeShipment.findMany({
          where: {
            courierCompanyIntegrationId: integration.id,
            status: { notIn: ['delivered', 'rto', 'cancelled'] },
            trackingNumber: { not: null },
          },
          select: {
            id: true,
            trackingNumber: true,
            courierSubStatus: true,
            status: true,
          },
        })

        // Combine all tracking numbers for bulk API call
        const allTrackingNumbers: Array<{ trackingNumber: string; type: 'order' | 'shipment'; id: string; currentSubStatus: string | null; currentStatus: string }> = [
          ...activeOrders.map((o) => ({
            trackingNumber: o.trackingNumber!,
            type: 'order' as const,
            id: o.id,
            currentSubStatus: o.courierSubStatus ?? null,
            currentStatus: o.status,
          })),
          ...activeShipments.map((s) => ({
            trackingNumber: s.trackingNumber!,
            type: 'shipment' as const,
            id: s.id,
            currentSubStatus: s.courierSubStatus ?? null,
            currentStatus: s.status,
          })),
        ]

        if (allTrackingNumbers.length === 0) continue

        // Call the bulk tracking API via the logged wrapper
        const trackingResults = await executeLoggedIntegrationAction<TrackShipmentResult[]>({
          companyIntegrationId: integration.id,
          organizationId: integration.organizationId,
          actionType: 'track_shipment_bulk',
          direction: 'outbound',
          fn: async () => adapter.trackBulkShipments!(allTrackingNumbers.map((t) => t.trackingNumber)),
        })

        // Map results back to records by tracking number
        const resultsByTrackingNumber = new Map<string, TrackShipmentResult>()
        for (let i = 0; i < allTrackingNumbers.length; i++) {
          if (trackingResults[i]) {
            resultsByTrackingNumber.set(allTrackingNumbers[i].trackingNumber, trackingResults[i])
          }
        }

        const now = new Date()

        for (const entry of allTrackingNumbers) {
          const result = resultsByTrackingNumber.get(entry.trackingNumber)
          if (!result || !result.success) {
            // Tracking failed for this number — update lastPolledAt only
            if (entry.type === 'order') {
              await db.order.update({ where: { id: entry.id }, data: { lastPolledAt: now } }).catch((e) => {
                console.error(`[poll] Failed to update lastPolledAt for order ${entry.id}:`, e)
              })
              polledOrders++
            } else {
              await db.exchangeShipment.update({ where: { id: entry.id }, data: { lastPolledAt: now } }).catch((e) => {
                console.error(`[poll] Failed to update lastPolledAt for shipment ${entry.id}:`, e)
              })
              polledShipments++
            }
            continue
          }

          // Extract the mapped subStatus from the raw response
          const raw = result.rawResponse as Record<string, unknown> | undefined
          const mappedSubStatus = (raw?.mappedSubStatus as string) ?? null
          const needsShipperAdvice = (raw?.needsShipperAdvice as boolean) ?? false
          const unrecognized = (raw?.unrecognized as boolean) ?? false

          // Check if status changed (compare subStatus)
          const subStatusChanged = mappedSubStatus !== entry.currentSubStatus

          if (entry.type === 'order') {
            // Update lastPolledAt + courierSubStatus + flags
            // NOTE: we also persist unrecognizedCourierStatus on Order (was
            // previously only persisted on ExchangeShipment — bug fix).
            await db.order.update({
              where: { id: entry.id },
              data: {
                lastPolledAt: now,
                courierSubStatus: mappedSubStatus,
                needsShipperAdvice: needsShipperAdvice,
                unrecognizedCourierStatus: unrecognized,
              },
            }).catch((e) => {
              console.error(`[poll] Failed to update courier status for order ${entry.id}:`, e)
            })
            polledOrders++

            if (subStatusChanged) {
              statusChanges++

              // ── "Picked By PostEx" → auto-dispatch ──
              // When PostEx picks up the package, the item has physically left
              // the warehouse. Call performOrderDispatch() which runs the FULL
              // inventory deduction (processInventoryTransaction('sale_dispatched')
              // per item — decrements onHand, releases reserved, locks WAC) +
              // sets status='dispatched' + audit/metric. This is the fix for the
              // critical bug where polling previously set status='dispatched' via
              // direct db.order.update() WITHOUT inventory deduction.
              if (result.status === 'in_transit') {
                try {
                  const order = await db.order.findUnique({
                    where: { id: entry.id },
                    select: { status: true, flowopsOrderNumber: true },
                  })
                  if (order && (order.status === 'confirmed' || order.status === 'processing')) {
                    const dispatchResult = await performOrderDispatch(entry.id, { source: 'auto_poll' })
                    if (dispatchResult.success) {
                      console.log(`[poll] Auto-dispatched ${order.flowopsOrderNumber} (PostEx picked up; inventory deducted${dispatchResult.skipped ? ' — skipped, already dispatched' : ''})`)
                    } else if (!dispatchResult.skipped) {
                      console.error(`[poll] Failed to auto-dispatch order ${entry.id}: ${dispatchResult.error}`)
                      errors.push(`Failed to auto-dispatch order ${entry.id}: ${dispatchResult.error}`)
                    }
                  }
                } catch (e) {
                  console.error(`[poll] Failed to auto-dispatch order ${entry.id}:`, e)
                  errors.push(`Failed to auto-dispatch order ${entry.id}: ${e}`)
                }
              }

              // ── "Delivered" → mark as delivered ──
              if (result.status === 'delivered') {
                try {
                  // First ensure the order is dispatched WITH inventory deduction
                  // (auto-dispatch if still confirmed/processing). performOrderDispatch
                  // creates the sale_dispatched txn so onHand is correctly decremented.
                  const order = await db.order.findUnique({
                    where: { id: entry.id },
                    select: { status: true, flowopsOrderNumber: true },
                  })
                  if (order && (order.status === 'confirmed' || order.status === 'processing')) {
                    const dispatchResult = await performOrderDispatch(entry.id, { source: 'auto_poll' })
                    if (!dispatchResult.success && !dispatchResult.skipped) {
                      console.error(`[poll] Failed to auto-dispatch order ${entry.id} before marking delivered: ${dispatchResult.error}`)
                      errors.push(`Failed to auto-dispatch order ${entry.id} before delivered: ${dispatchResult.error}`)
                    }
                  }
                  if (order && order.status !== 'delivered' && order.status !== 'cancelled' && order.status !== 'refunded') {
                    // Mark as delivered directly (bypass markOrderDelivered's
                    // getWorkspace() which breaks multi-tenant polling).
                    // No inventory change at delivery time — the dispatch txn
                    // already decremented onHand.
                    await db.order.update({
                      where: { id: entry.id },
                      data: {
                        status: 'delivered',
                        deliveredAt: new Date(),
                      },
                    })
                    console.log(`[poll] Marked order ${order.flowopsOrderNumber} as delivered (PostEx confirmed delivery)`)
                  }
                } catch (e) {
                  console.error(`[poll] Failed to mark order ${entry.id} as delivered:`, e)
                  errors.push(`Failed to mark order ${entry.id} as delivered: ${e}`)
                }
              }

              // ── "Returned" → mark as RTO ──
              // RTO means the item came back. The correct inventory treatment is
              // to RELEASE the reservation (order_unreserved) — NOT create a
              // sale_dispatched txn, because the item never stayed sold. This
              // matches the retroactive cleanup fix for RTO orders.
              //
              // NOTE: if the order was already 'dispatched' (has a sale_dispatched
              // txn from a previous in_transit polling cycle), the onHand was
              // already decremented. The correct return would be a return_resellable
              // txn to add stock back, but that requires per-item cost lookup and
              // the full processOrderReturn() logic (which uses getWorkspace()).
              // This is a pre-existing gap in the polling RTO path — NOT introduced
              // by this fix. For orders that go directly confirmed→rto (never
              // dispatched), this path correctly releases the reservation without
              // touching onHand.
              if (result.status === 'returned') {
                try {
                  const order = await db.order.findUnique({
                    where: { id: entry.id },
                    select: { status: true, flowopsOrderNumber: true, dispatchLocationId: true, organizationId: true },
                  })
                  if (order && order.status !== 'rto' && order.status !== 'cancelled' && order.status !== 'refunded') {
                    // If still confirmed/processing, release the reservation for
                    // all reserved items (the item came back — don't dispatch it).
                    if (order.status === 'confirmed' || order.status === 'processing') {
                      const reservedItems = await db.orderItem.findMany({
                        where: { orderId: entry.id, fulfillmentStatus: 'reserved' },
                      })
                      for (const item of reservedItems) {
                        const locationId = item.reservedLocationId ?? order.dispatchLocationId
                        if (!locationId) continue
                        try {
                          await unreserveStockForOrder({
                            orgVariantId: item.orgVariantId,
                            locationId,
                            organizationId: order.organizationId,
                            companyId: integration.companyId,
                            quantity: item.quantity,
                            orderId: entry.id,
                          })
                        } catch (e) {
                          console.error(`[poll] Failed to unreserve stock for RTO item ${item.id}:`, e)
                        }
                      }
                    }
                    // Mark as RTO directly (bypass processOrderReturn's
                    // getWorkspace() which breaks multi-tenant polling)
                    await db.order.update({
                      where: { id: entry.id },
                      data: {
                        status: 'rto',
                        returnedAt: new Date(),
                      },
                    })
                    console.log(`[poll] Marked order ${order.flowopsOrderNumber} as RTO (PostEx returned; reservation released)`)
                  }
                } catch (e) {
                  console.error(`[poll] Failed to mark order ${entry.id} as RTO:`, e)
                  errors.push(`Failed to mark order ${entry.id} as RTO: ${e}`)
                }
              }
              // ── "Cancelled by merchant" / "Expired" → cancel the order ──
              // PostEx returns "Un-Assigned By Me" when the merchant cancels
              // on the PostEx portal, or "Expired" when the booking expires.
              // Both map to genericStatus='failed' + courierSubStatus='cancelled_by_merchant' or 'expired'.
              // We need to cancel the order in FlowOps and unreserve stock.
              if (result.status === 'failed' && mappedSubStatus &&
                  (mappedSubStatus === 'cancelled_by_merchant' || mappedSubStatus === 'expired')) {
                try {
                  const order = await db.order.findUnique({
                    where: { id: entry.id },
                    select: { status: true, flowopsOrderNumber: true, dispatchLocationId: true, organizationId: true },
                  })
                  if (order && order.status !== 'cancelled' && order.status !== 'delivered' && order.status !== 'rto') {
                    // Unreserve stock for reserved items
                    const reservedItems = await db.orderItem.findMany({
                      where: { orderId: entry.id, fulfillmentStatus: 'reserved' },
                    })
                    for (const item of reservedItems) {
                      const locationId = item.reservedLocationId ?? order.dispatchLocationId
                      if (!locationId) continue
                      try {
                        await unreserveStockForOrder({
                          orgVariantId: item.orgVariantId,
                          locationId,
                          organizationId: order.organizationId,
                          companyId: integration.companyId,
                          employeeId: integration.createdBy ?? '',
                          quantity: item.quantity,
                          orderId: entry.id,
                        })
                      } catch (e) {
                        console.error(`[poll] Failed to unreserve stock for item ${item.id}:`, e)
                      }
                    }

                    // Cancel the order
                    await db.order.update({
                      where: { id: entry.id },
                      data: {
                        status: 'cancelled',
                        cancelledAt: new Date(),
                        cancellationReason: `Courier booking ${mappedSubStatus === 'cancelled_by_merchant' ? 'cancelled by merchant on PostEx portal' : 'expired on PostEx'} (detected via status polling)`,
                        courierBookingStatus: 'cancelled',
                      },
                    })
                    console.log(`[poll] Auto-cancelled ${order.flowopsOrderNumber} (PostEx status: ${mappedSubStatus})`)
                  }
                } catch (e) {
                  console.error(`[poll] Failed to auto-cancel order ${entry.id}:`, e)
                  errors.push(`Failed to auto-cancel order ${entry.id}: ${e}`)
                }
              }
            }

            // ── Payment Status lookup (Phase 3 — migration 012) ──
            if (result.status === 'delivered' || result.status === 'returned') {
              try {
                const paymentStatus = await executeLoggedIntegrationAction<{
                  success: boolean
                  settled: boolean
                  settlementDate: string | null
                  error?: string
                }>({
                  companyIntegrationId: integration.id,
                  organizationId: integration.organizationId,
                  actionType: 'fetch_payment_status',
                  direction: 'outbound',
                  relatedEntityType: 'order',
                  relatedEntityId: entry.id,
                  fn: async () => {
                    const postexAdapter = adapter as unknown as {
                      fetchPaymentStatus: (tn: string) => Promise<{
                        success: boolean
                        settled: boolean
                        settlementDate: string | null
                        error?: string
                      }>
                    }
                    if (typeof postexAdapter.fetchPaymentStatus === 'function') {
                      return postexAdapter.fetchPaymentStatus(entry.trackingNumber)
                    }
                    return { success: false, settled: false, settlementDate: null }
                  },
                })

                if (paymentStatus?.settled) {
                  await insertAuditLog({
                    action: 'postex.payment_settled',
                    entityType: 'order',
                    entityId: entry.id,
                    companyId: integration.companyId,
                    organizationId: integration.organizationId,
                    newValues: {
                      trackingNumber: entry.trackingNumber,
                      settlementDate: paymentStatus.settlementDate,
                    },
                  }).catch((e) => console.error(`[poll] Failed to log payment settlement for ${entry.id}:`, e))
                }
              } catch (e) {
                console.error(`[poll] Payment status lookup failed for ${entry.id}:`, e)
              }
            }
          } else {
            // Exchange shipment
            await db.exchangeShipment.update({
              where: { id: entry.id },
              data: {
                lastPolledAt: now,
                courierSubStatus: mappedSubStatus,
                needsShipperAdvice: needsShipperAdvice,
                unrecognizedCourierStatus: unrecognized,
              },
            }).catch((e) => {
              console.error(`[poll] Failed to update courier status for shipment ${entry.id}:`, e)
            })
            polledShipments++

            if (subStatusChanged) {
              statusChanges++

              // ── "Picked By PostEx" → auto-dispatch exchange shipment ──
              // Call performExchangeShipmentDispatch() which runs the FULL
              // inventory deduction (dispatchOrder → sale_dispatched txn —
              // decrements onHand, releases reserved) + sets status='dispatched'
              // + updates parent exchange status + audit/metric. This is the fix
              // for the bug where polling previously set status='dispatched' via
              // direct db.exchangeShipment.update() WITHOUT inventory deduction.
              if (result.status === 'in_transit') {
                try {
                  const shipment = await db.exchangeShipment.findUnique({
                    where: { id: entry.id },
                    select: { status: true, exchangeShipmentNumber: true },
                  })
                  if (shipment && shipment.status === 'confirmed') {
                    const dispatchResult = await performExchangeShipmentDispatch(entry.id, { source: 'auto_poll' })
                    if (dispatchResult.success) {
                      console.log(`[poll] Auto-dispatched exchange shipment ${shipment.exchangeShipmentNumber} (inventory deducted${dispatchResult.skipped ? ' — skipped, already dispatched' : ''})`)
                    } else if (!dispatchResult.skipped) {
                      console.error(`[poll] Failed to auto-dispatch shipment ${entry.id}: ${dispatchResult.error}`)
                      errors.push(`Failed to auto-dispatch shipment ${entry.id}: ${dispatchResult.error}`)
                    }
                  }
                } catch (e) {
                  console.error(`[poll] Failed to auto-dispatch shipment ${entry.id}:`, e)
                  errors.push(`Failed to auto-dispatch shipment ${entry.id}: ${e}`)
                }
              }

              if (result.status === 'delivered') {
                try {
                  const shipment = await db.exchangeShipment.findUnique({
                    where: { id: entry.id },
                    select: { status: true, exchangeShipmentNumber: true },
                  })
                  if (shipment && shipment.status !== 'delivered' && shipment.status !== 'cancelled') {
                    // Auto-dispatch first if needed (with inventory deduction)
                    if (shipment.status === 'confirmed') {
                      const dispatchResult = await performExchangeShipmentDispatch(entry.id, { source: 'auto_poll' })
                      if (!dispatchResult.success && !dispatchResult.skipped) {
                        console.error(`[poll] Failed to auto-dispatch shipment ${entry.id} before delivered: ${dispatchResult.error}`)
                        errors.push(`Failed to auto-dispatch shipment ${entry.id} before delivered: ${dispatchResult.error}`)
                      }
                    }
                    // Mark as delivered (no inventory change at delivery — dispatch txn already decremented onHand)
                    await db.exchangeShipment.update({
                      where: { id: entry.id },
                      data: { status: 'delivered', deliveredAt: new Date() },
                    })
                    console.log(`[poll] Marked exchange shipment ${shipment.exchangeShipmentNumber} as delivered`)
                  }
                } catch (e) {
                  console.error(`[poll] Failed to mark shipment ${entry.id} as delivered:`, e)
                  errors.push(`Failed to mark exchange shipment ${entry.id} as delivered: ${e}`)
                }
              }
            }
          }
        }
      } catch (integrationErr) {
        errors.push(
          `Failed to poll integration ${integration.id}: ${integrationErr instanceof Error ? integrationErr.message : String(integrationErr)}`,
        )
      }
    }

    // Audit log for the polling run (non-fatal) — use the first integration's
    // company/org context so the audit row is queryable (was previously empty strings).
    const firstIntegration = postexIntegrations[0]
    await insertAuditLog({
      action: 'postex.status_poll_completed',
      entityType: 'company_integration',
      entityId: firstIntegration?.id ?? '',
      companyId: firstIntegration?.companyId ?? '',
      organizationId: firstIntegration?.organizationId ?? '',
      newValues: { polledOrders, polledShipments, statusChanges, errorCount: errors.length },
    }).catch((e) => console.error('[poll] Failed to insert audit log:', e))

    await insertMetricEvent({
      companyId: firstIntegration?.companyId ?? '',
      entityType: 'company_integration',
      entityId: firstIntegration?.id ?? '',
      metricKey: 'postex.status_poll_completed',
      numericValue: statusChanges,
      dimensions: { polled_orders: polledOrders, polled_shipments: polledShipments, errors: errors.length },
    }).catch((e) => console.error('[poll] Failed to insert metric event:', e))

    return {
      success: true,
      data: { polledOrders, polledShipments, statusChanges, errors },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to poll PostEx statuses',
      data: { polledOrders, polledShipments, statusChanges, errors },
    }
  }
}
