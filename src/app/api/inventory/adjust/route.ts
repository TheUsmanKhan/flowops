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
      select: { avgCost: true, onHand: true, reserved: true },
    })
    const avgCostForMetric = pool ? Number(pool.avgCost) : 0

    // ── INV-010 fix: explicit pre-check BEFORE any database write ──
    //
    // The audit repro: onHand=5, reserved=3 (available=2), adjust=-4 → the
    // route currently returns HTTP 500 with "Adjustment failed:
    // INSUFFICIENT_STOCK: Available 2, requested 4" (caught from
    // processInventoryTransaction's OUT_TYPES check on damage_writeoff).
    //
    // HTTP semantics: this is a 400 (Bad Request — client supplied invalid
    // input), not a 500 (server error). Pre-check here and short-circuit
    // with a friendly 400 BEFORE the wasteful call into recordStockLoss →
    // processInventoryTransaction (which would otherwise throw, log an error,
    // and roll back the transaction).
    //
    // Boundary: onHand=10, reserved=10, adjust=-1 → newOnHand=9 < reserved=10
    // → must return 400. ✓
    //
    // Edge case (pool doesn't exist): onHand=0, reserved=0, any negative
    // adjustment → newOnHand goes negative, check fires with "0 units
    // reserved" message. Slightly awkward but technically correct — there
    // is no stock to remove. The 400 status is the important part.
    //
    // Adjustment=0: rejected at the Zod schema level
    // (adjustStockSchema.quantity.refine((v) => v !== 0)) → returns 400
    // BEFORE this pre-check runs. No empty transaction row is ever written.
    // (Confirmed: the route never calls processInventoryTransaction /
    // recordStockLoss when quantity=0 — the schema validation catches it
    // first.)
    if (!isPositive) {
      const currentOnHand = pool?.onHand ?? 0
      const currentReserved = pool?.reserved ?? 0
      const projectedOnHand = currentOnHand + d.quantity // d.quantity is negative here
      if (projectedOnHand < currentReserved) {
        throw new ApiError(
          400,
          `Cannot reduce stock below reserved quantity (${currentReserved} units reserved)`,
        )
      }
    }

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
        // ── INV-013 FIX (PART3-Section D, Option A) ──────────────────────
        // Previously this branch called recordStockLoss() which created a
        // StockLossRecord (with sourceModule='adjust_stock') AND the
        // damage_writeoff InventoryTransaction in one atomic operation.
        //
        // PROBLEM: that conflated two distinct operations:
        //   1. Adjust Stock = pure inventory count correction (positive OR
        //      negative). The user is correcting a physical count, not
        //      reporting a loss investigation.
        //   2. Stock Losses module = dedicated loss-reporting workflow with
        //      investigation/approval/insurance/courier-claim fields.
        //
        // Mixing the two meant:
        //   - Every negative adjustment created a damage-type loss record,
        //     even when the user's reason was "Miscount on previous receipt"
        //     (semantically wrong — polluting the Stock Losses dashboard).
        //   - Stock Losses UI showed a mixed-source list (adjust_stock +
        //     stock_loss records) with no UI to distinguish them.
        //   - If the user later recorded the same loss in the Stock Losses
        //     module, the dedup index didn't fire (different sourceModule)
        //     → potential double-decrement.
        //
        // FIX: Adjust Stock now performs ONLY the InventoryTransaction
        // (decrement onHand via damage_writeoff). NO StockLossRecord is
        // created. The onHand decrement still happens — the adjustment
        // works exactly as before for count-correction purposes.
        //
        // Users wanting loss tracking (damage type, responsible party,
        // investigation workflow, courier claim, insurance, etc.) must use
        // the dedicated Stock Losses module form.
        //
        // The frontend adjust-stock-view.tsx now shows a helper text
        // when the user selects a damage/theft/loss reason, pointing them
        // to the Stock Losses module.
        //
        // Note: 'adjust_stock' is kept as a valid sourceModule value in
        // stock-loss.ts for backwards compatibility with any historical
        // records; it just won't be used for new records.
        const txnType = d.reason.toLowerCase().includes('theft')
          ? 'theft_writeoff'
          : 'damage_writeoff'
        const txnResult = await processInventoryTransaction({
          orgVariantId: d.org_variant_id,
          locationId: d.location_id,
          organizationId: orgId,
          companyId: company.id,
          employeeId: caller.id,
          transactionType: txnType,
          quantity: absQty,
          referenceType: 'manual',
          notes: `Manual adjustment: ${d.reason}. ${d.notes || ''}`,
        })

        if (!txnResult.success) {
          throw new ApiError(500, `Adjustment failed: ${txnResult.error}`)
        }

        const txnId = txnResult.transactionId

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
            direction: 'decrease',
            reason: d.reason,
          },
        })

        return { success: true, transaction_id: txnId }
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
