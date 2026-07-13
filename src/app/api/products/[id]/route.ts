import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Get a single product with full details: variants, pricing, images. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const { id } = await params
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    const orgId = settings?.activeOrgId
    if (!companyId || !orgId) throw new ApiError(403, 'No active company')

    const product = await db.orgProduct.findFirst({
      where: {
        id,
        organizationId: orgId,
        OR: [
          { sourceCompanyId: companyId },
          { productScope: 'organization' },
          { productScope: 'selective', selectiveAccess: { some: { companyId } } },
        ],
      },
      include: {
        category: true,
        brand: true,
        images: { orderBy: { displayOrder: 'asc' } },
        variants: {
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
          include: {
            companyPricing: { where: { companyId } },
          },
        },
        companySettings: { where: { companyId } },
      },
    })
    if (!product) throw new ApiError(404, 'Product not found.')

    return Response.json({
      product: {
        id: product.id,
        title: product.title,
        slug: product.slug,
        description: product.description,
        shortDescription: product.shortDescription,
        productType: product.productType,
        productScope: product.productScope,
        isStitchable: product.isStitchable,
        hasSizeVariants: product.hasSizeVariants,
        stitchingBasePrice: Number(product.stitchingBasePrice),
        isActive: product.isActive,
        isFeatured: product.isFeatured,
        isOwner: product.sourceCompanyId === companyId,
        category: product.category,
        brand: product.brand,
        images: product.images.map((img) => ({
          id: img.id,
          publicUrl: img.publicUrl,
          isPrimary: img.isPrimary,
          displayOrder: img.displayOrder,
          variantId: img.variantId,
        })),
        variants: product.variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          barcode: v.barcode,
          attributeValues: JSON.parse(v.attributeValues),
          costPrice: Number(v.costPrice),
          weightGrams: v.weightGrams,
          fulfillmentType: v.fulfillmentType,
          stitchingType: v.stitchingType,
          stitchingCharges: Number(v.stitchingCharges),
          productionDays: v.productionDays,
          isTaxable: v.isTaxable,
          requiresShipping: v.requiresShipping,
          inventoryPolicy: v.inventoryPolicy,
          isDefault: v.isDefault,
          isActive: v.isActive,
          salePrice: v.companyPricing[0] ? Number(v.companyPricing[0].salePrice) : null,
          comparePrice: v.companyPricing[0]?.comparePrice ? Number(v.companyPricing[0].comparePrice) : null,
          pricingId: v.companyPricing[0]?.id ?? null,
        })),
        subscription: product.companySettings[0]
          ? {
              id: product.companySettings[0].id,
              status: product.companySettings[0].subscriptionStatus,
              isActive: product.companySettings[0].isActive,
            }
          : null,
      },
    })
  } catch (err) {
    return handleError(err)
  }
}
