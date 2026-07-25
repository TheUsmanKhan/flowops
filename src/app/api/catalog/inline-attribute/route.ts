import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Create a new attribute inline from the variant builder.
 * Accepts initial values so the attribute is immediately usable.
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
      name?: string
      display_name?: string
      attribute_type?: string
      display_order?: number
      initial_values?: Array<{ value: string; display_value?: string; sku_code?: string; color_hex?: string }>
    }>(req)

    if (!body.name || body.name.trim().length < 2) {
      throw new ApiError(400, 'Attribute name is required')
    }

    // Check uniqueness
    const existing = await db.orgAttribute.findFirst({
      where: { organizationId: orgId, name: { equals: body.name, mode: 'insensitive' } },
    })
    if (existing) throw new ApiError(409, 'An attribute with this name already exists.')

    // Determine display_order if not provided
    const maxOrder = await db.orgAttribute.aggregate({
      where: { organizationId: orgId },
      _max: { displayOrder: true },
    })
    const displayOrder = body.display_order ?? (maxOrder._max.displayOrder ?? 0) + 1

    const attribute = await db.orgAttribute.create({
      data: {
        organizationId: orgId,
        name: body.name.trim(),
        displayName: body.display_name || body.name.trim(),
        attributeType: body.attribute_type || 'select',
        displayOrder,
        createdById: caller.id,
        values: body.initial_values && body.initial_values.length > 0
          ? {
              create: body.initial_values.map((v, i) => ({
                organizationId: orgId,
                value: v.value,
                displayValue: v.display_value || v.value,
                skuCode: v.sku_code || (v.display_value || v.value).toUpperCase().replace(/\s+/g, ''),
                colorHex: v.color_hex || null,
                displayOrder: i + 1,
              })),
            }
          : undefined,
      },
      include: { values: true },
    })

    await insertAuditLog({
      action: 'attribute.created_inline',
      entityType: 'attribute',
      entityId: attribute.id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { name: attribute.name, valueCount: attribute.values.length },
    })
    await insertMetricEvent({
      companyId: company.id,
      entityType: 'catalog',
      entityId: attribute.id,
      metricKey: 'attribute.created_inline',
      numericValue: 1,
      dimensions: { type: 'attribute', name: attribute.name },
    })

    return Response.json({
      id: attribute.id,
      name: attribute.name,
      displayName: attribute.displayName,
      attributeType: attribute.attributeType,
      displayOrder: attribute.displayOrder,
      values: attribute.values.map((v) => ({
        id: v.id,
        value: v.value,
        displayValue: v.displayValue,
        colorHex: v.colorHex,
        skuCode: v.skuCode,
        displayOrder: v.displayOrder,
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}
