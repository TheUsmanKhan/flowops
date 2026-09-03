import { getCurrentUser } from '@/lib/session'
import { insertAuditLog } from '@/lib/audit'
import { handleError, clearAllCaches } from '@/lib/workspace'
import { SESSION_COOKIE } from '@/lib/session'
import { cookies } from 'next/headers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    const user = await getCurrentUser()
    if (user) {
      insertAuditLog({
        action: 'auth.logout',
        entityType: 'user',
        entityId: user.id,
        userId: user.id,
      })
      // Clear the workspace + role-permissions caches so the next login
      // starts fresh (no stale company/role data from the previous session).
      clearAllCaches()
    }
    const store = await cookies()
    store.delete(SESSION_COOKIE)
    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
