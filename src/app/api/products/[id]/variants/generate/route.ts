import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { generateCombinationsSchema } from '@/lib/validations/product'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Generate variant combinations from selected attributes.
 * Pure calculation — does NOT write to database.
 *
 * Takes the cartesian product of all selected attribute values.
 * If is_stitchable and "Piece Type" attribute is included with
 * "Unstitched"/"Stitched" values, auto-assigns fulfillment_type.
 *
 * Max 3 attributes enforced (Shopify limit).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')

    await params // productId (unused — slug comes in the body)

    const body = await readBody(req)
    const parsed = generateCombinationsSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    }
    const d = parsed.data

    // Enforce Shopify max-3-attributes limit
    if (d.selected_attributes.length > 3) {
      return Response.json(
        {
          error: 'MAX_3_ATTRIBUTES_EXCEEDED',
          message: `You selected ${d.selected_attributes.length} attributes. Shopify allows a maximum of 3 per product.`,
        },
        { status: 400 },
      )
    }

    // Build the cartesian product of selected values
    const arrays = d.selected_attributes.map((attr) =>
      attr.selected_values.map((v) => ({
        attribute_name: attr.attribute_name,
        value: v.value,
        display_value: v.display_value,
      })),
    )

    const cartesian = cartesianProduct(arrays)

    // Build combinations with suggested SKU + fulfillment type
    const combinations = cartesian.map((combo) => {
      const attributeValues: Record<string, string> = {}
      const codeParts: string[] = []

      for (const part of combo) {
        attributeValues[part.attribute_name] = part.value
        codeParts.push(part.display_value.toUpperCase().replace(/\s+/g, ''))
      }

      const suggestedSku = `${d.product_slug}-${codeParts.join('-')}`

      // Auto-assign fulfillment type for stitchable products
      let suggestedFulfillmentType = 'stock_based'
      if (d.is_stitchable) {
        const pieceType = attributeValues['Piece Type'] ?? attributeValues['piece type']
        if (pieceType && pieceType.toLowerCase().includes('stitched') && !pieceType.toLowerCase().includes('unstitched')) {
          suggestedFulfillmentType = 'made_to_order'
        } else {
          suggestedFulfillmentType = 'stock_based'
        }
      }

      return {
        attribute_values: attributeValues,
        suggested_sku: suggestedSku.slice(0, 100),
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
