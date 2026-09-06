import { NextRequest } from 'next/server'
import { handleError, readBody } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/exchange-shipments/[id]/dispatch — dispatch with tracking + courier */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await readBody<{ trackingNumber: string; courierCompanyIntegrationId: string }>(req)
    const { dispatchExchangeShipment } = await import('@/lib/actions/exchange-shipment.actions')
    const result = await dispatchExchangeShipment(id, body.trackingNumber, body.courierCompanyIntegrationId)
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json(result.data ?? { success: true })
  } catch (err) {
    return handleError(err)
  }
}
