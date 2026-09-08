import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { getWorkspace, requirePermission, ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { processInventoryTransaction } from '@/lib/inventory'
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
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.INVENTORY_VIEW)

    const companyId = ctx.company.id

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

    // INV-004 fix: previously the fabric_consumed_for_stitching
    // InventoryTransaction was created BEFORE the ProductionOrder record —
    // leaving the forward link (InventoryTransaction.referenceId →
    // ProductionOrder.id) NULL because the PO id didn't exist yet.
    // Now we create the ProductionOrder FIRST (with fabricTxnId=null), then
    // consume fabric with referenceId=productionOrder.id, then backfill
    // fabricTxnId on the ProductionOrder. All three writes are wrapped in a
    // db.$transaction so a failure in fabric consumption rolls back the
    // ProductionOrder creation (no orphan POs). processInventoryTransaction
    // internally uses db.$transaction (since the INV-006 fix), which Prisma
    // nests as a savepoint inside this outer transaction.
    const { order, transactionId } = await db.$transaction(async (tx) => {
      // 1. Create the ProductionOrder record (fabricTxnId is NULL at this
      //    point — backfilled in step 3).
      const po = await tx.productionOrder.create({
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
          fabricTxnId: null,
          createdById: caller.id,
        },
      })

      // 2. Process the fabric consumption transaction with referenceId=po.id
      //    so the InventoryTransaction → ProductionOrder forward link is set
      //    at creation time (no subsequent mutation needed).
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
        referenceId: po.id,
        notes: `Fabric consumed for stitched variant ${d.stitched_variant_id}`,
      })
      if (!txnResult.success) {
        // Throwing aborts the outer db.$transaction, rolling back the
        // ProductionOrder.create above. The catch block in POST() will
        // convert this ApiError into a JSON error response.
        throw new ApiError(500, `Fabric consumption failed: ${txnResult.error}`)
      }

      // 3. Backfill fabricTxnId on the ProductionOrder so the reverse
      //    link (ProductionOrder → InventoryTransaction) is set.
      await tx.productionOrder.update({
        where: { id: po.id },
        data: { fabricTxnId: txnResult.transactionId ?? null },
      })

      return { order: po, transactionId: txnResult.transactionId }
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

    return Response.json({ id: order.id, status: order.status, fabricTxnId: transactionId })
  } catch (err) {
    return handleError(err)
  }
}
