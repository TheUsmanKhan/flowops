import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import {
  determineParentAttribute,
  groupVariantsByParentAttribute,
  type GroupableAttribute,
  type GroupableVariant,
} from '@/lib/utils/variant-grouping'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Group variants by parent attribute (lowest display_order among used attributes).
 * Returns the grouped structure for the ParentChildVariantTable component.
 *
 * The "which attribute is the parent" and "how variants group" decisions
 * are delegated to the shared pure functions in
 * /lib/utils/variant-grouping.ts — the SAME functions the client-side
 * wizard uses — so the edit page and the creation wizard can never
 * disagree on grouping.
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
      return Response.json({ parentAttributeName: null, parentAttributeDisplayName: null, groups: [], hasMultipleAttributes: false })
    }

    // Determine which attributes are used across all variants
    const attributeNames = new Set<string>()
    for (const v of variants) {
      const attrs = JSON.parse(v.attributeValues) as Record<string, string>
      for (const k of Object.keys(attrs)) attributeNames.add(k)
    }

    // Fetch attribute metadata to find display_order + displayName
    const attributes = await db.orgAttribute.findMany({
      where: { organizationId: orgId, name: { in: Array.from(attributeNames) } },
      orderBy: { displayOrder: 'asc' },
    })

    if (attributes.length === 0) {
      return Response.json({ parentAttributeName: null, parentAttributeDisplayName: null, groups: [], hasMultipleAttributes: false })
    }

    // ── Use the SHARED grouping utility (same as the creation wizard) ──
    const groupableAttrs: GroupableAttribute[] = attributes.map((a) => ({
      attribute_id: a.id,
      name: a.name,
      display_order: a.displayOrder,
    }))
    const parentAttr = determineParentAttribute(groupableAttrs)

    // Map DB variants to the GroupableVariant shape for the utility
    const groupableVariants: Array<GroupableVariant & {
      dbVariant: typeof variants[number]
      attrs: Record<string, string>
      pricing: typeof variants[number]['companyPricing'][number] | undefined
    }> = variants.map((v) => {
      const attrs = JSON.parse(v.attributeValues) as Record<string, string>
      return { id: v.id, attribute_values: attrs, dbVariant: v, attrs, pricing: v.companyPricing[0] }
    })

    const grouping = groupVariantsByParentAttribute(groupableVariants, parentAttr?.name ?? null)

    // hasMultipleAttributes in the old response shape = hasMeaningfulGrouping
    const hasMultipleAttributes = grouping.hasMeaningfulGrouping

    // Find the displayName for the parent attribute (if any)
    const parentAttrRecord = parentAttr
      ? attributes.find((a) => a.name === parentAttr.name)
      : null

    return Response.json({
      parentAttributeName: grouping.parentAttributeName,
      parentAttributeDisplayName: parentAttrRecord?.displayName ?? null,
      hasMultipleAttributes,
      groups: grouping.groups.map((g) => ({
        parentValue: g.parentValue,
        childCount: g.children.length,
        children: g.children.map((item) => ({
          variantId: item.dbVariant.id,
          sku: item.dbVariant.sku,
          attributeValues: item.attrs,
          costPrice: Number(item.dbVariant.costPrice),
          costPriceSyncedWithParent: item.dbVariant.costPriceSyncedWithParent,
          fulfillmentType: item.dbVariant.fulfillmentType,
          trackInventory: item.dbVariant.trackInventory,
          isActive: item.dbVariant.isActive,
          salePrice: item.pricing ? Number(item.pricing.salePrice) : null,
          comparePrice: item.pricing?.comparePrice ? Number(item.pricing.comparePrice) : null,
          salePriceSyncedWithParent: item.pricing?.salePriceSyncedWithParent ?? true,
          comparePriceSyncedWithParent: item.pricing?.comparePriceSyncedWithParent ?? true,
          pricingId: item.pricing?.id ?? null,
        })),
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}
