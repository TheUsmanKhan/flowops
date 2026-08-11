import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Override a single child's sale/compare price (marks as not synced). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; variantId: string }> },
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
    if (!orgId || !company) throw new ApiError(403, 'No active company')

    const { id: productId, variantId } = await params
    const caller = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.PRODUCTS_PRICING },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to set pricing.')

    const body = await readBody<{ sale_price?: number; compare_price?: number | null }>(req)

    // Find existing pricing row
    const pricing = await db.companyVariantPricing.findUnique({
      where: { companyId_orgVariantId: { companyId: company.id, orgVariantId: variantId } },
    })
    if (!pricing) throw new ApiError(404, 'Pricing record not found for this variant.')

    const updateData: Record<string, unknown> = {}
    if (body.sale_price !== undefined) {
      updateData.salePrice = body.sale_price
      updateData.salePriceSyncedWithParent = false
    }
    if (body.compare_price !== undefined) {
      updateData.comparePrice = body.compare_price
      updateData.comparePriceSyncedWithParent = false
    }

    await db.companyVariantPricing.update({ where: { id: pricing.id }, data: updateData })

    insertAuditLog({
      action: 'variant.price_overridden',
      entityType: 'variant',
      entityId: variantId,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: body,
    })
    insertMetricEvent({
      companyId: company.id,
      entityType: 'product',
      entityId: productId,
      metricKey: 'variant.price_overridden',
      numericValue: 1,
      dimensions: { variant_id: variantId, field: 'price' },
    })

    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
