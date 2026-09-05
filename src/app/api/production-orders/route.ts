import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const createProductionOrderSchema = z.object({
  stitched_variant_id: z.string().min(1),
  fabric_variant_id: z.string().min(1),
  fabric_location_id: z.string().min(1),
  quantity: z.number().int().positive().default(1),
  stitching_cost: z.number().min(0).default(0),
  assigned_tailor: z.string().optional().or(z.literal('')),
  estimated_completion_date: z.string().optional(),
  notes: z.string().optional().or(z.literal('')),
})

/** List production orders for the active company. */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const orders = await db.productionOrder.findMany({
      where: { companyId },
      include: {
        stitchedVariant: { select: { sku: true, product: { select: { title: true } } } },
        fabricVariant: { select: { sku: true } },
        fabricLocation: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })

    return Response.json({
      orders: orders.map((o) => ({
        id: o.id,
        productTitle: o.stitchedVariant.product.title,
        stitchedSku: o.stitchedVariant.sku,
        fabricSku: o.fabricVariant.sku,
        fabricLocation: o.fabricLocation.name,
        quantity: o.quantity,
        status: o.status,
        stitchingCost: Number(o.stitchingCost),
        fabricCost: Number(o.fabricCost),
        totalCost: Number(o.stitchingCost) + Number(o.fabricCost),
        assignedTailor: o.assignedTailor,
        estimatedCompletionDate: o.estimatedCompletionDate?.toISOString() ?? null,
        actualCompletionDate: o.actualCompletionDate?.toISOString() ?? null,
        createdAt: o.createdAt.toISOString(),
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}

/**
 * Create a production order for a made_to_order variant.
 * Consumes fabric from the fabric source variant at the chosen location.
 */
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
    if (!orgId || !company) throw new ApiError(403, 'No active company')

    const caller = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_MANAGE_PRODUCTION },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to manage production orders.')

    const body = await readBody(req)
    const parsed = createProductionOrderSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    const d = parsed.data

    // Fetch fabric variant to get its current avg_cost at the location
    const fabricPool = await db.inventoryPool.findUnique({
      where: {
        orgVariantId_locationId: {
          orgVariantId: d.fabric_variant_id,
          locationId: d.fabric_location_id,
        },
      },
    })
    if (!fabricPool) throw new ApiError(404, 'No fabric stock at the specified location.')

    const available = fabricPool.onHand - fabricPool.reserved
    if (available < d.quantity) {
      throw new ApiError(400, `Insufficient fabric stock. Available: ${available}, required: ${d.quantity}.`)
    }

    const fabricCost = Number(fabricPool.avgCost) * d.quantity

    // Process the fabric consumption transaction
    const { processInventoryTransaction } = await import('@/lib/inventory')
    const txnResult = await processInventoryTransaction({
      orgVariantId: d.fabric_variant_id,
      locationId: d.fabric_location_id,
      organizationId: orgId,
      companyId: company.id,
      employeeId: caller.id,
      transactionType: 'fabric_consumed_for_stitching',
      quantity: d.quantity,
      costPerUnit: Number(fabricPool.avgCost),
      referenceType: 'production_order',
      notes: `Fabric consumed for stitched variant ${d.stitched_variant_id}`,
    })
    if (!txnResult.success) {
      throw new ApiError(500, `Fabric consumption failed: ${txnResult.error}`)
    }

    const order = await db.productionOrder.create({
      data: {
        organizationId: orgId,
        companyId: company.id,
        stitchedVariantId: d.stitched_variant_id,
        fabricVariantId: d.fabric_variant_id,
        fabricLocationId: d.fabric_location_id,
        quantity: d.quantity,
        status: 'fabric_reserved',
        stitchingCost: d.stitching_cost,
        fabricCost,
        assignedTailor: d.assigned_tailor || null,
        estimatedCompletionDate: d.estimated_completion_date ? new Date(d.estimated_completion_date) : null,
        fabricTxnId: txnResult.transactionId ?? null,
        createdById: caller.id,
      },
    })

    insertAuditLog({
      action: 'production_order.created',
      entityType: 'production_order',
      entityId: order.id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: {
        quantity: d.quantity,
        fabricCost,
        stitchingCost: d.stitching_cost,
        totalCost: fabricCost + d.stitching_cost,
      },
    })

    return Response.json({ id: order.id, status: order.status, fabricTxnId: txnResult.transactionId })
  } catch (err) {
    return handleError(err)
  }
}
