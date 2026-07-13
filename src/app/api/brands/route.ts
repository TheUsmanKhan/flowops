import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** List brands for the active org. */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const orgId = settings?.activeOrgId
    if (!orgId) throw new ApiError(403, 'No active organization')

    const brands = await db.orgBrand.findMany({
      where: { organizationId: orgId, isActive: true },
      include: { _count: { select: { products: true } } },
      orderBy: { name: 'asc' },
    })

    return Response.json({
      brands: brands.map((b) => ({
        id: b.id,
        name: b.name,
        slug: b.slug,
        logoUrl: b.logoUrl,
        productCount: b._count.products,
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}

/** Create a brand. */
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
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')

    const body = await readBody<{ name?: string }>(req)
    if (!body.name || body.name.trim().length < 2) {
      throw new ApiError(400, 'Brand name is required')
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
    while (await db.orgBrand.findUnique({ where: { organizationId_slug: { organizationId: orgId, slug: uniqueSlug } } })) {
      n++
      uniqueSlug = `${slug}-${n}`
    }

    const brand = await db.orgBrand.create({
      data: {
        organizationId: orgId,
        name: body.name.trim(),
        slug: uniqueSlug,
        createdById: caller.id,
      },
    })

    await insertAuditLog({
      action: 'brand.created',
      entityType: 'brand',
      entityId: brand.id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { name: brand.name },
    })

    return Response.json({ id: brand.id, name: brand.name, slug: brand.slug })
  } catch (err) {
    return handleError(err)
  }
}
