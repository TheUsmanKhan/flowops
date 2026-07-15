import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { processInventoryTransaction } from '@/lib/inventory'
import { reportDamagedLossSchema } from '@/lib/validations/stock-loss'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Report DAMAGED stock — single-stage, instant write-off.
 * Creates a damage_writeoff inventory transaction immediately.
 * investigation_status = 'none', resolution = 'written_off' at creation.
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
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_REPORT_LOSS },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to report stock loss.')

    const body = await readBody(req)
    const parsed = reportDamagedLossSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    const d = parsed.data

    // Fetch current avg_cost for this variant+location
    const pool = await db.inventoryPool.findUnique({
      where: { orgVariantId_locationId: { orgVariantId: d.org_variant_id, locationId: d.location_id } },
    })
    if (!pool) throw new ApiError(404, 'No inventory at this location for this variant.')
    const available = pool.onHand - pool.reserved
    if (available < d.quantity) {
      throw new ApiError(400, `Insufficient available stock. Available: ${available}, required: ${d.quantity}.`)
    }
    const avgCost = Number(pool.avgCost)

    // 1. Insert stock_loss_records first (with inventory_txn_id = NULL)
    const lossRecord = await db.stockLossRecord.create({
      data: {
        organizationId: orgId,
        companyId: company.id,
        orgVariantId: d.org_variant_id,
        locationId: d.location_id,
        lossType: 'damaged',
        subType: 'confirmed',
        damageType: d.damage_type,
        quantity: d.quantity,
        costPerUnit: avgCost,
        investigationStatus: 'none',
        resolution: 'written_off',
        responsibleParty: d.responsible_party,
        evidenceUrls: JSON.stringify(d.evidence_urls),
        notes: d.notes || null,
        reportedById: caller.id,
        resolvedById: caller.id,
        resolvedAt: new Date(),
      },
    })

    // 2. Call processInventoryTransaction with reference to the loss record
    const txnResult = await processInventoryTransaction({
      orgVariantId: d.org_variant_id,
      locationId: d.location_id,
      organizationId: orgId,
      companyId: company.id,
      employeeId: caller.id,
      transactionType: 'damage_writeoff',
      quantity: d.quantity,
      costPerUnit: avgCost,
      referenceType: 'stock_loss',
      referenceId: lossRecord.id,
      notes: `Damaged: ${d.damage_type}. ${d.notes || ''}`,
    })
    if (!txnResult.success) {
      throw new ApiError(500, `Write-off transaction failed: ${txnResult.error}`)
    }

    // 3. Update loss record with the transaction ID
    await db.stockLossRecord.update({
      where: { id: lossRecord.id },
      data: { inventoryTxnId: txnResult.transactionId },
    })

    await insertAuditLog({
      action: 'stock_loss.damaged_reported',
      entityType: 'stock_loss',
      entityId: lossRecord.id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { quantity: d.quantity, damageType: d.damage_type, value: d.quantity * avgCost },
    })

    return Response.json({ success: true, loss_record_id: lossRecord.id, transaction_id: txnResult.transactionId })
  } catch (err) {
    return handleError(err)
  }
}
