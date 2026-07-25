import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { dispatchOrderAction } from '@/lib/actions/order.actions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Dispatch an order. Deducts stock, sets tracking info, blocks if any items
 * are still backordered. Used by the ready-to-dispatch queue (single or bulk).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const { id } = await params
    const body = await readBody<{
      tracking_number?: string
      courier_name?: string
    }>(req)

    const trackingNumber = (body.tracking_number ?? '').trim()
    if (!trackingNumber) {
      throw new ApiError(400, 'Tracking number is required')
    }

    const result = await dispatchOrderAction(
      id,
      trackingNumber,
      body.courier_name?.trim() || undefined,
    )
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to dispatch order')
    }
    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
