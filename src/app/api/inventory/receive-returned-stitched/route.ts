import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { processReturnedStitchedReceipt } from '@/lib/inventory'
import { receiveReturnedStitchedSchema } from '@/lib/validations/inventory'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Receive a returned made-to-order stitched item.
 *
 * INV-002 fix: now delegates to the canonical processReturnedStitchedReceipt()
 * helper (in src/lib/inventory.ts) so EVERY receipt creates BOTH the
 * ReturnedStitchedInventory register row AND the corresponding ledger / loss
 * entry — with the bidirectional link set. Previously this route created only
 * the inventory transaction (or only the loss record on the damaged path);
 * the ReturnedStitchedInventory register row was skipped entirely.
 *
 * If condition = 'damaged': no stock addition. recordStockLoss creates a
 * StockLossRecord (loss_type='damaged', sourceModule='returned_stitched')
 * with createInventoryTransaction=false — onHand is unchanged because the
 * returned item was never added to stock in the first place.
 *
 * If condition = 'perfect'|'good'|'open_box': processInventoryTransaction
 * runs with type 'return_stitched_received', which creates the pool if
 * needed, increments onHand, recalculates WAC, and flips track_inventory
 * to TRUE on the variant (one-way).
 */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const orgId = settings?.activeOrgId
    const company = settings?.activeCompany
    if (!orgId || !company) throw new ApiError(403, 'No active company')

    const caller = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: {
          roleId: caller.roleId,
          permissionKey: { in: [PERMISSIONS.INVENTORY_RECEIVE, PERMISSIONS.INVENTORY_REPORT_LOSS] },
        },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to receive returns.')

    const body = await readBody(req)
    const parsed = receiveReturnedStitchedSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    const d = parsed.data

    // Delegate to the canonical receipt processor (INV-002 fix).
    // The function handles both the damaged and non-damaged branches,
    // creates the ReturnedStitchedInventory register row, links the
    // inventory transaction / loss record, and returns a unified result.
    const result = await processReturnedStitchedReceipt({
      organizationId: orgId,
      companyId: company.id,
      orgVariantId: d.org_variant_id,
      locationId: d.location_id,
      quantity: d.quantity,
      condition: d.condition,
      totalCost: d.total_cost,
      suggestedResalePrice: null,
      originalOrderReference: d.original_order_reference || null,
      returnReason: d.return_reason,
      photos: d.photos,
      notes: d.notes || null,
      employeeId: caller.id,
    })

    if (!result.success) {
      throw new ApiError(500, `Failed to receive returned stitched item: ${result.error}`)
    }

    const costPerUnit = d.total_cost / d.quantity

    insertAuditLog({
      action: 'inventory.stitched_return_received',
      entityType: result.lossRecordId ? 'stock_loss' : 'variant',
      entityId: result.lossRecordId ?? result.recordId ?? d.org_variant_id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: {
        condition: d.condition,
        quantity: d.quantity,
        totalCost: d.total_cost,
        locationId: d.location_id,
        status: result.status,
        recordId: result.recordId,
        inventoryTxnId: result.inventoryTxnId,
        lossRecordId: result.lossRecordId,
        wasDuplicate: result.wasDuplicate,
      },
    })

    // ── Metric event (CRITICAL — powers stitched-return / reverse-logistics KPIs) ──
    insertMetricEvent({
      companyId: company.id,
      entityType: 'product',
      entityId: d.org_variant_id,
      metricKey: 'inventory.returned_stitched_received',
      numericValue: d.quantity * costPerUnit,
      dimensions: {
        location_id: d.location_id,
        quantity: d.quantity,
        condition: d.condition,
        status: result.status ?? 'available',
        fabric_variant_id: (d as Record<string, unknown>).fabric_variant_id,
      },
    })

    // Preserve the route's previous response shapes (one per branch).
    // The `record_id` field is strictly additive — exposed now that the
    // canonical function consistently creates the ReturnedStitchedInventory row.
    if (d.condition === 'damaged') {
      return Response.json({
        success: true,
        record_id: result.recordId,
        loss_record_id: result.lossRecordId ?? 'dedup (already existed)',
        condition: 'damaged',
        status: 'written_off',
        was_duplicate: result.wasDuplicate,
      })
    }

    return Response.json({
      success: true,
      record_id: result.recordId,
      transaction_id: result.inventoryTxnId,
      condition: d.condition,
      status: 'available',
    })
  } catch (err) {
    return handleError(err)
  }
}
