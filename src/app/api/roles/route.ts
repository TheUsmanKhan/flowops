import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import {
  ApiError,
  handleError,
  readBody,
  getWorkspace,
  requirePermission,
} from '@/lib/workspace'
import { createRoleSchema } from '@/lib/validations/invitation'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** List all roles in the active company with their permission keys. */
export async function GET() {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.SETTINGS_ROLES_MANAGE)

    const roles = await db.role.findMany({
      where: { companyId: ctx.company.id },
      include: {
        rolePermissions: { select: { permissionKey: true } },
        _count: { select: { employees: { where: { status: 'active' } } } },
      },
      orderBy: [{ isSystemRole: 'desc' }, { name: 'asc' }],
    })

    return Response.json({
      roles: roles.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        roleTier: r.roleTier,
        isSystemRole: r.isSystemRole,
        systemRoleKey: r.systemRoleKey,
        isActive: r.isActive,
        companyId: r.companyId,
        permissions: r.rolePermissions.map((p) => p.permissionKey),
        ordersDataScope: r.ordersDataScope as 'own' | 'all',
        employeeCount: r._count.employees,
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}

/** Create a new custom (standard) role. */
export async function POST(req: Request) {
  try {
    const idempotencyKey = req.headers.get('Idempotency-Key')

    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
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

    const body = await readBody(req)
    const parsed = createRoleSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    }
    const { name, description, permissions, ordersDataScope } = parsed.data

    const existing = await db.role.findFirst({
      where: { companyId: company.id, name: { equals: name, mode: 'insensitive' } },
    })
    if (existing) throw new ApiError(409, 'A role with this name already exists.')

    // Core creation logic — wrapped in a closure so it can be run either
    // directly (no idempotency key, backwards-compatible) or via
    // withIdempotency() (prevents duplicate role submissions).
    const createRole = async () => {
      const role = await db.role.create({
        data: {
          companyId: company.id,
          name,
          description: description || null,
          roleTier: 'standard',
          isSystemRole: false,
          ordersDataScope,
          createdById: user!.id,
          rolePermissions: {
            create: permissions.map((key) => ({
              companyId: company.id,
              permissionKey: key,
            })),
          },
        },
        include: { rolePermissions: { select: { permissionKey: true } } },
      })

      insertAuditLog({
        action: 'role.created',
        entityType: 'role',
        entityId: role.id,
        companyId: company.id,
        organizationId: company.organizationId,
        userId: user!.id,
        employeeId: caller.id,
        newValues: { name, description, permissions, ordersDataScope },
      })

      return {
        id: role.id,
        name: role.name,
        permissions: role.rolePermissions.map((p) => p.permissionKey),
      }
    }

    if (idempotencyKey) {
      const { withIdempotency } = await import('@/lib/idempotency')
      const { result, wasReplay } = await withIdempotency({
        key: idempotencyKey,
        companyId: company.id,
        employeeId: caller.id,
        actionType: 'role.create',
        fn: createRole,
      })
      return Response.json(result, { status: wasReplay ? 200 : 201 })
    }

    // No idempotency key — normal flow (backwards-compatible)
    const result = await createRole()
    return Response.json(result)
  } catch (err) {
    return handleError(err)
  }
}
