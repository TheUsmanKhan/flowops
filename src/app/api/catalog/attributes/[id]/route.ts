import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { attributeSchema } from '@/lib/validations/product'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(
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
    const orgId = settings?.activeOrgId
    const company = settings?.activeCompany
    if (!orgId || !company) throw new ApiError(403, 'No active organization')

    const caller = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.PRODUCTS_MANAGE_CATALOG },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to manage catalog.')

    const { id } = await params
    const attr = await db.orgAttribute.findFirst({ where: { id, organizationId: orgId } })
    if (!attr) throw new ApiError(404, 'Attribute not found.')

    const body = await readBody(req)
    const parsed = attributeSchema.partial().safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')

    const updated = await db.orgAttribute.update({
      where: { id },
      data: {
        ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
        ...(parsed.data.attributeType ? { attributeType: parsed.data.attributeType } : {}),
        ...(parsed.data.displayOrder !== undefined ? { displayOrder: parsed.data.displayOrder } : {}),
        ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
      },
    })

    await insertAuditLog({
      action: 'attribute.updated',
      entityType: 'attribute',
      entityId: id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: parsed.data,
    })

    return Response.json({ id: updated.id })
  } catch (err) {
    return handleError(err)
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const orgId = settings?.activeOrgId
    const company = settings?.activeCompany
    if (!orgId || !company) throw new ApiError(403, 'No active organization')

    const caller = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    if (caller.role.roleTier !== 'elevated') {
      throw new ApiError(403, 'Only elevated employees can delete attributes.')
    }

    const { id } = await params
    const attr = await db.orgAttribute.findFirst({ where: { id, organizationId: orgId } })
    if (!attr) throw new ApiError(404, 'Attribute not found.')

    // Cascade deletes attribute values automatically.
    await db.orgAttribute.delete({ where: { id } })

    await insertAuditLog({
      action: 'attribute.deleted',
      entityType: 'attribute',
      entityId: id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues: { name: attr.name },
    })

    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
