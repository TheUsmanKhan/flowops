/**
 * Order Funnel Analytics — shared, filter-parameterized calculation function.
 *
 * Computes the order funnel metrics (cancellation rate, delivery rate, RTO rate,
 * items sold, damage/loss count, revenue) for ANY scope: by employee, by customer,
 * or by company. Written as ONE reusable function so the logic is never duplicated.
 *
 * Rate definitions (per the Phase 6 design agreement):
 *   cancellationRate = cancelledCount / totalOrders
 *   deliveryRate     = deliveredCount / dispatchedCount  (NOT total — denominator is dispatched)
 *   rtoRate          = rtoCount / dispatchedCount         (NOT total — denominator is dispatched)
 *   inTransitCount   = dispatchedCount - deliveredCount - rtoCount
 *
 * Guards against division by zero: returns 0 (not NaN/error) when denominator is 0.
 */

import { db } from '@/lib/db'
import type { Prisma } from '@prisma/client'

export interface OrderFunnelFilter {
  /** Scope to a specific employee's attributed orders (salesEmployeeId). */
  employeeId?: string
  /** Scope to a specific customer's orders. */
  customerId?: string
  /** Company scope (required — all orders are company-scoped). */
  companyId: string
  /** The company's base currency (for revenue conversion). Phase F1. */
  baseCurrency?: string
  /** Optional date range filter on Order.createdAt. */
  dateFrom?: Date
  dateTo?: Date
}

export interface OrderFunnelStats {
  totalOrders: number
  cancelledCount: number
  cancellationRate: number // 0-1 (cancelled / total)
  dispatchedCount: number
  deliveredCount: number
  deliveryRate: number // 0-1 (delivered / dispatched)
  rtoCount: number
  rtoRate: number // 0-1 (rto / dispatched)
  inTransitCount: number // dispatched - delivered - rto
  itemsSoldQty: number // sum of OrderItem.quantity for matching orders
  damageLossCount: number // count of StockLossRecord reported by this employee (tracking only)
  revenueGenerated: number // sum of totalOrderValue for delivered + dispatched orders
}

/**
 * Compute order funnel stats for the given filter.
 *
 * This is the SINGLE source of truth for funnel metrics. Used by:
 *   - Employee Performance tab (scoped by employeeId)
 *   - Customer detail page (scoped by customerId) — future
 *   - Company dashboard KPIs (scoped by companyId only) — future
 *
 * The function runs LIVE queries (not cached) so it returns accurate numbers
 * for any date range. The EmployeeStats table (cached by updateEmployeeStats)
 * stores all-time totals for quick list-view display; this function is called
 * for the detailed Performance tab which may use custom date ranges.
 *
 * @param filter The scope + optional date range
 * @returns The computed stats (all rates are 0-1, guarded against div-by-zero)
 */
