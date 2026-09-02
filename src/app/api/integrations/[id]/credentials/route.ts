import { ApiError, handleError, readBody } from '@/lib/workspace'
import { NextRequest } from 'next/server'
import { updateIntegrationCredentials } from '@/lib/actions/integration.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** PATCH /api/integrations/[id]/credentials — update credentials */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await readBody<Record<string, unknown>>(req)
    const result = await updateIntegrationCredentials(
      id,
      (body.credentials as Record<string, string>) ?? {},
    )
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed')
    return Response.json({ ok: true })
  } catch (err) {
    return handleError(err)
  }
}
