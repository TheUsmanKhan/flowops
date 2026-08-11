/**
 * Order Scan Module — Server Actions.
 *
 * processScan(): central barcode-scan processing function.
 * Triggers EXISTING order-lifecycle functions (markOrderProcessing,
 * markOrderPacked, processOrderReturn, cancelCourierBooking) without
 * duplicating their internal logic.
 *
 * Every scan (success, rejection, not-found) is logged to the immutable
 * scan_events table for audit and reporting.
 */

import { db } from '@/lib/db'
import { getWorkspace, requirePermission, ApiError } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'

type ScanMode = 'mark_processing' | 'mark_packed' | 'warehouse_handover' | 'receive_return' | 'locate_cancelled' | 'cancel_via_scan'
type EntityType = 'order' | 'exchange_shipment'

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

interface ScanLookupResult {
  entityType: EntityType
  entityId: string
  trackingNumber: string | null
  status: string
  flowopsOrderNumber?: string
  exchangeShipmentNumber?: string
  customerId?: string
  customerName?: string
  courierSubStatus: string | null
  physicalUnpackRequired?: boolean
  physicalUnpackConfirmedAt?: Date | null
  items?: Array<{ sku: string; productTitle: string; quantity: number }>
}

/**
 * Process a barcode scan. Looks up the tracking number, branches by scanMode,
 * triggers the corresponding existing lifecycle function, and logs the result.
 */
