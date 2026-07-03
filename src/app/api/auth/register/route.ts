import { db } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/session'
import { registerSchema } from '@/lib/validations/auth'
import { insertAuditLog } from '@/lib/audit'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { cookies } from 'next/headers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const body = await readBody(req)
    const parsed = registerSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    }
    const { fullName, email, password } = parsed.data

    const existing = await db.profile.findUnique({ where: { email } })
    if (existing) {
      throw new ApiError(409, 'An account with this email already exists.')
    }

    const profile = await db.profile.create({
      data: {
        email,
        fullName,
        passwordHash: hashPassword(password),
      },
    })

    await db.userSetting.create({
      data: { userId: profile.id, theme: 'system', language: 'en' },
    })

    await insertAuditLog({
      action: 'auth.registered',
      entityType: 'user',
      entityId: profile.id,
      userId: profile.id,
      newValues: { email, fullName },
    })

    const token = createSessionToken(profile.id)
    const store = await cookies()
    store.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE,
    })

    return Response.json({
      user: {
        id: profile.id,
        email: profile.email,
        fullName: profile.fullName,
        avatarUrl: profile.avatarUrl,
        phone: profile.phone,
        isOnboarded: profile.isOnboarded,
        createdAt: profile.createdAt.toISOString(),
      },
      activeCompany: null,
      companies: [],
      employee: null,
    })
  } catch (err) {
    return handleError(err)
  }
}
