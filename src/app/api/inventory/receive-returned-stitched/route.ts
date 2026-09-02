import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { processInventoryTransaction } from '@/lib/inventory'
import { receiveReturnedStitchedSchema } from '@/lib/validations/inventory'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Receive a returned made-to-order stitched item.
 *
 * If condition = 'damaged': does NOT add to stock. Creates a stock_loss_records
 * entry directly with loss_type = 'damaged', resolution = 'written_off'.
 *
 * If condition = 'perfect'|'good'|'open_box': calls processInventoryTransaction
 * with type 'return_stitched_received', which creates the pool if needed and
 * flips track_inventory to TRUE on the variant (one-way).
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

    const costPerUnit = d.total_cost / d.quantity

    if (d.condition === 'damaged') {
      // Damaged → goes straight to stock_loss_records, no inventory addition
      const lossRecord = await db.stockLossRecord.create({
        data: {
          organizationId: orgId,
          companyId: company.id,
          orgVariantId: d.org_variant_id,
          locationId: d.location_id,
          lossType: 'damaged',
          subType: 'confirmed',
          damageType: 'other',
          quantity: d.quantity,
          costPerUnit,
          investigationStatus: 'none',
          resolution: 'written_off',
          responsibleParty: 'courier',
          evidenceUrls: JSON.stringify(d.photos),
          notes: `Damaged returned stitched item. ${d.notes || ''}`,
          reportedById: caller.id,
          approvedById: caller.id,
          resolvedById: caller.id,
          resolvedAt: new Date(),
        },
      })

      insertAuditLog({
        action: 'inventory.stitched_return_received',
        entityType: 'stock_loss',
        entityId: lossRecord.id,
        companyId: company.id,
        organizationId: orgId,
        userId: user.id,
        employeeId: caller.id,
        newValues: { condition: 'damaged', quantity: d.quantity, totalCost: d.total_cost },
      })

      return Response.json({
        success: true,
        loss_record_id: lossRecord.id,
        condition: 'damaged',
        status: 'written_off',
      })
    }

    // Not damaged → add to stock via processInventoryTransaction
    const txnResult = await processInventoryTransaction({
      orgVariantId: d.org_variant_id,
      locationId: d.location_id,
      organizationId: orgId,
      companyId: company.id,
      employeeId: caller.id,
      transactionType: 'return_stitched_received',
      quantity: d.quantity,
      costPerUnit,
      referenceType: d.original_order_reference ? 'order' : 'manual',
      referenceId: d.original_order_reference || null,
      notes: `Returned stitched item (${d.condition}). ${d.notes || ''}`,
    })

    if (!txnResult.success) {
      throw new ApiError(500, `Failed to receive returned item: ${txnResult.error}`)
    }

    insertAuditLog({
      action: 'inventory.stitched_return_received',
      entityType: 'variant',
      entityId: d.org_variant_id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { condition: d.condition, quantity: d.quantity, totalCost: d.total_cost, locationId: d.location_id },
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
        fabric_variant_id: (d as Record<string, unknown>).fabric_variant_id,
      },
    })

    return Response.json({
      success: true,
      transaction_id: txnResult.transactionId,
      condition: d.condition,
      status: 'available',
    })
  } catch (err) {
    return handleError(err)
  }
}
