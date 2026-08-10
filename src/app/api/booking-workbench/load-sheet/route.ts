import { ApiError, handleError, readBody } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { generateLoadSheet } from '@/lib/actions/load-sheet.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/booking-workbench/load-sheet
 *
 * Generate a load sheet (pickup manifest) for a batch of orders and/or
 * exchange shipments. Courier-agnostic — dispatches to the adapter's
 * generateLoadSheet() based on providerKey.
 *
 * Body: {
 *   providerKey: string,
 *   entityRefs: Array<{ entityType: 'order'|'exchange_shipment', entityId: string }>,
 *   pickupAddressId?: string
 * }
 *
 * Response: { loadSheetId, pdfPath, itemCount }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await readBody<Record<string, unknown>>(req)
    const providerKey = typeof body.providerKey === 'string' ? body.providerKey : ''
    const pickupAddressId = typeof body.pickupAddressId === 'string' ? body.pickupAddressId : undefined
    const entityRefs = Array.isArray(body.entityRefs)
      ? body.entityRefs.map((e) => ({
          entityType: (e.entityType === 'exchange_shipment' ? 'exchange_shipment' : 'order') as 'order' | 'exchange_shipment',
          entityId: String(e.entityId ?? ''),
        }))
      : []

    if (!providerKey) throw new ApiError(400, 'providerKey is required')
    if (entityRefs.length === 0) throw new ApiError(400, 'At least one entity is required')

    const result = await generateLoadSheet(providerKey, entityRefs, pickupAddressId)
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed')
    return Response.json(result.data, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
