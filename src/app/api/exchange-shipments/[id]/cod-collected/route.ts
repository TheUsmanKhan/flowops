import { NextRequest } from 'next/server'
import { handleError, readBody } from '@/lib/workspace'
import { markExchangeShipmentCodCollected } from '@/lib/actions/exchange-shipment.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/exchange-shipments/[id]/cod-collected — record COD collection */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await readBody<{ collected_amount?: number }>(req).catch(() => ({ collected_amount: undefined }))
    const result = await markExchangeShipmentCodCollected(id, body.collected_amount)
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
