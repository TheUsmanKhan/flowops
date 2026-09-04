import { db } from '@/lib/db'
import { getCurrentUser, getSessionUserId } from '@/lib/session'
import { ApiError, handleError, readBody, getWorkspace, requirePermission } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** List categories for the active org. */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const orgId = settings?.activeOrgId
    if (!orgId) throw new ApiError(403, 'No active organization')

    const categories = await db.orgCategory.findMany({
      where: { organizationId: orgId, isActive: true },
      include: { _count: { select: { products: true } } },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    })

    return Response.json({
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        imageUrl: c.imageUrl,
        parentId: c.parentId,
        productCount: c._count.products,
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}

/** Create a category. Requires PRODUCTS_MANAGE_CATALOG permission. */
export async function POST(req: Request) {
  try {
    const idempotencyKey = req.headers.get('Idempotency-Key')

    // Modern auth: getWorkspace() (cached, 0ms) + requirePermission
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.PRODUCTS_MANAGE_CATALOG)

    const orgId = ctx.company.organizationId
    const company = ctx.company
    const caller = ctx.employee

    const body = await readBody<{ name?: string; parentId?: string }>(req)
    if (!body.name || body.name.trim().length < 2) {
      throw new ApiError(400, 'Category name is required')
    }

    // Core creation logic — wrapped in a closure so it can be run either
    // directly (no idempotency key, backwards-compatible) or via
    // withIdempotency() (prevents duplicate category submissions).
    const createCategory = async () => {
      const slug = body.name!
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/[\s_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)

      let categorySlug = slug
      let n = 1
      while (await db.orgCategory.findUnique({ where: { organizationId_slug: { organizationId: orgId, slug: categorySlug } } })) {
        n++
        categorySlug = `${slug}-${n}`
      }

      const category = await db.orgCategory.create({
        data: {
          organizationId: orgId,
          name: body.name!.trim(),
          slug: categorySlug,
          parentId: body.parentId || null,
          createdById: caller.id,
        },
      })

      insertAuditLog({
        action: 'category.created',
        entityType: 'category',
        entityId: category.id,
        companyId: company.id,
        organizationId: orgId,
        userId: ctx.user.id,
        employeeId: caller.id,
        newValues: { name: category.name },
      })

      return { id: category.id, name: category.name, slug: category.slug }
    }

    if (idempotencyKey) {
      const { withIdempotency } = await import('@/lib/idempotency')
      const { result, wasReplay } = await withIdempotency({
        key: idempotencyKey,
        companyId: company.id,
        employeeId: caller.id,
        actionType: 'category.create',
        fn: createCategory,
      })
      return Response.json(result, { status: wasReplay ? 200 : 201 })
    }

    // No idempotency key — normal flow (backwards-compatible)
    const result = await createCategory()
    return Response.json(result)
  } catch (err) {
    return handleError(err)
  }
}
