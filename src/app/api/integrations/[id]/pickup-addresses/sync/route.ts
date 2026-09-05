import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/integrations/[id]/pickup-addresses/sync
 *
 * Fetches all pickup/return addresses from the courier's API and upserts
 * them into the local courier_pickup_addresses table. This is the primary
 * way to import addresses that already exist on the courier's side (e.g.
 * addresses created directly in the PostEx merchant dashboard).
 *
 * On the first sync (no local addresses yet), the first remote address
 * is auto-set as the default.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { syncPickupAddresses } = await import('@/lib/actions/courier-address-book.actions')
    const result = await syncPickupAddresses(id)
    if (!result.success) throw new ApiError(400, result.error ?? 'Sync failed')
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