export async function processScan(
  trackingNumberScanned: string,
  scanMode: ScanMode,
  scanStationLabel?: string,
): Promise<ActionResult<{
  scanResult: 'success' | 'rejected' | 'not_found'
  entity?: ScanLookupResult
  rejectionReason?: string
  message?: string
}>> {
  try {
    const ctx = await getWorkspace()
    // All scan modes require at least ORDERS_FULFILL (warehouse activity)
    await requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)

    const trimmedTracking = trackingNumberScanned.trim()
    if (!trimmedTracking) {
      return { success: false, error: 'Tracking number is empty.' }
    }

    // ── 1. Look up the scanned value against Order + ExchangeShipment ──
    const [orderMatch, shipmentMatch] = await Promise.all([
      db.order.findFirst({
        where: { trackingNumber: trimmedTracking, companyId: ctx.company.id },
        select: {
          id: true, trackingNumber: true, status: true, flowopsOrderNumber: true,
          customerId: true, courierSubStatus: true,
          physicalUnpackRequired: true, physicalUnpackConfirmedAt: true,
          customer: { select: { name: true } },
          items: { select: { quantity: true, orgVariant: { select: { sku: true, product: { select: { title: true } } } } } },
        },
      }),
      db.exchangeShipment.findFirst({
        where: { trackingNumber: trimmedTracking, companyId: ctx.company.id },
        select: {
          id: true, trackingNumber: true, status: true, exchangeShipmentNumber: true,
          customerId: true, courierSubStatus: true,
          physicalUnpackRequired: true, physicalUnpackConfirmedAt: true,
          customer: { select: { name: true } },
          newOrgVariant: { select: { sku: true, product: { select: { title: true } } } },
          quantity: true,
        },
      }),
    ])

    let lookup: ScanLookupResult | null = null

    if (orderMatch) {
      lookup = {
        entityType: 'order' as EntityType,
        entityId: orderMatch.id,
        trackingNumber: orderMatch.trackingNumber,
        status: orderMatch.status,
        flowopsOrderNumber: orderMatch.flowopsOrderNumber,
        customerId: orderMatch.customerId,
        customerName: orderMatch.customer?.name,
        courierSubStatus: orderMatch.courierSubStatus,
        physicalUnpackRequired: orderMatch.physicalUnpackRequired,
        physicalUnpackConfirmedAt: orderMatch.physicalUnpackConfirmedAt,
        items: orderMatch.items.map((i) => ({
          sku: i.orgVariant.sku,
          productTitle: i.orgVariant.product.title,
          quantity: i.quantity,
        })),
      }
    } else if (shipmentMatch) {
      lookup = {
        entityType: 'exchange_shipment' as EntityType,
        entityId: shipmentMatch.id,
        trackingNumber: shipmentMatch.trackingNumber,
        status: shipmentMatch.status,
        exchangeShipmentNumber: shipmentMatch.exchangeShipmentNumber,
        customerId: shipmentMatch.customerId,
        customerName: shipmentMatch.customer?.name,
        courierSubStatus: shipmentMatch.courierSubStatus,
        physicalUnpackRequired: shipmentMatch.physicalUnpackRequired,
        physicalUnpackConfirmedAt: shipmentMatch.physicalUnpackConfirmedAt,
        items: [{
          sku: shipmentMatch.newOrgVariant.sku,
          productTitle: shipmentMatch.newOrgVariant.product.title,
          quantity: shipmentMatch.quantity,
        }],
      }
    }

    // ── 2. If no match found: log 'not_found' and return ──
    if (!lookup) {
      await logScanEvent(ctx, scanMode, null, null, trimmedTracking, 'not_found',
        'No order or exchange shipment found with this tracking number', scanStationLabel)
      return {
        success: true,
        data: {
          scanResult: 'not_found' as const,
          rejectionReason: 'No order or exchange shipment found with this tracking number',
        },
      }
    }

    // ── 3. Branch by scanMode ──
    switch (scanMode) {
      // ─── a. mark_processing ───
      case 'mark_processing': {
        if (lookup.entityType !== 'order') {
          await logScanEvent(ctx, scanMode, lookup.entityType, lookup.entityId, trimmedTracking, 'rejected',
            'mark_processing mode only applies to orders, not exchange shipments', scanStationLabel)
          return { success: true, data: { scanResult: 'rejected' as const, entity: lookup, rejectionReason: 'mark_processing mode only applies to orders, not exchange shipments' } }
        }

        const { markOrderProcessing } = await import('./order.actions')
        const result = await markOrderProcessing(lookup.entityId)

        if (result.success) {
          await logScanEvent(ctx, scanMode, lookup.entityType, lookup.entityId, trimmedTracking, 'success', undefined, scanStationLabel)
          return { success: true, data: { scanResult: 'success' as const, entity: lookup, message: `Order ${lookup.flowopsOrderNumber} marked as processing` } }
        } else {
          await logScanEvent(ctx, scanMode, lookup.entityType, lookup.entityId, trimmedTracking, 'rejected', result.error, scanStationLabel)
          return { success: true, data: { scanResult: 'rejected' as const, entity: lookup, rejectionReason: result.error } }
        }
      }

      // ─── b. mark_packed ───
      case 'mark_packed': {
        if (lookup.entityType !== 'order') {
          await logScanEvent(ctx, scanMode, lookup.entityType, lookup.entityId, trimmedTracking, 'rejected',
            'mark_packed mode only applies to orders, not exchange shipments', scanStationLabel)
          return { success: true, data: { scanResult: 'rejected' as const, entity: lookup, rejectionReason: 'mark_packed mode only applies to orders, not exchange shipments' } }
        }

        const { markOrderPacked } = await import('./order.actions')
        const result = await markOrderPacked(lookup.entityId)

        if (result.success) {
          await logScanEvent(ctx, scanMode, lookup.entityType, lookup.entityId, trimmedTracking, 'success', undefined, scanStationLabel)
          return { success: true, data: { scanResult: 'success' as const, entity: lookup, message: `Order ${lookup.flowopsOrderNumber} marked as packed` } }
        } else {
          await logScanEvent(ctx, scanMode, lookup.entityType, lookup.entityId, trimmedTracking, 'rejected', result.error, scanStationLabel)
          return { success: true, data: { scanResult: 'rejected' as const, entity: lookup, rejectionReason: result.error } }
        }
      }

      // ─── c. warehouse_handover ───
      case 'warehouse_handover': {
        const now = new Date()
        if (lookup.entityType === 'order') {
          await db.order.update({ where: { id: lookup.entityId }, data: { warehouseHandoverScannedAt: now } })
        } else {
          await db.exchangeShipment.update({ where: { id: lookup.entityId }, data: { warehouseHandoverScannedAt: now } })
        }
        await logScanEvent(ctx, scanMode, lookup.entityType, lookup.entityId, trimmedTracking, 'success', undefined, scanStationLabel)
        return { success: true, data: { scanResult: 'success' as const, entity: lookup, message: `Warehouse handover recorded for ${lookup.flowopsOrderNumber ?? lookup.exchangeShipmentNumber}` } }
      }

      // ─── d. receive_return ───
      case 'receive_return': {
        // Return entity details to UI — staff selects condition BEFORE calling processOrderReturn
        await logScanEvent(ctx, scanMode, lookup.entityType, lookup.entityId, trimmedTracking, 'success', undefined, scanStationLabel)
        return { success: true, data: { scanResult: 'success' as const, entity: lookup, message: `Order identified — select return condition to proceed` } }
      }

      // ─── e. locate_cancelled ───
      case 'locate_cancelled': {
        if (lookup.status !== 'cancelled') {
          await logScanEvent(ctx, scanMode, lookup.entityType, lookup.entityId, trimmedTracking, 'rejected',
            `This order is not cancelled (status: ${lookup.status}) — locate mode is only for already-cancelled orders`, scanStationLabel)
          return { success: true, data: { scanResult: 'rejected' as const, entity: lookup, rejectionReason: `This order is not cancelled (status: ${lookup.status}) — locate mode is only for already-cancelled orders` } }
        }
        await logScanEvent(ctx, scanMode, lookup.entityType, lookup.entityId, trimmedTracking, 'success', undefined, scanStationLabel)
        return { success: true, data: { scanResult: 'success' as const, entity: lookup, message: `Cancelled order located — review items and confirm physical unpack` } }
      }

      // ─── f. cancel_via_scan ───
      case 'cancel_via_scan': {
        if (!lookup.courierSubStatus || !['slip_generated', 'pickup_requested'].includes(lookup.courierSubStatus)) {
          await logScanEvent(ctx, scanMode, lookup.entityType, lookup.entityId, trimmedTracking, 'rejected',
            'This order can no longer be cancelled through the courier — it has already been picked up.', scanStationLabel)
          return { success: true, data: { scanResult: 'rejected' as const, entity: lookup, rejectionReason: 'This order can no longer be cancelled through the courier — it has already been picked up.' } }
        }
        // Return entity summary for confirmation — do NOT cancel yet
        await logScanEvent(ctx, scanMode, lookup.entityType, lookup.entityId, trimmedTracking, 'success', undefined, scanStationLabel)
        return { success: true, data: { scanResult: 'success' as const, entity: lookup, message: `Order identified — confirm cancellation to proceed` } }
      }

      default:
        return { success: false, error: `Unknown scan mode: ${scanMode}` }
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to process scan' }
  }
}

