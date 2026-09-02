import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Subscribe the active company to an org-wide or selectively-shared product.
 * Creates company_product_settings (inactive until pricing is set).
 * GUARD: has_permission('products.subscribe')
 */
export async function POST(
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

    const { id: productId } = await params
    const product = await db.orgProduct.findFirst({
      where: { id: productId, organizationId: orgId },
    })
    if (!product) throw new ApiError(404, 'Product not found.')

    // Verify scope allows this company
    if (product.sourceCompanyId === companyId) {
      throw new ApiError(400, 'You already own this product.')
    }
    const canAccess =
      product.productScope === 'organization' ||
      (product.productScope === 'selective' &&
        (await db.selectiveProductAccess.count({
          where: { orgProductId: productId, companyId },
        })) > 0)
    if (!canAccess) {
      throw new ApiError(403, 'This product is not available to your company.')
    }

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.PRODUCTS_SUBSCRIBE },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to subscribe to products.')

    // Check no existing subscription
    const existing = await db.companyProductSetting.findUnique({
      where: { companyId_orgProductId: { companyId, orgProductId: productId } },
    })
    if (existing) {
      throw new ApiError(409, 'Your company already has a subscription for this product.')
    }

    // Create subscription (inactive until pricing is set)
    const subscription = await db.companyProductSetting.create({
      data: {
        companyId,
        organizationId: orgId,
        orgProductId: productId,
        isActive: false, // inactive until pricing is set
        subscriptionStatus: 'active',
        subscribedById: caller.id,
      },
    })

    insertAuditLog({
      action: 'product.subscribed',
      entityType: 'product',
      entityId: productId,
      companyId,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { subscriptionId: subscription.id, isActive: false },
    })
    insertMetricEvent({
      companyId,
      entityType: 'product',
      entityId: productId,
      metricKey: 'product.subscribed',
      numericValue: 1,
      dimensions: { company_id: companyId },
    })

    return Response.json({ success: true, product_id: productId, subscription_id: subscription.id })
  } catch (err) {
    return handleError(err)
  }
}
