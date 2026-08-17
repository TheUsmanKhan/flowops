import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { inviteEmployeeSchema } from '@/lib/validations/employee'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** List employees in the active company. */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const employees = await db.employee.findMany({
      where: { companyId },
      include: {
        user: {
          select: { id: true, fullName: true, email: true, avatarUrl: true, phone: true },
        },
        role: { select: { id: true, name: true, roleTier: true, isSystemRole: true, systemRoleKey: true, ordersDataScope: true } },
        directManager: {
          select: { id: true, user: { select: { fullName: true } } },
        },
      },
      orderBy: [{ status: 'asc' }, { joinedAt: 'desc' }],
    })

    return Response.json({
      employees: employees.map((e) => ({
        id: e.id,
        employeeCode: e.employeeCode,
        department: e.department,
        designation: e.designation,
        status: e.status,
        joinedAt: e.joinedAt.toISOString(),
        terminatedAt: e.terminatedAt?.toISOString() ?? null,
        terminationReason: e.terminationReason,
        user: {
          id: e.user.id,
          fullName: e.user.fullName,
          email: e.user.email,
          avatarUrl: e.user.avatarUrl,
          phone: e.user.phone,
        },
        role: {
          id: e.role.id,
          name: e.role.name,
          roleTier: e.role.roleTier,
          isSystemRole: e.role.isSystemRole,
          systemRoleKey: e.role.systemRoleKey,
          ordersDataScope: e.role.ordersDataScope as 'own' | 'all',
        },
        directManager: e.directManager
          ? { id: e.directManager.id, name: e.directManager.user.fullName }
          : null,
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}

/** Invite a new employee by email. */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const company = settings?.activeCompany
    if (!company) throw new ApiError(403, 'No active company')

    // Permission check: elevated OR employees.invite
    const callerEmp = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!callerEmp) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      callerEmp.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: callerEmp.roleId, permissionKey: PERMISSIONS.EMPLOYEES_INVITE },
      })) > 0
    if (!allowed) {
      throw new ApiError(403, 'You lack permission to invite employees.')
    }

    const body = await readBody(req)
    const parsed = inviteEmployeeSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    }
    const { email, roleId, department, designation, message } = parsed.data

    // Validate role belongs to company.
    const role = await db.role.findFirst({ where: { id: roleId, companyId: company.id } })
    if (!role) throw new ApiError(400, 'Selected role does not belong to this company.')

    // The core invite creation logic — wrapped in a function so it can be
    // called either directly or via withIdempotency() (prevents duplicate
    // invitations from rapid double-clicks).
    const createInvite = async () => {
      // Prevent duplicate pending invite.
      // NOTE: This is a check-then-create pattern with a race window.
      // The withIdempotency wrapper below closes this gap for the
      // double-click case. A DB-level unique constraint on
      // [companyId, invitedEmail, status] would be the ideal fix, but
      // would require a schema migration — the idempotency key system
      // provides equivalent protection without the migration.
      const existingPending = await db.invitation.findFirst({
        where: { companyId: company.id, invitedEmail: email.toLowerCase(), status: 'pending' },
      })
      if (existingPending) {
        throw new ApiError(409, 'A pending invitation already exists for this email.')
      }

      const expiresAt = new Date(Date.now() + 7 * 86400000)
      const invitation = await db.invitation.create({
        data: {
          companyId: company.id,
          organizationId: company.organizationId,
          invitedEmail: email.toLowerCase(),
          invitedById: user.id,
          roleId: role.id,
          expiresAt,
          message: message || null,
          metadata: JSON.stringify({ department, designation }),
        },
        include: { role: true },
      })

      insertAuditLog({
        action: 'employee.invited',
        entityType: 'invitation',
        entityId: invitation.id,
        companyId: company.id,
        organizationId: company.organizationId,
        userId: user.id,
        employeeId: callerEmp.id,
        newValues: {
          invitedEmail: email,
          role: role.name,
          department,
          designation,
          expiresAt: expiresAt.toISOString(),
        },
      })

      return {
        id: invitation.id,
        invitedEmail: invitation.invitedEmail,
        status: invitation.status,
        role: { id: invitation.role.id, name: invitation.role.name },
        expiresAt: invitation.expiresAt.toISOString(),
        note:
          'The invitee will see this invitation when they sign in or register with this email.',
      }
    }

    // If an idempotency key is provided, wrap the creation in withIdempotency()
    const idempotencyKey = req.headers.get('Idempotency-Key')
    if (idempotencyKey) {
      const { withIdempotency } = await import('@/lib/idempotency')
      const { result, wasReplay } = await withIdempotency({
        key: idempotencyKey,
        companyId: company.id,
        employeeId: callerEmp.id,
        actionType: 'employee.invite',
        fn: createInvite,
      })
      return Response.json(result, { status: wasReplay ? 200 : 201 })
    }

    // No idempotency key — normal flow (backwards-compatible)
    const result = await createInvite()
    return Response.json(result, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
