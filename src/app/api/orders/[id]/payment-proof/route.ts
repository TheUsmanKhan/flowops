import { getWorkspace, ApiError, handleError, readBody } from '@/lib/workspace'
import { updatePaymentScreenshot } from '@/lib/actions/order.actions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/orders/[id]/payment-proof
 *
 * Attach (or clear) a payment proof screenshot URL on an existing order.
 *
 * Use cases:
 *   1. Order creation flow — the screenshot file is held in browser memory
 *      during the single-page form (no order_id yet). After createManualOrder
 *      returns the new order_id, the client uploads the file to
 *      /api/upload?type=payment-proofs&id={orderId} and then calls this
 *      endpoint with the returned { url }.
 *   2. Order detail page — "Add payment proof" affordance for orders
 *      created without a screenshot (or whose original upload failed).
 *
 * Body: { advance_payment_screenshot_url: string }
 *   - Pass an empty string to CLEAR an existing screenshot.
 *   - Pass a valid URL (typically /uploads/payment-proofs/...) to attach.
 *
 * Does NOT change payment_type, payment_status, or advance_amount. If the
 * order is still COD-pending (no advance recorded), the convert-payment
 * endpoint should be used instead.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getWorkspace()
    if (!ctx) throw new ApiError(401, 'Not authenticated')
    const { id } = await params

    const body = await readBody<{ advance_payment_screenshot_url?: string }>(req)

    const result = await updatePaymentScreenshot({
      order_id: id,
      advance_payment_screenshot_url: body.advance_payment_screenshot_url ?? '',
    })

    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to update payment proof')
    }

    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
