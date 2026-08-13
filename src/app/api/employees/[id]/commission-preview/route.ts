import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, getWorkspace } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'
import { computeCommissionEarned, getCurrentMonthRange } from '@/lib/analytics/commission'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/employees/[id]/commission-preview
 *
 * Returns a LIVE "earned so far this month" preview:
 *   - Base salary (from EmployeeSalaryProfile)
 *   - Commission earned so far (computed from real order data via computeCommissionEarned)
 *   - Estimated total = base + commission
 *
 * This is an ESTIMATE/preview — official figures only exist once Finance
 * finalizes a Payroll Run (Phase 8).
 *
 * Visibility: own profile always; others require employees.view_salary or elevated.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getWorkspace()
    const { id } = await params

    const employee = await db.employee.findFirst({
      where: { id, companyId: ctx.company.id },
      select: { id: true, userId: true },
    })
    if (!employee) throw new ApiError(404, 'Employee not found')

    const isSelf = employee.userId === ctx.user.id
    if (!isSelf) {
      const isElevated = ctx.employee.role.roleTier === 'elevated'
      const hasPermission = await db.rolePermission.count({
        where: { roleId: ctx.employee.roleId, permissionKey: PERMISSIONS.EMPLOYEES_VIEW_SALARY },
      }) > 0
      if (!isElevated && !hasPermission) {
        throw new ApiError(403, 'You lack permission to view this employee\'s commission preview.')
      }
    }

    // Fetch the active salary profile
    const profile = await db.employeeSalaryProfile.findUnique({
      where: { employeeId: id },
    })

    // Compute commission earned for the current calendar month to date
    const { start, end } = getCurrentMonthRange()
    const commission = await computeCommissionEarned(id, start, end)

    const baseSalary = profile ? Number(profile.baseSalary) : 0
    const commissionEarned = commission.totalEarned
    const estimatedTotal = baseSalary + commissionEarned

    return Response.json({
      isEstimate: true,
      period: {
        start: start.toISOString(),
        end: end.toISOString(),
        label: start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
      },
      baseSalary,
      currency: profile?.currency ?? 'PKR',
      commission: {
        totalEarned: commissionEarned,
        qualifyingOrderCount: commission.qualifyingOrderCount,
        qualifyingItemQty: commission.qualifyingItemQty,
        qualifyingRevenue: commission.qualifyingRevenue,
        rule: commission.rule,
      },
      estimatedTotal,
    })
  } catch (err) {
    return handleError(err)
  }
}
