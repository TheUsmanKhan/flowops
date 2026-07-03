import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Paginated, filterable audit log for the active company (elevated or audit.view). */
export async function GET(req: Request) {
  try {
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
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.AUDIT_VIEW },
      })) > 0
    if (!allowed) {
      throw new ApiError(403, 'You lack permission to view the audit log.')
    }

    const url = new URL(req.url)
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'))
    const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get('pageSize') ?? '25')))
    const action = url.searchParams.get('action') ?? ''
    const entityType = url.searchParams.get('entityType') ?? ''

    const where = {
      companyId: company.id,
      ...(action ? { action: { contains: action } } : {}),
      ...(entityType ? { entityType } : {}),
    }
    const [total, rows] = await Promise.all([
      db.auditLog.count({ where }),
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: { select: { id: true, fullName: true, email: true } },
          employee: { select: { id: true, designation: true } },
        },
      }),
    ])

    return Response.json({
      rows: rows.map((r) => ({
        id: r.id,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        createdAt: r.createdAt.toISOString(),
        ipAddress: r.ipAddress,
        metadata: safeParse(r.metadata),
        oldValues: safeParseNullable(r.oldValues),
        newValues: safeParseNullable(r.newValues),
        user: r.user,
      })),
      total,
      page,
      pageSize,
    })
  } catch (err) {
    return handleError(err)
  }
}

function safeParse(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}
function safeParseNullable(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}
