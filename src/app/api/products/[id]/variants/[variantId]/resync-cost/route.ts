import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { determineParentAttribute } from '@/lib/utils/variant-grouping'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Re-sync a child's cost price with its parent group. */
export async function POST(
  _req: NextRequest,
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

    // Fetch this variant
    const variant = await db.orgProductVariant.findFirst({
      where: { id: variantId, productId },
      select: { id: true, attributeValues: true, costPrice: true },
    })
    if (!variant) throw new ApiError(404, 'Variant not found.')

    const attrs = JSON.parse(variant.attributeValues) as Record<string, string>

    // Determine parent attribute using the SHARED utility (same as the
    // variant-groups endpoint and the creation wizard).
    const attributeNames = Object.keys(attrs)
    const attributes = await db.orgAttribute.findMany({
      where: { organizationId: orgId, name: { in: attributeNames } },
      orderBy: { displayOrder: 'asc' },
    })
    if (attributes.length === 0) throw new ApiError(400, 'Cannot determine parent attribute.')
    const parentAttr = determineParentAttribute(
      attributes.map((a) => ({ attribute_id: a.id, name: a.name, display_order: a.displayOrder })),
    )
    if (!parentAttr) throw new ApiError(400, 'Cannot determine parent attribute.')
    const parentValue = attrs[parentAttr.name]

    // Find a sibling that's currently synced to get the current parent cost
    const siblings = await db.orgProductVariant.findMany({
      where: { productId, costPriceSyncedWithParent: true, id: { not: variantId } },
      select: { attributeValues: true, costPrice: true },
    })

    const syncedSibling = siblings.find((s) => {
      const sAttrs = JSON.parse(s.attributeValues) as Record<string, string>
      return sAttrs[parentAttr.name] === parentValue
    })

    if (!syncedSibling) {
      throw new ApiError(400, 'No synced siblings found. Set the parent group cost price first.')
    }

    const newCost = Number(syncedSibling.costPrice)
    await db.orgProductVariant.update({
      where: { id: variantId },
      data: { costPrice: newCost, costPriceSyncedWithParent: true },
    })

    await insertAuditLog({
      action: 'variant.cost_resynced',
      entityType: 'variant',
      entityId: variantId,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { costPrice: newCost, synced: true },
    })
    await insertMetricEvent({
      companyId: company.id,
      entityType: 'product',
      entityId: productId,
      metricKey: 'variant.cost_resynced',
      numericValue: 1,
      dimensions: { variant_id: variantId },
    })

    return Response.json({ success: true, cost_price: newCost })
  } catch (err) {
    return handleError(err)
  }
}
