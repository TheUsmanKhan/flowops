import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { confirmOrder } from '@/lib/actions/order.actions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Confirm a pending order (triggers stock reservation). */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const { id } = await params
    const result = await confirmOrder(id)
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to confirm order')
    }
    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
