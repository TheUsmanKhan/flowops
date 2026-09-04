import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, handleError, getWorkspace } from '@/lib/workspace'
import { pollPostExOrderStatuses } from '@/lib/actions/postex-status-poll.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/couriers/postex/poll
 *
 * Manually triggers the PostEx status polling job. Intended for:
 *   - Manual refresh when staff wants the latest courier statuses.
 *   - The scheduled 30-minute job (when infrastructure scheduling is connected).
 *
 * Elevated-only (involves making API calls with stored credentials).
 */
export async function POST(_req: NextRequest) {
  try {
    const ctx = await getWorkspace()
    const companyId = ctx.company.id
    const caller = ctx.employee
    if (caller.role.roleTier !== 'elevated') {
      throw new ApiError(403, 'Only elevated roles can trigger polling.')
    }

    const result = await pollPostExOrderStatuses()
    return Response.json(result)
  } catch (err) {
    return handleError(err)
  }
}
