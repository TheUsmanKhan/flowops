import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Set weight (kg) for an entire parent group (cascades to synced children only).
 *  Mirrors POST .../variant-groups/[parentValueId]/cost exactly. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; parentValueId: string }> },
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

    const { id: productId, parentValueId } = await params
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

    const body = await readBody<{ weightKg?: number; parent_attribute_name?: string; parent_value?: string }>(req)
    if (body.weightKg === undefined || body.weightKg < 0) {
      throw new ApiError(400, 'weightKg must be 0 or positive')
    }

    // Fetch all variants for this product where parent attribute = parent_value AND synced
    const variants = await db.orgProductVariant.findMany({
      where: { productId, weightSyncedWithParent: true },
      select: { id: true, attributeValues: true },
    })

    const toUpdate = variants.filter((v) => {
      const attrs = JSON.parse(v.attributeValues) as Record<string, string>
      return attrs[body.parent_attribute_name!] === body.parent_value
    })

    if (toUpdate.length === 0) {
      return Response.json({ success: true, updated_count: 0 })
    }

    const result = await db.orgProductVariant.updateMany({
      where: { id: { in: toUpdate.map((v) => v.id) } },
      data: { weightKg: body.weightKg },
    })

    await insertAuditLog({
      action: 'variant.parent_weight_updated',
      entityType: 'product',
      entityId: productId,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { parentValue: body.parent_value, weightKg: body.weightKg, affectedCount: result.count },
    })
    await insertMetricEvent({
      companyId: company.id,
      entityType: 'product',
      entityId: productId,
      metricKey: 'variant.parent_weight_updated',
      numericValue: result.count,
      dimensions: { parent_value: body.parent_value },
    })

    return Response.json({ success: true, updated_count: result.count })
  } catch (err) {
    return handleError(err)
  }
}
