import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, getWorkspace } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/employees/[id]/salary
 * Returns the employee's current salary profile + revision history.
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
        throw new ApiError(403, 'You lack permission to view this employee\'s salary.')
      }
    }

    const [profile, revisions] = await Promise.all([
      db.employeeSalaryProfile.findUnique({
        where: { employeeId: id },
      }),
      db.salaryRevision.findMany({
        where: { employeeId: id },
        orderBy: { effectiveFrom: 'desc' },
        take: 20,
        include: {
          changedBy: { select: { user: { select: { fullName: true } } } },
        },
      }),
    ])

    return Response.json({
      profile: profile
        ? {
            baseSalary: Number(profile.baseSalary),
            currency: profile.currency,
            effectiveFrom: profile.effectiveFrom.toISOString(),
            status: profile.status,
          }
        : null,
      revisions: revisions.map((r) => ({
        id: r.id,
        oldAmount: r.oldAmount ? Number(r.oldAmount) : null,
        newAmount: Number(r.newAmount),
        effectiveFrom: r.effectiveFrom.toISOString(),
        changedByName: r.changedBy?.user?.fullName ?? 'Unknown',
        createdAt: r.createdAt.toISOString(),
      })),
      canEdit: isSelf
        ? false // employees cannot edit their own salary
        : ctx.employee.role.roleTier === 'elevated' ||
          (await db.rolePermission.count({
            where: { roleId: ctx.employee.roleId, permissionKey: PERMISSIONS.EMPLOYEES_MANAGE_SALARY },
          })) > 0,
    })
  } catch (err) {
    return handleError(err)
  }
}

const updateSalarySchema = z.object({
  baseSalary: z.number().min(0, 'Base salary must be >= 0'),
  currency: z.string().default('PKR'),
  effectiveFrom: z.string().optional(),
})

/**
 * PATCH /api/employees/[id]/salary
 * Updates the base salary — creates a new EmployeeSalaryProfile + SalaryRevision row.
 * Never silently overwrites — always logs the change.
 *
 * Requires employees.manage_salary permission (not just view_salary).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getWorkspace()
    const { id } = await params

    const employee = await db.employee.findFirst({
      where: { id, companyId: ctx.company.id },
      select: { id: true, companyId: true },
    })
    if (!employee) throw new ApiError(404, 'Employee not found')

    // Permission check: employees.manage_salary OR elevated
    const isElevated = ctx.employee.role.roleTier === 'elevated'
    if (!isElevated) {
      const hasPermission = await db.rolePermission.count({
        where: { roleId: ctx.employee.roleId, permissionKey: PERMISSIONS.EMPLOYEES_MANAGE_SALARY },
      }) > 0
      if (!hasPermission) {
        throw new ApiError(403, 'You lack permission to manage employee salary.')
      }
    }

    const body = await req.json()
    const parsed = updateSalarySchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    }
    const { baseSalary, currency, effectiveFrom } = parsed.data
    const effDate = effectiveFrom ? new Date(effectiveFrom) : new Date()

    // Fetch the current (old) salary profile to log the old amount
    const oldProfile = await db.employeeSalaryProfile.findUnique({
      where: { employeeId: id },
    })

    // Deactivate the old profile (if any) + create the new one + log the revision
    // in a transaction (atomic)
    await db.$transaction(async (tx) => {
      if (oldProfile) {
        await tx.employeeSalaryProfile.update({
          where: { employeeId: id },
          data: { status: 'inactive' },
        })
      }

      await tx.employeeSalaryProfile.create({
        data: {
          employeeId: id,
          baseSalary,
          currency,
          effectiveFrom: effDate,
          status: 'active',
        },
      })

      await tx.salaryRevision.create({
        data: {
          employeeId: id,
          oldAmount: oldProfile?.baseSalary ?? null,
          newAmount: baseSalary,
          effectiveFrom: effDate,
          changedByEmployeeId: ctx.employee.id,
        },
      })
    })

    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
