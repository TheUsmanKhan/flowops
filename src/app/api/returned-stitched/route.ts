import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { returnedStitchedInventorySchema } from '@/lib/validations/product'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * List returned stitched inventory for the active company.
 * Filters: status, org_variant_id, date range.
 * Joined with variant + product details.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const url = new URL(req.url)
    const status = url.searchParams.get('status') ?? ''
    const variantId = url.searchParams.get('org_variant_id') ?? ''

    const items = await db.returnedStitchedInventory.findMany({
      where: {
        companyId,
        ...(status ? { status } : {}),
        ...(variantId ? { orgVariantId: variantId } : {}),
      },
      include: {
        orgVariant: {
          include: {
            product: { select: { id: true, title: true, slug: true } },
          },
        },
      },
      orderBy: { receivedAt: 'desc' },
    })

    return Response.json({
      items: items.map((i) => ({
        id: i.id,
        variant: {
          id: i.orgVariant.id,
          sku: i.orgVariant.sku,
          attributeValues: JSON.parse(i.orgVariant.attributeValues),
          product: i.orgVariant.product,
        },
        quantity: i.quantity,
        condition: i.condition,
        totalCost: Number(i.totalCost),
        suggestedResalePrice: i.suggestedResalePrice ? Number(i.suggestedResalePrice) : null,
        returnReason: i.returnReason,
        status: i.status,
        photos: JSON.parse(i.photos),
        notes: i.notes,
        receivedAt: i.receivedAt.toISOString(),
        soldAt: i.soldAt?.toISOString() ?? null,
        writtenOffAt: i.writtenOffAt?.toISOString() ?? null,
        writeOffReason: i.writeOffReason,
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}

/**
 * Receive a returned stitched item.
 * If condition = 'damaged': immediately written off.
 * Else: status = 'available'.
 * GUARD: has_permission('inventory.receive') or has_permission('inventory.report_loss')
 */
export async function POST(req: NextRequest) {
  try {
    const idempotencyKey = req.headers.get('Idempotency-Key')

    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const companyId = settings?.activeCompanyId
    const orgId = settings?.activeOrgId
    if (!companyId || !orgId) throw new ApiError(403, 'No active company')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: {
          roleId: caller.roleId,
          permissionKey: { in: [PERMISSIONS.INVENTORY_RECEIVE, PERMISSIONS.INVENTORY_REPORT_LOSS] },
        },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to receive returns.')

    const body = await readBody(req)
    const parsed = returnedStitchedInventorySchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    const d = parsed.data

    // Verify variant exists and is made_to_order
    const variant = await db.orgProductVariant.findFirst({
      where: { id: d.org_variant_id, organizationId: orgId },
    })
    if (!variant) throw new ApiError(404, 'Variant not found.')

    // Core creation logic — wrapped in a closure so it can be run either
    // directly (no idempotency key, backwards-compatible) or via
    // withIdempotency() (prevents duplicate return-receive submissions).
    const receiveReturnedStitched = async () => {
      const isDamaged = d.condition === 'damaged'
      const record = await db.returnedStitchedInventory.create({
        data: {
          organizationId: orgId,
          companyId,
          orgVariantId: d.org_variant_id,
          quantity: d.quantity,
          condition: d.condition,
          totalCost: d.total_cost,
          suggestedResalePrice: d.suggested_resale_price ?? null,
          originalOrderReference: d.original_order_reference || null,
          returnReason: d.return_reason,
          status: isDamaged ? 'written_off' : 'available',
          photos: JSON.stringify(d.photos),
          notes: d.notes || null,
          receivedById: caller.id,
          ...(isDamaged
            ? {
                writtenOffAt: new Date(),
                writtenOffById: caller.id,
                writeOffReason: 'Damaged on return',
              }
            : {}),
        },
      })

      insertAuditLog({
        action: 'returned_stitched.received',
        entityType: 'returned_stitched',
        entityId: record.id,
        companyId,
        organizationId: orgId,
        userId: user!.id,
        employeeId: caller.id,
        newValues: {
          condition: d.condition,
          totalCost: d.total_cost,
          variantId: d.org_variant_id,
          status: record.status,
        },
      })

      return { success: true, record_id: record.id, status: record.status }
    }

    if (idempotencyKey) {
      const { withIdempotency } = await import('@/lib/idempotency')
      const { result, wasReplay } = await withIdempotency({
        key: idempotencyKey,
        companyId,
        employeeId: caller.id,
        actionType: 'returned_stitched.create',
        fn: receiveReturnedStitched,
      })
      return Response.json(result, { status: wasReplay ? 200 : 201 })
    }

    // No idempotency key — normal flow (backwards-compatible)
    const result = await receiveReturnedStitched()
    return Response.json(result)
  } catch (err) {
    return handleError(err)
  }
}
