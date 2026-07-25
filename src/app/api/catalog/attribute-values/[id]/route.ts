import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { attributeValueSchema } from '@/lib/validations/product'
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
    const value = await db.orgAttributeValue.findFirst({ where: { id, organizationId: orgId } })
    if (!value) throw new ApiError(404, 'Attribute value not found.')

    const body = await readBody(req)
    const parsed = attributeValueSchema.partial().safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')

    const updated = await db.orgAttributeValue.update({
      where: { id },
      data: {
        ...(parsed.data.value ? { value: parsed.data.value } : {}),
        ...(parsed.data.displayValue ? { displayValue: parsed.data.displayValue } : {}),
        ...(parsed.data.colorHex !== undefined ? { colorHex: parsed.data.colorHex || null } : {}),
        ...(parsed.data.skuCode !== undefined ? { skuCode: parsed.data.skuCode || null } : {}),
        ...(parsed.data.displayOrder !== undefined ? { displayOrder: parsed.data.displayOrder } : {}),
        ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
      },
    })

    await insertAuditLog({
      action: 'attribute_value.updated',
      entityType: 'attribute_value',
      entityId: id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: parsed.data,
    })
    await insertMetricEvent({
      companyId: company.id,
      entityType: 'catalog',
      entityId: id,
      metricKey: 'attribute_value.updated',
      numericValue: 1,
      dimensions: { type: 'attribute_value' },
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
      throw new ApiError(403, 'Only elevated employees can delete attribute values.')
    }

    const { id } = await params
    const value = await db.orgAttributeValue.findFirst({ where: { id, organizationId: orgId } })
    if (!value) throw new ApiError(404, 'Attribute value not found.')

    await db.orgAttributeValue.delete({ where: { id } })

    await insertAuditLog({
      action: 'attribute_value.deleted',
      entityType: 'attribute_value',
      entityId: id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues: { value: value.value },
    })
    await insertMetricEvent({
      companyId: company.id,
      entityType: 'catalog',
      entityId: id,
      metricKey: 'attribute_value.deleted',
      numericValue: 1,
      dimensions: { type: 'attribute_value' },
    })

    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
