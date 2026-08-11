import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { processInventoryTransaction } from '@/lib/inventory'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Create a stock transfer between two locations.
 * Produces TWO inventory_transactions: transfer_out (from) + transfer_in (to).
 * Logistics cost is tracked separately — NEVER merged into WAC.
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
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_TRANSFER },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to transfer stock.')

    const body = await readBody<{
      org_variant_id?: string
      from_location_id?: string
      to_location_id?: string
      quantity?: number
      logistics_cost?: number
      notes?: string
    }>(req)

    if (!body.org_variant_id || !body.from_location_id || !body.to_location_id || !body.quantity) {
      throw new ApiError(400, 'org_variant_id, from_location_id, to_location_id, and quantity are required.')
    }
    if (body.quantity <= 0) throw new ApiError(400, 'Quantity must be positive.')
    if (body.from_location_id === body.to_location_id) {
      throw new ApiError(400, 'From and to locations must be different.')
    }

    // Fetch the source pool to get the current avg_cost (the cost that transfers)
    const sourcePool = await db.inventoryPool.findUnique({
      where: {
        orgVariantId_locationId: {
          orgVariantId: body.org_variant_id,
          locationId: body.from_location_id,
        },
      },
    })
    if (!sourcePool) throw new ApiError(404, 'No inventory at the source location.')
    const available = sourcePool.onHand - sourcePool.reserved
    if (available < body.quantity) {
      throw new ApiError(400, `Insufficient stock. Available: ${available}, requested: ${body.quantity}.`)
    }

    const costPerUnitAtTransfer = Number(sourcePool.avgCost)

    // Create the stock_transfer record
    const transfer = await db.stockTransfer.create({
      data: {
        organizationId: orgId,
        orgVariantId: body.org_variant_id,
        fromLocationId: body.from_location_id,
        toLocationId: body.to_location_id,
        quantity: body.quantity,
        costPerUnitAtTransfer,
        logisticsCost: body.logistics_cost || 0,
        status: 'completed',
        notes: body.notes || null,
        initiatedById: caller.id,
      },
    })

    // Process transfer_out at source location
    const outResult = await processInventoryTransaction({
      orgVariantId: body.org_variant_id,
      locationId: body.from_location_id,
      organizationId: orgId,
      companyId: company.id,
      employeeId: caller.id,
      transactionType: 'transfer_out',
      quantity: body.quantity,
      costPerUnit: costPerUnitAtTransfer,
      referenceType: 'transfer',
      referenceId: transfer.id,
      notes: `Transfer to ${body.to_location_id}`,
    })
    if (!outResult.success) {
      throw new ApiError(500, `Transfer out failed: ${outResult.error}`)
    }

    // Process transfer_in at destination location
    // costPerUnit is the sending location's cost — logistics_cost is NOT merged
    const inResult = await processInventoryTransaction({
      orgVariantId: body.org_variant_id,
      locationId: body.to_location_id,
      organizationId: orgId,
      companyId: company.id,
      employeeId: caller.id,
      transactionType: 'transfer_in',
      quantity: body.quantity,
      costPerUnit: costPerUnitAtTransfer,
      referenceType: 'transfer',
      referenceId: transfer.id,
      notes: `Transfer from ${body.from_location_id}`,
    })
    if (!inResult.success) {
      throw new ApiError(500, `Transfer in failed: ${inResult.error}`)
    }

    insertAuditLog({
      action: 'stock.transferred',
      entityType: 'transfer',
      entityId: transfer.id,
      companyId: company.id,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      newValues: {
        quantity: body.quantity,
        costPerUnitAtTransfer,
        logisticsCost: body.logistics_cost || 0,
        fromLocation: body.from_location_id,
        toLocation: body.to_location_id,
      },
    })

    // ── Metric event (CRITICAL — powers stock movement / turnover KPIs) ──
    insertMetricEvent({
      companyId: company.id,
      entityType: 'product',
      entityId: body.org_variant_id,
      metricKey: 'inventory.stock_transferred',
      numericValue: body.quantity * costPerUnitAtTransfer,
      dimensions: {
        from_location_id: body.from_location_id,
        to_location_id: body.to_location_id,
        logistics_cost: body.logistics_cost ?? 0,
        quantity: body.quantity,
      },
    })

    return Response.json({
      id: transfer.id,
      status: 'completed',
      outTxnId: outResult.transactionId,
      inTxnId: inResult.transactionId,
    })
  } catch (err) {
    return handleError(err)
  }
}

/** List transfers for the active org. */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const orgId = settings?.activeOrgId
    if (!orgId) throw new ApiError(403, 'No active organization')

    const transfers = await db.stockTransfer.findMany({
      where: { organizationId: orgId },
      include: {
        orgVariant: { select: { sku: true, product: { select: { title: true } } } },
        fromLocation: { select: { name: true } },
        toLocation: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })

    return Response.json({
      transfers: transfers.map((t) => ({
        id: t.id,
        productTitle: t.orgVariant.product.title,
        sku: t.orgVariant.sku,
        fromLocation: t.fromLocation.name,
        toLocation: t.toLocation.name,
        quantity: t.quantity,
        costPerUnitAtTransfer: Number(t.costPerUnitAtTransfer),
        logisticsCost: Number(t.logisticsCost),
        status: t.status,
        createdAt: t.createdAt.toISOString(),
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}
