import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { recordStockLoss } from '@/lib/stock-loss'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Resolve a supplier return.
 * Sets status + resolution_type + resolution_amount.
 * If resolution = 'credit_note': increments the supplier's credit_balance.
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
    const record = await db.supplierReturn.findFirst({
      where: { id, companyId },
      include: { linkedLossRecord: true },
    })
    if (!record) throw new ApiError(404, 'Supplier return not found.')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_MANAGE_SUPPLIER_RETURNS },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to resolve supplier returns.')

    const body = await readBody<{
      status?: string
      resolution_type?: string
      resolution_amount?: number
      notes?: string
    }>(req)

    const oldValues = { status: record.status, resolutionType: record.resolutionType }

    const updated = await db.supplierReturn.update({
      where: { id },
      data: {
        ...(body.status ? { status: body.status } : {}),
        ...(body.resolution_type !== undefined ? { resolutionType: body.resolution_type || null } : {}),
        ...(body.resolution_amount !== undefined ? { resolutionAmount: body.resolution_amount } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        resolvedById: caller.id,
        resolvedAt: new Date(),
      },
    })

    // If resolution = credit_note: increment supplier's credit_balance
    if (body.resolution_type === 'credit_note' && body.resolution_amount) {
      await db.supplier.update({
        where: { id: record.supplierId },
        data: { creditBalance: { increment: body.resolution_amount } },
      })
    }

    // If status = 'rejected': auto-create a supplier_dispute stock_loss_records entry.
    //
    // F6 fix: previously this code created the StockLossRecord directly via
    // db.stockLossRecord.create, bypassing the unified recordStockLoss()
    // helper. That left sourceModule=NULL — so the supplier-dispute losses
    // didn't show up in any sourceModule-filtered view (the Stock Losses
    // dashboard's "Source: Supplier Return" filter, the supplier-dispute
    // KPI breakdown, etc.). Now we route through recordStockLoss() which:
    //   - Sets sourceModule='supplier_return' (the canonical value for the
    //     StockLossSourceModule enum — the audit's "supplier_dispute"
    //     refers to the lossType, which we preserve as 'supplier_dispute').
    //   - Sets investigationStatus='closed' + resolution='written_off' (the
    //     helper's defaults for non-stock_loss sourceModules) instead of
    //     the old 'none'/'written_off' combo that suggested an open
    //     investigation even though the dispute was just resolved.
    //   - Links the StockLossRecord back to the SupplierReturn via the
    //     supplierReturnId back-relation (the helper now accepts this).
    //   - Uses createInventoryTransaction=false because the supplier_return
    //     InventoryTransaction was ALREADY created when the SupplierReturn
    //     was first POSTed (POST /api/supplier-returns route.ts). Creating
    //     another supplier_return txn here would double-decrement onHand.
    if (body.status === 'rejected' && !record.linkedLossRecord) {
      const lossResult = await recordStockLoss({
        organizationId: orgId,
        companyId,
        orgVariantId: record.orgVariantId,
        locationId: record.locationId,
        lossType: 'supplier_dispute',
        sourceModule: 'supplier_return',
        quantity: record.quantity,
        costPerUnit: Number(record.costPerUnit),
        supplierReturnId: id,
        employeeId: caller.id,
        subType: 'confirmed',
        responsibleParty: 'supplier',
        notes: `Auto-created from rejected supplier return. ${body.notes || ''}`,
        // See comment above — the original supplier_return txn already
        // decremented onHand when the SupplierReturn was created.
        createInventoryTransaction: false,
      })

      let lossRecordId: string | null = null
      if (lossResult.success && !lossResult.wasDuplicate && lossResult.lossRecordId) {
        lossRecordId = lossResult.lossRecordId
        // Backfill resolvedById + resolvedAt — recordStockLoss sets
        // reportedById but doesn't set resolvedById/resolvedAt. The
        // existing direct-create code set these (the dispute is resolved
        // by the rejection), so we preserve that behavior.
        await db.stockLossRecord.update({
          where: { id: lossRecordId },
          data: {
            resolvedById: caller.id,
            resolvedAt: new Date(),
          },
        })
      } else if (lossResult.wasDuplicate) {
        // Loss was already recorded for this supplier return — shouldn't
        // happen because we check !record.linkedLossRecord above, but
        // recordStockLoss's dedup catches it gracefully if it does.
        console.log(`[supplier-returns] Loss already recorded for return ${id}, skipping.`)
      } else if (!lossResult.success) {
        // Real error — log it but don't fail the PATCH. The supplier
        // return IS marked as rejected; the loss record can be created
        // manually later if needed.
        console.error(
          `[supplier-returns] Failed to auto-create stock loss record for rejected return ${id}: ${lossResult.error}`,
        )
      }

      if (lossRecordId) {
        insertAuditLog({
          action: 'stock_loss.supplier_dispute_created',
          entityType: 'stock_loss',
          entityId: lossRecordId,
          companyId,
          organizationId: orgId,
          userId: user.id,
          employeeId: caller.id,
          newValues: { supplierReturnId: id, quantity: record.quantity, sourceModule: 'supplier_return' },
        })
      }
    }

    insertAuditLog({
      action: 'supplier_return.resolved',
      entityType: 'supplier_return',
      entityId: id,
      companyId,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues,
      newValues: body,
    })

    const totalValue = Number(record.costPerUnit) * record.quantity
    const resolutionValue =
      body.resolution_amount !== undefined ? body.resolution_amount : totalValue
    insertMetricEvent({
      companyId,
      entityType: 'supplier',
      entityId: record.supplierId,
      metricKey: 'supplier_return.resolved',
      numericValue: resolutionValue,
      dimensions: {
        resolution_type: body.resolution_type ?? record.resolutionType ?? null,
      },
    })

    return Response.json({ id: updated.id, status: updated.status })
  } catch (err) {
    return handleError(err)
  }
}
