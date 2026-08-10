import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { listLoadSheetHistory } from '@/lib/actions/load-sheet.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/booking-workbench/load-sheets
 *
 * Returns previously generated load sheets for this company (History section).
 * Most recent first, default limit 20.
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const limitParam = url.searchParams.get('limit')
    const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 20, 100) : 20

    const result = await listLoadSheetHistory(limit)
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed')
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
