import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Group variants by parent attribute (lowest display_order among used attributes).
 * Returns the grouped structure for the ParentChildVariantTable component.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const orgId = settings?.activeOrgId
    const companyId = settings?.activeCompanyId
    if (!orgId) throw new ApiError(403, 'No active organization')

    const { id: productId } = await params
    const product = await db.orgProduct.findFirst({ where: { id: productId, organizationId: orgId } })
    if (!product) throw new ApiError(404, 'Product not found.')

    // Fetch all variants
    const variants = await db.orgProductVariant.findMany({
      where: { productId },
      include: {
        companyPricing: { where: { companyId: companyId ?? undefined } },
      },
      orderBy: { createdAt: 'asc' },
    })

    if (variants.length === 0) {
      return Response.json({ parentAttributeName: null, groups: [], hasMultipleAttributes: false })
    }

    // Determine which attributes are used across all variants
    const attributeNames = new Set<string>()
    for (const v of variants) {
      const attrs = JSON.parse(v.attributeValues) as Record<string, string>
      for (const k of Object.keys(attrs)) attributeNames.add(k)
    }

    // Fetch attribute metadata to find display_order
    const attributes = await db.orgAttribute.findMany({
      where: { organizationId: orgId, name: { in: Array.from(attributeNames) } },
      orderBy: { displayOrder: 'asc' },
    })

    if (attributes.length === 0) {
      return Response.json({ parentAttributeName: null, groups: [], hasMultipleAttributes: false })
    }

    // Parent attribute = lowest display_order
    const parentAttr = attributes[0]
    const hasMultipleAttributes = attributes.length > 1

    // Group variants by parent attribute value
    const groupMap = new Map<string, { parentValue: string; children: typeof variants }>()

    for (const v of variants) {
      const attrs = JSON.parse(v.attributeValues) as Record<string, string>
      const parentValue = attrs[parentAttr.name] ?? '—'
      let group = groupMap.get(parentValue)
      if (!group) {
        group = { parentValue, children: [] }
        groupMap.set(parentValue, group)
      }
      group.children.push(v)
    }

    return Response.json({
      parentAttributeName: parentAttr.name,
      parentAttributeDisplayName: parentAttr.displayName,
      hasMultipleAttributes,
      groups: Array.from(groupMap.values()).map((g) => ({
        parentValue: g.parentValue,
        childCount: g.children.length,
        children: g.children.map((v) => {
          const attrs = JSON.parse(v.attributeValues) as Record<string, string>
          const pricing = v.companyPricing[0]
          return {
            variantId: v.id,
            sku: v.sku,
            attributeValues: attrs,
            costPrice: Number(v.costPrice),
            costPriceSyncedWithParent: v.costPriceSyncedWithParent,
            fulfillmentType: v.fulfillmentType,
            isActive: v.isActive,
            salePrice: pricing ? Number(pricing.salePrice) : null,
            comparePrice: pricing?.comparePrice ? Number(pricing.comparePrice) : null,
            salePriceSyncedWithParent: pricing?.salePriceSyncedWithParent ?? true,
            comparePriceSyncedWithParent: pricing?.comparePriceSyncedWithParent ?? true,
            pricingId: pricing?.id ?? null,
          }
        }),
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}
