import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { variantSchema, type VariantInput } from '@/lib/validations/product'
import { syncInventoryPolicy } from '@/lib/constants/fulfillment-types'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Create variants for an existing product.
 * - Validates each variant with variantSchema
 * - Syncs fulfillment_type ↔ inventory_policy
 * - For made_to_order: cost_price = fabric_cost + stitching_charges
 * - Creates company_product_settings (if missing) + company_variant_pricing
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
    const isOwner = product.sourceCompanyId === companyId
    const elevated = caller.role.roleTier === 'elevated'
    if (!isOwner && !elevated) {
      throw new ApiError(403, 'Only the source company can add variants.')
    }
    const allowed =
      elevated ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.PRODUCTS_EDIT },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to edit products.')

    const body = await readBody<{ variants?: VariantInput[] }>(req)
    const variants = body.variants
    if (!variants || !Array.isArray(variants) || variants.length === 0) {
      throw new ApiError(400, 'At least one variant is required.')
    }

    // Validate all variants
    for (let i = 0; i < variants.length; i++) {
      const parsed = variantSchema.safeParse(variants[i])
      if (!parsed.success) {
        throw new ApiError(400, `Variant ${i + 1}: ${parsed.error.issues[0]?.message}`)
      }
      // Defense in depth: max 3 attribute keys
      const keys = Object.keys(parsed.data.attribute_values)
      if (keys.length > 3) {
        throw new ApiError(400, `Variant ${i + 1}: max 3 attributes allowed (Shopify limit).`)
      }
    }

    const createdIds: string[] = []
    for (const v of variants) {
      const parsed = variantSchema.parse(v)

      // Sync fulfillment_type ↔ inventory_policy
      let fulfillmentType = parsed.fulfillment_type
      if (parsed.stitching_type === 'unstitched') {
        fulfillmentType = 'stock_based'
      } else if (['stitched_basic', 'stitched_heavy', 'custom_order'].includes(parsed.stitching_type ?? '')) {
        fulfillmentType = 'made_to_order'
      }

      // For made_to_order: cost_price = fabric_cost + stitching_charges
      let costPrice = parsed.cost_price
      if (fulfillmentType === 'made_to_order' && parsed.fabric_cost !== undefined) {
        costPrice = parsed.fabric_cost + parsed.stitching_charges
      }

      const variant = await db.orgProductVariant.create({
        data: {
          productId,
          organizationId: orgId,
          sku: parsed.sku,
          barcode: parsed.barcode || null,
          attributeValues: JSON.stringify(parsed.attribute_values),
          costPrice,
          weightGrams: parsed.weight_grams,
          weightKg: parsed.weight_kg ?? null,
          fulfillmentType,
          stitchingType: parsed.stitching_type ?? null,
          stitchingCharges: parsed.stitching_charges,
          productionDays: parsed.production_days,
          isTaxable: parsed.is_taxable,
          requiresShipping: parsed.requires_shipping,
          inventoryPolicy: syncInventoryPolicy(fulfillmentType, parsed.allow_backorder),
          isDefault: parsed.is_default,
          isActive: parsed.is_active,
          createdById: caller.id,
        },
      })
      createdIds.push(variant.id)

      // Create company_variant_pricing for the source company
      await db.companyVariantPricing.upsert({
        where: { companyId_orgVariantId: { companyId, orgVariantId: variant.id } },
        update: { salePrice: parsed.sale_price, comparePrice: parsed.compare_price ?? null },
        create: {
          companyId,
          orgVariantId: variant.id,
          organizationId: orgId,
          salePrice: parsed.sale_price,
          comparePrice: parsed.compare_price ?? null,
        },
      })
    }

    // Ensure company_product_settings exists for source company
    await db.companyProductSetting.upsert({
      where: { companyId_orgProductId: { companyId, orgProductId: productId } },
      update: {},
      create: {
        companyId,
        organizationId: orgId,
        orgProductId: productId,
        isActive: true,
        subscribedById: caller.id,
      },
    })

    insertAuditLog({
      action: 'product.variants_created',
      entityType: 'product',
      entityId: productId,
      companyId,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { variantCount: createdIds.length, variantIds: createdIds },
    })
    insertMetricEvent({
      companyId,
      entityType: 'product',
      entityId: productId,
      metricKey: 'product.variant_created',
      numericValue: createdIds.length,
      dimensions: { variant_count: createdIds.length },
    })

    return Response.json({ success: true, variant_ids: createdIds })
  } catch (err) {
    return handleError(err)
  }
}
