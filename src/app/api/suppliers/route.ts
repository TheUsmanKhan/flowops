import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** List suppliers visible to the active company. */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    const orgId = settings?.activeOrgId
    if (!companyId || !orgId) throw new ApiError(403, 'No active company')

    const suppliers = await db.supplier.findMany({
      where: {
        organizationId: orgId,
        isActive: true,
        OR: [{ companyId: null }, { companyId }],
      },
      include: { _count: { select: { purchaseOrders: true } } },
      orderBy: { name: 'asc' },
    })

    return Response.json({
      suppliers: suppliers.map((s) => ({
        id: s.id,
        name: s.name,
        contactPerson: s.contactPerson,
        phone: s.phone,
        email: s.email,
        paymentTerms: s.paymentTerms,
        creditBalance: Number(s.creditBalance),
        isOrgLevel: s.companyId === null,
        poCount: s._count.purchaseOrders,
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}

/** Create a supplier. */
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
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_MANAGE_SUPPLIERS },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to manage suppliers.')

    const body = await readBody<{
      name?: string
      contactPerson?: string
      phone?: string
      email?: string
      paymentTerms?: string
      isOrgLevel?: boolean
    }>(req)
    if (!body.name || body.name.trim().length < 2) {
      throw new ApiError(400, 'Supplier name is required')
    }

    const supplier = await db.supplier.create({
      data: {
        organizationId: orgId,
        companyId: body.isOrgLevel ? null : company.id,
        name: body.name.trim(),
        contactPerson: body.contactPerson || null,
        phone: body.phone || null,
        email: body.email || null,
        paymentTerms: body.paymentTerms || 'immediate',
        createdById: caller.id,
      },
    })

    await insertAuditLog({
      action: 'supplier.created',
      entityType: 'supplier',
      entityId: supplier.id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: { name: supplier.name },
    })

    return Response.json({ id: supplier.id, name: supplier.name })
  } catch (err) {
    return handleError(err)
  }
}
