import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { setCompanyPricingSchema } from '@/lib/validations/product'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Set per-variant pricing for the active company.
 * UPSERTs company_variant_pricing for each variant.
 * If this is the first pricing set, activates the company_product_settings.
 * GUARD: has_permission('products.pricing')
 */
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
    const companyId = settings?.activeCompanyId
    const orgId = settings?.activeOrgId
    if (!companyId || !orgId) throw new ApiError(403, 'No active company')

    const { id: productId } = await params
    const product = await db.orgProduct.findFirst({ where: { id: productId, organizationId: orgId } })
    if (!product) throw new ApiError(404, 'Product not found.')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.PRODUCTS_PRICING },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to set pricing.')

    const body = await readBody(req)
    const parsed = setCompanyPricingSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    const d = parsed.data

    // UPSERT each pricing entry
    for (const p of d.pricing) {
      await db.companyVariantPricing.upsert({
        where: { companyId_orgVariantId: { companyId, orgVariantId: p.org_variant_id } },
        update: { salePrice: p.sale_price, comparePrice: p.compare_price ?? null, isActive: true },
        create: {
          companyId,
          orgVariantId: p.org_variant_id,
          organizationId: orgId,
          salePrice: p.sale_price,
          comparePrice: p.compare_price ?? null,
        },
      })
    }

    // If this is the first pricing set, activate the subscription
    const sub = await db.companyProductSetting.findUnique({
      where: { companyId_orgProductId: { companyId, orgProductId: productId } },
    })
    if (sub && !sub.isActive) {
      await db.companyProductSetting.update({
        where: { id: sub.id },
        data: { isActive: true },
      })
    }

    await insertAuditLog({
      action: 'product.pricing_set',
      entityType: 'product',
      entityId: productId,
      companyId,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { pricingCount: d.pricing.length, activated: !sub?.isActive },
    })

    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
