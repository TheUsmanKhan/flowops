import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { productSchema } from '@/lib/validations/product'
import { syncInventoryPolicy } from '@/lib/constants/fulfillment-types'
import { PERMISSIONS } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * List products visible to the active company.
 * Visibility rules (mirroring the RLS spec):
 *   - private: only source_company_id = active company
 *   - organization: any company in the same org
 *   - selective: only companies in selective_product_access
 *   - archived: only source company or elevated
 *
 * Supports filters via query params: search, category_id, brand_id,
 * product_type, product_scope, is_active. Paginated with page & pageSize.
 */
export async function GET(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    const orgId = settings?.activeOrgId
    if (!companyId || !orgId) throw new ApiError(403, 'No active company')

    // Parse query params for filtering + pagination
    const url = new URL(req.url)
    const search = url.searchParams.get('search') ?? ''
    const categoryId = url.searchParams.get('category_id') ?? ''
    const brandId = url.searchParams.get('brand_id') ?? ''
    const productType = url.searchParams.get('product_type') ?? ''
    const productScope = url.searchParams.get('product_scope') ?? ''
    const isActiveParam = url.searchParams.get('is_active')
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'))
    const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get('pageSize') ?? '20')))

    const where = {
      organizationId: orgId,
      ...(categoryId ? { categoryId } : {}),
      ...(brandId ? { brandId } : {}),
      ...(productType ? { productType } : {}),
      ...(productScope ? { productScope } : {}),
      ...(isActiveParam !== null ? { isActive: isActiveParam === 'true' } : { isActive: true }),
      ...(search ? { title: { contains: search, mode: 'insensitive' as const } } : {}),
      OR: [
        { sourceCompanyId: companyId },
        { productScope: 'organization' },
        { productScope: 'selective', selectiveAccess: { some: { companyId } } },
      ],
    }

    const [total, products] = await Promise.all([
      db.orgProduct.count({ where }),
      db.orgProduct.findMany({
        where,
        include: {
          category: { select: { id: true, name: true } },
          brand: { select: { id: true, name: true } },
          variants: {
            where: { isActive: true },
            select: {
              id: true,
              sku: true,
              costPrice: true,
              fulfillmentType: true,
              stitchingType: true,
              isDefault: true,
              attributeValues: true,
              companyPricing: {
                where: { companyId },
                select: { salePrice: true, comparePrice: true },
              },
            },
          },
          images: {
            where: { isPrimary: true },
            take: 1,
            select: { publicUrl: true },
          },
          _count: { select: { variants: { where: { isActive: true } } } },
          companySettings: { where: { companyId }, select: { isActive: true, subscriptionStatus: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])

    return Response.json({
      products: products.map((p) => ({
        id: p.id,
        title: p.title,
        slug: p.slug,
        productType: p.productType,
        productScope: p.productScope,
        isStitchable: p.isStitchable,
        isFeatured: p.isFeatured,
        isActive: p.isActive,
        category: p.category,
        brand: p.brand,
        primaryImage: p.images[0]?.publicUrl ?? null,
        variantCount: p._count.variants,
        variants: p.variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          costPrice: Number(v.costPrice),
          fulfillmentType: v.fulfillmentType,
          stitchingType: v.stitchingType,
          isDefault: v.isDefault,
          // Parse attributeValues JSONB (e.g. {"Size":"M","Color":"Blue"}) —
          // used by the order-create form to auto-build the orderDetail
          // preview string with variant attributes.
          attributeValues: (() => {
            try {
              return JSON.parse(v.attributeValues || '{}') as Record<string, string>
            } catch {
              return {}
            }
          })(),
          salePrice: v.companyPricing[0] ? Number(v.companyPricing[0].salePrice) : null,
          comparePrice: v.companyPricing[0]?.comparePrice ? Number(v.companyPricing[0].comparePrice) : null,
        })),
        isOwner: p.sourceCompanyId === companyId,
        subscription: p.companySettings[0]
          ? { isActive: p.companySettings[0].isActive, status: p.companySettings[0].subscriptionStatus }
          : null,
      })),
      total,
      page,
      pageSize,
    })
  } catch (err) {
    return handleError(err)
  }
}

/**
 * Create a new product with variants.
 * Creates: org_products + org_product_variants + company_product_settings
 *          + company_variant_pricing (+ audit + metric).
 */
