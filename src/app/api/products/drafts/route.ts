import { ApiError, handleError, readBody } from '@/lib/workspace'
import { saveProductDraft } from '@/lib/actions/drafts/save-draft'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /api/products/drafts — save a product form draft */
export async function POST(req: Request) {
  try {
    const body = await readBody<Record<string, unknown>>(req)
    const result = await saveProductDraft({
      draftId: typeof body.draftId === 'string' ? body.draftId : undefined,
      draftData: (body.draftData as Record<string, unknown>) ?? {},
      draftTitle: typeof body.draftTitle === 'string' ? body.draftTitle : undefined,
    })
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed to save draft')
    return Response.json(result.data, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
