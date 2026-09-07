import { ApiError, handleError, getWorkspace, requirePermission } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'
import { NextRequest } from 'next/server'
import { getExchangeDetail } from '@/lib/actions/exchange.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/exchanges/[id] — full exchange detail. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_VIEW)

    const { id } = await params
    const result = await getExchangeDetail(id)
    if (!result.success) throw new ApiError(404, result.error ?? 'Exchange not found')
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
