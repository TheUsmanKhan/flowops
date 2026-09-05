import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/integrations/[id]/disconnect — deactivate an integration */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    // Dynamic import — integration.actions has heavy transitive deps
    const { disconnectIntegration } = await import('@/lib/actions/integration.actions')
    const result = await disconnectIntegration(id)
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed')
    return Response.json({ ok: true })
  } catch (err) {
    return handleError(err)
  }
}
