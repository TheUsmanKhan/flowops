import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { selectiveAccessSchema } from '@/lib/validations/product'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Grant selective access to a company.
 * GUARD: elevated only.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const companyId = settings?.activeCompanyId
    const orgId = settings?.activeOrgId
    if (!companyId || !orgId) throw new ApiError(403, 'No active company')

    const { id: productId } = await params
    const product = await db.orgProduct.findFirst({
      where: { id: productId, organizationId: orgId, sourceCompanyId: companyId },
    })
    if (!product) throw new ApiError(404, 'Product not found or you are not the owner.')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    if (caller.role.roleTier !== 'elevated') {
      throw new ApiError(403, 'Only elevated employees can grant selective access.')
    }

    const body = await readBody(req)
    const parsed = selectiveAccessSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')

    await db.selectiveProductAccess.upsert({
      where: { orgProductId_companyId: { orgProductId: productId, companyId: parsed.data.company_id } },
      update: {},
      create: {
        orgProductId: productId,
        companyId: parsed.data.company_id,
        organizationId: orgId,
        grantedById: caller.id,
      },
    })

    insertAuditLog({
      action: 'product.selective_access_granted',
      entityType: 'product',
      entityId: productId,
      companyId,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { grantedTo: parsed.data.company_id },
    })
    insertMetricEvent({
      companyId,
      entityType: 'product',
      entityId: productId,
      metricKey: 'product.selective_access_granted',
      numericValue: 1,
      dimensions: { company_id: parsed.data.company_id },
    })

    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}

/**
 * Revoke selective access from a company.
 * GUARD: elevated only.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const companyId = settings?.activeCompanyId
    const orgId = settings?.activeOrgId
    if (!companyId || !orgId) throw new ApiError(403, 'No active company')

    const { id: productId } = await params
    const product = await db.orgProduct.findFirst({
      where: { id: productId, organizationId: orgId, sourceCompanyId: companyId },
    })
    if (!product) throw new ApiError(404, 'Product not found or you are not the owner.')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    if (caller.role.roleTier !== 'elevated') {
      throw new ApiError(403, 'Only elevated employees can revoke selective access.')
    }

    const url = new URL(req.url)
    const targetCompanyId = url.searchParams.get('company_id')
    if (!targetCompanyId) throw new ApiError(400, 'company_id query parameter is required.')

    await db.selectiveProductAccess.deleteMany({
      where: { orgProductId: productId, companyId: targetCompanyId },
    })

    insertAuditLog({
      action: 'product.selective_access_revoked',
      entityType: 'product',
      entityId: productId,
      companyId,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues: { revokedFrom: targetCompanyId },
    })
    insertMetricEvent({
      companyId,
      entityType: 'product',
      entityId: productId,
      metricKey: 'product.selective_access_revoked',
      numericValue: 1,
      dimensions: { company_id: targetCompanyId },
    })

    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
