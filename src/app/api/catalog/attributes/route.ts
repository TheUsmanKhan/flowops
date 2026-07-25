import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { attributeSchema } from '@/lib/validations/product'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** List attributes for the active org (with their values). */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const orgId = settings?.activeOrgId
    if (!orgId) throw new ApiError(403, 'No active organization')

    const attributes = await db.orgAttribute.findMany({
      where: { organizationId: orgId, isActive: true },
      include: {
        values: {
          where: { isActive: true },
          orderBy: { displayOrder: 'asc' },
        },
      },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    })

    return Response.json({
      attributes: attributes.map((a) => ({
        id: a.id,
        name: a.name,
        displayName: a.displayName,
        attributeType: a.attributeType,
        displayOrder: a.displayOrder,
        values: a.values.map((v) => ({
          id: v.id,
          value: v.value,
          displayValue: v.displayValue,
          colorHex: v.colorHex,
          skuCode: v.skuCode,
          displayOrder: v.displayOrder,
        })),
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}

/** Create an attribute. */
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

    const body = await readBody(req)
    const parsed = attributeSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')

    // Check name uniqueness within org
    const existing = await db.orgAttribute.findFirst({
      where: { organizationId: orgId, name: { equals: parsed.data.name, mode: 'insensitive' } },
    })
    if (existing) throw new ApiError(409, 'An attribute with this name already exists.')

    const attribute = await db.orgAttribute.create({
      data: {
        organizationId: orgId,
        name: parsed.data.name,
        displayName: parsed.data.displayName,
        attributeType: parsed.data.attributeType,
        displayOrder: parsed.data.displayOrder,
        isActive: parsed.data.isActive,
        createdById: caller.id,
      },
    })

    await insertAuditLog({
      action: 'attribute.created',
      entityType: 'attribute',
      entityId: attribute.id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { name: attribute.name, displayName: attribute.displayName },
    })
    await insertMetricEvent({
      companyId: company.id,
      entityType: 'catalog',
      entityId: attribute.id,
      metricKey: 'attribute.created',
      numericValue: 1,
      dimensions: { type: 'attribute', name: attribute.name },
    })

    return Response.json({ id: attribute.id, name: attribute.name })
  } catch (err) {
    return handleError(err)
  }
}
