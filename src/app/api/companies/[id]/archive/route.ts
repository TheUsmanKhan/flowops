import { getCurrentUser } from '@/lib/session'
import { db } from '@/lib/db'
import { archiveSchema } from '@/lib/validations/organization'
import { insertAuditLog } from '@/lib/audit'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { buildSessionPayload } from '@/lib/session-payload'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Archive a company (owner only, requires name confirmation).
 * - Sets company.isActive = false
 * - Terminates all active employees (revokes access)
 * - Clears active workspace if it pointed at this company
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const body = await readBody(req)
    const parsed = archiveSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    }
    const { id: companyId, confirmation_text } = parsed.data

    const company = await db.company.findFirst({
      where: { id: companyId, isActive: true },
      include: {
        organization: { select: { ownerId: true } },
        _count: { select: { employees: { where: { status: 'active' } } } },
      },
    })
    if (!company) throw new ApiError(404, 'Company not found.')
    // Only the org owner can archive a company.
    if (company.organization.ownerId !== user.id) {
      throw new ApiError(403, 'Only the organization owner can archive a company.')
    }
    if (confirmation_text !== company.name) {
      throw new ApiError(400, 'The typed name does not match the company name.')
    }

    const affectedEmployees = company._count.employees

    // Terminate all active employees.
    await db.employee.updateMany({
      where: { companyId: company.id, status: 'active' },
      data: {
        status: 'terminated',
        terminatedAt: new Date(),
        terminatedById: user.id,
        terminationReason: 'Company archived',
      },
    })

    await db.company.update({ where: { id: company.id }, data: { isActive: false } })

    // Clear active workspace if it pointed here.
    await db.userSetting.updateMany({
      where: { userId: user.id, activeCompanyId: company.id },
      data: { activeCompanyId: null, activeOrgId: null },
    })

    await insertAuditLog({
      action: 'company.archived',
      entityType: 'company',
      entityId: company.id,
      companyId: company.id,
      organizationId: company.organizationId,
      userId: user.id,
      oldValues: { name: company.name, employeesAffected: affectedEmployees },
    })

    return Response.json(await buildSessionPayload(user.id))
  } catch (err) {
    return handleError(err)
  }
}
