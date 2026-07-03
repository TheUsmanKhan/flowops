import { getCurrentUser } from '@/lib/session'
import { buildSessionPayload } from '@/lib/session-payload'
import { db } from '@/lib/db'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const body = await readBody<{ companyId?: string }>(req)
    const companyId = body.companyId
    if (!companyId) throw new ApiError(400, 'companyId is required')

    const employee = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
    })
    if (!employee) {
      throw new ApiError(403, 'You are not a member of that company.')
    }
    const company = await db.company.findUnique({ where: { id: companyId } })
    if (!company || !company.isActive) {
      throw new ApiError(403, 'Company unavailable.')
    }

    await db.userSetting.update({
      where: { userId: user.id },
      data: {
        activeCompanyId: companyId,
        activeOrgId: company.organizationId,
      },
    })

    await insertAuditLog({
      action: 'workspace.switched',
      entityType: 'company',
      entityId: companyId,
      companyId,
      organizationId: company.organizationId,
      userId: user.id,
      employeeId: employee.id,
      newValues: { companyId, organizationId: company.organizationId },
    })

    const payload = await buildSessionPayload(user.id)
    return Response.json({
      activeCompany: payload.activeCompany,
      employee: payload.employee,
    })
  } catch (err) {
    return handleError(err)
  }
}

export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const payload = await buildSessionPayload(user.id)
    return Response.json({ companies: payload.companies })
  } catch (err) {
    return handleError(err)
  }
}
