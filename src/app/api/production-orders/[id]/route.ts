import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, getWorkspace, handleError, readBody, requirePermission } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { patchProductionOrderSchema } from '@/lib/validations/inventory'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Get a single production order with full details. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // PO-009 fix: previously used legacy `getCurrentUser()` pattern with no
    // permission check — any employee could read full production order
    // detail incl. costs. Now uses getWorkspace() + requirePermission(INVENTORY_VIEW).
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.INVENTORY_VIEW)
    const companyId = ctx.company.id

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
    // F4 fix: include the orderItem relation so we can resolve the parent
    // orderId for the order_reserved transaction below. processInventoryTransaction
    // now sets `orderId = referenceId` whenever referenceType is 'order' or
    // 'order_item' — so callers must pass the parent ORDER id (not the order
    // item id) as referenceId, otherwise the orderId column FK will reject it.
    const order = await db.productionOrder.findFirst({
      where: { id, companyId },
      include: { orderItem: { select: { orderId: true } } },
    })
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
      estimated_completion_date?: string | null
      actual_completion_date?: string | null
      cancellation_reason?: string
    }>(req)

    // PO-014 fix: validate the structured fields with Zod before applying.
    // The PATCH handler previously trusted body-supplied values for status,
    // assigned_tailor, and the completion dates — a malformed status string
    // or out-of-range date would be silently written to the DB. The schema
    // below enforces:
    //   - status ∈ {fabric_reserved, in_production, completed, dispatched,
    //     cancelled} (matches the handler's transition logic)
    //   - assigned_tailor is a string ≤ 100 chars
    //   - estimated_completion_date / actual_completion_date are ISO 8601
    //     datetime strings (or null to clear)
    //
    // `cancellation_reason` is intentionally NOT validated by the schema —
    // it's only consumed when status='cancelled' and stored in a separate
    // `cancellationReason` field. It's read directly from the body for
    // backward compatibility with the existing cancel UI flow.
    const parsed = patchProductionOrderSchema.safeParse({
      status: body.status,
      assigned_tailor: body.assigned_tailor,
      estimated_completion_date: body.estimated_completion_date,
      actual_completion_date: body.actual_completion_date,
    })
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    }
    const d = parsed.data

    const oldValues = { status: order.status, assignedTailor: order.assignedTailor }

    const updateData: Record<string, unknown> = {}
    if (d.status) {
      updateData.status = d.status
      // Set timestamps based on status transition
      if (d.status === 'completed') {
        updateData.actualCompletionDate = new Date()
      }
      if (d.status === 'cancelled') {
        updateData.cancelledAt = new Date()
        updateData.cancellationReason = body.cancellation_reason || null
      }
    }
    if (d.assigned_tailor !== undefined) updateData.assignedTailor = d.assigned_tailor || null
    if (d.estimated_completion_date !== undefined) {
      updateData.estimatedCompletionDate = d.estimated_completion_date ? new Date(d.estimated_completion_date) : null
    }
    if (d.actual_completion_date !== undefined) {
      updateData.actualCompletionDate = d.actual_completion_date ? new Date(d.actual_completion_date) : null
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
      d.status === 'cancelled' &&
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
    //    produced stock to inventory AND (if linked) reserve it for the
    //    waiting order item. This closes the MTO cycle: production
    //    completes → stock exists → order can be dispatched (performOrderDispatch
    //    will decrement onHand and release reserved). Without this, dispatch
    //    would fail because no inventory pool entry exists for the freshly-
    //    produced items.
    //
    //    PO-002 fix (CRITICAL): previously this entire block was guarded by
    //    `if (order.orderItemId)`, which meant manual ProductionOrders and
    //    exchange-shipment-triggered ones (NULL orderItemId) silently lost
    //    their stitched stock — fabric was consumed but the output never
    //    appeared in inventory. Now `opening_stock` is ALWAYS created for
    //    the stitched variant; the `order_reserved` transaction (and the
    //    order-item link update) only fires when `order.orderItemId` IS set.
    if (d.status === 'completed' && oldValues.status !== 'completed') {
      try {
        const { processInventoryTransaction } = await import('@/lib/inventory')

        // ALWAYS create opening_stock for the stitched variant. The stitched
        // product is produced at the fabric location (the tailor's cutting
        // and stitching station), so we add it there. For POs without an
        // orderItemId, the stock sits available for future orders. For POs
        // linked to an order item, we also create an order_reserved txn
        // below so the stock is held for that specific order.
        const addResult = await processInventoryTransaction({
          orgVariantId: order.stitchedVariantId,
          locationId: order.fabricLocationId,
          organizationId: order.organizationId,
          companyId: order.companyId,
          employeeId: caller.id,
          transactionType: 'opening_stock',
          quantity: order.quantity,
          costPerUnit: Number(order.stitchingCost) + Number(order.fabricCost),
          referenceType: 'production_order',
          referenceId: id,
          notes: `Stock added from completed production order ${id}`,
        })

        if (!addResult.success) {
          console.error(`[production-orders] Failed to add stock after production completion: ${addResult.error}`)
        } else {
          // Only create order_reserved if the production order is linked to
          // an order item — the reservation auto-holds the stock for that
          // order so performOrderDispatch can release it later. POs without
          // an orderItemId (manual / exchange-shipment-triggered) leave the
          // stock available for future orders.
          if (order.orderItemId) {
            // F4 fix: pass the parent ORDER id (not the order item id) as
            // referenceId when referenceType='order_item'. processInventoryTransaction
            // now sets `orderId = referenceId` whenever referenceType is 'order'
            // or 'order_item' — so callers must pass the parent ORDER id,
            // otherwise the orderId column FK will reject the insert.
            // The orderItemId is preserved in the notes for audit traceability.
            const parentOrderId = order.orderItem?.orderId ?? null
            const reserveResult = await processInventoryTransaction({
              orgVariantId: order.stitchedVariantId,
              locationId: order.fabricLocationId,
              organizationId: order.organizationId,
              companyId: order.companyId,
              employeeId: caller.id,
              transactionType: 'order_reserved',
              quantity: order.quantity,
              referenceType: 'order_item',
              referenceId: parentOrderId,
              notes: `Reserved for order item ${order.orderItemId}${parentOrderId ? ` (order ${parentOrderId})` : ''} after production completion`,
            })

            if (reserveResult.success) {
              // Set reservedLocationId on the order item (if not already
              // set) so performOrderDispatch knows where to dispatch from.
              // We use updateMany with a `reservedLocationId: null` filter
              // to avoid clobbering a previously-reserved location.
              try {
                await db.orderItem.updateMany({
                  where: { id: order.orderItemId, reservedLocationId: null },
                  data: { reservedLocationId: order.fabricLocationId },
                })
              } catch (linkErr) {
                console.error(
                  `[production-orders] Failed to set reservedLocationId on order item ${order.orderItemId}:`,
                  linkErr instanceof Error ? linkErr.message : linkErr,
                )
              }
              console.log(
                `[production-orders] Auto-stocked + reserved ${order.quantity} units of variant ${order.stitchedVariantId} for order item ${order.orderItemId} after production completion (PO ${id})`,
              )
            } else {
              console.error(`[production-orders] Failed to reserve stock after production completion: ${reserveResult.error}`)
            }
          } else {
            console.log(
              `[production-orders] Auto-stocked ${order.quantity} units of variant ${order.stitchedVariantId} from production order ${id} (no order item link — stock sits available)`,
            )
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
      newValues: { ...body, ...d },
    })

    return Response.json({ id: updated.id, status: updated.status })
  } catch (err) {
    return handleError(err)
  }
}
