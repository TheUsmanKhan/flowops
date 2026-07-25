import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { convertPaymentStatus } from '@/lib/actions/order.actions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Convert a COD order's payment status to partial_advance or fully_prepaid.
 * Payment conversion acts as a confirmation signal for pending orders.
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
      new_payment_type: 'partial_advance' | 'fully_prepaid'
      advance_amount?: number
      advance_payment_method?: string
      advance_payment_reference?: string
      advance_payment_screenshot_url?: string
    }>(req)

    const result = await convertPaymentStatus({
      order_id: id,
      new_payment_type: body.new_payment_type,
      advance_amount: body.advance_amount,
      advance_payment_method: body.advance_payment_method,
      advance_payment_reference: body.advance_payment_reference,
      advance_payment_screenshot_url: body.advance_payment_screenshot_url,
    })
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to convert payment')
    }
    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
