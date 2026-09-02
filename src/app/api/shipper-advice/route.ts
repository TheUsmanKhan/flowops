import { ApiError, handleError, readBody } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { sendShipperAdvice } from '@/lib/actions/shipper-advice.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/shipper-advice
 *
 * Submit shipper advice to Leopard for an order or exchange shipment.
 *
 * Body: { entityType: 'order'|'exchange_shipment', entityId, adviceType: 'RA'|'RT', notes?: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await readBody<Record<string, unknown>>(req)
    const entityType = body.entityType === 'exchange_shipment' ? 'exchange_shipment' : 'order'
    const entityId = String(body.entityId ?? '')
    const adviceType = String(body.adviceType ?? '')
    const notes = typeof body.notes === 'string' ? body.notes : undefined

    if (!entityId) throw new ApiError(400, 'entityId is required')
    if (!adviceType) throw new ApiError(400, 'adviceType is required')

    const result = await sendShipperAdvice(entityType, entityId, adviceType, notes)
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed')
    return Response.json({ ok: true })
  } catch (err) {
    return handleError(err)
  }
}
