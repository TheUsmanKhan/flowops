import { getCurrentUser } from '@/lib/session'
import { db } from '@/lib/db'
import { acceptInviteSchema } from '@/lib/validations/invitation'
import { insertAuditLog } from '@/lib/audit'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { buildSessionPayload } from '@/lib/session-payload'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const body = await readBody(req)
    const parsed = acceptInviteSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid token')
    }
    const { token } = parsed.data

    const invitation = await db.invitation.findUnique({
      where: { token },
      include: { role: true, company: true },
    })
    if (!invitation) throw new ApiError(404, 'Invitation not found.')
    if (invitation.status !== 'pending') {
      throw new ApiError(400, `Invitation is already ${invitation.status}.`)
    }
    if (invitation.expiresAt < new Date()) {
      await db.invitation.update({
        where: { id: invitation.id },
        data: { status: 'expired' },
      })
      throw new ApiError(410, 'This invitation has expired.')
    }
    if (invitation.invitedEmail.toLowerCase() !== user.email.toLowerCase()) {
      throw new ApiError(403, 'This invitation was sent to a different email.')
    }

    // Sequential operations (avoids interactive-transaction issues with the
    // Supabase pooled connection).
    const existing = await db.employee.findUnique({
      where: { companyId_userId: { companyId: invitation.companyId, userId: user.id } },
    })
    let employee
    if (existing) {
      employee = await db.employee.update({
        where: { id: existing.id },
        data: {
          roleId: invitation.roleId,
          status: 'active',
          terminatedAt: null,
          terminatedById: null,
          terminationReason: null,
          invitedById: invitation.invitedById,
          joinedAt: new Date(),
        },
      })
    } else {
      employee = await db.employee.create({
        data: {
          companyId: invitation.companyId,
          userId: user.id,
          roleId: invitation.roleId,
          status: 'active',
          invitedById: invitation.invitedById,
        },
      })
    }

    await db.invitation.update({
      where: { id: invitation.id },
      data: {
        status: 'accepted',
        acceptedById: user.id,
        acceptedAt: new Date(),
      },
    })

    await db.userSetting.upsert({
      where: { userId: user.id },
      update: {
        activeCompanyId: invitation.companyId,
        activeOrgId: invitation.organizationId,
      },
      create: {
        userId: user.id,
        activeCompanyId: invitation.companyId,
        activeOrgId: invitation.organizationId,
      },
    })
    await db.profile.update({
      where: { id: user.id },
      data: { isOnboarded: true },
    })

    const result = { employee, company: invitation.company, role: invitation.role }

    insertAuditLog({
      action: 'invitation.accepted',
      entityType: 'invitation',
      entityId: invitation.id,
      companyId: invitation.companyId,
      organizationId: invitation.organizationId,
      userId: user.id,
      employeeId: result.employee.id,
      newValues: { role: result.role.name },
    })
    insertAuditLog({
      action: 'employee.joined',
      entityType: 'employee',
      entityId: result.employee.id,
      companyId: invitation.companyId,
      organizationId: invitation.organizationId,
      userId: user.id,
      employeeId: result.employee.id,
      newValues: { role: result.role.name, status: 'active', via: 'invitation' },
    })

    const payload = await buildSessionPayload(user.id)
    return Response.json(payload)
  } catch (err) {
    return handleError(err)
  }
}
