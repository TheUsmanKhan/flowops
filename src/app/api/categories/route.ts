import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'

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

/** Create a category. */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const orgId = settings?.activeOrgId
    const company = settings?.activeCompany
    if (!orgId || !company) throw new ApiError(403, 'No active organization')

    const caller = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')

    const body = await readBody<{ name?: string; parentId?: string }>(req)
    if (!body.name || body.name.trim().length < 2) {
      throw new ApiError(400, 'Category name is required')
    }

    const slug = body.name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)

    let uniqueSlug = slug
    let n = 1
    while (await db.orgCategory.findUnique({ where: { organizationId_slug: { organizationId: orgId, slug: uniqueSlug } } })) {
      n++
      uniqueSlug = `${slug}-${n}`
    }

    const category = await db.orgCategory.create({
      data: {
        organizationId: orgId,
        name: body.name.trim(),
        slug: uniqueSlug,
        parentId: body.parentId || null,
        createdById: caller.id,
      },
    })

    await insertAuditLog({
      action: 'category.created',
      entityType: 'category',
      entityId: category.id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { name: category.name },
    })

    return Response.json({ id: category.id, name: category.name, slug: category.slug })
  } catch (err) {
    return handleError(err)
  }
}
