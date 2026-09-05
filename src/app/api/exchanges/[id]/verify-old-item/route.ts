import { ApiError, handleError, readBody } from '@/lib/workspace'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/exchanges/[id]/verify-old-item — manually verify old item received (the gating point). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { verifyOldItemReceived } = await import('@/lib/actions/exchange.actions')
    const body = await readBody<Record<string, unknown>>(req)
    const result = await verifyOldItemReceived({
      exchange_id: id,
      condition: body.condition as 'perfect' | 'good' | 'open_box' | 'damaged',
      evidence_urls: Array.isArray(body.evidence_urls) ? (body.evidence_urls as string[]) : [],
      notes: typeof body.notes === 'string' ? body.notes : undefined,
    })
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed to verify old item')
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
