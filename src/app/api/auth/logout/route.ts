import { getCurrentUser } from '@/lib/session'
import { insertAuditLog } from '@/lib/audit'
import { handleError } from '@/lib/workspace'
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
    }
    const store = await cookies()
    store.delete(SESSION_COOKIE)
    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
