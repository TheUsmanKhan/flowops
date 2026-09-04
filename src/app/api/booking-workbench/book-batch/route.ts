import { NextRequest } from 'next/server'
import { db } from '@/lib/db'

import { ApiError, handleError, readBody, getWorkspace } from '@/lib/workspace'
import { bookOrdersBatch } from '@/lib/actions/booking.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface BookBatchBody {
  companyIntegrationId: string
  items: Array<{
    entityType: 'order' | 'exchange_shipment'
    entityId: string
    customerName?: string
    customerPhone?: string
    deliveryAddress?: string
    deliveryCity?: string
    codAmount?: number
    orderType?: string
    transactionNotes?: string
    itemDescription?: string
    orderRefNumber?: string
  }>
}

/**
 * POST /api/booking-workbench/book-batch
 *
 * Books multiple orders AND/OR exchange shipments in a single batch API call.
 * Used by the Booking Workbench when the selected courier supports batch
 * booking (e.g. Leopard's batchBookPacketsv2).
 *
 * Each item independently indicates success/failure — partial failures are
 * handled gracefully.
 *
 * Response: { success, data: { results: [{entityType, entityId, success, trackingNumber?, error?}] } }
 */
export async function POST(req: NextRequest) {
  try {
    const ctx = await getWorkspace()
    const companyId = ctx.company.id
    const caller = ctx.employee

    if (caller.role.roleTier !== 'elevated') {
      throw new ApiError(403, 'Only elevated roles can book shipments.')
    }

    const body = await readBody<BookBatchBody>(req)
    if (!body.companyIntegrationId) {
      throw new ApiError(400, 'companyIntegrationId is required')
    }
    if (!body.items || body.items.length === 0) {
      throw new ApiError(400, 'At least one item is required')
    }

    const result = await bookOrdersBatch(body.companyIntegrationId, body.items)
    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Batch booking failed')
    }

    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
