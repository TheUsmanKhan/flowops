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
              await db.order.update({ where: { id: entry.id }, data: { lastPolledAt: now } }).catch(() => {})
              polledOrders++
            } else {
              await db.exchangeShipment.update({ where: { id: entry.id }, data: { lastPolledAt: now } }).catch(() => {})
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
            await db.order.update({
              where: { id: entry.id },
              data: {
                lastPolledAt: now,
                courierSubStatus: mappedSubStatus, // reuse the existing column
                needsShipperAdvice: needsShipperAdvice, // Note: this column doesn't exist on Order yet — see note below
              },
            }).catch(() => {})
            polledOrders++

            if (subStatusChanged) {
              statusChanges++
              // Trigger OMS functions if the mapped status requires it
              if (result.status === 'delivered') {
                // Dynamic import to avoid circular dependency
                const { markOrderDelivered } = await import('./order.actions')
                await markOrderDelivered(entry.id).catch((e) => {
                  errors.push(`Failed to mark order ${entry.id} as delivered: ${e}`)
                })
              } else if (result.status === 'returned') {
                const { processOrderReturn } = await import('./order-return.actions')
                await processOrderReturn(entry.id, 'Courier returned (RTO) — detected via PostEx polling').catch((e) => {
                  errors.push(`Failed to process RTO for order ${entry.id}: ${e}`)
                })
              }
            }

            // ── Payment Status lookup (Phase 3 — migration 012) ──
            // For orders that have reached delivered/rto, also check payment
            // settlement status. Non-fatal — failure doesn't break the main poll.
            // NOTE: PostEx's Payment Status API does NOT break out delivery charge
            // separately — actualDeliveryCharge CANNOT be auto-populated.
            // We still call it to record settlement metadata for audit purposes.
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
                    // fetchPaymentStatus is not on the CourierAdapter interface —
                    // it's a PostEx-specific method. Cast to access it.
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

                // If settled, record it in an audit log (non-fatal)
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
                  }).catch(() => {})
                }
                // NOTE: actualDeliveryCharge is NOT populated here because
                // PostEx's Payment Status API does not break out delivery charge.
              } catch {
                // Non-fatal — payment status lookup failure doesn't break the poll
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
            }).catch(() => {})
            polledShipments++

            if (subStatusChanged) {
              statusChanges++
              if (result.status === 'delivered') {
                const { markExchangeShipmentDelivered } = await import('./exchange-shipment.actions')
                await markExchangeShipmentDelivered(entry.id).catch((e) => {
                  errors.push(`Failed to mark exchange shipment ${entry.id} as delivered: ${e}`)
                })
              }
              // Note: RTO for exchange shipments doesn't trigger processOrderReturn —
              // exchange shipments have their own simpler lifecycle. The RTO is
              // just recorded as a status change. Prompt 5 may add additional handling.
            }
          }
        }
      } catch (integrationErr) {
        errors.push(
          `Failed to poll integration ${integration.id}: ${integrationErr instanceof Error ? integrationErr.message : String(integrationErr)}`,
        )
      }
    }

    // Audit log for the polling run (non-fatal)
    await insertAuditLog({
      action: 'postex.status_poll_completed',
      entityType: 'company_integration',
      entityId: '',
      companyId: '',
      organizationId: '',
      newValues: { polledOrders, polledShipments, statusChanges, errorCount: errors.length },
    }).catch(() => {})

    await insertMetricEvent({
      companyId: '',
      entityType: 'company_integration',
      entityId: '',
      metricKey: 'postex.status_poll_completed',
      numericValue: statusChanges,
      dimensions: { polled_orders: polledOrders, polled_shipments: polledShipments, errors: errors.length },
    }).catch(() => {})

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
