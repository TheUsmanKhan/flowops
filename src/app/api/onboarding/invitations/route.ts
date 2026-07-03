import { getCurrentUser } from '@/lib/session'
import { db } from '@/lib/db'
import { ApiError, handleError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Fetch pending invitations for the current user's email. */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')

    const invitations = await db.invitation.findMany({
      where: {
        invitedEmail: user.email,
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
      include: {
        role: { select: { id: true, name: true } },
        company: { select: { id: true, name: true, logoUrl: true } },
        invitedBy: { select: { id: true, fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    return Response.json({
      invitations: invitations.map((i) => ({
        id: i.id,
        token: i.token,
        invitedEmail: i.invitedEmail,
        status: i.status,
        message: i.message,
        expiresAt: i.expiresAt.toISOString(),
        createdAt: i.createdAt.toISOString(),
        role: i.role,
        company: i.company,
        invitedBy: i.invitedBy,
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}
