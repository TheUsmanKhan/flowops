import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { listLoadSheetReady } from '@/lib/actions/load-sheet.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/booking-workbench/load-sheet-ready?companyIntegrationId=...
 *
 * Returns orders AND exchange shipments ready for load sheet generation
 * for the specified courier integration:
 *   - courierBookingStatus='booked'
 *   - courierSubStatus='slip_generated'
 *   - loadSheetId IS NULL
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const companyIntegrationId = url.searchParams.get('companyIntegrationId')
    if (!companyIntegrationId) {
      throw new ApiError(400, 'companyIntegrationId query parameter is required')
    }
    const result = await listLoadSheetReady(companyIntegrationId)
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed')
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
