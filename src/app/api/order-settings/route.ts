import { db } from '@/lib/db'
import { ApiError, handleError, readBody, isElevated, getWorkspace } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateSchema = z.object({
  require_order_confirmation: z.boolean().optional(),
  require_packing_step: z.boolean().optional(),
  default_courier: z.string().max(100).optional().or(z.literal('')),
  default_dispatch_location_id: z.string().optional().or(z.literal('')),
  // Integration Framework (migration 004)
  courier_booking_mode: z.enum(['automatic', 'semi_manual']).optional(),
  default_courier_company_integration_id: z.string().optional().or(z.literal('')),
})

/** Get the active company's order workflow settings. */
export async function GET() {
  try {
    const ctx = await getWorkspace()
    let settings = await db.companyOrderSetting.findUnique({
      where: { companyId: ctx.company.id },
    })
    if (!settings) {
      settings = await db.companyOrderSetting.create({
        data: { companyId: ctx.company.id },
      })
    }
    return Response.json({
      settings: {
        id: settings.id,
        companyId: settings.companyId,
        requireOrderConfirmation: settings.requireOrderConfirmation,
        requirePackingStep: settings.requirePackingStep,
        defaultCourier: settings.defaultCourier,
        defaultDispatchLocationId: settings.defaultDispatchLocationId,
        courierBookingMode: settings.courierBookingMode,
        defaultCourierCompanyIntegrationId: settings.defaultCourierCompanyIntegrationId,
        updatedAt: settings.updatedAt.toISOString(),
      },
    })
  } catch (err) {
    return handleError(err)
  }
}

/** Update the active company's order workflow settings (elevated only). */
export async function PUT(req: Request) {
  try {
    const ctx = await getWorkspace()
    if (!isElevated(ctx)) {
      throw new ApiError(403, 'Only elevated employees can update order settings')
    }

    const body = await readBody(req)
    const parsed = updateSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    }
    const d = parsed.data

    const existing = await db.companyOrderSetting.findUnique({
      where: { companyId: ctx.company.id },
    })
    if (!existing) {
      throw new ApiError(404, 'Order settings not found for this company')
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
    if (d.courier_booking_mode !== undefined) {
      updateData.courierBookingMode = d.courier_booking_mode
    }
    if (d.default_courier_company_integration_id !== undefined) {
      updateData.defaultCourierCompanyIntegrationId = d.default_courier_company_integration_id || null
    }

    await db.companyOrderSetting.update({
      where: { companyId: ctx.company.id },
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

    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
