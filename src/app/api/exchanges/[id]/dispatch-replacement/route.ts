import { NextRequest } from 'next/server'
import { handleError } from '@/lib/workspace'
import { dispatchReplacementForSelfReturnExchange } from '@/lib/actions/exchange.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/exchanges/[id]/dispatch-replacement — Send Replacement Order for customer_self_return */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const result = await dispatchReplacementForSelfReturnExchange(id)
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json(result.data, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
