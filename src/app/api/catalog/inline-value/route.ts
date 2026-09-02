import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Create a new attribute value inline from the variant builder.
 * The new value is immediately available for all products in the org.
 */
export async function POST(req: Request) {
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

    const body = await readBody<{
      attribute_id?: string
      value?: string
      display_value?: string
      sku_code?: string
      color_hex?: string
    }>(req)

    if (!body.attribute_id || !body.value) {
      throw new ApiError(400, 'attribute_id and value are required')
    }

    const attr = await db.orgAttribute.findFirst({ where: { id: body.attribute_id, organizationId: orgId } })
    if (!attr) throw new ApiError(404, 'Attribute not found.')

    // Check uniqueness
    const existing = await db.orgAttributeValue.findFirst({
      where: { attributeId: body.attribute_id, value: { equals: body.value, mode: 'insensitive' } },
    })
    if (existing) throw new ApiError(409, 'A value with this name already exists for this attribute.')

    const maxOrder = await db.orgAttributeValue.aggregate({
      where: { attributeId: body.attribute_id },
      _max: { displayOrder: true },
    })

    const value = await db.orgAttributeValue.create({
      data: {
        attributeId: body.attribute_id,
        organizationId: orgId,
        value: body.value,
        displayValue: body.display_value || body.value,
        skuCode: body.sku_code || (body.display_value || body.value).toUpperCase().replace(/\s+/g, ''),
        colorHex: body.color_hex || null,
        displayOrder: (maxOrder._max.displayOrder ?? 0) + 1,
      },
    })

    insertAuditLog({
      action: 'attribute_value.created_inline',
      entityType: 'attribute_value',
      entityId: value.id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { value: value.value, attributeName: attr.name },
    })
    insertMetricEvent({
      companyId: company.id,
      entityType: 'catalog',
      entityId: value.id,
      metricKey: 'attribute_value.created_inline',
      numericValue: 1,
      dimensions: { type: 'attribute_value' },
    })

    return Response.json({
      id: value.id,
      value: value.value,
      displayValue: value.displayValue,
      colorHex: value.colorHex,
      skuCode: value.skuCode,
      displayOrder: value.displayOrder,
    })
  } catch (err) {
    return handleError(err)
  }
}
