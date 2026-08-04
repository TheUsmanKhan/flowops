import { NextRequest } from 'next/server'
import { handleError, readBody } from '@/lib/workspace'
import { cancelExchangeShipment } from '@/lib/actions/exchange-shipment.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/exchange-shipments/[id]/cancel */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await readBody<{ reason: string }>(req)
    const result = await cancelExchangeShipment(id, body.reason ?? 'Cancelled by staff')
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
