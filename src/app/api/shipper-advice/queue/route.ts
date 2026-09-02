import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { listNeedsShipperAdvice } from '@/lib/actions/shipper-advice.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/shipper-advice/queue
 *
 * Returns all orders + exchange shipments that currently need shipper advice
 * (needsShipperAdvice=true) across both PostEx (read-only) and Leopard (with Respond).
 */
export async function GET(_req: NextRequest) {
  try {
    const result = await listNeedsShipperAdvice()
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed')
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
