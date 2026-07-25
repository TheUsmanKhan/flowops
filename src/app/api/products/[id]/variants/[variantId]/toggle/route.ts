import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Toggle a variant's is_active status.
 * GUARD: source company or elevated + has_permission('products.edit')
 */
export async function POST(
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
      throw new ApiError(403, 'Only the source company can toggle variants.')
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

    const { is_active } = await readBody<{ is_active: boolean }>(req)
    const oldValues = { isActive: variant.isActive }

    const updated = await db.orgProductVariant.update({
      where: { id: variantId },
      data: { isActive: is_active },
    })

    await insertAuditLog({
      action: is_active ? 'variant.activated' : 'variant.deactivated',
      entityType: 'variant',
      entityId: variantId,
      companyId,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues,
      newValues: { isActive: is_active },
    })
    await insertMetricEvent({
      companyId,
      entityType: 'product',
      entityId: productId,
      metricKey: is_active ? 'product.variant_activated' : 'product.variant_deactivated',
      numericValue: 1,
      dimensions: { variant_id: variantId, sku: variant.sku },
    })

    return Response.json({ id: updated.id, isActive: updated.isActive })
  } catch (err) {
    return handleError(err)
  }
}
