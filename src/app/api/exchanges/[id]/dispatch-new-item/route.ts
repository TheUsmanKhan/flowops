import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { dispatchExchangeNewItem } from '@/lib/actions/exchange.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/exchanges/[id]/dispatch-new-item — courier_replacement: dispatch new item immediately. */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const result = await dispatchExchangeNewItem(id)
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed to dispatch new item')
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
