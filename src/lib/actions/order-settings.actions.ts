/**
 * OMS — Company Order Settings server actions.
 *
 * Per-company configurable workflow strictness. When requireOrderConfirmation
 * or requirePackingStep are FALSE, orders can jump straight to 'dispatched'
 * and the DB trigger auto-backfills the skipped timestamps.
 */

import { db } from '@/lib/db'
import { getWorkspace, requirePermission, isElevated, ApiError } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { updateCompanyOrderSettingsSchema, type UpdateCompanyOrderSettingsInput } from '@/lib/validations/order.schemas'

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// ──────────────────────────────────────────────────────────────
// getCompanyOrderSettings
// ──────────────────────────────────────────────────────────────

export async function getCompanyOrderSettings(
  companyId?: string,
): Promise<ActionResult<{
  id: string
  companyId: string
  requireOrderConfirmation: boolean
  requirePackingStep: boolean
  defaultCourier: string | null
  defaultDispatchLocationId: string | null
  updatedAt: Date
}>> {
  try {
    const ctx = await getWorkspace()
    const targetCompanyId = companyId ?? ctx.company.id

    // Verify the caller has access to this company
    if (targetCompanyId !== ctx.company.id && !isElevated(ctx)) {
      return { success: false, error: 'Not authorized to view this company\'s settings' }
    }

    let settings = await db.companyOrderSetting.findUnique({
      where: { companyId: targetCompanyId },
    })

    // Auto-create default settings if missing (safety net — the createCompany
    // hook should have done this, but this ensures consistency)
    if (!settings) {
      settings = await db.companyOrderSetting.create({
        data: { companyId: targetCompanyId },
      })
    }

    return {
      success: true,
      data: {
        id: settings.id,
        companyId: settings.companyId,
        requireOrderConfirmation: settings.requireOrderConfirmation,
        requirePackingStep: settings.requirePackingStep,
        defaultCourier: settings.defaultCourier,
        defaultDispatchLocationId: settings.defaultDispatchLocationId,
        updatedAt: settings.updatedAt,
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to get company order settings',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// updateCompanyOrderSettings
// ──────────────────────────────────────────────────────────────

export async function updateCompanyOrderSettings(
  companyId: string,
  input: UpdateCompanyOrderSettingsInput,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()

    // GUARD: elevated employees only
    if (!isElevated(ctx)) {
      return { success: false, error: 'Only elevated employees can update order settings' }
    }

    // Verify the caller belongs to this company
    if (companyId !== ctx.company.id) {
      return { success: false, error: 'Not authorized to update this company\'s settings' }
    }

    const parsed = updateCompanyOrderSettingsSchema.safeParse(input)
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
    }
    const d = parsed.data

    const existing = await db.companyOrderSetting.findUnique({ where: { companyId } })
    if (!existing) {
      return { success: false, error: 'Order settings not found for this company' }
    }

    const updateData: Record<string, unknown> = { updatedBy: ctx.employee.id }
    if (d.require_order_confirmation !== undefined) {
      updateData.requireOrderConfirmation = d.require_order_confirmation
    }
    if (d.require_packing_step !== undefined) {
      updateData.requirePackingStep = d.require_packing_step
    }
    if (d.default_courier !== undefined) {
      updateData.defaultCourier = d.default_courier || null
    }
    if (d.default_dispatch_location_id !== undefined) {
      updateData.defaultDispatchLocationId = d.default_dispatch_location_id || null
    }

    await db.companyOrderSetting.update({
      where: { companyId },
      data: updateData,
    })

    await insertAuditLog({
      action: 'company_order_settings.updated',
      entityType: 'company_order_settings',
      entityId: existing.id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      oldValues: {
        requireOrderConfirmation: existing.requireOrderConfirmation,
        requirePackingStep: existing.requirePackingStep,
        defaultCourier: existing.defaultCourier,
        defaultDispatchLocationId: existing.defaultDispatchLocationId,
      },
      newValues: updateData,
    })

    await insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'company_order_settings',
      entityId: existing.id,
      metricKey: 'company_order_settings.updated',
      numericValue: 1,
    }).catch(() => {})

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to update company order settings',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// ensureCompanyOrderSettings — internal helper, called by createCompany()
// ──────────────────────────────────────────────────────────────

export async function ensureCompanyOrderSettings(companyId: string): Promise<void> {
  const existing = await db.companyOrderSetting.findUnique({ where: { companyId } })
  if (!existing) {
    await db.companyOrderSetting.create({
      data: { companyId },
    })
  }
}
