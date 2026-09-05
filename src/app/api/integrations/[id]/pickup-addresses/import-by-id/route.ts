import { NextRequest } from 'next/server'
import { handleError, readBody } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/integrations/[id]/pickup-addresses/import-by-id
 *
 * Import a single shipper by shipment_id (Leopard-specific).
 * Calls getShipperDetails, finds the matching shipper, saves it locally.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await readBody<{ shipment_id: string }>(req)

    if (!body.shipment_id) {
      return Response.json(
        { error: 'shipment_id is required' },
        { status: 400 },
      )
    }

    const { importPickupAddressById } = await import('@/lib/actions/courier-address-book.actions')
    const result = await importPickupAddressById(id, body.shipment_id)
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json(result.data, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
