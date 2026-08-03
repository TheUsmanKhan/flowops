import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { updateProductSchema } from '@/lib/validations/product'
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
        baseSku: product.baseSku,
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
          weightKg: v.weightKg ? Number(v.weightKg) : null,
          weightSyncedWithParent: v.weightSyncedWithParent,
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

/** Update product fields. Source company or elevated only. */
export async function PATCH(
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

    const { id } = await params
    const product = await db.orgProduct.findFirst({ where: { id, organizationId: orgId } })
    if (!product) throw new ApiError(404, 'Product not found.')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const isOwner = product.sourceCompanyId === companyId
    const elevated = caller.role.roleTier === 'elevated'
    if (!isOwner && !elevated) {
      throw new ApiError(403, 'Only the source company or elevated employees can edit this product.')
    }
    const allowed =
      elevated ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.PRODUCTS_EDIT },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to edit products.')

    const body = await readBody(req)
    const parsed = updateProductSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    const d = parsed.data

    const oldValues = {
      title: product.title,
      description: product.description,
      categoryId: product.categoryId,
      brandId: product.brandId,
      isStitchable: product.isStitchable,
      isFeatured: product.isFeatured,
      isActive: product.isActive,
    }

    const updated = await db.orgProduct.update({
      where: { id },
      data: {
        ...(d.title ? { title: d.title } : {}),
        ...(d.base_sku !== undefined ? { baseSku: d.base_sku || null } : {}),
        ...(d.description !== undefined ? { description: d.description || null } : {}),
        ...(d.short_description !== undefined ? { shortDescription: d.short_description || null } : {}),
        ...(d.category_id !== undefined ? { categoryId: d.category_id || null } : {}),
        ...(d.brand_id !== undefined ? { brandId: d.brand_id || null } : {}),
        ...(d.is_stitchable !== undefined ? { isStitchable: d.is_stitchable } : {}),
        ...(d.stitching_base_price !== undefined ? { stitchingBasePrice: d.stitching_base_price } : {}),
        ...(d.has_size_variants !== undefined ? { hasSizeVariants: d.has_size_variants } : {}),
        ...(d.is_active !== undefined ? { isActive: d.is_active } : {}),
        ...(d.is_featured !== undefined ? { isFeatured: d.is_featured } : {}),
      },
    })

    await insertAuditLog({
      action: 'product.updated',
      entityType: 'product',
      entityId: id,
      companyId,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues,
      newValues: d,
    })

    await insertMetricEvent({
      companyId,
      entityType: 'product',
      entityId: id,
      metricKey: 'product.updated',
      numericValue: 1,
      dimensions: { fields_changed: Object.keys(d) },
    })

    return Response.json({ id: updated.id })
  } catch (err) {
    return handleError(err)
  }
}

/** Archive a product (elevated only — never hard delete). */
export async function DELETE(
  _req: NextRequest,
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

    const { id } = await params
    const product = await db.orgProduct.findFirst({ where: { id, organizationId: orgId } })
    if (!product) throw new ApiError(404, 'Product not found.')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    if (caller.role.roleTier !== 'elevated') {
      throw new ApiError(403, 'Only elevated employees can archive products.')
    }

    const oldValues = { productScope: product.productScope, isActive: product.isActive }
    await db.orgProduct.update({
      where: { id },
      data: { productScope: 'archived', isActive: false },
    })

    await insertAuditLog({
      action: 'product.archived',
      entityType: 'product',
      entityId: id,
      companyId,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues,
      newValues: { productScope: 'archived', isActive: false },
    })

    await insertMetricEvent({
      companyId,
      entityType: 'product',
      entityId: id,
      metricKey: 'product.archived',
      numericValue: 1,
    })

    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
