import { db } from '@/lib/db'
import { handleError, getWorkspace, hasPermission } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Dashboard overview for the active company: counts + recent activity. */
export async function GET() {
  try {
    const ctx = await getWorkspace()
    const companyId = ctx.company.id
    const orgId = ctx.company.organizationId

    // Phase 2: Only fetch the audit log feed if the caller has audit.view.
    // Employees without the permission still see the KPI cards + metrics —
    // the recentActivity array is returned empty for them.
    const canViewAudit = await hasPermission(ctx, PERMISSIONS.AUDIT_VIEW)

    const [employeeCount, roleCount, pendingInvites, auditRecent, metrics7d] =
      await Promise.all([
        db.employee.count({ where: { companyId, status: 'active' } }),
        db.role.count({ where: { companyId, isActive: true } }),
        db.invitation.count({
          where: { companyId, status: 'pending' },
        }),
        canViewAudit
          ? db.auditLog.findMany({
              where: { companyId },
              orderBy: { createdAt: 'desc' },
              take: 6,
              include: { user: { select: { id: true, fullName: true, email: true } } },
            })
          : Promise.resolve([]),
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
