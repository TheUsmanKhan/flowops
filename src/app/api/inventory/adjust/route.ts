import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { processInventoryTransaction } from '@/lib/inventory'
import { adjustStockSchema } from '@/lib/validations/inventory'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Manual stock adjustment (positive or negative).
 * Uses cycle_count_adjust txn type with reference_type = 'manual'.
 * Negative quantity removes stock, positive adds stock.
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
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_ADJUST },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to adjust stock.')

    const body = await readBody(req)
    const parsed = adjustStockSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    const d = parsed.data

    // For negative adjustments, the quantity passed to processInventoryTransaction
    // should be the absolute value (the function handles direction by type)
    // We use cycle_count_adjust which sets on_hand directly when positive
    // For negative, we need to use a write-off type
    const isPositive = d.quantity > 0
    const absQty = Math.abs(d.quantity)

    // Fetch the pool's current avg_cost to value the metric event (use 0 if no pool yet)
    const pool = await db.inventoryPool.findUnique({
      where: {
        orgVariantId_locationId: {
          orgVariantId: d.org_variant_id,
          locationId: d.location_id,
        },
      },
      select: { avgCost: true },
    })
    const avgCostForMetric = pool ? Number(pool.avgCost) : 0

    // Core creation logic — wrapped in a closure so it can be run either
    // directly (no idempotency key, backwards-compatible) or via
    // withIdempotency() (prevents duplicate adjustment submissions).
    const adjustStock = async () => {
      if (isPositive) {
        // Adding stock — use manual_adjustment_in (increments on_hand)
        const txnResult = await processInventoryTransaction({
          orgVariantId: d.org_variant_id,
          locationId: d.location_id,
          organizationId: orgId,
          companyId: company.id,
          employeeId: caller.id,
          transactionType: 'manual_adjustment_in',
          quantity: absQty,
          referenceType: 'manual',
          notes: `Manual adjustment: ${d.reason}. ${d.notes || ''}`,
        })
        if (!txnResult.success) {
          throw new ApiError(500, `Adjustment failed: ${txnResult.error}`)
        }

        insertAuditLog({
          action: 'stock.adjusted',
          entityType: 'variant',
          entityId: d.org_variant_id,
          companyId: company.id,
          organizationId: orgId,
          userId: user.id,
          employeeId: caller.id,
          newValues: { adjustment: d.quantity, reason: d.reason, locationId: d.location_id },
        })

        // Metric event (CRITICAL — powers stock adjustment KPI)
        insertMetricEvent({
          companyId: company.id,
          entityType: 'product',
          entityId: d.org_variant_id,
          metricKey: 'inventory.stock_adjusted',
          numericValue: absQty * avgCostForMetric,
          dimensions: {
            location_id: d.location_id,
            direction: 'increase',
            reason: d.reason,
          },
        })

        return { success: true, transaction_id: txnResult.transactionId }
      } else {
        // Removing stock — use damage_writeoff as a generic removal type.
        //
        // BUG FIX: Previously this branch only created the inventory
        // transaction (decremented onHand) but NO StockLossRecord —
        // leaving the Stock Losses module completely unaware that stock
        // was lost/damaged. The user could then record the same loss
        // AGAIN in the Stock Losses module → double-decrement.
        //
        // Now we create a StockLossRecord via the unified recordStockLoss
        // helper, which:
        //   1. Creates the loss record (linked to the inventory txn)
        //   2. Is dedup-safe (if the user re-records in Stock Losses, the
        //      unique index prevents duplicate)
        //   3. Uses sourceModule='adjust_stock' so it's traceable
        // See STOCKLOSS_INVESTIGATION.md Problem 2.
        const { recordStockLoss } = await import('@/lib/stock-loss')
        const lossResult = await recordStockLoss({
          organizationId: orgId,
          companyId: company.id,
          orgVariantId: d.org_variant_id,
          locationId: d.location_id,
          // Infer loss type from the reason — if reason mentions "theft",
          // use theft; otherwise default to damaged (manual adjustment
          // is typically for damage correction).
          lossType: d.reason.toLowerCase().includes('theft') ? 'theft' : 'damaged',
          sourceModule: 'adjust_stock',
          quantity: absQty,
          costPerUnit: avgCostForMetric,
          employeeId: caller.id,
          subType: 'confirmed',
          responsibleParty: 'warehouse',
          notes: `Manual adjustment: ${d.reason}. ${d.notes || ''}`,
          // createInventoryTransaction=true (default) — recordStockLoss
          // creates the damage_writeoff transaction itself, so we DON'T
          // call processInventoryTransaction separately below (was the
          // old behavior). This unifies the stock movement + loss record
          // into one atomic-ish operation with rollback on failure.
        })

        if (!lossResult.success) {
          throw new ApiError(500, `Adjustment failed: ${lossResult.error}`)
        }
        if (lossResult.wasDuplicate) {
          // Loss already recorded for this — the adjustment is still valid
          // (the user might be re-adjusting). Don't fail, just log.
          console.log(`[adjust-stock] Loss already existed for this item, continuing with adjustment.`)
        }

        // If recordStockLoss created the inventory transaction, use that
        // txn ID; otherwise (createInventoryTransaction was false), create
        // the txn directly (shouldn't happen here since we use default true).
        const txnId = lossResult.inventoryTxnId

        insertAuditLog({
          action: 'stock.adjusted',
          entityType: 'variant',
          entityId: d.org_variant_id,
          companyId: company.id,
          organizationId: orgId,
          userId: user.id,
          employeeId: caller.id,
          newValues: { adjustment: d.quantity, reason: d.reason, locationId: d.location_id, lossRecordId: lossResult.lossRecordId },
        })

        // Metric event (CRITICAL — powers stock adjustment KPI)
        insertMetricEvent({
          companyId: company.id,
          entityType: 'product',
          entityId: d.org_variant_id,
          metricKey: 'inventory.stock_adjusted',
          numericValue: absQty * avgCostForMetric,
          dimensions: {
            location_id: d.location_id,
            direction: 'decrease',
            reason: d.reason,
            loss_record_id: lossResult.lossRecordId ?? undefined,
          },
        })

        return { success: true, transaction_id: txnId, loss_record_id: lossResult.lossRecordId }
      }
    }

    if (idempotencyKey) {
      const { withIdempotency } = await import('@/lib/idempotency')
      const { result, wasReplay } = await withIdempotency({
        key: idempotencyKey,
        companyId: company.id,
        employeeId: caller.id,
        actionType: 'inventory.adjust',
        fn: adjustStock,
      })
      return Response.json(result, { status: wasReplay ? 200 : 201 })
    }

    // No idempotency key — normal flow (backwards-compatible)
    const result = await adjustStock()
    return Response.json(result)
  } catch (err) {
    return handleError(err)
  }
}
