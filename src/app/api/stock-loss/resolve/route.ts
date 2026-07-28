import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { processInventoryTransaction, releaseQuarantine } from '@/lib/inventory'
import { resolveTheftOrMissingLossSchema, resolveTransitLossSchema } from '@/lib/validations/stock-loss'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Resolve a stock loss record.
 * Handles two paths:
 * 1. Theft/Missing (two-stage): release quarantine, optionally write off
 * 2. Transit Loss: update claim status only (no inventory transaction)
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
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_MANAGE_LOSS },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to resolve stock loss records.')

    const body = await readBody<{ loss_id?: string }>(req)
    const lossId = body.loss_id
    if (!lossId) throw new ApiError(400, 'loss_id is required')

    const record = await db.stockLossRecord.findFirst({ where: { id: lossId, companyId: company.id } })
    if (!record) throw new ApiError(404, 'Stock loss record not found.')

    // ── Path 1: Theft or Missing (two-stage) ──
    if (record.lossType === 'theft' || record.lossType === 'missing') {
      if (record.investigationStatus !== 'open') {
        throw new ApiError(400, 'This investigation is already closed.')
      }
      const parsed = resolveTheftOrMissingLossSchema.safeParse(body)
      if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
      const d = parsed.data

      // Step 1: Release quarantine in ALL cases
      await releaseQuarantine(record.orgVariantId, record.locationId, record.quantity)

      // Step 2: Handle resolution
      let txnId: string | null = null
      if (d.resolution === 'written_off') {
        const txnType = record.lossType === 'theft' ? 'theft_writeoff' : 'missing_writeoff'
        const txnResult = await processInventoryTransaction({
          orgVariantId: record.orgVariantId,
          locationId: record.locationId,
          organizationId: orgId,
          companyId: company.id,
          employeeId: caller.id,
          transactionType: txnType,
          quantity: record.quantity,
          costPerUnit: Number(record.costPerUnit),
          referenceType: 'stock_loss',
          referenceId: record.id,
          notes: `${record.lossType} write-off. ${d.notes || ''}`,
        })
        if (!txnResult.success) {
          throw new ApiError(500, `Write-off transaction failed: ${txnResult.error}`)
        }
        txnId = txnResult.transactionId ?? null
      }
      // 'recovered' and 'error_corrected' → no transaction (quarantine release already fixed availability)

      await db.stockLossRecord.update({
        where: { id: record.id },
        data: {
          resolution: d.resolution,
          investigationStatus: 'closed',
          inventoryTxnId: txnId,
          resolvedById: caller.id,
          resolvedAt: new Date(),
          notes: d.notes ? `${record.notes || ''}\n[Resolution] ${d.notes}` : record.notes,
        },
      })

      await insertAuditLog({
        action: 'stock_loss.resolved',
        entityType: 'stock_loss',
        entityId: record.id,
        companyId: company.id,
        organizationId: orgId,
        userId: user.id,
        employeeId: caller.id,
        oldValues: { investigationStatus: 'open' },
        newValues: { resolution: d.resolution, investigationStatus: 'closed' },
      })

      await insertMetricEvent({
        companyId: company.id,
        entityType: 'product',
        entityId: record.orgVariantId,
        metricKey: 'inventory.loss_resolved',
        numericValue: Number(record.costPerUnit) * record.quantity,
        dimensions: {
          resolution: d.resolution,
          loss_type: record.lossType,
          quantity: record.quantity,
        },
      })

      return Response.json({ success: true, resolution: d.resolution, transaction_id: txnId })
    }

    // ── Path 2: Transit Loss (claim tracking only) ──
    if (record.lossType === 'transit_loss') {
      if (record.resolution) {
        throw new ApiError(400, 'This transit loss is already resolved.')
      }
      const parsed = resolveTransitLossSchema.safeParse(body)
      if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
      const d = parsed.data

      if (d.resolution === 'claim_accepted' && d.courier_recovered === undefined) {
        throw new ApiError(400, 'courier_recovered amount is required when claim is accepted.')
      }

      await db.stockLossRecord.update({
        where: { id: record.id },
        data: {
          resolution: d.resolution,
          courierClaimStatus: d.resolution === 'claim_accepted' ? 'accepted' : 'rejected',
          courierRecovered: d.courier_recovered ?? 0,
          resolvedById: caller.id,
          resolvedAt: new Date(),
          notes: d.notes ? `${record.notes || ''}\n[Resolution] ${d.notes}` : record.notes,
        },
      })

      await insertAuditLog({
        action: 'stock_loss.transit_resolved',
        entityType: 'stock_loss',
        entityId: record.id,
        companyId: company.id,
        organizationId: orgId,
        userId: user.id,
        employeeId: caller.id,
        newValues: { resolution: d.resolution, courierRecovered: d.courier_recovered ?? 0 },
      })

      await insertMetricEvent({
        companyId: company.id,
        entityType: 'product',
        entityId: record.orgVariantId,
        metricKey: 'inventory.loss_resolved',
        numericValue: Number(record.costPerUnit) * record.quantity,
        dimensions: {
          resolution: d.resolution,
          loss_type: record.lossType,
          quantity: record.quantity,
        },
      })

      return Response.json({ success: true, resolution: d.resolution })
    }

    throw new ApiError(400, `Cannot resolve loss type '${record.lossType}' from this endpoint.`)
  } catch (err) {
    return handleError(err)
  }
}
