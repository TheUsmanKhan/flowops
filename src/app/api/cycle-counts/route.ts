import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createCycleCountSchema = z.object({
  location_id: z.string().min(1),
  count_name: z.string().min(2).max(200),
  count_type: z.enum(['full', 'partial', 'spot']).default('full'),
  scheduled_at: z.string().optional(),
  notes: z.string().optional().or(z.literal('')),
})

/** List cycle counts for the active company. */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const counts = await db.cycleCount.findMany({
      where: { companyId },
      include: {
        location: { select: { name: true } },
        _count: { select: { items: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })

    return Response.json({
      counts: counts.map((c) => ({
        id: c.id,
        countName: c.countName,
        countType: c.countType,
        status: c.status,
        location: c.location.name,
        scheduledAt: c.scheduledAt.toISOString(),
        startedAt: c.startedAt?.toISOString() ?? null,
        completedAt: c.completedAt?.toISOString() ?? null,
        approvedAt: c.approvedAt?.toISOString() ?? null,
        totalDiscrepancies: c.totalDiscrepancies,
        totalVarianceValue: Number(c.totalVarianceValue),
        itemCount: c._count.items,
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}

/** Create a cycle count. */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const orgId = settings?.activeOrgId
    const company = settings?.activeCompany
    if (!orgId || !company) throw new ApiError(403, 'No active company')

    const caller = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_CYCLE_COUNT },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to manage cycle counts.')

    const body = await readBody(req)
    const parsed = createCycleCountSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    const d = parsed.data

    const count = await db.cycleCount.create({
      data: {
        organizationId: orgId,
        companyId: company.id,
        locationId: d.location_id,
        countName: d.count_name,
        countType: d.count_type,
        status: 'scheduled',
        scheduledAt: d.scheduled_at ? new Date(d.scheduled_at) : new Date(),
        notes: d.notes || null,
        createdById: caller.id,
      },
    })

    await insertAuditLog({
      action: 'cycle_count.created',
      entityType: 'cycle_count',
      entityId: count.id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { countName: count.countName, countType: count.countType },
    })

    await insertMetricEvent({
      companyId: company.id,
      entityType: 'location',
      entityId: d.location_id,
      metricKey: 'inventory.cycle_count_created',
      numericValue: 1,
      dimensions: {
        count_type: d.count_type,
        count_name: d.count_name,
      },
    })

    return Response.json({ id: count.id })
  } catch (err) {
    return handleError(err)
  }
}
