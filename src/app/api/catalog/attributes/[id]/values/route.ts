import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { attributeValueSchema } from '@/lib/validations/product'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** List values for an attribute. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const orgId = settings?.activeOrgId
    if (!orgId) throw new ApiError(403, 'No active organization')

    const { id } = await params
    const values = await db.orgAttributeValue.findMany({
      where: { attributeId: id, organizationId: orgId, isActive: true },
      orderBy: { displayOrder: 'asc' },
    })

    return Response.json({
      values: values.map((v) => ({
        id: v.id,
        value: v.value,
        displayValue: v.displayValue,
        colorHex: v.colorHex,
        displayOrder: v.displayOrder,
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}

/** Create a value for an attribute. */
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

    const { id: attributeId } = await params
    const attr = await db.orgAttribute.findFirst({ where: { id: attributeId, organizationId: orgId } })
    if (!attr) throw new ApiError(404, 'Attribute not found.')

    const body = await readBody(req)
    const parsed = attributeValueSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')

    const value = await db.orgAttributeValue.create({
      data: {
        attributeId,
        organizationId: orgId,
        value: parsed.data.value,
        displayValue: parsed.data.displayValue,
        colorHex: parsed.data.colorHex || null,
        displayOrder: parsed.data.displayOrder,
        isActive: parsed.data.isActive,
      },
    })

    await insertAuditLog({
      action: 'attribute_value.created',
      entityType: 'attribute_value',
      entityId: value.id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { value: value.value, displayValue: value.displayValue },
    })

    return Response.json({ id: value.id })
  } catch (err) {
    return handleError(err)
  }
}
