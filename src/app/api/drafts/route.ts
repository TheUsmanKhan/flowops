import { ApiError, handleError } from '@/lib/workspace'
import { listDrafts, countDrafts, deleteDraft, getDraft } from '@/lib/actions/drafts/save-draft'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/drafts?draftType=product|order&scope=mine|all&mode=count
 *  GET /api/drafts?id=draftId  (fetch single draft for resume)
 *
 * DRAFT EXPIRY: on every list/count request, lazily deletes drafts older
 * than 30 days. This prevents abandoned drafts from accumulating in the
 * DB forever (a draft is a temporary work-in-progress, not a permanent
 * record). The delete is non-blocking (fire-and-forget) — the list
 * returns immediately with whatever drafts exist at query time.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const id = url.searchParams.get('id')

    // Single draft fetch (for resume/edit flow)
    if (id) {
      const result = await getDraft(id)
      if (!result.success) throw new ApiError(404, result.error ?? 'Draft not found')
      return Response.json(result.data)
    }

    // List/count drafts
    const draftType = url.searchParams.get('draftType') as 'product' | 'order' | null
    const scope = url.searchParams.get('scope') as 'mine' | 'all' | null
    const mode = url.searchParams.get('mode')

    if (!draftType) throw new ApiError(400, 'draftType is required (or provide id for single draft)')

    // ── Lazy cleanup: delete drafts older than 30 days ──
    // Fire-and-forget (no await) so the response isn't delayed.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    db.formDraft.deleteMany({
      where: { updatedAt: { lt: thirtyDaysAgo } },
    }).catch(() => {/* non-fatal */})

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
