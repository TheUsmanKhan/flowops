import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { categorySchema } from '@/lib/validations/product'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Update a category. */
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
    const category = await db.orgCategory.findFirst({ where: { id, organizationId: orgId } })
    if (!category) throw new ApiError(404, 'Category not found.')

    const body = await readBody(req)
    const parsed = categorySchema.partial().safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')

    const oldValues = { name: category.name, imageUrl: category.imageUrl, isActive: category.isActive }
    const updated = await db.orgCategory.update({
      where: { id },
      data: {
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.parentId !== undefined ? { parentId: parsed.data.parentId || null } : {}),
        ...(parsed.data.imageUrl !== undefined ? { imageUrl: parsed.data.imageUrl || null } : {}),
        ...(parsed.data.displayOrder !== undefined ? { displayOrder: parsed.data.displayOrder } : {}),
        ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
      },
    })

    await insertAuditLog({
      action: 'category.updated',
      entityType: 'category',
      entityId: id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues,
      newValues: parsed.data,
    })
    await insertMetricEvent({
      companyId: company.id,
      entityType: 'catalog',
      entityId: id,
      metricKey: 'category.updated',
      numericValue: 1,
      dimensions: { type: 'category' },
    })

    return Response.json({ id: updated.id })
  } catch (err) {
    return handleError(err)
  }
}

/** Delete a category — blocked if products reference it. */
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
      throw new ApiError(403, 'Only elevated employees can delete categories.')
    }

    const { id } = await params
    const category = await db.orgCategory.findFirst({ where: { id, organizationId: orgId } })
    if (!category) throw new ApiError(404, 'Category not found.')

    // Reference check: count products using this category
    const productCount = await db.orgProduct.count({ where: { categoryId: id } })
    if (productCount > 0) {
      return Response.json(
        { error: `Cannot delete: ${productCount} product(s) still use this category. Reassign them first.` },
        { status: 409 },
      )
    }

    await db.orgCategory.delete({ where: { id } })

    await insertAuditLog({
      action: 'category.deleted',
      entityType: 'category',
      entityId: id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues: { name: category.name },
    })
    await insertMetricEvent({
      companyId: company.id,
      entityType: 'catalog',
      entityId: id,
      metricKey: 'category.deleted',
      numericValue: 1,
      dimensions: { type: 'category' },
    })

    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
