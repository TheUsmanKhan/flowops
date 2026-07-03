import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Dashboard overview for the active company: counts + recent activity. */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')

    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const orgId = settings.activeOrgId

    const [employeeCount, roleCount, pendingInvites, auditRecent, metrics7d] =
      await Promise.all([
        db.employee.count({ where: { companyId, status: 'active' } }),
        db.role.count({ where: { companyId, isActive: true } }),
        db.invitation.count({
          where: { companyId, status: 'pending' },
        }),
        db.auditLog.findMany({
          where: { companyId },
          orderBy: { createdAt: 'desc' },
          take: 6,
          include: { user: { select: { fullName: true, email: true } } },
        }),
        db.metricEvent.findMany({
          where: {
            companyId,
            recordedAt: { gte: new Date(Date.now() - 7 * 86400000) },
          },
          select: { metricKey: true, numericValue: true, recordedAt: true },
        }),
      ])

    const byKey = new Map<string, number>()
    for (const m of metrics7d) {
      byKey.set(m.metricKey, (byKey.get(m.metricKey) ?? 0) + m.numericValue)
    }

    return Response.json({
      stats: {
        employees: employeeCount,
        roles: roleCount,
        pendingInvites,
        orgs: orgId ? 1 : 0,
      },
      recentActivity: auditRecent.map((a) => ({
        id: a.id,
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        createdAt: a.createdAt.toISOString(),
        user: a.user
          ? { id: a.user.id, fullName: a.user.fullName, email: a.user.email }
          : null,
      })),
      metrics: Array.from(byKey.entries()).map(([key, value]) => ({
        key,
        value,
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}
