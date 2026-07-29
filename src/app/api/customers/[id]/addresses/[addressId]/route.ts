import { ApiError, handleError, readBody } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { updateCustomerAddress, removeCustomerAddress } from '@/lib/actions/customer.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** PATCH /api/customers/[id]/addresses/[addressId] — update an address. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; addressId: string }> },
) {
  try {
    const { addressId } = await params
    const body = await readBody<Record<string, unknown>>(req)
    const result = await updateCustomerAddress(addressId, {
      label: typeof body.label === 'string' ? body.label : undefined,
      address: typeof body.address === 'string' ? body.address : '',
      city: typeof body.city === 'string' ? body.city : '',
      is_default: body.is_default === true,
    })
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to update address')
    }
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}

/** DELETE /api/customers/[id]/addresses/[addressId] — remove an address. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; addressId: string }> },
) {
  try {
    const { addressId } = await params
    const result = await removeCustomerAddress(addressId)
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to remove address')
    }
    return Response.json({ ok: true })
  } catch (err) {
    return handleError(err)
  }
}
