import { ApiError, handleError } from '@/lib/workspace'
import { db } from '@/lib/db'
import { updateCustomerStats } from '@/lib/actions/customer.actions'
import { getWorkspace, requirePermission } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/customers/backfill-stats
 *
 * One-time backfill: iterates all customers in the active organization and
 * recomputes their cached stats (totalOrdersCount, totalOrderValue,
 * totalRtoCount) by calling updateCustomerStats() for each.
 *
 * Required because existing customers have stale cached stats from before
 * updateCustomerStats() was wired into every order lifecycle hook.
 *
 * Returns { processed, updated, errors }.
 */
export async function POST() {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const customers = await db.customer.findMany({
      where: { organizationId: ctx.company.organizationId },
      select: { id: true, name: true, totalOrdersCount: true, totalRtoCount: true },
    })

    let processed = 0
    let updated = 0
    const errors: Array<{ customerId: string; error: string }> = []

    for (const c of customers) {
      processed++
      const result = await updateCustomerStats(c.id)
      if (result.success) {
        updated++
      } else {
        errors.push({ customerId: c.id, error: result.error ?? 'Unknown error' })
      }
    }

    return Response.json({
      success: true,
      processed,
      updated,
      errors,
    })
  } catch (err) {
    return handleError(err)
  }
}
