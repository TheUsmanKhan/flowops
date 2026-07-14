import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Get a single location with its inventory pools + recent transactions. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const orgId = settings?.activeOrgId
    if (!orgId) throw new ApiError(403, 'No active organization')

    const { id } = await params
    const location = await db.inventoryLocation.findFirst({
      where: { id, organizationId: orgId },
    })
    if (!location) throw new ApiError(404, 'Location not found.')

    const [pools, recentTxns] = await Promise.all([
      db.inventoryPool.findMany({
        where: { locationId: id },
        include: {
          orgVariant: {
            select: {
              id: true,
              sku: true,
              product: { select: { title: true } },
            },
          },
        },
        orderBy: { orgVariant: { sku: 'asc' } },
      }),
      db.inventoryTransaction.findMany({
        where: { locationId: id },
        include: {
          orgVariant: { select: { sku: true, product: { select: { title: true } } } },
        },
        orderBy: { recordedAt: 'desc' },
        take: 20,
      }),
    ])

    return Response.json({
      location: {
        id: location.id,
        name: location.name,
        locationType: location.locationType,
        city: location.city,
        province: location.province,
        countryCode: location.countryCode,
        contactPerson: location.contactPerson,
        contactPhone: location.contactPhone,
        isDefault: location.isDefault,
        isActive: location.isActive,
        isOrgLevel: location.companyId === null,
      },
      pools: pools.map((p) => ({
        id: p.id,
        variantId: p.orgVariant.id,
        sku: p.orgVariant.sku,
        productTitle: p.orgVariant.product.title,
        onHand: p.onHand,
        reserved: p.reserved,
        available: p.onHand - p.reserved,
        incoming: p.incoming,
        avgCost: Number(p.avgCost),
        stockValue: p.onHand * Number(p.avgCost),
        reorderPoint: p.reorderPoint,
        lastReceivedAt: p.lastReceivedAt?.toISOString() ?? null,
        lastSoldAt: p.lastSoldAt?.toISOString() ?? null,
      })),
      recentTransactions: recentTxns.map((t) => ({
        id: t.id,
        sku: t.orgVariant.sku,
        productTitle: t.orgVariant.product.title,
        transactionType: t.transactionType,
        quantity: t.quantity,
        costPerUnit: Number(t.costPerUnit),
        recordedAt: t.recordedAt.toISOString(),
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}

/** Update a location. */
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
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_MANAGE_LOCATIONS },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to manage locations.')

    const { id } = await params
    const location = await db.inventoryLocation.findFirst({ where: { id, organizationId: orgId } })
    if (!location) throw new ApiError(404, 'Location not found.')

    const body = await readBody<{
      name?: string
      locationType?: string
      city?: string
      province?: string
      contactPerson?: string
      contactPhone?: string
      isDefault?: boolean
      isActive?: boolean
    }>(req)

    const oldValues = { name: location.name, isDefault: location.isDefault, isActive: location.isActive }
    const updated = await db.inventoryLocation.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.locationType ? { locationType: body.locationType } : {}),
        ...(body.city ? { city: body.city } : {}),
        ...(body.province ? { province: body.province } : {}),
        ...(body.contactPerson !== undefined ? { contactPerson: body.contactPerson || null } : {}),
        ...(body.contactPhone !== undefined ? { contactPhone: body.contactPhone || null } : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    })

    await insertAuditLog({
      action: 'location.updated',
      entityType: 'location',
      entityId: id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues,
      newValues: body,
    })

    return Response.json({ id: updated.id })
  } catch (err) {
    return handleError(err)
  }
}

/** Deactivate a location (never hard-delete). */
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
      throw new ApiError(403, 'Only elevated employees can deactivate locations.')
    }

    const { id } = await params
    const location = await db.inventoryLocation.findFirst({ where: { id, organizationId: orgId } })
    if (!location) throw new ApiError(404, 'Location not found.')

    // Check if any inventory_pools at this location have on_hand > 0
    const poolsWithStock = await db.inventoryPool.findMany({
      where: { locationId: id, onHand: { gt: 0 } },
      include: {
        orgVariant: { select: { sku: true, product: { select: { title: true } } } },
      },
    })
    if (poolsWithStock.length > 0) {
      const totalValue = poolsWithStock.reduce(
        (sum, p) => sum + p.onHand * Number(p.avgCost),
        0,
      )
      throw new ApiError(
        409,
        `Cannot deactivate: ${poolsWithStock.length} variant(s) with ${poolsWithStock.reduce(
          (s, p) => s + p.onHand,
          0,
        )} units in stock (Rs. ${totalValue.toFixed(2)} total value) at this location. Move or zero out all stock first.`,
      )
    }

    await db.inventoryLocation.update({ where: { id }, data: { isActive: false, isDefault: false } })

    await insertAuditLog({
      action: 'location.deactivated',
      entityType: 'location',
      entityId: id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues: { name: location.name },
    })

    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
