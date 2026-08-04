import { NextRequest } from 'next/server'
import { handleError } from '@/lib/workspace'
import { reserveExchangeShipmentStock } from '@/lib/actions/exchange-shipment.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/exchange-shipments/[id]/reserve — reserve stock for an exchange shipment */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const result = await reserveExchangeShipmentStock(id)
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
