import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { updateRoleSchema } from '@/lib/validations/invitation'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Update a role's name/description/permissions. System roles cannot be renamed. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const { id } = await params
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const company = settings?.activeCompany
    if (!company) throw new ApiError(403, 'No active company')

    const caller = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.SETTINGS_ROLES_MANAGE },
      })) > 0
    if (!allowed) {
      throw new ApiError(403, 'You lack permission to manage roles.')
    }

    const role = await db.role.findFirst({ where: { id, companyId: company.id } })
    if (!role) throw new ApiError(404, 'Role not found.')

    const body = await readBody(req)
    const parsed = updateRoleSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    }
    const d = parsed.data

    const oldValues = {
      name: role.name,
      description: role.description,
      permissions: (
        await db.rolePermission.findMany({ where: { roleId: role.id } })
      ).map((p) => p.permissionKey),
    }

    // System roles cannot be renamed.
    if (role.isSystemRole && d.name && d.name !== role.name) {
      throw new ApiError(400, 'System role names cannot be changed.')
    }

    // Sequential operations (avoids interactive-transaction issues with the
    // Supabase pooled connection). Permission sync uses delete-then-create;
    // a brief empty window is acceptable for role edits.
    if (d.name !== undefined || d.description !== undefined) {
      await db.role.update({
        where: { id: role.id },
        data: {
          ...(d.name !== undefined && !role.isSystemRole ? { name: d.name } : {}),
          ...(d.description !== undefined ? { description: d.description || null } : {}),
        },
      })
    }
    if (d.permissions !== undefined) {
      await db.rolePermission.deleteMany({ where: { roleId: role.id } })
      if (d.permissions.length > 0) {
        await db.rolePermission.createMany({
          data: d.permissions.map((key) => ({
            roleId: role.id,
            companyId: company.id,
            permissionKey: key,
          })),
        })
      }
    }

    insertAuditLog({
      action: 'role.updated',
      entityType: 'role',
      entityId: role.id,
      companyId: company.id,
      organizationId: company.organizationId,
      userId: user.id,
      employeeId: caller.id,
      oldValues,
      newValues: d,
    })

    return Response.json({ id: role.id })
  } catch (err) {
    return handleError(err)
  }
}

/** Delete a custom role (system roles are protected). */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const { id } = await params
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const company = settings?.activeCompany
    if (!company) throw new ApiError(403, 'No active company')

    const caller = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.SETTINGS_ROLES_MANAGE },
      })) > 0
    if (!allowed) {
      throw new ApiError(403, 'You lack permission to manage roles.')
    }

    const role = await db.role.findFirst({ where: { id, companyId: company.id } })
    if (!role) throw new ApiError(404, 'Role not found.')
    if (role.isSystemRole) {
      throw new ApiError(400, 'System roles cannot be deleted.')
    }
    const inUse = await db.employee.count({ where: { roleId: role.id, status: 'active' } })
    if (inUse > 0) {
      throw new ApiError(409, `${inUse} active employee(s) still use this role. Reassign them first.`)
    }

    await db.role.delete({ where: { id: role.id } })

    insertAuditLog({
      action: 'role.deleted',
      entityType: 'role',
      entityId: role.id,
      companyId: company.id,
      organizationId: company.organizationId,
      userId: user.id,
      employeeId: caller.id,
      oldValues: { name: role.name, roleTier: role.roleTier },
    })

    return Response.json({ id: role.id })
  } catch (err) {
    return handleError(err)
  }
}
