import { ApiError, handleError, readBody } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { getCustomerDetail, updateCustomer } from '@/lib/actions/customer.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/customers/[id]
 *
 * Returns the full customer record + all phones (primary first) + all
 * addresses (default first, then by lastUsedAt desc) + external identities
 * + recent order history.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const result = await getCustomerDetail(id)
    if (!result.success) {
      throw new ApiError(404, result.error ?? 'Customer not found')
    }
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}

/** PATCH /api/customers/[id] — update customer name/email. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await readBody<Record<string, unknown>>(req)
    const result = await updateCustomer({
      customer_id: id,
      name: typeof body.name === 'string' ? body.name : undefined,
      email: typeof body.email === 'string' ? body.email : undefined,
    })
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to update customer')
    }
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