/**
 * Confirm physical unpack for a cancelled order (separate from the scan itself).
 */
export async function confirmPhysicalUnpack(
  entityType: EntityType,
  entityId: string,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)

    const now = new Date()
    if (entityType === 'order') {
      const order = await db.order.findFirst({
        where: { id: entityId, companyId: ctx.company.id },
        select: { physicalUnpackRequired: true, physicalUnpackConfirmedAt: true, status: true }
      })
      if (!order) return { success: false, error: 'Order not found' }
      if (!order.physicalUnpackRequired) return { success: false, error: 'This order does not require physical unpacking' }
      if (order.physicalUnpackConfirmedAt) return { success: false, error: 'Physical unpack already confirmed' }

      await db.order.update({ where: { id: entityId }, data: { physicalUnpackConfirmedAt: now } })
    } else {
      const shipment = await db.exchangeShipment.findFirst({
        where: { id: entityId, companyId: ctx.company.id },
        select: { physicalUnpackRequired: true, physicalUnpackConfirmedAt: true }
      })
      if (!shipment) return { success: false, error: 'Exchange shipment not found' }
      if (!shipment.physicalUnpackRequired) return { success: false, error: 'This shipment does not require physical unpacking' }
      if (shipment.physicalUnpackConfirmedAt) return { success: false, error: 'Physical unpack already confirmed' }

      await db.exchangeShipment.update({ where: { id: entityId }, data: { physicalUnpackConfirmedAt: now } })
    }

    insertAuditLog({
      action: 'scan.physical_unpack_confirmed',
      entityType,
      entityId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
    })

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to confirm physical unpack' }
  }
}

/**
 * Confirm cancellation after scan (calls existing cancelCourierBooking).
 */
export async function confirmCancelAfterScan(
  entityType: EntityType,
  entityId: string,
): Promise<ActionResult> {
  try {
    const { cancelCourierBooking } = await import('./courier-cancel.actions')
    const result = await cancelCourierBooking(entityType, entityId)

    // Log the outcome to scan_events
    const ctx = await getWorkspace()
    // We can't know the exact tracking number here without re-fetching,
    // but cancelCourierBooking already logs its own audit entry.
    // For scan_events, we log the confirmation result.
    await logScanEvent(ctx, 'cancel_via_scan', entityType, entityId,
      '(confirmed)', result.success ? 'success' : 'rejected',
      result.error, undefined)

    return result
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to cancel' }
  }
}

// ─── Helper: insert scan_events row ───
async function logScanEvent(
  ctx: Awaited<ReturnType<typeof getWorkspace>>,
  scanMode: string,
  entityType: string | null,
  entityId: string | null,
  trackingNumberScanned: string,
  scanResult: 'success' | 'rejected' | 'not_found',
  rejectionReason: string | undefined,
  scanStationLabel: string | undefined,
) {
  await db.scanEvent.create({
    data: {
      organizationId: ctx.company.organizationId,
      companyId: ctx.company.id,
      scanMode,
      entityType: entityType ?? '',
      entityId: entityId,
      trackingNumberScanned,
      scanResult,
      rejectionReason: rejectionReason ?? null,
      scannedBy: ctx.employee.id,
      scanStationLabel: scanStationLabel ?? null,
    },
  }).catch((e) => console.error('[scan] Failed to log scan event:', e))
}
