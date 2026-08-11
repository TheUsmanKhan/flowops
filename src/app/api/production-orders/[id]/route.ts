import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Get a single production order with full details. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const { id } = await params
    const order = await db.productionOrder.findFirst({
      where: { id, companyId },
      include: {
        stitchedVariant: { select: { id: true, sku: true, product: { select: { title: true } } } },
        fabricVariant: { select: { id: true, sku: true } },
        fabricLocation: { select: { id: true, name: true } },
        fabricTxn: { select: { id: true, quantity: true, costPerUnit: true } },
      },
    })
    if (!order) throw new ApiError(404, 'Production order not found.')

    return Response.json({
      order: {
        id: order.id,
        status: order.status,
        quantity: order.quantity,
        stitchingCost: Number(order.stitchingCost),
        fabricCost: Number(order.fabricCost),
        totalCost: Number(order.stitchingCost) + Number(order.fabricCost),
        assignedTailor: order.assignedTailor,
        estimatedCompletionDate: order.estimatedCompletionDate?.toISOString() ?? null,
        actualCompletionDate: order.actualCompletionDate?.toISOString() ?? null,
        referenceType: order.referenceType,
        referenceId: order.referenceId,
        createdAt: order.createdAt.toISOString(),
        cancelledAt: order.cancelledAt?.toISOString() ?? null,
        cancellationReason: order.cancellationReason,
        stitchedVariant: order.stitchedVariant,
        fabricVariant: order.fabricVariant,
        fabricLocation: order.fabricLocation,
        fabricTxn: order.fabricTxn
          ? {
              id: order.fabricTxn.id,
              quantity: order.fabricTxn.quantity,
              costPerUnit: Number(order.fabricTxn.costPerUnit),
            }
          : null,
      },
    })
  } catch (err) {
    return handleError(err)
  }
}

/**
 * Update a production order's status.
 * Supported transitions:
 *   fabric_reserved → in_production (tailor starts working)
 *   in_production → completed (stitching done)
 *   completed → dispatched (sent to customer)
 *   any → cancelled
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const companyId = settings?.activeCompanyId
    const orgId = settings?.activeOrgId
    if (!companyId || !orgId) throw new ApiError(403, 'No active company')

    const { id } = await params
    const order = await db.productionOrder.findFirst({ where: { id, companyId } })
    if (!order) throw new ApiError(404, 'Production order not found.')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_MANAGE_PRODUCTION },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to manage production orders.')

    const body = await readBody<{
      status?: string
      assigned_tailor?: string
      estimated_completion_date?: string
      actual_completion_date?: string
      cancellation_reason?: string
    }>(req)

    const oldValues = { status: order.status, assignedTailor: order.assignedTailor }

    const updateData: Record<string, unknown> = {}
    if (body.status) {
      updateData.status = body.status
      // Set timestamps based on status transition
      if (body.status === 'completed') {
        updateData.actualCompletionDate = new Date()
      }
      if (body.status === 'cancelled') {
        updateData.cancelledAt = new Date()
        updateData.cancellationReason = body.cancellation_reason || null
      }
    }
    if (body.assigned_tailor !== undefined) updateData.assignedTailor = body.assigned_tailor || null
    if (body.estimated_completion_date !== undefined) {
      updateData.estimatedCompletionDate = body.estimated_completion_date ? new Date(body.estimated_completion_date) : null
    }
    if (body.actual_completion_date !== undefined) {
      updateData.actualCompletionDate = body.actual_completion_date ? new Date(body.actual_completion_date) : null
    }

    const updated = await db.productionOrder.update({
      where: { id },
      data: updateData,
    })

    insertAuditLog({
      action: 'production_order.updated',
      entityType: 'production_order',
      entityId: id,
      companyId,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues,
      newValues: body,
    })

    return Response.json({ id: updated.id, status: updated.status })
  } catch (err) {
    return handleError(err)
  }
}