export async function computeOrderFunnelStats(
  filter: OrderFunnelFilter,
): Promise<OrderFunnelStats> {
  const where: Prisma.OrderWhereInput = {
    companyId: filter.companyId,
  }
  if (filter.employeeId) {
    where.salesEmployeeId = filter.employeeId
  }
  if (filter.customerId) {
    where.customerId = filter.customerId
  }
  if (filter.dateFrom || filter.dateTo) {
    where.createdAt = {}
    if (filter.dateFrom) where.createdAt.gte = filter.dateFrom
    if (filter.dateTo) {
      const end = new Date(filter.dateTo)
      end.setHours(23, 59, 59, 999)
      where.createdAt.lte = end
    }
  }

  // Single query: fetch all matching orders with their status + totalOrderValue + deliveryCountry.
  // For itemsSoldQty, we use a separate aggregate query (sum of OrderItem.quantity).
  const [orders, itemsAgg] = await Promise.all([
    db.order.findMany({
      where,
      select: {
        status: true,
        totalOrderValue: true,
        deliveryCountry: true,
      },
    }),
    // Sum of OrderItem.quantity for the matching orders
    db.orderItem.aggregate({
      _sum: { quantity: true },
      where: { order: where },
    }),
  ])

  const totalOrders = orders.length
  const cancelledCount = orders.filter((o) => o.status === 'cancelled').length
  const dispatchedCount = orders.filter((o) => o.status === 'dispatched').length
  const deliveredCount = orders.filter((o) => o.status === 'delivered').length
  const rtoCount = orders.filter((o) => o.status === 'rto').length

  // inTransit = dispatched but not yet delivered or rto
  // (orders currently in the courier's hands)
  const inTransitCount = Math.max(0, dispatchedCount - deliveredCount - rtoCount)

  // Items sold = sum of OrderItem.quantity for dispatched + delivered orders
  // (orders that have actually left the warehouse — reflects real sales volume)
  const itemsSoldQty = itemsAgg._sum.quantity ?? 0

  // Revenue = sum of totalOrderValue for delivered + dispatched orders
  // (same convention as updateCustomerStats — reflects real revenue, excludes
  // pending/confirmed/cancelled orders)
  // Phase F1: use the shared currency-aware revenue function.
  const revenueOrders = orders
    .filter((o) => o.status === 'delivered' || o.status === 'dispatched')
    .map((o) => ({ totalOrderValue: Number(o.totalOrderValue), deliveryCountry: o.deliveryCountry }))

  const { computeRevenueWithCurrencies } = await import('@/lib/analytics/revenue')
  const revenueResult = await computeRevenueWithCurrencies(
    filter.companyId,
    revenueOrders,
    filter.baseCurrency || 'PKR',
  )
  const revenueGenerated = revenueResult.estimatedTotalBase ?? 0

  // Rates — guarded against division by zero (return 0, not NaN)
  const cancellationRate = totalOrders > 0 ? cancelledCount / totalOrders : 0
  const deliveryRate = dispatchedCount > 0 ? deliveredCount / dispatchedCount : 0
  const rtoRate = dispatchedCount > 0 ? rtoCount / dispatchedCount : 0

  // Damage/loss count — count StockLossRecord reported by this employee.
  // Tracking only (display), never subtracted from any monetary figure per
  // Usman's decision. Only computed when scoped by employeeId (a company-wide
  // damage count would need a different query; not needed for this phase).
  let damageLossCount = 0
  if (filter.employeeId) {
    damageLossCount = await db.stockLossRecord.count({
      where: { reportedById: filter.employeeId },
    })
  }

  return {
    totalOrders,
    cancelledCount,
    cancellationRate,
    dispatchedCount,
    deliveredCount,
    deliveryRate,
    rtoCount,
    rtoRate,
    inTransitCount,
    itemsSoldQty,
    damageLossCount,
    revenueGenerated,
  }
}

/**
 * Compute the funnel breakdown for charting.
 *
 * Returns the counts at each funnel stage:
 *   Created → Confirmed → Dispatched → Delivered / RTO / Cancelled
 *
 * "Confirmed" = totalOrders - cancelled - pending (orders that passed confirmation)
 * "Dispatched" = orders that left the warehouse (status = dispatched/delivered/rto)
 */
export function computeFunnelBreakdown(
  stats: OrderFunnelStats,
  confirmedCount: number,
  pendingCount: number,
): Array<{ stage: string; count: number; fill?: string }> {
  return [
    { stage: 'Created', count: stats.totalOrders, fill: 'hsl(var(--muted-foreground))' },
    { stage: 'Confirmed', count: confirmedCount, fill: 'hsl(199 89% 48%)' }, // sky
    { stage: 'Dispatched', count: stats.dispatchedCount, fill: 'hsl(262 83% 58%)' }, // violet
    { stage: 'Delivered', count: stats.deliveredCount, fill: 'hsl(142 71% 45%)' }, // green
    { stage: 'RTO', count: stats.rtoCount, fill: 'hsl(0 72% 51%)' }, // red
    { stage: 'Cancelled', count: stats.cancelledCount, fill: 'hsl(215 16% 47%)' }, // slate
  ]
}
