import { getCurrentUser } from '@/lib/session'
import { db } from '@/lib/db'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface SelectedAttribute {
  attribute_id: string
  attribute_name: string
  display_order: number
  selected_values: Array<{
    value_id: string
    value: string
    display_value: string
    sku_code: string | null
  }>
}

/**
 * Generate variant combinations from selected attributes.
 * Pure calculation — does NOT write to database.
 *
 * Applies attribute_value_rules during generation (prevention, not post-filter):
 * if a trigger value is in the combination, the forced attribute MUST equal
 * the forced value — invalid combinations are never generated.
 *
 * SKU concatenation order follows each attribute's display_order (ascending).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    await params

    const body = await readBody<{
      product_slug: string
      base_sku?: string
      selected_attributes?: SelectedAttribute[]
    }>(req)

    const selectedAttrs = body.selected_attributes ?? []

    // Enforce Shopify max-3-attributes limit
    if (selectedAttrs.length > 3) {
      return Response.json(
        {
          error: 'MAX_3_ATTRIBUTES_EXCEEDED',
          message: `You selected ${selectedAttrs.length} attributes. Shopify allows a maximum of 3 per product.`,
        },
        { status: 400 },
      )
    }

    if (selectedAttrs.length === 0) {
      return Response.json({ combinations: [] })
    }

    // Fetch attribute_value_rules for this org
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const orgId = settings?.activeOrgId
    if (!orgId) throw new ApiError(403, 'No active organization')

    const rules = await db.attributeValueRule.findMany({
      where: { organizationId: orgId },
      include: {
        triggerAttributeValue: { select: { id: true } },
        forcesAttribute: { select: { id: true, name: true } },
        forcesValue: { select: { id: true, value: true } },
      },
    })

    // Sort attributes by display_order for SKU concatenation order
    const sortedAttrs = [...selectedAttrs].sort((a, b) => a.display_order - b.display_order)

    // Build arrays for cartesian product
    const arrays = sortedAttrs.map((attr) =>
      attr.selected_values.map((v) => ({
        attribute_id: attr.attribute_id,
        attribute_name: attr.attribute_name,
        value_id: v.value_id,
        value: v.value,
        display_value: v.display_value,
        sku_code: v.sku_code,
      })),
    )

    const rawCombinations = cartesianProduct(arrays)

    // Filter combinations using rules (prevention at generation time)
    const validCombinations = rawCombinations.filter((combo) => {
      for (const rule of rules) {
        // Does this combo include the trigger value?
        const hasTrigger = combo.some((part) => part.value_id === rule.triggerAttributeValueId)
        if (!hasTrigger) continue

        // Find the forced attribute's value in this combo
        const forcedPart = combo.find((part) => part.attribute_id === rule.forcesAttributeId)
        if (!forcedPart) continue // forced attribute not in this product's selection — skip rule

        // The forced attribute's value MUST equal the forced value
        if (forcedPart.value_id !== rule.forcesValueId) {
          return false // INVALID combination — skip it
        }
      }
      return true
    })

    // Build the final combinations with suggested SKUs
    const combinations = validCombinations.map((combo) => {
      const attributeValues: Record<string, string> = {}
      const codeParts: string[] = []

      // combo is already in display_order (sortedAttrs order)
      for (const part of combo) {
        attributeValues[part.attribute_name] = part.value
        const code = part.sku_code || part.display_value.toUpperCase().replace(/\s+/g, '')
        codeParts.push(code)
      }

      const skuPrefix = (body.base_sku || body.product_slug).toUpperCase().replace(/[^A-Z0-9-]/g, '')
      const suggestedSku = `${skuPrefix}-${codeParts.join('-')}`.slice(0, 100)

      // Determine fulfillment type based on Piece Type value (generic — checks for "stitched" in any value)
      let suggestedFulfillmentType = 'stock_based'
      const pieceTypeValue = attributeValues['Piece Type']
      if (pieceTypeValue) {
        const lower = pieceTypeValue.toLowerCase()
        if (lower.includes('stitched') && !lower.includes('unstitched')) {
          suggestedFulfillmentType = 'made_to_order'
        }
      }

      return {
        attribute_values: attributeValues,
        suggested_sku: suggestedSku,
        suggested_fulfillment_type: suggestedFulfillmentType,
      }
    })

    return Response.json({ combinations })
  } catch (err) {
    return handleError(err)
  }
}

/** Cartesian product helper. */
function cartesianProduct<T>(arrays: T[][]): T[][] {
  if (arrays.length === 0) return [[]]
  const [first, ...rest] = arrays
  const restProduct = cartesianProduct(rest)
  const result: T[][] = []
  for (const item of first) {
    for (const combo of restProduct) {
      result.push([item, ...combo])
    }
  }
  return result
}
