/**
 * Load Sheets — Server Actions.
 *
 * Courier-agnostic pickup manifest system. Combines orders AND exchange
 * shipments into a single load sheet (a courier rider physically picks up
 * both types in one trip).
 *
 * REUSES the existing PostEx adapter's generateLoadSheet() method (and the
 * generatePostExLoadSheet() action's pattern) — does NOT reimplement PostEx
 * load-sheet generation. The provider dispatch is generic: Leopard/TCS will
 * plug into the same system once their adapters implement generateLoadSheet().
 *
 * The PDF is stored in OUR file storage (not an external courier URL that
 * might expire — same principle as Proof of Delivery and scan reports).
 */

import { db } from '@/lib/db'
import { getWorkspace, isElevated, ApiError } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { decryptCredentials } from '@/lib/utils/encryption'
import { getCourierAdapter } from '@/lib/integrations/registry'
import { executeLoggedIntegrationAction } from '@/lib/integrations/logged-call'
import fs from 'fs/promises'
import path from 'path'

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

interface EntityRef {
  entityType: 'order' | 'exchange_shipment'
  entityId: string
}

interface LoadSheetItem {
  entityType: 'order' | 'exchange_shipment'
  entityId: string
  trackingNumber: string
}

// ──────────────────────────────────────────────────────────────
// 1. generateLoadSheet — create a load sheet for a batch of entities
// ──────────────────────────────────────────────────────────────

/**
 * Generate a load sheet (pickup manifest) for a batch of orders and/or
 * exchange shipments.
 *
 * Provider-agnostic: dispatches to the adapter's generateLoadSheet() method
 * based on the providerKey. For PostEx, this reuses the EXISTING adapter
 * method (the same one generatePostExLoadSheet() calls) — NOT a reimplementation.
 *
 * Business rules:
 *   1. Every referenced entity must have:
 *      - courierBookingStatus='booked'
 *      - courierSubStatus='slip_generated' (booked but not yet load-sheeted)
 *      - loadSheetId IS NULL (not already included in a load sheet)
 *      → reject with a clear error listing any entity that doesn't qualify.
 *   2. Collect tracking numbers, call the adapter's generateLoadSheet().
 *   3. On success: store the returned PDF in our /uploads file storage,
 *      create the load_sheets row, set loadSheetId on every included entity,
 *      and update their courierSubStatus to 'pickup_requested'.
 *   4. Audit log: 'load_sheet.generated'.
 *
 * @param providerKey - 'postex' | 'leopard' | 'tcs' (must have generateLoadSheet() implemented)
 * @param entityRefs - Array of { entityType, entityId } to include
 * @param pickupAddressId - Optional pickup address ID (from the address book)
 */
