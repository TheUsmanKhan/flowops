/**
 * Employee Stats Recomputation — mirrors the updateCustomerStats() pattern.
 *
 * Called as a fire-and-forget (NOT awaited) from order status transitions:
 * confirmOrder, cancelOrder, performOrderDispatch, markOrderDelivered,
 * processOrderReturn (RTO), and stock-loss reporting.
 *
 * Only called when the order has a non-null salesEmployeeId (webhook-imported
 * orders with null salesEmployeeId have no stats to update).
 *
 * Writes the computed stats to the EmployeeStats table (1:1 with Employee).
 * The cached row represents ALL-TIME totals for quick list-view display.
 * The Performance tab calls computeOrderFunnelStats() LIVE for custom date ranges.
 */

import { db } from '@/lib/db'
import { computeOrderFunnelStats } from '@/lib/analytics/order-funnel'

interface ActionResult {
  success: boolean
  error?: string
}

/**
 * Recompute and cache the employee's funnel stats.
 *
 * @param employeeId The employee whose stats to recompute
 * @returns { success } — never throws (errors logged, caller continues)
 */
export async function updateEmployeeStats(employeeId: string): Promise<ActionResult> {
  try {
    // Fetch the employee's companyId (needed for the funnel query scope)
    const employee = await db.employee.findUnique({
      where: { id: employeeId },
      select: {
        companyId: true,
        company: { select: { baseCurrency: true } },
      },
    })
    if (!employee) {
      return { success: false, error: 'Employee not found' }
    }

    // Compute all-time stats (no date filter — the cached row represents totals)
    const stats = await computeOrderFunnelStats({
      employeeId,
      companyId: employee.companyId,
      baseCurrency: employee.company.baseCurrency,
    })

    // Fetch the confirmed + pending counts for the cached row (the EmployeeStats
    // table stores these as separate columns for quick list-view display)
    const statusCounts = await db.order.groupBy({
      by: ['status'],
      where: { salesEmployeeId: employeeId, companyId: employee.companyId },
      _count: { status: true },
    })
    const statusMap = new Map(statusCounts.map((s) => [s.status, s._count.status]))
    const confirmedCount =
      (statusMap.get('confirmed') ?? 0) +
      (statusMap.get('partially_backordered') ?? 0) +
      (statusMap.get('processing') ?? 0)

    // Upsert the EmployeeStats row (1:1 with Employee via unique employeeId)
    await db.employeeStats.upsert({
      where: { employeeId },
      update: {
        totalOrders: stats.totalOrders,
        cancelledCount: stats.cancelledCount,
        dispatchedCount: stats.dispatchedCount,
        deliveredCount: stats.deliveredCount,
        rtoCount: stats.rtoCount,
        inTransitCount: stats.inTransitCount,
        cancellationRate: stats.cancellationRate,
        deliveryRate: stats.deliveryRate,
        rtoRate: stats.rtoRate,
        itemsSoldQty: stats.itemsSoldQty,
        damageLossCount: stats.damageLossCount,
        revenueGenerated: stats.revenueGenerated,
      },
      create: {
        employeeId,
        totalOrders: stats.totalOrders,
        cancelledCount: stats.cancelledCount,
        dispatchedCount: stats.dispatchedCount,
        deliveredCount: stats.deliveredCount,
        rtoCount: stats.rtoCount,
        inTransitCount: stats.inTransitCount,
        cancellationRate: stats.cancellationRate,
        deliveryRate: stats.deliveryRate,
        rtoRate: stats.rtoRate,
        itemsSoldQty: stats.itemsSoldQty,
        damageLossCount: stats.damageLossCount,
        revenueGenerated: stats.revenueGenerated,
      },
    })

    return { success: true }
  } catch (err) {
    // CRITICAL: never let a stats-update failure break the calling order
    // action. Log and return failure — the caller continues regardless.
    console.error('[employee] updateEmployeeStats failed:', err)
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to update employee stats',
    }
  }
}
