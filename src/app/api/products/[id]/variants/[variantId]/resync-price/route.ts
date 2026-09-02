import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { determineParentAttribute } from '@/lib/utils/variant-grouping'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Re-sync a child's sale/compare price with its parent group.
 *  Uses CompanyVariantPricing (per-company pricing) — no market scoping. */
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
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.PRODUCTS_PRICING },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to set pricing.')

    const body = await readBody<{ field: 'sale_price' | 'compare_price' }>(req)
    const field = body.field

    // Fetch this variant + its attrs
    const variant = await db.orgProductVariant.findFirst({
      where: { id: variantId, productId },
      select: { id: true, attributeValues: true },
    })
    if (!variant) throw new ApiError(404, 'Variant not found.')

    const attrs = JSON.parse(variant.attributeValues) as Record<string, string>

    // Determine parent attribute using the SHARED utility
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

    // Find a synced sibling's pricing (for this company)
    const siblings = await db.orgProductVariant.findMany({
      where: { productId, id: { not: variantId } },
      select: {
        id: true,
        attributeValues: true,
        companyPricing: { where: { companyId: company.id } },
      },
    })

    const syncedSibling = siblings.find((s) => {
      const sAttrs = JSON.parse(s.attributeValues) as Record<string, string>
      if (sAttrs[parentAttr.name] !== parentValue) return false
      const p = s.companyPricing[0]
      if (!p) return false
      return field === 'sale_price' ? p.salePriceSyncedWithParent : p.comparePriceSyncedWithParent
    })

    if (!syncedSibling || !syncedSibling.companyPricing[0]) {
      throw new ApiError(400, `No synced siblings found for ${field}. Set the parent group price first.`)
    }

    const siblingPricing = syncedSibling.companyPricing[0]
    const newValue = field === 'sale_price' ? Number(siblingPricing.salePrice) : (siblingPricing.comparePrice ? Number(siblingPricing.comparePrice) : null)

    // Fetch this variant's pricing (for this company)
    const pricing = await db.companyVariantPricing.findUnique({
      where: { companyId_orgVariantId: { companyId: company.id, orgVariantId: variantId } },
    })
    if (!pricing) throw new ApiError(404, 'Pricing record not found.')

    const updateData: Record<string, unknown> = {}
    if (field === 'sale_price') {
      updateData.salePrice = newValue
      updateData.salePriceSyncedWithParent = true
    } else {
      updateData.comparePrice = newValue
      updateData.comparePriceSyncedWithParent = true
    }

    await db.companyVariantPricing.update({ where: { id: pricing.id }, data: updateData })

    insertAuditLog({
      action: 'variant.price_resynced',
      entityType: 'variant',
      entityId: variantId,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { field, value: newValue, synced: true },
    })
    insertMetricEvent({
      companyId: company.id,
      entityType: 'product',
      entityId: productId,
      metricKey: 'variant.price_resynced',
      numericValue: 1,
      dimensions: { variant_id: variantId },
    })

    return Response.json({ success: true, [field]: newValue })
  } catch (err) {
    return handleError(err)
  }
}
