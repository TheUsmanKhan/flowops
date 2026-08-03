import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Override a single child's weight (kg) (marks as not synced).
 *  Mirrors POST .../variants/[variantId]/override-cost exactly. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; variantId: string }> },
) {
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

    const { id: productId, variantId } = await params
    const caller = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.PRODUCTS_EDIT },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to edit products.')

    const body = await readBody<{ weightKg?: number }>(req)
    if (body.weightKg === undefined || body.weightKg < 0) {
      throw new ApiError(400, 'weightKg must be 0 or positive')
    }

    await db.orgProductVariant.update({
      where: { id: variantId },
      data: { weightKg: body.weightKg, weightSyncedWithParent: false },
    })

    await insertAuditLog({
      action: 'variant.weight_overridden',
      entityType: 'variant',
      entityId: variantId,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { weightKg: body.weightKg, synced: false },
    })
    await insertMetricEvent({
      companyId: company.id,
      entityType: 'product',
      entityId: productId,
      metricKey: 'variant.weight_overridden',
      numericValue: 1,
      dimensions: { variant_id: variantId, field: 'weight' },
    })

    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
