import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
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
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

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
      // Create items from existing inventory_pools at the location
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
            discrepancyValue: 0,
          },
        })
      }

      await db.cycleCount.update({
        where: { id },
        data: { status: 'in_progress', startedAt: new Date() },
      })

      await insertAuditLog({
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
      // Record counted quantities for each item
      let totalDiscrepancies = 0
      let totalVariance = 0

      for (const ci of body.counted_items) {
        const item = await db.cycleCountItem.findUnique({ where: { id: ci.item_id } })
        if (!item || item.cycleCountId !== id) continue

        const discrepancy = ci.counted_quantity - item.systemQuantity
        if (discrepancy !== 0) totalDiscrepancies++
        const variance = discrepancy * (Number(item.discrepancyValue || 0) / (item.systemQuantity || 1))
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

      await insertAuditLog({
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
      // Process items with discrepancies
      const items = await db.cycleCountItem.findMany({
        where: { cycleCountId: id, countedQuantity: { not: null } },
      })

      for (const item of items) {
        if (item.countedQuantity === null) continue
        const discrepancy = item.countedQuantity - item.systemQuantity
        if (discrepancy === 0) continue

        const absDiscrepancy = Math.abs(discrepancy)

        // If shortage AND discrepancy_reason is theft_suspected or unknown:
        // create a missing stock_loss_records entry (quarantine) instead of adjusting
        if (discrepancy < 0 && (item.discrepancyReason === 'theft_suspected' || item.discrepancyReason === 'unknown')) {
          // Quarantine the missing quantity
          const { quarantineStock } = await import('@/lib/inventory')
          const quarantineResult = await quarantineStock(item.orgVariantId, count.locationId, absDiscrepancy)
          if (quarantineResult.success) {
            // Fetch avg_cost for the loss record
            const pool = await db.inventoryPool.findUnique({
              where: { orgVariantId_locationId: { orgVariantId: item.orgVariantId, locationId: count.locationId } },
            })
            const avgCost = pool ? Number(pool.avgCost) : 0

            // Create missing stock_loss_records entry
            await db.stockLossRecord.create({
              data: {
                organizationId: orgId,
                companyId: company.id,
                orgVariantId: item.orgVariantId,
                locationId: count.locationId,
                lossType: 'missing',
                subType: 'suspected',
                quantity: absDiscrepancy,
                costPerUnit: avgCost,
                investigationStatus: 'open',
                resolution: null,
                responsibleParty: 'unknown',
                notes: `Auto-created from cycle count ${count.countName}. Discrepancy reason: ${item.discrepancyReason}`,
                reportedById: caller.id,
                // metadata linking back to cycle count could go in notes
              },
            })
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
            await db.cycleCountItem.update({
              where: { id: item.id },
              data: { adjustmentApproved: true, inventoryTxnId: txnResult.transactionId },
            })
          }
        } else {
          // Normal cycle_count_adjust for recording_error, transfer_not_recorded, damage_not_recorded, or surplus
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
            await db.cycleCountItem.update({
              where: { id: item.id },
              data: {
                adjustmentApproved: true,
                inventoryTxnId: txnResult.transactionId,
              },
            })
          }
        }
      }

      await db.cycleCount.update({
        where: { id },
        data: {
          status: 'approved',
          approvedAt: new Date(),
          approvedById: caller.id,
        },
      })

      await insertAuditLog({
        action: 'cycle_count.approved',
        entityType: 'cycle_count',
        entityId: id,
        companyId: company.id,
        organizationId: orgId,
        userId: user.id,
        employeeId: caller.id,
      })

      return Response.json({ success: true, status: 'approved' })
    }

    if (action === 'cancel') {
      await db.cycleCount.update({
        where: { id },
        data: { status: 'cancelled' },
      })

      await insertAuditLog({
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
