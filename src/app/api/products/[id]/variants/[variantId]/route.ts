import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { z } from 'zod'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateVariantSchema = z.object({
  sku: z.string().min(1).max(100).optional(),
  barcode: z.string().max(100).optional().or(z.literal('')),
  cost_price: z.number().min(0).optional(),
  weight_grams: z.number().int().min(0).optional(),
  weight_kg: z.number().min(0).optional().nullable(),
  stitching_charges: z.number().min(0).optional(),
  production_days: z.number().int().min(0).optional(),
  is_taxable: z.boolean().optional(),
  requires_shipping: z.boolean().optional(),
})

/**
 * Update a variant's editable fields.
 * GUARD: source company or elevated + has_permission('products.edit')
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; variantId: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const { id: productId, variantId } = await params
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const companyId = settings?.activeCompanyId
    const orgId = settings?.activeOrgId
    if (!companyId || !orgId) throw new ApiError(403, 'No active company')

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
      throw new ApiError(403, 'Only the source company can edit variants.')
    }
    const allowed =
      elevated ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.PRODUCTS_EDIT },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to edit products.')

    const variant = await db.orgProductVariant.findFirst({
      where: { id: variantId, productId },
    })
    if (!variant) throw new ApiError(404, 'Variant not found.')

    const body = await readBody(req)
    const parsed = updateVariantSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    const d = parsed.data

    // SKU uniqueness check if changing
    if (d.sku && d.sku !== variant.sku) {
      const existing = await db.orgProductVariant.findFirst({
        where: { sku: d.sku, id: { not: variantId } },
        select: { id: true, product: { select: { title: true } } },
      })
      if (existing) {
        throw new ApiError(409, `SKU "${d.sku}" is already in use by product "${existing.product.title}".`)
      }
    }

    const oldValues = {
      sku: variant.sku,
      barcode: variant.barcode,
      costPrice: variant.costPrice,
      weightGrams: variant.weightGrams,
      weightKg: variant.weightKg,
      stitchingCharges: variant.stitchingCharges,
      productionDays: variant.productionDays,
      isTaxable: variant.isTaxable,
      requiresShipping: variant.requiresShipping,
    }

    const updated = await db.orgProductVariant.update({
      where: { id: variantId },
      data: {
        ...(d.sku ? { sku: d.sku } : {}),
        ...(d.barcode !== undefined ? { barcode: d.barcode || null } : {}),
        ...(d.cost_price !== undefined ? { costPrice: d.cost_price } : {}),
        ...(d.weight_grams !== undefined ? { weightGrams: d.weight_grams } : {}),
        ...(d.weight_kg !== undefined ? { weightKg: d.weight_kg } : {}),
        ...(d.stitching_charges !== undefined ? { stitchingCharges: d.stitching_charges } : {}),
        ...(d.production_days !== undefined ? { productionDays: d.production_days } : {}),
        ...(d.is_taxable !== undefined ? { isTaxable: d.is_taxable } : {}),
        ...(d.requires_shipping !== undefined ? { requiresShipping: d.requires_shipping } : {}),
      },
    })

    insertAuditLog({
      action: 'variant.updated',
      entityType: 'variant',
      entityId: variantId,
      companyId,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues,
      newValues: d,
    })
    insertMetricEvent({
      companyId,
      entityType: 'product',
      entityId: productId,
      metricKey: 'product.variant_updated',
      numericValue: 1,
    })

    return Response.json({
      id: updated.id,
      sku: updated.sku,
      barcode: updated.barcode,
      costPrice: Number(updated.costPrice),
      weightGrams: updated.weightGrams,
      weightKg: updated.weightKg ? Number(updated.weightKg) : null,
      stitchingCharges: Number(updated.stitchingCharges),
      productionDays: updated.productionDays,
      isTaxable: updated.isTaxable,
      requiresShipping: updated.requiresShipping,
    })
  } catch (err) {
    return handleError(err)
  }
}
