import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Mark a supplier return as disputed. */
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

    const { id } = await params
    const record = await db.supplierReturn.findFirst({ where: { id, companyId } })
    if (!record) throw new ApiError(404, 'Supplier return not found.')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_MANAGE_SUPPLIER_RETURNS },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to manage supplier returns.')

    const body = await readBody<{ notes?: string }>(req)

    await db.supplierReturn.update({
      where: { id },
      data: {
        status: 'disputed',
        notes: body.notes ? `${record.notes || ''}\n[Disputed] ${body.notes}` : record.notes,
        resolvedById: caller.id,
        resolvedAt: new Date(),
      },
    })

    await insertAuditLog({
      action: 'supplier_return.disputed',
      entityType: 'supplier_return',
      entityId: id,
      companyId,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { status: 'disputed', notes: body.notes },
    })

    await insertMetricEvent({
      companyId,
      entityType: 'supplier',
      entityId: record.supplierId,
      metricKey: 'supplier_return.disputed',
      numericValue: Number(record.costPerUnit) * record.quantity,
      dimensions: { became_loss: true },
    })

    return Response.json({ success: true, status: 'disputed' })
  } catch (err) {
    return handleError(err)
  }
}
