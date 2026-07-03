import { db } from '@/lib/db'
import { handleError, readBody } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Password recovery request.
 *
 * NOTE: The sandbox has no outbound SMTP and Supabase Auth is unreachable
 * for password resets via the pooler, so this endpoint does NOT actually
 * send email. It records the request and returns success — the UI shows
 * a "check your email" confirmation. In production this would call
 * supabase.auth.resetPasswordForEmail(email, { redirectTo }).
 */
export async function POST(req: Request) {
  try {
    const body = await readBody<{ email?: string }>(req)
    if (!body.email) return Response.json({ ok: true })
    // Don't leak whether the email exists.
    await db.profile.findUnique({ where: { email: body.email.toLowerCase() } })
    return Response.json({ ok: true })
  } catch (err) {
    return handleError(err)
  }
}
