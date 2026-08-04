import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
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
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    if (caller.role.roleTier !== 'elevated') {
      throw new ApiError(403, 'Only elevated roles can trigger polling.')
    }

    const result = await pollPostExOrderStatuses()
    return Response.json(result)
  } catch (err) {
    return handleError(err)
  }
}
