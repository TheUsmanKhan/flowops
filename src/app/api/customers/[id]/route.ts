import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { getCustomerDetail } from '@/lib/actions/customer.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/customers/[id]
 *
 * Returns the full customer record + all phones (primary first) + all
 * addresses (default first, then by lastUsedAt desc) + external identities
 * (Shopify/Daraz/Instagram mappings) + recent order history (most recent
 * first, showing order number, date, status, total, recipient name, and
 * which saved address/phone was used).
 *
 * Delegates to the getCustomerDetail server action which enforces
 * organization-scoped access via getWorkspace().
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
