import { handleError } from '@/lib/workspace'
import { getOwnAdvances } from '@/lib/actions/advance.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/advances/own
 * Returns the current employee's own advances (active + settled history).
 * No special permission needed — identity check only. This is transparency,
 * not a sensitive permission-gated figure like salary/commission.
 */
export async function GET() {
  try {
    const result = await getOwnAdvances()
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
