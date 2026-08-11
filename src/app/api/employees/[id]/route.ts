import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import {
  ApiError,
  handleError,
  readBody,
} from '@/lib/workspace'
import {
  updateEmployeeSchema,
  terminateEmployeeSchema,
} from '@/lib/validations/employee'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Fetch a single employee with full detail. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const { id } = await params
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const employee = await db.employee.findFirst({
      where: { id, companyId },
      include: {
        user: {
          select: { id: true, fullName: true, email: true, avatarUrl: true, phone: true, createdAt: true },
        },
        role: {
          include: { rolePermissions: { select: { permissionKey: true } } },
        },
        directManager: { select: { id: true, user: { select: { fullName: true } } } },
        subordinates: {
          select: {
            id: true,
            user: { select: { fullName: true } },
            designation: true,
          },
        },
        invitedBy: { select: { id: true, fullName: true } },
        terminatedBy: { select: { id: true, fullName: true } },
      },
    })
    if (!employee) throw new ApiError(404, 'Employee not found.')

    return Response.json({
      employee: {
        id: employee.id,
        employeeCode: employee.employeeCode,
        department: employee.department,
        designation: employee.designation,
        status: employee.status,
        joinedAt: employee.joinedAt.toISOString(),
        terminatedAt: employee.terminatedAt?.toISOString() ?? null,
        terminationReason: employee.terminationReason,
        user: employee.user,
        role: {
          id: employee.role.id,
          name: employee.role.name,
          roleTier: employee.role.roleTier,
          isSystemRole: employee.role.isSystemRole,
          systemRoleKey: employee.role.systemRoleKey,
          permissions: employee.role.rolePermissions.map((p) => p.permissionKey),
        },
        directManager: employee.directManager
          ? { id: employee.directManager.id, name: employee.directManager.user.fullName }
          : null,
        subordinates: employee.subordinates.map((s) => ({
          id: s.id,
          name: s.user.fullName,
          designation: s.designation,
        })),
        invitedBy: employee.invitedBy,
        terminatedBy: employee.terminatedBy,
      },
    })
  } catch (err) {
    return handleError(err)
  }
}

/** Update an employee (role, department, designation, code, manager). */
export async function PATCH(
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

    const target = await db.employee.findFirst({ where: { id, companyId } })
    if (!target) throw new ApiError(404, 'Employee not found.')

    const body = await readBody(req)
    const parsed = updateEmployeeSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    }
    const d = parsed.data

    // Permission: elevated OR employees.manage. Self-updates for own
    // department/designation are also allowed (limited fields).
    const isSelf = target.userId === user.id
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.EMPLOYEES_MANAGE },
      })) > 0 ||
      (isSelf && d.department !== undefined && d.designation !== undefined && d.roleId === undefined && d.directManagerId === undefined && d.employeeCode === undefined)
    if (!allowed) {
      throw new ApiError(403, 'You lack permission to update this employee.')
    }

    const oldValues = {
      roleId: target.roleId,
      department: target.department,
      designation: target.designation,
      employeeCode: target.employeeCode,
      directManagerId: target.directManagerId,
    }

    // Validate role + manager if provided.
    if (d.roleId) {
      const role = await db.role.findFirst({ where: { id: d.roleId, companyId } })
      if (!role) throw new ApiError(400, 'Role does not belong to this company.')
    }
    if (d.directManagerId) {
      const mgr = await db.employee.findFirst({ where: { id: d.directManagerId, companyId } })
      if (!mgr || mgr.id === target.id) {
        throw new ApiError(400, 'Invalid direct manager.')
      }
    }

    const updated = await db.employee.update({
      where: { id },
      data: {
        roleId: d.roleId ?? undefined,
        department: d.department !== undefined ? (d.department || null) : undefined,
        designation: d.designation !== undefined ? (d.designation || null) : undefined,
        employeeCode: d.employeeCode !== undefined ? (d.employeeCode || null) : undefined,
        directManagerId: d.directManagerId !== undefined ? (d.directManagerId || null) : undefined,
      },
    })

    insertAuditLog({
      action: d.roleId ? 'employee.role_changed' : 'employee.updated',
      entityType: 'employee',
      entityId: updated.id,
      companyId,
      organizationId: settings?.activeOrgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues,
      newValues: d,
    })

    return Response.json({ id: updated.id })
  } catch (err) {
    return handleError(err)
  }
}