export async function POST(req: Request) {
  try {
    const idempotencyKey = req.headers.get('Idempotency-Key')
    const body = await readBody(req)

    // The core creation logic — wrapped in a function so it can be called
    // either directly (no idempotency key, backwards-compatible) or via
    // withIdempotency() (prevents duplicate submissions).
    const createProduct = async () => {
      const user = await getCurrentUser()
      if (!user) throw new ApiError(401, 'Not authenticated')
      const settings = await db.userSetting.findUnique({
        where: { userId: user.id },
      })
      const companyId = settings?.activeCompanyId
      const orgId = settings?.activeOrgId
      if (!companyId || !orgId) throw new ApiError(403, 'No active company')

      // Permission check
      const caller = await db.employee.findFirst({
        where: { companyId, userId: user.id, status: 'active' },
        include: { role: true },
      })
      if (!caller) throw new ApiError(403, 'Not a member of this company.')
      const allowed =
        caller.role.roleTier === 'elevated' ||
        (await db.rolePermission.count({
          where: { roleId: caller.roleId, permissionKey: PERMISSIONS.PRODUCTS_CREATE },
        })) > 0
      if (!allowed) throw new ApiError(403, 'You lack permission to create products.')

      const parsed = productSchema.safeParse(body)
      if (!parsed.success) {
        throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
      }
      const d = parsed.data

      // Generate unique slug
      const baseSlug = d.title
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/[\s_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80)
      let slug = baseSlug || 'product'
      let n = 1
      while (await db.orgProduct.findUnique({ where: { organizationId_slug: { organizationId: orgId, slug } } })) {
        n++
        slug = `${baseSlug}-${n}`
      }

      // Validate variant attribute_values (max 3 keys — Shopify limit)
      for (const v of d.variants) {
        const keys = Object.keys(v.attribute_values)
        if (keys.length > 3) {
          throw new ApiError(400, `Variant ${v.sku} has ${keys.length} attributes. Maximum 3 allowed (Shopify limit).`)
        }
      }

      // Create product
      const product = await db.orgProduct.create({
        data: {
          organizationId: orgId,
          sourceCompanyId: companyId,
          categoryId: d.category_id || null,
          brandId: d.brand_id || null,
          title: d.title,
          slug,
          baseSku: d.base_sku || null,
          description: d.description || null,
          shortDescription: d.short_description || null,
          productType: d.product_type,
          productScope: d.product_scope,
          isStitchable: d.is_stitchable,
          hasSizeVariants: d.has_size_variants,
          stitchingBasePrice: d.stitching_base_price,
          isActive: d.is_active,
          isFeatured: d.is_featured,
          createdById: caller.id,
        },
      })

      // Create variants + company pricing
      const variantRecords: Array<{ id: string }> = []
      for (const v of d.variants) {
        // Sync fulfillment_type ↔ inventory_policy
        const inventoryPolicy = syncInventoryPolicy(v.fulfillment_type, v.allow_backorder)

        // Validate stitching_type ↔ fulfillment_type consistency
        let fulfillmentType = v.fulfillment_type
        if (v.stitching_type === 'unstitched') {
          fulfillmentType = 'stock_based'
        } else if (['stitched_basic', 'stitched_heavy', 'custom_order'].includes(v.stitching_type ?? '')) {
          fulfillmentType = 'made_to_order'
        }

        const variant = await db.orgProductVariant.create({
          data: {
            productId: product.id,
            organizationId: orgId,
            sku: v.sku,
            barcode: v.barcode || null,
            attributeValues: JSON.stringify(v.attribute_values),
            costPrice: v.cost_price,
            weightGrams: v.weight_grams,
            weightKg: v.weight_kg ?? null,
            fulfillmentType,
            stitchingType: v.stitching_type ?? null,
            stitchingCharges: v.stitching_charges,
            productionDays: v.production_days,
            isTaxable: v.is_taxable,
            requiresShipping: v.requires_shipping,
            inventoryPolicy: syncInventoryPolicy(fulfillmentType, v.allow_backorder),
            isDefault: v.is_default,
            isActive: v.is_active,
            fabricSourceVariantId: v.fabric_source_variant_id || null,
            createdById: caller.id,
          },
        })
        variantRecords.push(variant)

        // Create company pricing for this variant
        await db.companyVariantPricing.create({
          data: {
            companyId,
            orgVariantId: variant.id,
            organizationId: orgId,
            salePrice: v.sale_price,
            comparePrice: v.compare_price ?? null,
          },
        })
      }

      // Create company_product_settings (creator auto-subscribes)
      await db.companyProductSetting.create({
        data: {
          companyId,
          organizationId: orgId,
          orgProductId: product.id,
          subscribedById: caller.id,
        },
      })

      // Audit + metric
      insertAuditLog({
        action: 'product.created',
        entityType: 'product',
        entityId: product.id,
        companyId,
        organizationId: orgId,
        userId: user.id,
        employeeId: caller.id,
        newValues: {
          title: product.title,
          productType: product.productType,
          variantCount: variantRecords.length,
          isStitchable: product.isStitchable,
        },
      })
      insertMetricEvent({
        companyId,
        entityType: 'product',
        entityId: product.id,
        metricKey: 'product.created',
        numericValue: 1,
      })

      return { id: product.id, slug: product.slug, title: product.title, variantIds: variantRecords.map(v => v.id) }
    }

    // If an idempotency key is provided, wrap the creation in withIdempotency()
    if (idempotencyKey) {
      const user = await getCurrentUser()
      if (!user) throw new ApiError(401, 'Not authenticated')
      const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
      const companyId = settings?.activeCompanyId
      if (!companyId) throw new ApiError(403, 'No active company')
      const caller = await db.employee.findFirst({
        where: { companyId, userId: user.id, status: 'active' },
        select: { id: true },
      })

      const { withIdempotency } = await import('@/lib/idempotency')
      const { result, wasReplay } = await withIdempotency({
        key: idempotencyKey,
        companyId,
        employeeId: caller?.id,
        actionType: 'product.create',
        fn: createProduct,
      })
      return Response.json(result, { status: wasReplay ? 200 : 201 })
    }

    // No idempotency key — normal flow (backwards-compatible)
    const result = await createProduct()
    return Response.json(result, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
