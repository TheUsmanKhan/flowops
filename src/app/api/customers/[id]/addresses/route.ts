import { ApiError, handleError, readBody } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { addCustomerAddress } from '@/lib/actions/customer.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/customers/[id]/addresses — add an address to a customer. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await readBody<Record<string, unknown>>(req)
    const result = await addCustomerAddress(id, {
      label: typeof body.label === 'string' ? body.label : undefined,
      address: typeof body.address === 'string' ? body.address : '',
      city: typeof body.city === 'string' ? body.city : '',
      is_default: body.is_default === true,
    })
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to add address')
    }
    return Response.json(result.data, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
