import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, getWorkspace } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/employees/[id]/commission-rules
 * Returns the employee's active commission rules.
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
        throw new ApiError(403, 'You lack permission to view this employee\'s commission rules.')
      }
    }

    const rules = await db.commissionRule.findMany({
      where: { employeeId: id },
      orderBy: { createdAt: 'desc' },
    })

    const canEdit = isSelf
      ? false
      : ctx.employee.role.roleTier === 'elevated' ||
        (await db.rolePermission.count({
          where: { roleId: ctx.employee.roleId, permissionKey: PERMISSIONS.EMPLOYEES_MANAGE_SALARY },
        })) > 0

    return Response.json({
      rules: rules.map((r) => ({
        id: r.id,
        basisType: r.basisType,
        rateValue: Number(r.rateValue),
        triggerStatus: r.triggerStatus,
        isActive: r.isActive,
        createdAt: r.createdAt.toISOString(),
      })),
      canEdit,
    })
  } catch (err) {
    return handleError(err)
  }
}

const createRuleSchema = z.object({
  basisType: z.enum(['per_order', 'per_item_sold', 'percentage_of_revenue']),
  rateValue: z.number().min(0, 'Rate must be >= 0'),
  triggerStatus: z.string().min(1, 'Trigger status is required'),
})

/**
 * POST /api/employees/[id]/commission-rules
 * Creates a new commission rule. Deactivates any existing active rule (v1: one active rule).
 *
 * Requires employees.manage_salary permission.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getWorkspace()
    const { id } = await params

    const employee = await db.employee.findFirst({
      where: { id, companyId: ctx.company.id },
      select: { id: true },
    })
    if (!employee) throw new ApiError(404, 'Employee not found')

    const isElevated = ctx.employee.role.roleTier === 'elevated'
    if (!isElevated) {
      const hasPermission = await db.rolePermission.count({
        where: { roleId: ctx.employee.roleId, permissionKey: PERMISSIONS.EMPLOYEES_MANAGE_SALARY },
      }) > 0
      if (!hasPermission) {
        throw new ApiError(403, 'You lack permission to manage commission rules.')
      }
    }

    const body = await req.json()
    const parsed = createRuleSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    }
    const { basisType, rateValue, triggerStatus } = parsed.data

    // v1: one active rule per employee — deactivate existing active rules
    await db.commissionRule.updateMany({
      where: { employeeId: id, isActive: true },
      data: { isActive: false },
    })

    const rule = await db.commissionRule.create({
      data: {
        employeeId: id,
        basisType,
        rateValue,
        triggerStatus,
        isActive: true,
      },
    })

    return Response.json({
      id: rule.id,
      basisType: rule.basisType,
      rateValue: Number(rule.rateValue),
      triggerStatus: rule.triggerStatus,
      isActive: rule.isActive,
    }, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}

/**
 * DELETE /api/employees/[id]/commission-rules?ruleId=xxx
 * Deactivates a commission rule (soft delete — sets isActive=false).
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getWorkspace()
    const { id } = await params
    const url = new URL(req.url)
    const ruleId = url.searchParams.get('ruleId')
    if (!ruleId) throw new ApiError(400, 'ruleId query param is required')

    const isElevated = ctx.employee.role.roleTier === 'elevated'
    if (!isElevated) {
      const hasPermission = await db.rolePermission.count({
        where: { roleId: ctx.employee.roleId, permissionKey: PERMISSIONS.EMPLOYEES_MANAGE_SALARY },
      }) > 0
      if (!hasPermission) {
        throw new ApiError(403, 'You lack permission to manage commission rules.')
      }
    }

    await db.commissionRule.update({
      where: { id: ruleId, employeeId: id },
      data: { isActive: false },
    })

    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
