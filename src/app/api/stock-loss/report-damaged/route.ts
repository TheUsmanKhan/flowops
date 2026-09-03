import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
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
    const idempotencyKey = req.headers.get('Idempotency-Key')

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

    // Core creation logic — wrapped in a closure so it can be run either
    // directly (no idempotency key, backwards-compatible) or via
    // withIdempotency() (prevents duplicate damage reports).
    const createDamagedLoss = async () => {
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

      // UNIFIED: use recordStockLoss() (was: direct db.stockLossRecord.create
      // + processInventoryTransaction + db.stockLossRecord.update). The
      // helper handles dedup (if order_item_id is set + a loss already
      // exists for this order + damaged + stock_loss, returns wasDuplicate),
      // creates the inventory transaction, links it to the loss record,
      // and rolls back the loss record if the transaction fails.
      const { recordStockLoss } = await import('@/lib/stock-loss')
      const lossResult = await recordStockLoss({
        organizationId: orgId,
        companyId: company.id,
        orgVariantId: d.org_variant_id,
        locationId: d.location_id,
        lossType: 'damaged',
        sourceModule: 'stock_loss',
        quantity: d.quantity,
        costPerUnit: avgCost,
        orderItemId: d.order_item_id || null,
        employeeId: caller.id,
        subType: 'confirmed',
        damageType: d.damage_type,
        responsibleParty: d.responsible_party,
        notes: d.notes || null,
        createInventoryTransaction: true,
      })

      if (!lossResult.success) {
        throw new ApiError(500, `Failed to record damaged loss: ${lossResult.error}`)
      }
      if (lossResult.wasDuplicate) {
        // Loss already recorded for this order item — idempotent success
        return {
          loss_record_id: null,
          was_duplicate: true,
          message: 'A loss record already exists for this order item + damaged type. No duplicate created.',
        }
      }

      const lossRecordId = lossResult.lossRecordId!

      insertAuditLog({
        action: 'stock_loss.damaged_reported',
        entityType: 'stock_loss',
        entityId: lossRecordId,
        companyId: company.id,
        organizationId: orgId,
        userId: user.id,
        employeeId: caller.id,
        newValues: { quantity: d.quantity, damageType: d.damage_type, value: d.quantity * avgCost },
      })

      insertMetricEvent({
        companyId: company.id,
        entityType: 'product',
        entityId: d.org_variant_id,
        metricKey: 'inventory.damage_loss',
        numericValue: d.quantity * avgCost,
        dimensions: {
          damage_type: d.damage_type,
          responsible_party: d.responsible_party,
          location_id: d.location_id,
          quantity: d.quantity,
        },
      })

      return { success: true, loss_record_id: lossRecordId, transaction_id: lossResult.inventoryTxnId, was_duplicate: false }
    }

    if (idempotencyKey) {
      const { withIdempotency } = await import('@/lib/idempotency')
      const { result, wasReplay } = await withIdempotency({
        key: idempotencyKey,
        companyId: company.id,
        employeeId: caller.id,
        actionType: 'stock_loss.damaged',
        fn: createDamagedLoss,
      })
      return Response.json(result, { status: wasReplay ? 200 : 201 })
    }

    // No idempotency key — normal flow (backwards-compatible)
    const result = await createDamagedLoss()
    return Response.json(result)
  } catch (err) {
    return handleError(err)
  }
}
