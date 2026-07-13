import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { promoteProductSchema } from '@/lib/validations/product'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Promote a product to org-wide or selective scope.
 * GUARD: elevated employees only.
 * Requires at least 1 active variant and 1 image.
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
      include: {
        _count: {
          select: {
            variants: { where: { isActive: true } },
            images: true,
          },
        },
      },
    })
    if (!product) throw new ApiError(404, 'Product not found or you are not the owner.')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    if (caller.role.roleTier !== 'elevated') {
      throw new ApiError(403, 'Only elevated employees can promote products.')
    }

    // Validate prerequisites
    if (product._count.variants === 0) {
      throw new ApiError(400, 'Cannot promote: product has no active variants. Add at least one variant first.')
    }
    if (product._count.images === 0) {
      throw new ApiError(400, 'Cannot promote: product has no images. Upload at least one image first.')
    }

    const body = await readBody(req)
    const parsed = promoteProductSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    const d = parsed.data

    if (d.target_scope === 'selective' && d.selected_company_ids.length === 0) {
      throw new ApiError(400, 'Selective scope requires at least one company to be selected.')
    }

    const oldValues = { productScope: product.productScope }

    await db.orgProduct.update({
      where: { id: productId },
      data: {
        productScope: d.target_scope,
        promotedAt: new Date(),
        promotedById: caller.id,
      },
    })

    // If selective: grant access to selected companies
    if (d.target_scope === 'selective') {
      for (const cid of d.selected_company_ids) {
        await db.selectiveProductAccess.upsert({
          where: { orgProductId_companyId: { orgProductId: productId, companyId: cid } },
          update: {},
          create: {
            orgProductId: productId,
            companyId: cid,
            organizationId: orgId,
            grantedById: caller.id,
          },
        })
      }
    }

    await insertAuditLog({
      action: 'product.promoted',
      entityType: 'product',
      entityId: productId,
      companyId,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues,
      newValues: { productScope: d.target_scope, selectedCompanies: d.selected_company_ids },
    })

    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
