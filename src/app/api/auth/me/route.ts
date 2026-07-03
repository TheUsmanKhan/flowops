import { getCurrentUser } from '@/lib/session'
import { buildSessionPayload } from '@/lib/session-payload'
import { handleError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) {
      return Response.json({ user: null, activeCompany: null, companies: [], employee: null })
    }
    return Response.json(await buildSessionPayload(user.id))
  } catch (err) {
    return handleError(err)
  }
}
