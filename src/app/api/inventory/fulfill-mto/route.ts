import { ApiError, getWorkspace, handleError, readBody, requirePermission } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'
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
 *
 * PO-001 fix: previously this route used the legacy `getCurrentUser()`
 * pattern with no permission check, AND trusted `company_id` from the
 * request body — any authenticated user could trigger MTO for ANY
 * company. Now uses `getWorkspace()` (resolves company from session) +
 * `requirePermission(INVENTORY_MANAGE_PRODUCTION)`. The Zod schema no
 * longer accepts `company_id`; the caller's active company is used.
 */
export async function POST(req: Request) {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.INVENTORY_MANAGE_PRODUCTION)

    const body = await readBody(req)
    const parsed = fulfillMadeToOrderSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')

    // PO-001: derive company from session (ctx.company.id), NEVER from body
    const result = await checkAndFulfillMadeToOrderVariant(
      parsed.data.org_variant_id,
      parsed.data.quantity,
      ctx.company.id,
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
