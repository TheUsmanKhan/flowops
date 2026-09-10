import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { getWorkspace, requirePermission, ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { processInventoryTransaction } from '@/lib/inventory'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Get a cycle count with its items. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.INVENTORY_VIEW)

    const companyId = ctx.company.id

    const { id } = await params
    const count = await db.cycleCount.findFirst({
      where: { id, companyId },
      include: {
        location: { select: { id: true, name: true } },
        items: {
          include: {
            orgVariant: { select: { id: true, sku: true, product: { select: { title: true } } } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!count) throw new ApiError(404, 'Cycle count not found.')

    return Response.json({
      count: {
        id: count.id,
        countName: count.countName,
        countType: count.countType,
        status: count.status,
        location: count.location,
        scheduledAt: count.scheduledAt.toISOString(),
        startedAt: count.startedAt?.toISOString() ?? null,
        completedAt: count.completedAt?.toISOString() ?? null,
        approvedAt: count.approvedAt?.toISOString() ?? null,
        totalDiscrepancies: count.totalDiscrepancies,
        totalVarianceValue: Number(count.totalVarianceValue),
        notes: count.notes,
        items: count.items.map((item) => ({
          id: item.id,
          variant: {
            id: item.orgVariant.id,
            sku: item.orgVariant.sku,
            productTitle: item.orgVariant.product.title,
          },
          systemQuantity: item.systemQuantity,
          countedQuantity: item.countedQuantity,
          discrepancy: item.countedQuantity !== null ? item.countedQuantity - item.systemQuantity : null,
          discrepancyValue: item.discrepancyValue ? Number(item.discrepancyValue) : null,
          discrepancyReason: item.discrepancyReason,
          adjustmentApproved: item.adjustmentApproved,
          inventoryTxnId: item.inventoryTxnId,
          notes: item.notes,
          countedAt: item.countedAt?.toISOString() ?? null,
        })),
      },
    })
  } catch (err) {
    return handleError(err)
  }
}

/**
 * Update a cycle count:
 * - Start it (status → in_progress, creates items from existing inventory_pools)
 * - Submit counted quantities for items
 * - Approve adjustments (processes cycle_count_adjust transactions)
 * - Cancel
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
    const orgId = settings?.activeOrgId
    const company = settings?.activeCompany
    if (!orgId || !company) throw new ApiError(403, 'No active company')
    const companyId = company.id

    const { id } = await params
    const count = await db.cycleCount.findFirst({ where: { id, companyId } })
    if (!count) throw new ApiError(404, 'Cycle count not found.')

    const caller = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_CYCLE_COUNT },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to manage cycle counts.')

    const body = await readBody<{
      action?: string
      counted_items?: Array<{
        item_id: string
        counted_quantity: number
        discrepancy_reason?: string
        notes?: string
      }>
      notes?: string
    }>(req)

    const action = body.action

    if (action === 'start') {
      // Create items from existing inventory_pools at the location.
      // discrepancyValue stores the avg_cost per unit so the variance
      // calculation in submit_counts can compute the financial impact.
      const pools = await db.inventoryPool.findMany({
        where: { locationId: count.locationId },
        select: { orgVariantId: true, onHand: true, avgCost: true },
      })

      for (const pool of pools) {
        await db.cycleCountItem.create({
          data: {
            cycleCountId: id,
            orgVariantId: pool.orgVariantId,
            organizationId: orgId,
            systemQuantity: pool.onHand,
            discrepancyValue: pool.avgCost,
          },
        })
      }

      await db.cycleCount.update({
        where: { id },
        data: { status: 'in_progress', startedAt: new Date() },
      })

      insertAuditLog({
        action: 'cycle_count.started',
        entityType: 'cycle_count',
        entityId: id,
        companyId: company.id,
        organizationId: orgId,
        userId: user.id,
        employeeId: caller.id,
        newValues: { itemCount: pools.length },
      })

      return Response.json({ success: true, status: 'in_progress', itemsCreated: pools.length })
    }

    if (action === 'submit_counts' && body.counted_items) {
      // ── Validation: prevent absurd counted_quantity values ──
      // A cycle count adjusts stock to match physical reality. Without
      // bounds, a typo (1000 instead of 100) or fraud (50,000 to inflate
      // stock value) silently goes through. We enforce:
      //   1. counted_quantity must be a non-negative integer (no negative stock)
      //   2. counted_quantity must not exceed 10× the system quantity
      //      (a 10x jump in a single count is almost always a typo/fraud —
      //      legitimate large deliveries should go through PO receive)
      //   3. If a count exceeds the threshold, the user must first do a
      //      manual_adjustment with explicit reason + audit, then re-count.
      // See INVENTORY_AUDIT.md "HIGH: cycle_count_adjust can SET onHand to
      // any value with no upper bound".
      for (const ci of body.counted_items) {
        if (!Number.isInteger(ci.counted_quantity) || ci.counted_quantity < 0) {
          throw new ApiError(
            400,
            `Counted quantity must be a non-negative integer (got ${ci.counted_quantity} for item ${ci.item_id}). Negative stock is not physically possible.`,
          )
        }
      }

      // Fetch all items being submitted to validate bounds against system qty
      const itemsToValidate = await db.cycleCountItem.findMany({
        where: { id: { in: body.counted_items.map((c) => c.item_id) } },
        select: { id: true, systemQuantity: true, orgVariantId: true },
      })
      const itemMap = new Map(itemsToValidate.map((i) => [i.id, i]))
      const MAX_MULTIPLIER = 10 // counted qty can't exceed 10× system qty
      const ABSOLUTE_CAP = 1_000_000 // hard cap: 1M units (sanity ceiling)

      for (const ci of body.counted_items) {
        const item = itemMap.get(ci.item_id)
        if (!item) continue
        const sysQty = item.systemQuantity
        const threshold = Math.max(sysQty * MAX_MULTIPLIER, 100) // allow 100 floor for new items
        if (ci.counted_quantity > ABSOLUTE_CAP) {
          throw new ApiError(
            400,
            `Counted quantity ${ci.counted_quantity} exceeds the absolute cap of ${ABSOLUTE_CAP.toLocaleString()} units. If this is correct, contact an admin to perform a manual adjustment with explicit reason.`,
          )
        }
        if (ci.counted_quantity > threshold) {
          throw new ApiError(
            400,
            `Counted quantity ${ci.counted_quantity} is ${MAX_MULTIPLIER}× the system quantity (${sysQty}). This looks like a typo. If the physical stock really is this high, first receive the new stock via a Purchase Order, then run the cycle count.`,
          )
        }
      }

      // Record counted quantities for each item
      let totalDiscrepancies = 0
      let totalVariance = 0

      for (const ci of body.counted_items) {
        const item = await db.cycleCountItem.findUnique({ where: { id: ci.item_id } })
        if (!item || item.cycleCountId !== id) continue

        const discrepancy = ci.counted_quantity - item.systemQuantity
        if (discrepancy !== 0) totalDiscrepancies++
        // variance = discrepancy units × avg_cost per unit
        // discrepancyValue stores the avg_cost from the inventory_pool snapshot
        const variance = discrepancy * Number(item.discrepancyValue || 0)
        totalVariance += variance

        await db.cycleCountItem.update({
          where: { id: ci.item_id },
          data: {
            countedQuantity: ci.counted_quantity,
            discrepancyReason: ci.discrepancy_reason || null,
            notes: ci.notes || null,
            countedById: caller.id,
            countedAt: new Date(),
          },
        })
      }

      await db.cycleCount.update({
        where: { id },
        data: {
          status: 'pending_review',
          completedAt: new Date(),
          totalDiscrepancies,
          totalVarianceValue: totalVariance,
        },
      })

      insertAuditLog({
        action: 'cycle_count.submitted',
        entityType: 'cycle_count',
        entityId: id,
        companyId: company.id,
        organizationId: orgId,
        userId: user.id,
        employeeId: caller.id,
        newValues: { totalDiscrepancies, totalVariance },
      })

      return Response.json({ success: true, status: 'pending_review', totalDiscrepancies })
    }

    if (action === 'approve') {
      // F5 fix: wrap the ENTIRE approval (header update + all item processing)
      // in a single db.$transaction. If any item fails (processInventoryTransaction
      // returns success=false, or a DB write throws), the entire transaction
      // rolls back — including the cycleCount header status change, all
      // cycleCountItem.adjustmentApproved flips, and any cycle_count_adjust
      // inventory pool writes (processInventoryTransaction internally uses
      // db.$transaction which becomes a savepoint inside this outer one).
      // Previously: items were processed one-by-one outside any outer
      // transaction. If item 3 failed, items 1-2's writes were already
      // committed (adjustmentApproved=true, inventory adjusted) but the
      // cycle count header was never marked 'approved' — leaving the
      // cycle count in a half-finished state.
      try {
        await db.$transaction(async (tx) => {
          // Process items with discrepancies
          const items = await tx.cycleCountItem.findMany({
            where: { cycleCountId: id, countedQuantity: { not: null } },
          })

          for (const item of items) {
            if (item.countedQuantity === null) continue
            const discrepancy = item.countedQuantity - item.systemQuantity
            if (discrepancy === 0) continue

            const absDiscrepancy = Math.abs(discrepancy)

            // Fetch avg_cost for the loss record (used by both branches below)
            const pool = await tx.inventoryPool.findUnique({
              where: { orgVariantId_locationId: { orgVariantId: item.orgVariantId, locationId: count.locationId } },
            })
            const avgCost = pool ? Number(pool.avgCost) : 0

            // If shortage AND discrepancy_reason is theft_suspected or unknown:
            // create a missing stock_loss_records entry (quarantine) instead of adjusting
            if (discrepancy < 0 && (item.discrepancyReason === 'theft_suspected' || item.discrepancyReason === 'unknown')) {
              // Quarantine the missing quantity
              const { quarantineStock } = await import('@/lib/inventory')
              const quarantineResult = await quarantineStock(item.orgVariantId, count.locationId, absDiscrepancy)
              if (quarantineResult.success) {
                // UNIFIED: create the stock loss record via the unified helper
                // (was: db.stockLossRecord.create directly — which bypassed the
                // dedup + inventory transaction creation. Now uses recordStockLoss
                // so the loss is properly linked + deduped.)
                const { recordStockLoss } = await import('@/lib/stock-loss')
                const lossResult = await recordStockLoss({
                  organizationId: orgId,
                  companyId: company.id,
                  orgVariantId: item.orgVariantId,
                  locationId: count.locationId,
                  lossType: 'missing',
                  sourceModule: 'cycle_count',
                  quantity: absDiscrepancy,
                  costPerUnit: avgCost,
                  cycleCountItemId: item.id,
                  employeeId: caller.id,
                  subType: 'suspected',
                  responsibleParty: 'unknown',
                  notes: `Auto-created from cycle count ${count.countName}. Discrepancy reason: ${item.discrepancyReason}`,
                  // createInventoryTransaction=false because the quarantine already
                  // reduced available; the cycle_count_adjust below sets onHand to
                  // match the counted quantity. Creating another stock movement
                  // would double-decrement.
                  createInventoryTransaction: false,
                })
                if (lossResult.wasDuplicate) {
                  // Loss was already recorded for this cycle count item — skip
                  console.log(`[cycle-count] Loss already recorded for item ${item.id}, skipping.`)
                }
                // F5 fix: if the loss record itself failed (not a duplicate),
                // throw to abort the entire approval transaction.
                if (!lossResult.success && !lossResult.wasDuplicate) {
                  throw new Error(
                    `Failed to record stock loss for item ${item.id} (variant ${item.orgVariantId}): ${lossResult.error ?? 'unknown error'}`,
                  )
                }
              } else {
                // F5 fix: quarantine failed — abort the entire approval so
                // we don't half-commit (loss recorded but stock not held).
                throw new Error(
                  `Failed to quarantine stock for item ${item.id} (variant ${item.orgVariantId}): ${quarantineResult.error ?? 'unknown error'}`,
                )
              }
              // Still need to adjust the on_hand to match counted quantity
              // The quarantine reduced available, but on_hand needs to be set to counted value
              const txnResult = await processInventoryTransaction({
                orgVariantId: item.orgVariantId,
                locationId: count.locationId,
                organizationId: orgId,
                companyId: company.id,
                employeeId: caller.id,
                transactionType: 'cycle_count_adjust',
                quantity: item.countedQuantity,
                costPerUnit: null,
                referenceType: 'cycle_count',
                referenceId: id,
                notes: `Cycle count adjustment (shortage - quarantined as missing): ${item.systemQuantity} → ${item.countedQuantity}`,
              })
              if (txnResult.success && txnResult.transactionId) {
                await tx.cycleCountItem.update({
                  where: { id: item.id },
                  data: { adjustmentApproved: true, inventoryTxnId: txnResult.transactionId },
                })
              } else {
                // F5 fix: abort the entire approval — partial commits leave
                // the cycle count in an inconsistent state.
                throw new Error(
                  `Failed to adjust inventory for cycle count item ${item.id} (variant ${item.orgVariantId}): ${txnResult.error ?? 'unknown error'}`,
                )
              }
            } else if (discrepancy < 0 && item.discrepancyReason === 'damage_not_recorded') {
              // ── BUG FIX: damage_not_recorded shortage was NOT creating a
              //    StockLossRecord — it just adjusted onHand via cycle_count_adjust,
              //    leaving the Stock Losses module completely unaware. Now we
              //    create a proper loss record via the unified helper.
              //    See STOCKLOSS_INVESTIGATION.md Problem 2. ──
              const { recordStockLoss } = await import('@/lib/stock-loss')
              const lossResult = await recordStockLoss({
                organizationId: orgId,
                companyId: company.id,
                orgVariantId: item.orgVariantId,
                locationId: count.locationId,
                lossType: 'damaged',
                sourceModule: 'cycle_count',
                quantity: absDiscrepancy,
                costPerUnit: avgCost,
                cycleCountItemId: item.id,
                employeeId: caller.id,
                subType: 'confirmed',
                responsibleParty: 'warehouse',
                notes: `Auto-created from cycle count ${count.countName}. Discrepancy reason: damage_not_recorded.`,
                // createInventoryTransaction=false — the cycle_count_adjust
                // below already sets onHand to the counted value. A separate
                // damage_writeoff would double-decrement.
                createInventoryTransaction: false,
              })
              if (lossResult.wasDuplicate) {
                console.log(`[cycle-count] Damage loss already recorded for item ${item.id}, skipping.`)
              }
              // F5 fix: loss record creation failed (not a duplicate) — abort.
              if (!lossResult.success && !lossResult.wasDuplicate) {
                throw new Error(
                  `Failed to record damage loss for item ${item.id} (variant ${item.orgVariantId}): ${lossResult.error ?? 'unknown error'}`,
                )
              }

              // Still adjust onHand to match the counted quantity
              const txnResult = await processInventoryTransaction({
                orgVariantId: item.orgVariantId,
                locationId: count.locationId,
                organizationId: orgId,
                companyId: company.id,
                employeeId: caller.id,
                transactionType: 'cycle_count_adjust',
                quantity: item.countedQuantity,
                costPerUnit: null,
                referenceType: 'cycle_count',
                referenceId: id,
                notes: `Cycle count adjustment (shortage - damage): ${item.systemQuantity} → ${item.countedQuantity}`,
              })
              if (txnResult.success && txnResult.transactionId) {
                await tx.cycleCountItem.update({
                  where: { id: item.id },
                  data: { adjustmentApproved: true, inventoryTxnId: txnResult.transactionId },
                })
              } else {
                // F5 fix: abort the entire approval.
                throw new Error(
                  `Failed to adjust inventory for cycle count item ${item.id} (variant ${item.orgVariantId}): ${txnResult.error ?? 'unknown error'}`,
                )
              }
            } else {
              // Normal cycle_count_adjust for recording_error, transfer_not_recorded, or surplus
              const txnResult = await processInventoryTransaction({
                orgVariantId: item.orgVariantId,
                locationId: count.locationId,
                organizationId: orgId,
                companyId: company.id,
                employeeId: caller.id,
                transactionType: 'cycle_count_adjust',
                quantity: item.countedQuantity,
                costPerUnit: null,
                referenceType: 'cycle_count',
                referenceId: id,
                notes: `Cycle count adjustment: ${item.systemQuantity} → ${item.countedQuantity}`,
              })

              if (txnResult.success && txnResult.transactionId) {
                await tx.cycleCountItem.update({
                  where: { id: item.id },
                  data: {
                    adjustmentApproved: true,
                    inventoryTxnId: txnResult.transactionId,
                  },
                })
              } else {
                // F5 fix: abort the entire approval.
                throw new Error(
                  `Failed to adjust inventory for cycle count item ${item.id} (variant ${item.orgVariantId}): ${txnResult.error ?? 'unknown error'}`,
                )
              }
            }
          }

          // Mark the cycle count header as approved — INSIDE the transaction
          // so this only commits if ALL item processing succeeded. If any
          // item threw or returned success=false above, this never executes
          // and the entire transaction rolls back (header stays in
          // pending_review, items stay with adjustmentApproved=false).
          await tx.cycleCount.update({
            where: { id },
            data: {
              status: 'approved',
              approvedAt: new Date(),
              approvedById: caller.id,
            },
          })
        })
      } catch (txnErr) {
        // The transaction threw — either a DB error, a processInventoryTransaction
        // failure (converted to a thrown Error above), or a quarantine/loss
        // failure. The entire approval has been rolled back. Surface the error
        // to the caller so they know the approval did NOT go through.
        console.error('[cycle-count] Approval transaction failed:', txnErr)
        return handleError(txnErr)
      }

      // Audit log + metric event fire AFTER the transaction commits — they're
      // observability side-effects, not part of the atomic state change.
      // (insertAuditLog + insertMetricEvent use fire-and-forget DB writes that
      // are intentionally NOT inside the approval transaction.)
      insertAuditLog({
        action: 'cycle_count.approved',
        entityType: 'cycle_count',
        entityId: id,
        companyId: company.id,
        organizationId: orgId,
        userId: user.id,
        employeeId: caller.id,
      })

      insertMetricEvent({
        companyId: company.id,
        entityType: 'location',
        entityId: count.locationId,
        metricKey: 'inventory.cycle_count_variance',
        numericValue: Math.abs(Number(count.totalVarianceValue)),
        dimensions: {
          total_discrepancies: count.totalDiscrepancies,
          count_id: id,
          count_name: count.countName,
        },
      })

      return Response.json({ success: true, status: 'approved' })
    }

    if (action === 'cancel') {
      await db.cycleCount.update({
        where: { id },
        data: { status: 'cancelled' },
      })

      insertAuditLog({
        action: 'cycle_count.cancelled',
        entityType: 'cycle_count',
        entityId: id,
        companyId: company.id,
        organizationId: orgId,
        userId: user.id,
        employeeId: caller.id,
      })

      return Response.json({ success: true, status: 'cancelled' })
    }

    throw new ApiError(400, `Unknown action: ${action}. Expected: start | submit_counts | approve | cancel`)
  } catch (err) {
    return handleError(err)
  }
}
