import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { generateStitchedSchema } from '@/lib/validations/product'
import {
  STITCHING_TYPES,
  STITCHING_SHORT,
  DEFAULT_PRODUCTION_DAYS,
} from '@/lib/constants/fulfillment-types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Generate stitched/unstitched variant combinations for a stitchable product.
 * Returns a preview array of variants — the UI shows these for review before
 * the user confirms and the product is created via /api/products POST.
 *
 * Logic:
 *   - If include_unstitched: 1 unstitched variant (stock_based, no stitching)
 *   - For each size × stitching_type: a made_to_order variant
 *   - SKU pattern: {slug}-{size}-{type_short} or {slug}-UN
 */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const body = await readBody(req)
    const parsed = generateStitchedSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    }
    const d = parsed.data

    const variants: Array<{
      sku: string
      attribute_values: Record<string, string>
      cost_price: number
      stitching_charges: number
      fulfillment_type: string
      stitching_type: string
      production_days: number
      requires_shipping: boolean
      allow_backorder: boolean
      is_default: boolean
    }> = []

    // 1. Unstitched variant (optional)
    if (d.include_unstitched) {
      variants.push({
        sku: `${d.product_slug}-UN`,
        attribute_values: { 'Piece Type': 'Unstitched', Size: 'Free Size' },
        cost_price: d.base_fabric_cost,
        stitching_charges: 0,
        fulfillment_type: 'stock_based',
        stitching_type: STITCHING_TYPES.UNSTITCHED,
        production_days: 0,
        requires_shipping: true,
        allow_backorder: false,
        is_default: true,
      })
    }

    // 2. Stitched variants: sizes × stitching_types
    const stitchingChargeMap: Record<string, number> = {
      stitched_basic: d.base_stitching,
      stitched_heavy: d.heavy_stitching,
      custom_order: d.custom_stitching,
    }

    for (const stType of d.stitching_types) {
      const charge = stitchingChargeMap[stType] ?? 0
      const pieceTypeLabel =
        stType === 'stitched_basic'
          ? 'Stitched'
          : stType === 'stitched_heavy'
            ? 'Stitched (Heavy Work)'
            : 'Custom Order'

      if (d.sizes.length === 0) {
        // No sizes → single stitched variant (Free Size)
        variants.push({
          sku: `${d.product_slug}-${STITCHING_SHORT[stType]}`,
          attribute_values: { 'Piece Type': pieceTypeLabel, Size: 'Free Size' },
          cost_price: d.base_fabric_cost + charge,
          stitching_charges: charge,
          fulfillment_type: 'made_to_order',
          stitching_type: stType,
          production_days: DEFAULT_PRODUCTION_DAYS[stType] ?? 5,
          requires_shipping: true,
          allow_backorder: false,
          is_default: !d.include_unstitched,
        })
      } else {
        for (const size of d.sizes) {
          variants.push({
            sku: `${d.product_slug}-${size}-${STITCHING_SHORT[stType]}`,
            attribute_values: { 'Piece Type': pieceTypeLabel, Size: size },
            cost_price: d.base_fabric_cost + charge,
            stitching_charges: charge,
            fulfillment_type: 'made_to_order',
            stitching_type: stType,
            production_days: DEFAULT_PRODUCTION_DAYS[stType] ?? 5,
            requires_shipping: true,
            allow_backorder: false,
            is_default: false,
          })
        }
      }
    }

    return Response.json({ variants })
  } catch (err) {
    return handleError(err)
  }
}
