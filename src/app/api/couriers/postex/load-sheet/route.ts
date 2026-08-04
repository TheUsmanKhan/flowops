import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { generatePostExLoadSheet } from '@/lib/actions/postex-status-poll.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/couriers/postex/load-sheet
 * Body: { companyIntegrationId: string, trackingNumbers: string[], pickupAddress?: string }
 *
 * Generates a PostEx load sheet (pickup manifest) for a batch of tracking numbers.
 * Can be called manually from a "Generate Load Sheet" button.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const body = await readBody<{
      companyIntegrationId: string
      trackingNumbers: string[]
      pickupAddress?: string
    }>(req)

    if (!body.companyIntegrationId || !body.trackingNumbers || body.trackingNumbers.length === 0) {
      return Response.json(
        { error: 'companyIntegrationId and trackingNumbers are required' },
        { status: 400 },
      )
    }

    const result = await generatePostExLoadSheet(
      body.companyIntegrationId,
      body.trackingNumbers,
      body.pickupAddress,
    )

    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
