import { db } from '@/lib/db'
import { getWorkspace, requirePermission, handleError } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * List production orders for the active company.
 *
 * ProductionOrders are NEVER created via this API route — they are only ever
 * created by `checkAndFulfillMadeToOrderVariant()` in src/lib/inventory.ts
 * (which is invoked by order placement / exchange-shipment / server actions).
 * The previous manual POST handler was removed in the PO-007 fix to prevent
 * future PO-002-style data loss bugs (where manual POs without an
 * orderItemId silently lost their stitched stock on completion).
 *
 * Use PATCH /api/production-orders/[id] to update status, tailor, dates, etc.
 */
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
        orderItemId: o.orderItemId,
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}

/**
 * POST is intentionally disabled — ProductionOrders must only be created via
 * `checkAndFulfillMadeToOrderVariant()` in src/lib/inventory.ts (called by
 * server actions during order placement / exchange-shipment / fulfill-mto).
 *
 * Returns 405 Method Not Allowed for any POST request.
 *
 * See PO-007 fix in worklog.md for the rationale (defense-in-depth against
 * future PO-002-style bugs).
 */
export async function POST() {
  return new Response(
    JSON.stringify({
      error:
        'Method Not Allowed. ProductionOrders can only be created via checkAndFulfillMadeToOrderVariant() in src/lib/inventory.ts.',
    }),
    { status: 405, headers: { 'Content-Type': 'application/json' } },
  )
}
