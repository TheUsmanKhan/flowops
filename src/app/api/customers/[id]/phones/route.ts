import { ApiError, handleError, readBody } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { addCustomerPhone } from '@/lib/actions/customer.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/customers/[id]/phones — add a phone to a customer. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await readBody<Record<string, unknown>>(req)
    const result = await addCustomerPhone(id, {
      phone: typeof body.phone === 'string' ? body.phone : '',
      label: typeof body.label === 'string' ? body.label : undefined,
      is_primary: body.is_primary === true,
    })
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to add phone')
    }
    return Response.json(result.data, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
