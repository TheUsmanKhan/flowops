/**
 * Shipper Advice — Server Actions.
 *
 * Leopard-specific capability: when a shipment needs shipper input (delivery
 * attempts failed, etc.), staff can send advice back to Leopard (Re-Attempt
 * or Return). This is NEW capability beyond what PostEx offers (which is
 * read-only flagging).
 */

import { db } from '@/lib/db'
import { getWorkspace, requirePermission, ApiError } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { decryptCredentials } from '@/lib/utils/encryption'
import { getCourierAdapter } from '@/lib/integrations/registry'
import { executeLoggedIntegrationAction } from '@/lib/integrations/logged-call'

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// ──────────────────────────────────────────────────────────────
// 1. sendShipperAdvice — submit advice to Leopard for a specific entity
// ──────────────────────────────────────────────────────────────

/**
 * Send shipper advice to Leopard for an order or exchange shipment.
 *
 * Validates:
 *   - The entity has needsShipperAdvice=true
 *   - The entity has a Leopard courier integration
 *   - The entity has a tracking number
 *
 * On success:
 *   - Sets lastShipperAdviceSubmittedAt + lastShipperAdviceType
 *   - Does NOT clear needsShipperAdvice (that flag only clears when the
 *     courier's NEXT status update arrives showing progress)
 *
 * @param entityType - 'order' | 'exchange_shipment'
 * @param entityId - The entity ID
 * @param adviceType - 'RA' (Re-Attempt) or 'RT' (Return)
 * @param notes - Optional remarks
 */
