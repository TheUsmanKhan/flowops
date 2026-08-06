import { db } from '@/lib/db'
import { verifyPassword } from '@/lib/auth'
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/session'
import { loginSchema } from '@/lib/validations/auth'
import { insertAuditLog } from '@/lib/audit'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { buildSessionPayload } from '@/lib/session-payload'
import { cookies } from 'next/headers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const body = await readBody(req)
    const parsed = loginSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    }
    const { email, password } = parsed.data

    const profile = await db.profile.findUnique({ where: { email } })
    if (!profile || !verifyPassword(password, profile.passwordHash)) {
      throw new ApiError(401, 'Invalid email or password.')
    }

    const token = createSessionToken(profile.id)
    const store = await cookies()
    store.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'none',
      secure: false,
      path: '/',
      maxAge: SESSION_MAX_AGE,
    })

    await insertAuditLog({
      action: 'auth.login',
      entityType: 'user',
      entityId: profile.id,
      userId: profile.id,
    })

    const payload = await buildSessionPayload(profile.id)
    // Return the session token in the JSON body so the frontend can store it
    // in localStorage and send it as a Bearer token. This is CRITICAL for
    // iframe/preview-panel contexts where cookies don't work reliably.
    return Response.json({ ...payload, sessionToken: token })
  } catch (err) {
    return handleError(err)
  }
}
