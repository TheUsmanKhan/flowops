import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { reportTransitLossSchema } from '@/lib/validations/stock-loss'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Report TRANSIT LOSS — no inventory transaction.
 * Stock was already decremented at dispatch time (sale_dispatched).
 * This record is purely for financial/claim tracking.
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
    const parsed = reportTransitLossSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    const d = parsed.data

    // Fetch avg_cost for cost recording (no transaction will be created)
    const pool = await db.inventoryPool.findUnique({
      where: { orgVariantId_locationId: { orgVariantId: d.org_variant_id, locationId: d.location_id } },
    })
    const avgCost = pool ? Number(pool.avgCost) : 0

    const lossRecord = await db.stockLossRecord.create({
      data: {
        organizationId: orgId,
        companyId: company.id,
        orgVariantId: d.org_variant_id,
        locationId: d.location_id,
        lossType: 'transit_loss',
        quantity: d.quantity,
        costPerUnit: avgCost,
        investigationStatus: 'none',
        resolution: null,
        responsibleParty: 'courier',
        courierClaimRef: d.courier_claim_ref || null,
        courierClaimStatus: 'filed',
        orderReferenceId: d.order_reference_id,
        notes: d.notes || null,
        reportedById: caller.id,
        // inventoryTxnId stays NULL — no new transaction
      },
    })

    insertAuditLog({
      action: 'stock_loss.transit_reported',
      entityType: 'stock_loss',
      entityId: lossRecord.id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { quantity: d.quantity, orderRef: d.order_reference_id, claimRef: d.courier_claim_ref },
    })

    insertMetricEvent({
      companyId: company.id,
      entityType: 'product',
      entityId: d.org_variant_id,
      metricKey: 'inventory.transit_loss',
      numericValue: d.quantity * avgCost,
      dimensions: {
        location_id: d.location_id,
        order_reference_id: d.order_reference_id,
        courier_claim_ref: d.courier_claim_ref || null,
        quantity: d.quantity,
      },
    })

    return Response.json({ success: true, loss_record_id: lossRecord.id })
  } catch (err) {
    return handleError(err)
  }
}
