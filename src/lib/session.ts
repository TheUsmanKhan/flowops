import crypto from 'crypto'
import { cookies, headers } from 'next/headers'
import { db } from './db'

/**
 * Lightweight signed-token session (HMAC).
 *
 * The token carries `userId.timestamp.hmac` and is verified server-side.
 *
 * DUAL-CHANNEL AUTH:
 *   1. Cookie-based: Set as an HttpOnly cookie on login (works for same-origin)
 *   2. Header-based: Sent via `Authorization: Bearer <token>` header (works
 *      for ALL contexts — iframes, cross-origin, preview panels, mobile apps)
 *
 * The server checks BOTH channels: first the Authorization header, then the
 * cookie. This means the frontend can store the token in localStorage AND
 * send it as a Bearer token, completely bypassing all cookie/SameSite/iframe
 * restrictions while still maintaining cookie-based auth as a fallback.
 */

const COOKIE_NAME = 'flowops_session'
const SECRET =
  process.env.SESSION_SECRET || 'flowops-dev-secret-change-in-production-32b'
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export function createSessionToken(userId: string): string {
  const payload = `${userId}.${Date.now()}`
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex')
  return `${payload}.${sig}`
}

export function verifySessionToken(token: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [userId, ts, sig] = parts
  if (!userId || !ts || !sig) return null
  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(`${userId}.${ts}`)
    .digest('hex')
  if (sig.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null
  }
  const tsNum = Number(ts)
  if (!Number.isFinite(tsNum)) return null
  if (Date.now() - tsNum > MAX_AGE_MS) return null
  return userId
}

export const SESSION_COOKIE = COOKIE_NAME
export const SESSION_MAX_AGE = MAX_AGE_MS / 1000

/**
 * Read & verify the session token from EITHER:
 *   1. Authorization: Bearer <token> header (preferred — works everywhere)
 *   2. flowops_session cookie (fallback — works for same-origin)
 *
 * Returns the userId or null.
 */
export async function getSessionUserId(): Promise<string | null> {
  // ── Channel 1: Authorization header ──
  const hdrs = await headers()
  const authHeader = hdrs.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7)
    const userId = verifySessionToken(token)
    if (userId) return userId
  }

  // ── Channel 2: Cookie (fallback) ──
  const store = await cookies()
  const token = store.get(COOKIE_NAME)?.value
  if (!token) return null
  return verifySessionToken(token)
}

/** Returns the current authenticated profile, or null. */
export async function getCurrentUser() {
  const userId = await getSessionUserId()
  if (!userId) return null
  return db.profile.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      fullName: true,
      avatarUrl: true,
      phone: true,
      isOnboarded: true,
      createdAt: true,
    },
  })
}

/** Throws/redirects-free variant: returns the user or null. */
export type SessionUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>
