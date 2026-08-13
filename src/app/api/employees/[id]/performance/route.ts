import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, getWorkspace } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'
import { computeOrderFunnelStats } from '@/lib/analytics/order-funnel'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/employees/[id]/performance
 *
 * Returns the employee's order funnel stats (live-computed, not cached) for
 * the Performance tab. Supports an optional date range filter.
 *
 * Visibility:
 *   - An employee can always view their OWN performance stats
 *   - Viewing another employee's stats requires employees.view permission
 *     (kpi_view or employees.manage also works, following the existing KPI
 *     & Audit module's permission pattern). employees.view_salary is NOT
 *     required here — Performance/KPI is separate from Salary.
 *
 * Query params:
 *   - date_from: ISO date string (optional)
 *   - date_to: ISO date string (optional)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getWorkspace()
    const { id } = await params

    // Fetch the employee (must belong to the caller's company)
    const employee = await db.employee.findFirst({
      where: { id, companyId: ctx.company.id },
      select: {
        id: true,
        userId: true,
        designation: true,
        department: true,
        user: { select: { fullName: true } },
      },
    })
    if (!employee) throw new ApiError(404, 'Employee not found')

    // Visibility check: own profile OR has employees.view / kpi.view / elevated
    const isSelf = employee.userId === ctx.user.id
    if (!isSelf) {
      const isElevated = ctx.employee.role.roleTier === 'elevated'
      const hasPermission =
        await db.rolePermission.count({
          where: {
            roleId: ctx.employee.roleId,
            permissionKey: { in: [PERMISSIONS.EMPLOYEES_VIEW, PERMISSIONS.KPI_VIEW] },
          },
        }) > 0
      if (!isElevated && !hasPermission) {
        throw new ApiError(403, 'You lack permission to view this employee\'s performance.')
      }
    }

    // Parse date range
    const url = new URL(req.url)
    const dateFromStr = url.searchParams.get('date_from')
    const dateToStr = url.searchParams.get('date_to')
    const dateFrom = dateFromStr ? new Date(dateFromStr) : undefined
    const dateTo = dateToStr ? new Date(dateToStr) : undefined

    // Compute the funnel stats LIVE (not from the cached EmployeeStats row —
    // the cached row represents all-time totals, but the Performance tab may
    // use custom date ranges)
    const stats = await computeOrderFunnelStats({
      employeeId: employee.id,
      companyId: ctx.company.id,
      dateFrom,
      dateTo,
    })

    // Fetch the cached EmployeeStats row for the "all-time" snapshot
    // (shown alongside the live-computed numbers for comparison)
    const cachedStats = await db.employeeStats.findUnique({
      where: { employeeId: employee.id },
    })

    // Get status breakdown for the funnel chart
    const statusCounts = await db.order.groupBy({
      by: ['status'],
      where: {
        salesEmployeeId: employee.id,
        companyId: ctx.company.id,
        ...(dateFrom || dateTo
          ? {
              createdAt: {
                ...(dateFrom ? { gte: dateFrom } : {}),
                ...(dateTo ? { lte: new Date(dateTo.getTime() + 86400000) } : {}),
              },
            }
          : {}),
      },
      _count: { status: true },
    })
    const statusMap = new Map(statusCounts.map((s) => [s.status, s._count.status]))
    const pendingCount = (statusMap.get('pending') ?? 0) + (statusMap.get('partially_backordered') ?? 0)
    const confirmedCount =
      (statusMap.get('confirmed') ?? 0) +
      (statusMap.get('processing') ?? 0)

    return Response.json({
      employee: {
        id: employee.id,
        name: employee.user.fullName,
        designation: employee.designation,
        department: employee.department,
      },
      stats,
      statusBreakdown: {
        pending: pendingCount,
        confirmed: confirmedCount,
        dispatched: stats.dispatchedCount,
        delivered: stats.deliveredCount,
        rto: stats.rtoCount,
        cancelled: stats.cancelledCount,
      },
      cachedAllTime: cachedStats
        ? {
            totalOrders: cachedStats.totalOrders,
            cancelledCount: cachedStats.cancelledCount,
            cancellationRate: Number(cachedStats.cancellationRate),
            dispatchedCount: cachedStats.dispatchedCount,
            deliveredCount: cachedStats.deliveredCount,
            deliveryRate: Number(cachedStats.deliveryRate),
            rtoCount: cachedStats.rtoCount,
            rtoRate: Number(cachedStats.rtoRate),
            inTransitCount: cachedStats.inTransitCount,
            itemsSoldQty: cachedStats.itemsSoldQty,
            damageLossCount: cachedStats.damageLossCount,
            revenueGenerated: Number(cachedStats.revenueGenerated),
          }
        : null,
    })
  } catch (err) {
    return handleError(err)
  }
}
