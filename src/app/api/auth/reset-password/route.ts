import { getCurrentUser } from '@/lib/session'
import { db } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Reset password for the currently-authenticated user (recovery flow).
 * In production this would verify the OTP token via Supabase; here the
 * user is already session-authenticated when they click the email link,
 * so we update the password directly and audit it.
 */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) {
      return Response.json({ error: 'Session expired. Please restart the flow.' }, { status: 401 })
    }
    const body = await readBody<{ password?: string }>(req)
    if (!body.password || body.password.length < 8) {
      return Response.json({ error: 'Password must be at least 8 characters.' }, { status: 400 })
    }
    await db.profile.update({
      where: { id: user.id },
      data: { passwordHash: hashPassword(body.password) },
    })
    insertAuditLog({
      action: 'auth.password_reset',
      entityType: 'user',
      entityId: user.id,
      userId: user.id,
    })
    return Response.json({ ok: true })
  } catch (err) {
    return handleError(err)
  }
}
