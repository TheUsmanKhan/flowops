import { ApiError, handleError, readBody } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { removeCustomerPhone, setCustomerPhonePrimary } from '@/lib/actions/customer.actions'

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

/**
 * PATCH /api/customers/[id]/phones/[phoneId]
 *
 * CUS-013: previously, "set as primary" was implemented in the frontend as
 * DELETE the phone then POST it back with is_primary=true — losing the
 * original `createdAt` and any metadata. The PATCH endpoint now updates
 * `is_primary` in place (transactionally unsetting other primary phones on
 * the same customer).
 *
 * Currently only `is_primary` is supported (boolean). Other fields can be
 * added later (label, isValidFormat, etc.).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; phoneId: string }> },
) {
  try {
    const { phoneId } = await params
    const body = await readBody<Record<string, unknown>>(req)

    if (body && typeof body === 'object' && 'is_primary' in body) {
      if (body.is_primary !== true) {
        throw new ApiError(
          400,
          'PATCH /phones/[phoneId] currently only supports setting is_primary=true. To unset primary, set another phone as primary instead.',
        )
      }
      const result = await setCustomerPhonePrimary(phoneId)
      if (!result.success) {
        throw new ApiError(400, result.error ?? 'Failed to set primary phone')
      }
      return Response.json({ ok: true })
    }

    throw new ApiError(400, 'PATCH /phones/[phoneId] requires { is_primary: true }')
  } catch (err) {
    return handleError(err)
  }
}
