import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { removeCustomerPhone } from '@/lib/actions/customer.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** DELETE /api/customers/[id]/phones/[phoneId] — remove a phone. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; phoneId: string }> },
) {
  try {
    const { phoneId } = await params
    const result = await removeCustomerPhone(phoneId)
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to remove phone')
    }
    return Response.json({ ok: true })
  } catch (err) {
    return handleError(err)
  }
}
