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

    // ── BUG FIX: When cancelling a production order, REVERSE the fabric
    //    consumption if fabric was already consumed.
    //
    //    Problem (from INVENTORY_AUDIT.md CRITICAL #3): the old code only
    //    set status='cancelled' but did NOT return the consumed fabric to
    //    inventory. The fabric was physically still in the warehouse
    //    (tailor didn't use it), but the system's onHand was decremented
    //    at fabric_reserved stage — so the fabric became "invisible" in
    //    the system. Next cycle count would show a phantom shortage.
    //
    //    Fix: when cancelling, if the production order's fabricTxn exists
    //    (meaning fabric was consumed at fabric_reserved stage), create a
    //    reverse transaction that ADDS the fabric back to onHand.
    //
    //    This only applies when fabric was consumed (status was
    //    fabric_reserved / in_production / completed). If status was
    //    'pending' (fabric not yet consumed), there's nothing to reverse.
    if (
      body.status === 'cancelled' &&
      oldValues.status !== 'cancelled' &&
      oldValues.status !== 'pending' &&
      order.fabricTxnId
    ) {
      try {
        const { processInventoryTransaction } = await import('@/lib/inventory')

        // Fetch the original fabric consumption transaction to get the
        // exact quantity + cost that was consumed (so we reverse the same).
        const fabricTxn = await db.inventoryTransaction.findUnique({
          where: { id: order.fabricTxnId },
          select: { quantity: true, costPerUnit: true },
        })

        if (fabricTxn) {
          // fabricTxn.quantity is NEGATIVE (it was an OUT transaction).
          // To reverse, we create an IN transaction with the ABSOLUTE value.
          // We use 'manual_adjustment_in' (not 'cycle_count_adjust') because:
          //   - cycle_count_adjust SETS onHand to a value (wrong — we want to ADD)
          //   - manual_adjustment_in INCREMENTS onHand (correct)
          // The referenceType + notes link it back to the production order
          // so the audit trail is clear.
          const absFabricQty = Math.abs(fabricTxn.quantity)
          await processInventoryTransaction({
            orgVariantId: order.fabricVariantId,
            locationId: order.fabricLocationId,
            organizationId: orgId,
            companyId,
            employeeId: caller.id,
            transactionType: 'manual_adjustment_in',
            quantity: absFabricQty,
            costPerUnit: Number(fabricTxn.costPerUnit) || null,
            referenceType: 'production_order',
            referenceId: id,
            notes: `FABRIC RETURNED: Production order ${order.id} cancelled. Fabric was consumed at fabric_reserved stage but stitching did not complete. Returning ${absFabricQty} units of fabric to inventory. Original txn: ${order.fabricTxnId}.`,
          })
          // Note: the original fabric_consumed_for_stitching transaction
          // remains in the ledger (append-only) — it's the historical
          // record. The new manual_adjustment_in transaction is the
          // reversal. Auditors can trace: consumed on Day 1, returned on
          // Day 5 when order cancelled.
        }
      } catch (reverseErr) {
        // Log but don't fail the cancel — the order IS cancelled, just
        // the fabric reversal failed. Admin can manually adjust later.
        console.error(
          `[production-orders] Cancel: failed to reverse fabric consumption for order ${id}:`,
          reverseErr instanceof Error ? reverseErr.message : reverseErr,
        )
      }
    }

    // ── Automation: when production order is marked "completed", add the
    //    produced stock to inventory AND reserve it for the linked order item.
    //    This closes the MTO cycle: production completes → stock exists →
    //    order can be dispatched (performOrderDispatch will decrement onHand
    //    and release reserved). Without this, dispatch would fail because no
    //    inventory pool entry exists for the freshly-produced items.
    if (body.status === 'completed' && oldValues.status !== 'completed' && order.orderItemId) {
      try {
        const { processInventoryTransaction } = await import('@/lib/inventory')

        // Fetch the linked order item + order to get the dispatch location
        const orderItem = await db.orderItem.findUnique({
          where: { id: order.orderItemId },
          include: {
            order: { select: { id: true, dispatchLocationId: true, organizationId: true, companyId: true } },
            orgVariant: { select: { id: true, sku: true } },
          },
        })

        if (orderItem && orderItem.order.dispatchLocationId) {
          const locationId = orderItem.order.dispatchLocationId
          const orgVariantId = orderItem.orgVariantId
          const organizationId = orderItem.order.organizationId
          const companyId = orderItem.order.companyId
          const quantity = orderItem.quantity

          // Step 1: Add the produced stock to inventory (opening_stock increments onHand)
          const addResult = await processInventoryTransaction({
            orgVariantId,
            locationId,
            organizationId,
            companyId,
            employeeId: caller.id,
            transactionType: 'opening_stock',
            quantity,
            referenceType: 'production_order',
            referenceId: id,
            notes: `Stock added from completed production order ${id}`,
          })

          if (addResult.success) {
            // Step 2: Reserve the stock for the order (order_reserved increments reserved)
            const reserveResult = await processInventoryTransaction({
              orgVariantId,
              locationId,
              organizationId,
              companyId,
              employeeId: caller.id,
              transactionType: 'order_reserved',
              quantity,
              referenceType: 'order',
              referenceId: orderItem.order.id,
              notes: `Reserved for order after production completion`,
            })

            if (reserveResult.success) {
              // Step 3: Set reservedLocationId on the order item (if not already set)
              // so performOrderDispatch knows where to dispatch from
              if (!orderItem.reservedLocationId) {
                await db.orderItem.update({
                  where: { id: orderItem.id },
                  data: { reservedLocationId: locationId },
                })
              }
              console.log(`[production-orders] Auto-stocked + reserved ${quantity} units of ${orderItem.orgVariant.sku} for order ${orderItem.order.id} after production completion`)
            } else {
              console.error(`[production-orders] Failed to reserve stock after production completion: ${reserveResult.error}`)
            }
          } else {
            console.error(`[production-orders] Failed to add stock after production completion: ${addResult.error}`)
          }
        }
      } catch (automationErr) {
        // Non-fatal — the production order status was already updated.
        // Log the error so it can be investigated, but don't fail the PATCH.
        console.error(`[production-orders] Post-completion automation failed:`, automationErr instanceof Error ? automationErr.message : automationErr)
      }
    }

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