export async function generateLoadSheet(
  providerKey: string,
  entityRefs: EntityRef[],
  pickupAddressId?: string,
): Promise<ActionResult<{ loadSheetId: string; pdfPath: string; itemCount: number }>> {
  try {
    const ctx = await getWorkspace()
    if (!isElevated(ctx)) {
      return { success: false, error: 'Only elevated roles can generate load sheets.' }
    }

    if (entityRefs.length === 0) {
      return { success: false, error: 'No entities selected for load sheet.' }
    }

    // ── 1. Fetch the company integration for this provider ──
    const integration = await db.companyIntegration.findFirst({
      where: {
        companyId: ctx.company.id,
        isActive: true,
        provider: { providerKey },
      },
      include: { provider: true },
    })
    if (!integration) {
      return { success: false, error: `No active ${providerKey} integration found for this company.` }
    }
    if (!integration.credentialsEncrypted) {
      return { success: false, error: 'No credentials stored for this integration.' }
    }

    // ── 2. Fetch the pickup address (if provided) ──
    let pickupAddressText: string | undefined
    if (pickupAddressId) {
      const pickupAddress = await db.courierPickupAddress.findFirst({
        where: { id: pickupAddressId, companyIntegrationId: integration.id },
      })
      if (!pickupAddress) {
        return { success: false, error: 'Pickup address not found for this integration.' }
      }
      pickupAddressText = pickupAddress.address
    }

    // ── 3. Validate + collect entities ──
    const orderIds = entityRefs.filter((e) => e.entityType === 'order').map((e) => e.entityId)
    const shipmentIds = entityRefs.filter((e) => e.entityType === 'exchange_shipment').map((e) => e.entityId)

    const items: LoadSheetItem[] = []
    const disqualified: Array<{ ref: EntityRef; reason: string }> = []

    // Fetch orders
    if (orderIds.length > 0) {
      const orders = await db.order.findMany({
        where: { id: { in: orderIds }, companyId: ctx.company.id },
        select: {
          id: true,
          flowopsOrderNumber: true,
          trackingNumber: true,
          courierBookingStatus: true,
          courierSubStatus: true,
          loadSheetId: true,
          courierCompanyIntegrationId: true,
        },
      })
      for (const o of orders) {
        const ref = { entityType: 'order' as const, entityId: o.id }
        if (o.courierBookingStatus !== 'booked') {
          disqualified.push({ ref, reason: `courierBookingStatus='${o.courierBookingStatus}' (expected 'booked')` })
        } else if (o.courierSubStatus !== 'slip_generated') {
          disqualified.push({ ref, reason: `courierSubStatus='${o.courierSubStatus}' (expected 'slip_generated')` })
        } else if (o.loadSheetId !== null) {
          disqualified.push({ ref, reason: 'already included in a load sheet' })
        } else if (!o.trackingNumber) {
          disqualified.push({ ref, reason: 'no tracking number' })
        } else if (o.courierCompanyIntegrationId !== integration.id) {
          disqualified.push({ ref, reason: 'booked with a different integration' })
        } else {
          items.push({ entityType: 'order', entityId: o.id, trackingNumber: o.trackingNumber })
        }
      }
      // Flag any order IDs that weren't found
      const foundOrderIds = new Set(orders.map((o) => o.id))
      for (const id of orderIds) {
        if (!foundOrderIds.has(id)) {
          disqualified.push({ ref: { entityType: 'order', entityId: id }, reason: 'not found in this company' })
        }
      }
    }

    // Fetch exchange shipments
    if (shipmentIds.length > 0) {
      const shipments = await db.exchangeShipment.findMany({
        where: { id: { in: shipmentIds }, companyId: ctx.company.id },
        select: {
          id: true,
          exchangeShipmentNumber: true,
          trackingNumber: true,
          courierBookingStatus: true,
          courierSubStatus: true,
          loadSheetId: true,
          courierCompanyIntegrationId: true,
        },
      })
      for (const s of shipments) {
        const ref = { entityType: 'exchange_shipment' as const, entityId: s.id }
        if (s.courierBookingStatus !== 'booked') {
          disqualified.push({ ref, reason: `courierBookingStatus='${s.courierBookingStatus}' (expected 'booked')` })
        } else if (s.courierSubStatus !== 'slip_generated') {
          disqualified.push({ ref, reason: `courierSubStatus='${s.courierSubStatus}' (expected 'slip_generated')` })
        } else if (s.loadSheetId !== null) {
          disqualified.push({ ref, reason: 'already included in a load sheet' })
        } else if (!s.trackingNumber) {
          disqualified.push({ ref, reason: 'no tracking number' })
        } else if (s.courierCompanyIntegrationId !== integration.id) {
          disqualified.push({ ref, reason: 'booked with a different integration' })
        } else {
          items.push({ entityType: 'exchange_shipment', entityId: s.id, trackingNumber: s.trackingNumber })
        }
      }
      const foundShipmentIds = new Set(shipments.map((s) => s.id))
      for (const id of shipmentIds) {
        if (!foundShipmentIds.has(id)) {
          disqualified.push({ ref: { entityType: 'exchange_shipment', entityId: id }, reason: 'not found in this company' })
        }
      }
    }

    // If any entity was disqualified, reject with a clear error
    if (disqualified.length > 0) {
      const errorLines = disqualified.map((d) => {
        const label = d.ref.entityType === 'order' ? 'Order' : 'Exchange Shipment'
        return `  • ${label} ${d.ref.entityId}: ${d.reason}`
      })
      return {
        success: false,
        error: `The following ${disqualified.length} entit${disqualified.length === 1 ? 'y' : 'ies'} cannot be included in a load sheet:\n${errorLines.join('\n')}`,
      }
    }

    if (items.length === 0) {
      return { success: false, error: 'No qualifying entities found.' }
    }

    // ── 4. Call the adapter's generateLoadSheet() ──
    // This reuses the EXISTING adapter method — same one generatePostExLoadSheet() calls.
    const credentials = decryptCredentials(integration.credentialsEncrypted)
    const adapter = getCourierAdapter(providerKey, credentials)

    if (!adapter.generateLoadSheet) {
      return { success: false, error: `The ${providerKey} adapter does not support load sheet generation.` }
    }

    const trackingNumbers = items.map((i) => i.trackingNumber)

    const result = await executeLoggedIntegrationAction<{ success: boolean; error?: string; pdfBase64?: string; rawResponse?: unknown }>({
      companyIntegrationId: integration.id,
      organizationId: integration.organizationId,
      actionType: 'generate_load_sheet',
      direction: 'outbound',
      fn: async () => adapter.generateLoadSheet!(trackingNumbers, pickupAddressText),
    })

    if (!result.success) {
      return { success: false, error: result.error ?? 'Load sheet generation failed.' }
    }

    // ── 5. Store the PDF in our own file storage ──
    let pdfStoragePath: string | null = null
    if (result.pdfBase64) {
      try {
        const dir = path.join(process.cwd(), 'public', 'uploads', 'load-sheets', ctx.company.id)
        await fs.mkdir(dir, { recursive: true })
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const filename = `load-sheet-${providerKey}-${timestamp}.pdf`
        const filepath = path.join(dir, filename)
        const buffer = Buffer.from(result.pdfBase64, 'base64')
        await fs.writeFile(filepath, buffer)
        pdfStoragePath = `/uploads/load-sheets/${ctx.company.id}/${filename}`
      } catch (storeErr) {
        console.error('[load-sheet] Failed to store PDF:', storeErr)
        // Non-fatal — the load sheet row is still created, just without a PDF path
      }
    }

    // ── 6. Create the load_sheets row ──
    const loadSheet = await db.loadSheet.create({
      data: {
        organizationId: ctx.company.organizationId,
        companyId: ctx.company.id,
        providerKey,
        companyIntegrationId: integration.id,
        pickupAddressId: pickupAddressId ?? null,
        items: JSON.stringify(items),
        pdfStoragePath,
        generatedBy: ctx.employee.id,
        generatedAt: new Date(),
      },
    })

    // ── 7. Set loadSheetId + update courierSubStatus on every included entity ──
    const orderItemIds = items.filter((i) => i.entityType === 'order').map((i) => i.entityId)
    const shipmentItemIds = items.filter((i) => i.entityType === 'exchange_shipment').map((i) => i.entityId)

    if (orderItemIds.length > 0) {
      await db.order.updateMany({
        where: { id: { in: orderItemIds } },
        data: {
          loadSheetId: loadSheet.id,
          courierSubStatus: 'pickup_requested',
        },
      })
    }

    if (shipmentItemIds.length > 0) {
      await db.exchangeShipment.updateMany({
        where: { id: { in: shipmentItemIds } },
        data: {
          loadSheetId: loadSheet.id,
          courierSubStatus: 'pickup_requested',
        },
      })
    }

    // ── 8. Audit log ──
    await insertAuditLog({
      action: 'load_sheet.generated',
      entityType: 'load_sheet',
      entityId: loadSheet.id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: {
        providerKey,
        companyIntegrationId: integration.id,
        pickupAddressId: pickupAddressId ?? null,
        itemCount: items.length,
        orderCount: orderItemIds.length,
        shipmentCount: shipmentItemIds.length,
        trackingNumbers,
        pdfStoragePath,
      },
    })

    await insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'load_sheet',
      entityId: loadSheet.id,
      metricKey: 'load_sheet.generated',
      numericValue: items.length,
      dimensions: {
        provider_key: providerKey,
        order_count: orderItemIds.length,
        shipment_count: shipmentItemIds.length,
      },
    }).catch(() => {})

    return {
      success: true,
      data: {
        loadSheetId: loadSheet.id,
        pdfPath: pdfStoragePath ?? '',
        itemCount: items.length,
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to generate load sheet',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 2. listLoadSheetReady — entities ready for load sheet generation
// ──────────────────────────────────────────────────────────────

/**
 * List all orders AND exchange shipments that are ready for load sheet
 * generation for a specific courier integration:
 *   - courierBookingStatus='booked'
 *   - courierSubStatus='slip_generated'
 *   - loadSheetId IS NULL
 *
 * Returns a combined array with entity type badges for the UI checklist.
 */
export async function listLoadSheetReady(companyIntegrationId: string): Promise<ActionResult<{
  orders: Array<{
    id: string
    entityType: 'order'
    referenceNumber: string
    trackingNumber: string
    customerName: string
    bookedAt: string | null
    courierSubStatus: string | null
  }>
  shipments: Array<{
    id: string
    entityType: 'exchange_shipment'
    referenceNumber: string
    trackingNumber: string
    customerName: string
    bookedAt: string | null
    courierSubStatus: string | null
  }>
}>> {
  try {
    const ctx = await getWorkspace()

    const integration = await db.companyIntegration.findFirst({
      where: { id: companyIntegrationId, companyId: ctx.company.id },
    })
    if (!integration) {
      return { success: false, error: 'Integration not found.' }
    }

    // Fetch orders ready for load sheet
    const orders = await db.order.findMany({
      where: {
        companyId: ctx.company.id,
        courierCompanyIntegrationId: companyIntegrationId,
        courierBookingStatus: 'booked',
        courierSubStatus: 'slip_generated',
        loadSheetId: null,
      },
      select: {
        id: true,
        flowopsOrderNumber: true,
        trackingNumber: true,
        dispatchedAt: true,
        customer: { select: { name: true } },
        courierSubStatus: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    // Fetch exchange shipments ready for load sheet
    const shipments = await db.exchangeShipment.findMany({
      where: {
        companyId: ctx.company.id,
        courierCompanyIntegrationId: companyIntegrationId,
        courierBookingStatus: 'booked',
        courierSubStatus: 'slip_generated',
        loadSheetId: null,
      },
      select: {
        id: true,
        exchangeShipmentNumber: true,
        trackingNumber: true,
        dispatchedAt: true,
        customer: { select: { name: true } },
        courierSubStatus: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    return {
      success: true,
      data: {
        orders: orders.map((o) => ({
          id: o.id,
          entityType: 'order' as const,
          referenceNumber: o.flowopsOrderNumber,
          trackingNumber: o.trackingNumber ?? '',
          customerName: o.customer.name,
          bookedAt: o.dispatchedAt?.toISOString() ?? null,
          courierSubStatus: o.courierSubStatus,
        })),
        shipments: shipments.map((s) => ({
          id: s.id,
          entityType: 'exchange_shipment' as const,
          referenceNumber: s.exchangeShipmentNumber,
          trackingNumber: s.trackingNumber ?? '',
          customerName: s.customer.name,
          bookedAt: s.dispatchedAt?.toISOString() ?? null,
          courierSubStatus: s.courierSubStatus,
        })),
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list load-sheet-ready entities',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 3. listLoadSheetHistory — previously generated load sheets
// ──────────────────────────────────────────────────────────────

/**
 * List previously generated load sheets for this company, most recent first.
 * Includes the generating employee's name for the History UI.
 */
export async function listLoadSheetHistory(limit = 20): Promise<ActionResult<{
  loadSheets: Array<{
    id: string
    providerKey: string
    itemCount: number
    pdfStoragePath: string | null
    generatedAt: string
    generatedByName: string | null
    items: Array<{ entityType: string; entityId: string; trackingNumber: string }>
  }>
}>> {
  try {
    const ctx = await getWorkspace()

    const loadSheets = await db.loadSheet.findMany({
      where: { companyId: ctx.company.id },
      select: {
        id: true,
        providerKey: true,
        items: true,
        pdfStoragePath: true,
        generatedAt: true,
        generatedByEmployee: { select: { user: { select: { fullName: true } } } },
      },
      orderBy: { generatedAt: 'desc' },
      take: limit,
    })

    return {
      success: true,
      data: {
        loadSheets: loadSheets.map((ls) => {
          let items: Array<{ entityType: string; entityId: string; trackingNumber: string }> = []
          try {
            items = JSON.parse(ls.items)
          } catch {
            items = []
          }
          return {
            id: ls.id,
            providerKey: ls.providerKey,
            itemCount: items.length,
            pdfStoragePath: ls.pdfStoragePath,
            generatedAt: ls.generatedAt.toISOString(),
            generatedByName: ls.generatedByEmployee?.user.fullName ?? null,
            items,
          }
        }),
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list load sheet history',
    }
  }
}
