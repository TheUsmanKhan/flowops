import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Get all active attributes for the org, with their values + any attribute_value_rules.
 * Powers the generic AttributeSelector in the variant builder.
 */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const orgId = settings?.activeOrgId
    if (!orgId) throw new ApiError(403, 'No active organization')

    const [attributes, rules] = await Promise.all([
      db.orgAttribute.findMany({
        where: { organizationId: orgId, isActive: true },
        include: {
          values: {
            where: { isActive: true },
            orderBy: { displayOrder: 'asc' },
          },
        },
        orderBy: { displayOrder: 'asc' },
      }),
      db.attributeValueRule.findMany({
        where: { organizationId: orgId },
        include: {
          triggerAttributeValue: { select: { id: true, value: true, attributeId: true } },
          forcesAttribute: { select: { id: true, name: true } },
          forcesValue: { select: { id: true, value: true, displayValue: true } },
        },
      }),
    ])

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
      rules: rules.map((r) => ({
        id: r.id,
        triggerValueId: r.triggerAttributeValueId,
        triggerValueInfo: r.triggerAttributeValue,
        forcesAttributeId: r.forcesAttributeId,
        forcesAttributeName: r.forcesAttribute.name,
        forcesValueId: r.forcesValueId,
        forcesValueInfo: r.forcesValue,
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}
