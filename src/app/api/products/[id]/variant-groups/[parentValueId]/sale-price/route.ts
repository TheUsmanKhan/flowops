import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Set sale/compare price for an entire parent group (cascades to synced children only).
 *  Uses CompanyVariantPricing (per-company pricing) — no market scoping. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; parentValueId: string }> },
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

    const { id: productId, parentValueId } = await params
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

    const body = await readBody<{
      sale_price?: number
      compare_price?: number | null
      parent_attribute_name?: string
      parent_value?: string
    }>(req)

    if (body.sale_price === undefined || body.sale_price < 0) {
      throw new ApiError(400, 'sale_price must be 0 or positive')
    }

    // Fetch all variants for this product where parent attribute = parent_value
    const variants = await db.orgProductVariant.findMany({
      where: { productId },
      select: { id: true, attributeValues: true },
    })

    const targetVariantIds = variants
      .filter((v) => {
        const attrs = JSON.parse(v.attributeValues) as Record<string, string>
        return attrs[body.parent_attribute_name!] === body.parent_value
      })
      .map((v) => v.id)

    if (targetVariantIds.length === 0) {
      return Response.json({ success: true, updated_count: 0 })
    }

    // Fetch existing CompanyVariantPricing rows that are synced (for this company).
    // Preserves the exact cascade logic: only synced children are updated;
    // detached children (salePriceSyncedWithParent=false) stay independent.
    const syncedPricing = await db.companyVariantPricing.findMany({
      where: {
        companyId: company.id,
        orgVariantId: { in: targetVariantIds },
        salePriceSyncedWithParent: true,
      },
    })

    // Also find variants in the group that have NO CompanyVariantPricing row yet
    // (e.g. a new company that hasn't set prices, or a newly-added variant).
    // These get UPSERTed with the cascade values + synced=true so the cascade
    // works even on fresh companies. Detached variants (existing rows with
    // salePriceSyncedWithParent=false) are NOT touched — preserving the
    // "detached children stay independent" rule.
    const existingVariantIds = new Set(syncedPricing.map((p) => p.orgVariantId))
    const missingVariantIds = targetVariantIds.filter((vid) => !existingVariantIds.has(vid))

    let updatedCount = 0
    for (const pricing of syncedPricing) {
      const updateData: Record<string, unknown> = { salePrice: body.sale_price }
      if (body.compare_price !== undefined && pricing.comparePriceSyncedWithParent) {
        updateData.comparePrice = body.compare_price
      }
      await db.companyVariantPricing.update({ where: { id: pricing.id }, data: updateData })
      updatedCount++
    }
    // Create rows for variants that don't have one yet (synced=true by default).
    if (missingVariantIds.length > 0) {
      const created = await db.companyVariantPricing.createMany({
        data: missingVariantIds.map((vid) => ({
          companyId: company.id,
          organizationId: orgId,
          orgVariantId: vid,
          salePrice: body.sale_price!,
          comparePrice: body.compare_price ?? null,
          salePriceSyncedWithParent: true,
          comparePriceSyncedWithParent: true,
        })),
      })
      updatedCount += created.count
    }

    insertAuditLog({
      action: 'variant.parent_sale_price_updated',
      entityType: 'product',
      entityId: productId,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { parentValue: body.parent_value, salePrice: body.sale_price, affectedCount: updatedCount },
    })
    insertMetricEvent({
      companyId: company.id,
      entityType: 'product',
      entityId: productId,
      metricKey: 'variant.parent_sale_price_updated',
      numericValue: updatedCount,
      dimensions: { parent_value: body.parent_value },
    })

    return Response.json({ success: true, updated_count: updatedCount })
  } catch (err) {
    return handleError(err)
  }
}
