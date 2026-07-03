import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { terminateEmployeeSchema } from '@/lib/validations/employee'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Suspend or terminate an employee (status transitions). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const { id } = await params
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')

    const body = await readBody<{
      action: 'suspend' | 'terminate' | 'reactivate'
      reason?: string
    }>(req)

    if (!body.action || !['suspend', 'terminate', 'reactivate'].includes(body.action)) {
      throw new ApiError(400, 'Invalid action.')
    }

    // Permission gate.
    const requiredPerm =
      body.action === 'terminate'
        ? PERMISSIONS.EMPLOYEES_TERMINATE
        : PERMISSIONS.EMPLOYEES_MANAGE
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: requiredPerm },
      })) > 0
    if (!allowed) {
      throw new ApiError(403, `You lack permission to ${body.action} employees.`)
    }

    const target = await db.employee.findFirst({ where: { id, companyId } })
    if (!target) throw new ApiError(404, 'Employee not found.')
    if (target.userId === user.id) {
      throw new ApiError(400, 'You cannot modify your own employment status.')
    }

    const oldValues = { status: target.status }

    let newStatus: string
    if (body.action === 'suspend') {
      if (target.status !== 'active') {
        throw new ApiError(400, 'Only active employees can be suspended.')
      }
      newStatus = 'suspended'
    } else if (body.action === 'terminate') {
      const parsed = terminateEmployeeSchema.safeParse({ reason: body.reason })
      if (!parsed.success) {
        throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Reason required')
      }
      newStatus = 'terminated'
      await db.employee.update({
        where: { id },
        data: {
          status: newStatus,
          terminatedAt: new Date(),
          terminatedById: user.id,
          terminationReason: parsed.data.reason,
        },
      })
    } else {
      // reactivate
      if (target.status === 'active') {
        throw new ApiError(400, 'Employee is already active.')
      }
      newStatus = 'active'
      await db.employee.update({
        where: { id },
        data: {
          status: newStatus,
          terminatedAt: null,
          terminatedById: null,
          terminationReason: null,
        },
      })
    }

    if (body.action !== 'terminate') {
      await db.employee.update({ where: { id }, data: { status: newStatus } })
    }

    const actionLog =
      body.action === 'terminate'
        ? 'employee.terminated'
        : body.action === 'suspend'
          ? 'employee.suspended'
          : 'employee.reactivated'

    await insertAuditLog({
      action: actionLog,
      entityType: 'employee',
      entityId: id,
      companyId,
      organizationId: settings?.activeOrgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues,
      newValues: {
        status: newStatus,
        reason: body.reason ?? null,
      },
    })

    return Response.json({ id, status: newStatus })
  } catch (err) {
    return handleError(err)
  }
}
