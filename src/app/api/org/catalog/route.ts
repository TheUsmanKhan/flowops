import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Org catalog overview — for elevated employees.
 * Returns:
 *   - org_products with scope = organization/selective (the shared catalog)
 *   - private products across all companies in the org (promotable)
 *   - subscriber info per product
 */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const orgId = settings?.activeOrgId
    if (!orgId) throw new ApiError(403, 'No active organization')

    const caller = await db.employee.findFirst({
      where: { companyId: settings!.activeCompanyId!, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    if (caller.role.roleTier !== 'elevated') {
      throw new ApiError(403, 'Only elevated employees can view the org catalog.')
    }

    // Shared catalog (organization + selective scope)
    const sharedProducts = await db.orgProduct.findMany({
      where: {
        organizationId: orgId,
        productScope: { in: ['organization', 'selective'] },
        isActive: true,
      },
      include: {
        sourceCompany: { select: { id: true, name: true } },
        companySettings: {
          select: {
            id: true,
            companyId: true,
            isActive: true,
            subscriptionStatus: true,
            company: { select: { id: true, name: true } },
          },
        },
        _count: { select: { variants: { where: { isActive: true } } } },
      },
      orderBy: { promotedAt: 'desc' },
    })

    // Promotable products (private scope across all companies in the org)
    const promotableProducts = await db.orgProduct.findMany({
      where: {
        organizationId: orgId,
        productScope: 'private',
        isActive: true,
      },
      include: {
        sourceCompany: { select: { id: true, name: true } },
        _count: {
          select: {
            variants: { where: { isActive: true } },
            images: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    // All companies in the org (for selective access picker)
    const companies = await db.company.findMany({
      where: { organizationId: orgId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    })

    return Response.json({
      shared: sharedProducts.map((p) => ({
        id: p.id,
        title: p.title,
        slug: p.slug,
        productScope: p.productScope,
        productType: p.productType,
        isStitchable: p.isStitchable,
        sourceCompany: p.sourceCompany,
        variantCount: p._count.variants,
        subscribers: p.companySettings.map((s) => ({
          id: s.id,
          company: s.company,
          isActive: s.isActive,
          status: s.subscriptionStatus,
        })),
        subscriberCount: p.companySettings.length,
      })),
      promotable: promotableProducts.map((p) => ({
        id: p.id,
        title: p.title,
        slug: p.slug,
        productType: p.productType,
        isStitchable: p.isStitchable,
        sourceCompany: p.sourceCompany,
        variantCount: p._count.variants,
        imageCount: p._count.images,
        readyToPromote: p._count.variants > 0 && p._count.images > 0,
      })),
      companies,
    })
  } catch (err) {
    return handleError(err)
  }
}
