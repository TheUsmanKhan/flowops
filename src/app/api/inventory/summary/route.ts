import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { getProductInventorySummary } from '@/lib/inventory'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Get inventory summary for a product.
 * GET /api/inventory/summary?product_id=xxx
 *
 * Returns per-variant: total on_hand/reserved/available across all locations,
 * per-location breakdown, total stock value, and track_inventory flag.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')

    const url = new URL(req.url)
    const productId = url.searchParams.get('product_id')
    if (!productId) throw new ApiError(400, 'product_id query parameter is required.')

    const summary = await getProductInventorySummary(productId)
    return Response.json({ variants: summary })
  } catch (err) {
    return handleError(err)
  }
}
