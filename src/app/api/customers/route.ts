import { ApiError, handleError } from '@/lib/workspace'
import { listCustomers } from '@/lib/actions/customer.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/customers
 * Search customers by phone / name / email for the active organization.
 * Supports: search, is_flagged, limit, offset.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const search = url.searchParams.get('search') ?? ''
    const isFlagged = url.searchParams.get('is_flagged')
    const limit = url.searchParams.get('limit')
      ? Number(url.searchParams.get('limit'))
      : undefined
    const offset = url.searchParams.get('offset')
      ? Number(url.searchParams.get('offset'))
      : undefined

    const result = await listCustomers({
      search: search || undefined,
      isFlagged:
        isFlagged === 'true' ? true : isFlagged === 'false' ? false : undefined,
      limit,
      offset,
    })

    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to list customers')
    }
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
