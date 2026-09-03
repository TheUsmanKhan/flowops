import { NextRequest } from 'next/server'
import { ApiError, handleError } from '@/lib/workspace'
import { refreshAllPickupAddresses } from '@/lib/actions/courier-address-book.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/integrations/[id]/pickup-addresses/refresh
 *
 * Re-fetches each EXISTING locally-stored shipper's details from the
 * courier's API (Leopard: getShipperDetails by shipment_id) and updates
 * the local record if anything changed (name, address, phone, city).
 *
 * This is DIFFERENT from sync:
 *   - Sync   = fetch ALL remote shippers, import new ones + update existing
 *   - Refresh = only update shippers ALREADY in the local address book
 *
 * Use Import by ID to add new shippers. Use Refresh to check for changes
 * (e.g. shipper updated their phone number on Leopard's side).
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const result = await refreshAllPickupAddresses(id)
    if (!result.success) throw new ApiError(400, result.error ?? 'Refresh failed')
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
