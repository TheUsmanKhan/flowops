import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/courier-status-history?entityType=order&entityId=...
 *
 * Returns the courier status history for a specific entity (order or
 * exchange_shipment) in chronological order (most recent first).
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')

    const url = new URL(req.url)
    const entityType = url.searchParams.get('entityType')
    const entityId = url.searchParams.get('entityId')

    if (!entityType || !entityId) {
      throw new ApiError(400, 'entityType and entityId query parameters are required')
    }

    const history = await db.courierStatusHistory.findMany({
      where: { entityType, entityId },
      orderBy: { receivedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        providerKey: true,
        rawStatus: true,
        courierSubStatus: true,
        courierActivityDate: true,
        receivedAt: true,
        source: true,
        metadata: true,
      },
    })

    return Response.json({ history })
  } catch (err) {
    return handleError(err)
  }
}
