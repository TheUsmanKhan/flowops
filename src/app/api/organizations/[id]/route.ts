import { getCurrentUser } from '@/lib/session'
import { db } from '@/lib/db'
import { updateOrganizationSchema, archiveSchema } from '@/lib/validations/organization'
import { insertAuditLog } from '@/lib/audit'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { buildSessionPayload } from '@/lib/session-payload'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Update organization profile (owner only). */
export async function PATCH(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const body = await readBody(req)
    const parsed = updateOrganizationSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    }
    const d = parsed.data

    const org = await db.organization.findFirst({
      where: { id: d.org_id, ownerId: user.id },
    })
    if (!org) throw new ApiError(404, 'Organization not found or you are not the owner.')

    const oldValues = {
      name: org.name,
      logoUrl: org.logoUrl,
    }

    const updated = await db.organization.update({
      where: { id: org.id },
      data: {
        ...(d.name ? { name: d.name } : {}),
        ...(d.website !== undefined ? { } : {}),
        ...(d.logoUrl !== undefined ? { logoUrl: d.logoUrl || null } : {}),
      },
    })

    // Store description + website in metadata JSONB.
    if (d.description !== undefined || d.website !== undefined) {
      const meta = org.metadata ? safeParse(org.metadata) : {}
      if (d.description !== undefined) meta.description = d.description || ''
      if (d.website !== undefined) meta.website = d.website || ''
      await db.organization.update({
        where: { id: org.id },
        data: { metadata: JSON.stringify(meta) },
      })
    }

    insertAuditLog({
      action: 'organization.updated',
      entityType: 'organization',
      entityId: org.id,
      organizationId: org.id,
      userId: user.id,
      oldValues,
      newValues: d,
    })

    return Response.json(await buildSessionPayload(user.id))
  } catch (err) {
    return handleError(err)
  }
}

/** Archive an organization (owner only, requires name confirmation). */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const body = await readBody(req)
    const parsed = archiveSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    }
    const { id: orgId, confirmation_text } = parsed.data

    const org = await db.organization.findFirst({
      where: { id: orgId, ownerId: user.id },
      include: { _count: { select: { companies: { where: { isActive: true } } } } },
    })
    if (!org) throw new ApiError(404, 'Organization not found or you are not the owner.')
    if (confirmation_text !== org.name) {
      throw new ApiError(400, 'The typed name does not match the organization name.')
    }

    // Archive all active companies in this org, then the org itself.
    const companies = await db.company.findMany({
      where: { organizationId: org.id, isActive: true },
      select: { id: true },
    })
    for (const c of companies) {
      await db.employee.updateMany({
        where: { companyId: c.id, status: 'active' },
        data: { status: 'terminated', terminatedAt: new Date(), terminatedById: user.id, terminationReason: 'Company archived' },
      })
      await db.company.update({ where: { id: c.id }, data: { isActive: false } })
    }
    await db.organization.update({ where: { id: org.id }, data: { isActive: false } })

    // Clear active workspace if it pointed at this org.
    await db.userSetting.updateMany({
      where: { userId: user.id, activeOrgId: org.id },
      data: { activeCompanyId: null, activeOrgId: null },
    })

    insertAuditLog({
      action: 'organization.archived',
      entityType: 'organization',
      entityId: org.id,
      organizationId: org.id,
      userId: user.id,
      oldValues: { name: org.name, companiesAffected: companies.length },
    })

    return Response.json(await buildSessionPayload(user.id))
  } catch (err) {
    return handleError(err)
  }
}

function safeParse(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) } catch { return {} }
}
