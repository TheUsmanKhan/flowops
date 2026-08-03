import { NextRequest } from 'next/server'
import { handleError, readBody } from '@/lib/workspace'
import { setDefaultPickupAddress } from '@/lib/actions/courier-address-book.actions'
import { deletePickupAddress } from '@/lib/actions/courier-address-book.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * PATCH /api/integrations/[id]/pickup-addresses/[addressId]
 * Body: { action: 'set-default' }
 *
 * Sets the given address as the default for its integration.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; addressId: string }> },
) {
  try {
    const { id, addressId } = await params
    const body = await readBody<{ action?: string }>(req).catch(() => ({ action: undefined }))

    if (body.action === 'set-default') {
      const result = await setDefaultPickupAddress(id, addressId)
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 })
      }
      return Response.json({ success: true })
    }

    return Response.json({ error: 'Unknown action. Use { action: "set-default" }.' }, { status: 400 })
  } catch (err) {
    return handleError(err)
  }
}

/** DELETE /api/integrations/[id]/pickup-addresses/[addressId] — delete address */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; addressId: string }> },
) {
  try {
    const { addressId } = await params
    const result = await deletePickupAddress(addressId)
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
