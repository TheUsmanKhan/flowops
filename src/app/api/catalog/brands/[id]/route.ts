import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { brandSchema } from '@/lib/validations/product'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(
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
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.PRODUCTS_MANAGE_CATALOG },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to manage catalog.')

    const { id } = await params
    const brand = await db.orgBrand.findFirst({ where: { id, organizationId: orgId } })
    if (!brand) throw new ApiError(404, 'Brand not found.')

    const body = await readBody(req)
    const parsed = brandSchema.partial().safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')

    const oldValues = { name: brand.name, logoUrl: brand.logoUrl, isActive: brand.isActive }
    const updated = await db.orgBrand.update({
      where: { id },
      data: {
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.logoUrl !== undefined ? { logoUrl: parsed.data.logoUrl || null } : {}),
        ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
      },
    })

    insertAuditLog({
      action: 'brand.updated',
      entityType: 'brand',
      entityId: id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues,
      newValues: parsed.data,
    })
    insertMetricEvent({
      companyId: company.id,
      entityType: 'catalog',
      entityId: id,
      metricKey: 'brand.updated',
      numericValue: 1,
      dimensions: { type: 'brand' },
    })

    return Response.json({ id: updated.id })
  } catch (err) {
    return handleError(err)
  }
}

export async function DELETE(
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
    const orgId = settings?.activeOrgId
    const company = settings?.activeCompany
    if (!orgId || !company) throw new ApiError(403, 'No active organization')

    const caller = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    if (caller.role.roleTier !== 'elevated') {
      throw new ApiError(403, 'Only elevated employees can delete brands.')
    }

    const { id } = await params
    const brand = await db.orgBrand.findFirst({ where: { id, organizationId: orgId } })
    if (!brand) throw new ApiError(404, 'Brand not found.')

    const productCount = await db.orgProduct.count({ where: { brandId: id } })
    if (productCount > 0) {
      return Response.json(
        { error: `Cannot delete: ${productCount} product(s) still use this brand. Reassign them first.` },
        { status: 409 },
      )
    }

    await db.orgBrand.delete({ where: { id } })

    insertAuditLog({
      action: 'brand.deleted',
      entityType: 'brand',
      entityId: id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues: { name: brand.name },
    })
    insertMetricEvent({
      companyId: company.id,
      entityType: 'catalog',
      entityId: id,
      metricKey: 'brand.deleted',
      numericValue: 1,
      dimensions: { type: 'brand' },
    })

    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
