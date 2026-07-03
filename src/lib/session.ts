import crypto from 'crypto'
import { cookies } from 'next/headers'
import { db } from './db'

/**
 * Lightweight signed-cookie session (HMAC).
 * The sandbox cannot reach Supabase Auth, so we implement a minimal,
 * secure session: the cookie carries `userId.timestamp.hmac` and is
 * verified server-side. This mirrors the Supabase Auth contract used
 * by the rest of the app (getCurrentUser / requireUser).
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

/** Read & verify the session cookie; returns the userId or null. */
export async function getSessionUserId(): Promise<string | null> {
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
