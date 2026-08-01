import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { setDefaultIntegration } from '@/lib/actions/integration.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/integrations/[id]/set-default — set as default for its category */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const result = await setDefaultIntegration(id)
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed')
    return Response.json({ ok: true })
  } catch (err) {
    return handleError(err)
  }
}
