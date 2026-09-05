import { NextRequest } from 'next/server'
import { handleError, readBody } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/scan — process a barcode scan or confirm a sub-action */
export async function POST(req: NextRequest) {
  try {
    const body = await readBody<{
      trackingNumber?: string
      scanMode?: string
      scanStationLabel?: string
      action?: 'confirm_unpack' | 'confirm_cancel'
      entityType?: string
      entityId?: string
    }>(req)

    // Lazy-load scan actions to avoid heavy top-level import on Hostinger
    const { processScan, confirmPhysicalUnpack, confirmCancelAfterScan } = await import('@/lib/actions/scan.actions')

    if (body.action === 'confirm_unpack' && body.entityType && body.entityId) {
      const result = await confirmPhysicalUnpack(body.entityType as 'order' | 'exchange_shipment', body.entityId)
      if (!result.success) return Response.json({ error: result.error }, { status: 400 })
      return Response.json({ success: true })
    }

    if (body.action === 'confirm_cancel' && body.entityType && body.entityId) {
      const result = await confirmCancelAfterScan(body.entityType as 'order' | 'exchange_shipment', body.entityId)
      if (!result.success) return Response.json({ error: result.error }, { status: 400 })
      return Response.json({ success: true })
    }

    if (!body.trackingNumber || !body.scanMode) {
      return Response.json({ error: 'trackingNumber and scanMode are required' }, { status: 400 })
    }

    const result = await processScan(body.trackingNumber, body.scanMode as any, body.scanStationLabel)
    if (!result.success) return Response.json({ error: result.error }, { status: 400 })
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
