import { db } from '@/lib/db'
import { getWorkspace, handleError, requirePermission } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Get all active attributes for the org, with their values + any attribute_value_rules.
 * Powers the generic AttributeSelector in the variant builder.
 */
export async function GET() {
  try {
    // PROD-019: added PRODUCTS_VIEW permission gate. Previously the route only
    // verified the user was authenticated + had an activeOrgId, so any active
    // employee — even one with zero permissions — could enumerate ALL
    // attributes + values + rules for the org. Low severity since attributes
    // are typically non-sensitive catalog metadata, but aligns the gate with
    // sibling catalog GET routes.
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.PRODUCTS_VIEW)
    const orgId = ctx.company.organizationId

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