export async function sendShipperAdvice(
  entityType: 'order' | 'exchange_shipment',
  entityId: string,
  adviceType: string,
  notes?: string,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)

    // Validate advice type
    if (adviceType !== 'RA' && adviceType !== 'RT') {
      return { success: false, error: `Invalid advice type. Allowed: 'RA' (Re-Attempt) or 'RT' (Return).` }
    }

    // Fetch the entity
    let trackingNumber: string | null
    let companyIntegrationId: string | null
    let needsShipperAdvice: boolean
    let flowopsNumber: string

    if (entityType === 'order') {
      const order = await db.order.findFirst({
        where: { id: entityId, companyId: ctx.company.id },
        select: {
          trackingNumber: true,
          courierCompanyIntegrationId: true,
          needsShipperAdvice: true,
          flowopsOrderNumber: true,
        },
      })
      if (!order) return { success: false, error: 'Order not found.' }
      trackingNumber = order.trackingNumber
      companyIntegrationId = order.courierCompanyIntegrationId
      needsShipperAdvice = order.needsShipperAdvice
      flowopsNumber = order.flowopsOrderNumber
    } else {
      const shipment = await db.exchangeShipment.findFirst({
        where: { id: entityId, companyId: ctx.company.id },
        select: {
          trackingNumber: true,
          courierCompanyIntegrationId: true,
          needsShipperAdvice: true,
          exchangeShipmentNumber: true,
        },
      })
      if (!shipment) return { success: false, error: 'Exchange shipment not found.' }
      trackingNumber = shipment.trackingNumber
      companyIntegrationId = shipment.courierCompanyIntegrationId
      needsShipperAdvice = shipment.needsShipperAdvice
      flowopsNumber = shipment.exchangeShipmentNumber
    }

    if (!trackingNumber) return { success: false, error: 'No tracking number on this entity.' }
    if (!companyIntegrationId) return { success: false, error: 'No courier integration on this entity.' }

    // Soft warning if needsShipperAdvice is false — still allow submission
    // (the flag might have been cleared by a recent status update but the
    // staff member may still want to submit advice)
    if (!needsShipperAdvice) {
      console.log(`[shipper-advice] Warning: ${flowopsNumber} does not have needsShipperAdvice=true, but proceeding with advice submission.`)
    }

    // Fetch the integration + verify it's Leopard
    const integration = await db.companyIntegration.findFirst({
      where: { id: companyIntegrationId, companyId: ctx.company.id },
      include: { provider: true },
    })
    if (!integration) return { success: false, error: 'Courier integration not found.' }

    const providerKey = integration.provider.providerKey
    if (providerKey !== 'leopard') {
      return { success: false, error: `Shipper advice is only supported for Leopard (this entity uses ${providerKey}).` }
    }

    // Decrypt credentials + get the adapter
    const credentials = decryptCredentials(integration.credentialsEncrypted!)
    const adapter = getCourierAdapter(providerKey, credentials)

    // Cast to access the submitShipperAdvice method (it's not on the interface)
    const adviceAdapter = adapter as unknown as {
      submitShipperAdvice: (tn: string, at: string, n?: string) => Promise<{ success: boolean; error?: string; rawResponse?: unknown }>
    }

    if (typeof adviceAdapter.submitShipperAdvice !== 'function') {
      return { success: false, error: 'Leopard adapter does not support submitShipperAdvice().' }
    }

    // Call the adapter via the logged wrapper
    const result = await executeLoggedIntegrationAction<{ success: boolean; error?: string }>({
      companyIntegrationId: integration.id,
      organizationId: integration.organizationId,
      actionType: 'submit_shipper_advice',
      direction: 'outbound',
      relatedEntityType: entityType,
      relatedEntityId: entityId,
      fn: async () => adviceAdapter.submitShipperAdvice(trackingNumber!, adviceType, notes),
    })

    if (!result.success) {
      return { success: false, error: result.error ?? 'Failed to submit shipper advice.' }
    }

    // Update the entity with the advice submission timestamp + type
    const now = new Date()
    if (entityType === 'order') {
      await db.order.update({
        where: { id: entityId },
        data: {
          lastShipperAdviceSubmittedAt: now,
          lastShipperAdviceType: adviceType,
        },
      })
    } else {
      await db.exchangeShipment.update({
        where: { id: entityId },
        data: {
          lastShipperAdviceSubmittedAt: now,
          lastShipperAdviceType: adviceType,
        },
      })
    }

    // Audit log
    await insertAuditLog({
      action: 'shipper_advice.submitted',
      entityType,
      entityId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: {
        trackingNumber,
        adviceType,
        adviceLabel: adviceType === 'RA' ? 'Re-Attempt Delivery' : 'Return Shipment',
        notes: notes ?? null,
      },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to send shipper advice',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 2. listNeedsShipperAdvice — queue view for all entities needing advice
// ──────────────────────────────────────────────────────────────

/**
 * List all orders AND exchange shipments that currently need shipper advice
 * (needsShipperAdvice=true) across both PostEx (read-only flagging) and
 * Leopard (with Respond button). Used by the "Needs Shipper Advice" queue view.
 */
export async function listNeedsShipperAdvice(): Promise<ActionResult<{
  orders: Array<{
    id: string
    referenceNumber: string
    trackingNumber: string
    customerName: string
    status: string
    courierSubStatus: string | null
    courierName: string | null
    providerKey: string
    lastShipperAdviceSubmittedAt: string | null
    lastShipperAdviceType: string | null
  }>
  shipments: Array<{
    id: string
    referenceNumber: string
    trackingNumber: string
    customerName: string
    status: string
    courierSubStatus: string | null
    courierName: string | null
    providerKey: string
    lastShipperAdviceSubmittedAt: string | null
    lastShipperAdviceType: string | null
  }>
}>> {
  try {
    const ctx = await getWorkspace()

    const orders = await db.order.findMany({
      where: { companyId: ctx.company.id, needsShipperAdvice: true },
      select: {
        id: true,
        flowopsOrderNumber: true,
        trackingNumber: true,
        status: true,
        courierSubStatus: true,
        courierName: true,
        courierCompanyIntegrationId: true,
        lastShipperAdviceSubmittedAt: true,
        lastShipperAdviceType: true,
        customer: { select: { name: true } },
      },
      orderBy: { lastPolledAt: 'desc' },
    })

    const shipments = await db.exchangeShipment.findMany({
      where: { companyId: ctx.company.id, needsShipperAdvice: true },
      select: {
        id: true,
        exchangeShipmentNumber: true,
        trackingNumber: true,
        status: true,
        courierSubStatus: true,
        courierCompanyIntegrationId: true,
        lastShipperAdviceSubmittedAt: true,
        lastShipperAdviceType: true,
        customer: { select: { name: true } },
      },
      orderBy: { lastPolledAt: 'desc' },
    })

    // Fetch provider keys for the integrations
    const integrationIds = new Set([
      ...orders.map((o) => o.courierCompanyIntegrationId).filter(Boolean),
      ...shipments.map((s) => s.courierCompanyIntegrationId).filter(Boolean),
    ])
    const integrations = await db.companyIntegration.findMany({
      where: { id: { in: Array.from(integrationIds) as string[] } },
      select: { id: true, provider: { select: { providerKey: true } } },
    })
    const providerKeyMap = new Map(integrations.map((i) => [i.id, i.provider.providerKey]))

    return {
      success: true,
      data: {
        orders: orders.map((o) => ({
          id: o.id,
          referenceNumber: o.flowopsOrderNumber,
          trackingNumber: o.trackingNumber ?? '',
          customerName: o.customer.name,
          status: o.status,
          courierSubStatus: o.courierSubStatus,
          courierName: o.courierName,
          providerKey: providerKeyMap.get(o.courierCompanyIntegrationId ?? '') ?? '',
          lastShipperAdviceSubmittedAt: o.lastShipperAdviceSubmittedAt?.toISOString() ?? null,
          lastShipperAdviceType: o.lastShipperAdviceType,
        })),
        shipments: shipments.map((s) => ({
          id: s.id,
          referenceNumber: s.exchangeShipmentNumber,
          trackingNumber: s.trackingNumber ?? '',
          customerName: s.customer.name,
          status: s.status,
          courierSubStatus: s.courierSubStatus,
          courierName: null, // ExchangeShipment doesn't have courierName — derive from provider
          providerKey: providerKeyMap.get(s.courierCompanyIntegrationId ?? '') ?? '',
          lastShipperAdviceSubmittedAt: s.lastShipperAdviceSubmittedAt?.toISOString() ?? null,
          lastShipperAdviceType: s.lastShipperAdviceType,
        })),
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list needs-shipper-advice entities',
    }
  }
}
