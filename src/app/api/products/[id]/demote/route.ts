import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { demoteProductSchema } from '@/lib/validations/product'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Demote a product (organization/selective → private/selective).
 * GUARD: elevated only. Revokes all non-source company subscriptions.
 * Non-blocking warning if returned_stitched_inventory has available items
 * for affected companies.
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
    const product = await db.orgProduct.findFirst({
      where: { id: productId, organizationId: orgId, sourceCompanyId: companyId },
    })
    if (!product) throw new ApiError(404, 'Product not found or you are not the owner.')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    if (caller.role.roleTier !== 'elevated') {
      throw new ApiError(403, 'Only elevated employees can demote products.')
    }

    const body = await readBody(req)
    const parsed = demoteProductSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    const d = parsed.data

    // Fetch all non-source companies with active subscriptions
    const affectedSettings = await db.companyProductSetting.findMany({
      where: { orgProductId: productId, companyId: { not: companyId } },
      select: { id: true, companyId: true },
    })
    const affectedCompanyIds = affectedSettings.map((s) => s.companyId)

    // Non-blocking warning: check for available returned stitched inventory
    const returnedCount = await db.returnedStitchedInventory.count({
      where: {
        orgVariantId: { in: (await db.orgProductVariant.findMany({ where: { productId }, select: { id: true } })).map((v) => v.id) },
        companyId: { in: affectedCompanyIds },
        status: 'available',
      },
    })

    const warnings: string[] = []
    if (returnedCount > 0) {
      warnings.push(`${returnedCount} returned stitched item(s) in available status are tied to affected companies. They will remain in inventory but the companies will lose product access.`)
    }

    const oldValues = { productScope: product.productScope }

    // Demote the product
    await db.orgProduct.update({
      where: { id: productId },
      data: {
        productScope: d.new_scope,
        demotedAt: new Date(),
        demotedById: caller.id,
        demotionReason: d.reason,
      },
    })

    // Revoke all non-source company subscriptions
    if (affectedSettings.length > 0) {
      await db.companyProductSetting.updateMany({
        where: { id: { in: affectedSettings.map((s) => s.id) } },
        data: {
          subscriptionStatus: 'revoked',
          isActive: false,
          revokedAt: new Date(),
          revokedById: caller.id,
          revokeReason: d.reason,
        },
      })
    }

    await insertAuditLog({
      action: 'product.demoted',
      entityType: 'product',
      entityId: productId,
      companyId,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues,
      newValues: {
        productScope: d.new_scope,
        reason: d.reason,
        affectedCompanies: affectedCompanyIds,
      },
    })

    return Response.json({
      success: true,
      affected_companies: affectedCompanyIds,
      warnings,
    })
  } catch (err) {
    return handleError(err)
  }
}
