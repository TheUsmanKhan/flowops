import { ApiError, handleError } from '@/lib/workspace'
import { listDrafts, countDrafts, deleteDraft } from '@/lib/actions/drafts/save-draft'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/drafts?draftType=product|order&scope=mine|all&mode=count */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const draftType = url.searchParams.get('draftType') as 'product' | 'order' | null
    const scope = url.searchParams.get('scope') as 'mine' | 'all' | null
    const mode = url.searchParams.get('mode')

    if (!draftType) throw new ApiError(400, 'draftType is required')

    if (mode === 'count') {
      const result = await countDrafts({ draftType, scope: scope ?? undefined })
      if (!result.success) throw new ApiError(400, result.error ?? 'Failed')
      return Response.json(result.data)
    }

    const result = await listDrafts({ draftType, scope: scope ?? undefined })
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed')
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}

/** DELETE /api/drafts?id=draftId */
export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) throw new ApiError(400, 'id is required')

    const result = await deleteDraft(id)
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed')
    return Response.json({ ok: true })
  } catch (err) {
    return handleError(err)
  }
}
