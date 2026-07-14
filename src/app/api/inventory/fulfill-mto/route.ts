import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { checkAndFulfillMadeToOrderVariant } from '@/lib/inventory'
import { fulfillMadeToOrderSchema } from '@/lib/validations/inventory'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Check and fulfill a made-to-order variant.
 * The central decision function:
 *   1. Checks if returned stock is available → uses existing stock
 *   2. If not → creates a production order + consumes fabric
 *
 * This will be called by the future Order system (Sprint 3).
 */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')

    const body = await readBody(req)
    const parsed = fulfillMadeToOrderSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')

    const result = await checkAndFulfillMadeToOrderVariant(
      parsed.data.org_variant_id,
      parsed.data.quantity,
      parsed.data.company_id,
      parsed.data.preferred_location_id,
    )

    if (result.error) {
      return Response.json({ success: false, error: result.error }, { status: 400 })
    }

    return Response.json({ success: true, ...result })
  } catch (err) {
    return handleError(err)
  }
}
