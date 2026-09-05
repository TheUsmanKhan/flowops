import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Create a stock transfer between two locations.
 * Produces TWO inventory_transactions: transfer_out (from) + transfer_in (to).
 * Logistics cost is tracked separately — NEVER merged into WAC.
 */
export async function POST(req: Request) {
  try {
    const idempotencyKey = req.headers.get('Idempotency-Key')

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

    // Core creation logic — wrapped in a closure so it can be run either
    // directly (no idempotency key, backwards-compatible) or via
    // withIdempotency() (prevents duplicate transfer submissions).
    //
    // ATOMICITY: The 3 writes (stockTransfer.create + transfer_out txn +
    // transfer_in txn) are NOT wrapped in db.$transaction because
    // processInventoryTransaction uses the global db client (can't accept
    // a tx client without a major refactor of the 949-line inventory.ts).
    // Instead, we use a COMPENSATING-TRANSACTION pattern: if step 2 or 3
    // fails, we explicitly delete the orphan stockTransfer record so the
    // system is left in a consistent state (no stock moved, no orphan
    // transfer record). This prevents the "stock vanished" bug where
    // transfer_out succeeds but transfer_in fails — previously the stock
    // was decremented from source but never added to destination.
    const createTransfer = async () => {
      // Lazy-load inventory module to avoid heavy top-level import on Hostinger
      const { processInventoryTransaction } = await import('@/lib/inventory')

      // Step 1: Create the stock_transfer record (orphan if steps 2/3 fail)
      const transfer = await db.stockTransfer.create({
        data: {
          organizationId: orgId,
          orgVariantId: body.org_variant_id!,
          fromLocationId: body.from_location_id!,
          toLocationId: body.to_location_id!,
          quantity: body.quantity!,
          costPerUnitAtTransfer,
          logisticsCost: body.logistics_cost || 0,
          status: 'in_transit', // start as in_transit, mark completed after both txns succeed
          notes: body.notes || null,
          initiatedById: caller.id,
        },
      })

      // Step 2: Process transfer_out at source location
      let outResult
      try {
        outResult = await processInventoryTransaction({
          orgVariantId: body.org_variant_id!,
          locationId: body.from_location_id!,
          organizationId: orgId,
          companyId: company.id,
          employeeId: caller.id,
          transactionType: 'transfer_out',
          quantity: body.quantity!,
          costPerUnit: costPerUnitAtTransfer,
          referenceType: 'transfer',
          referenceId: transfer.id,
          notes: `Transfer to ${body.to_location_id}`,
        })
        if (!outResult.success) {
          throw new Error(`Transfer out failed: ${outResult.error}`)
        }
      } catch (outErr) {
        // COMPENSATING ACTION: delete the orphan transfer record so the
        // system is left clean (no stock moved, no orphan record).
        await db.stockTransfer.delete({ where: { id: transfer.id } }).catch(() => {})
        throw new ApiError(500, outErr instanceof Error ? outErr.message : 'Transfer out failed — rolled back.')
      }

      // Step 3: Process transfer_in at destination location
      // costPerUnit is the sending location's cost — logistics_cost is NOT merged
      let inResult
      try {
        inResult = await processInventoryTransaction({
          orgVariantId: body.org_variant_id!,
          locationId: body.to_location_id!,
          organizationId: orgId,
          companyId: company.id,
          employeeId: caller.id,
          transactionType: 'transfer_in',
          quantity: body.quantity!,
          costPerUnit: costPerUnitAtTransfer,
          referenceType: 'transfer',
          referenceId: transfer.id,
          notes: `Transfer from ${body.from_location_id}`,
        })
        if (!inResult.success) {
          throw new Error(`Transfer in failed: ${inResult.error}`)
        }
      } catch (inErr) {
        // COMPENSATING ACTION: reverse the transfer_out (step 2 succeeded,
        // so source stock was decremented — we must add it back) AND delete
        // the orphan transfer record. This prevents "stock vanished" —
        // the source gets its stock back, the destination was never
        // incremented, and the transfer record is cleaned up.
        await processInventoryTransaction({
          orgVariantId: body.org_variant_id!,
          locationId: body.from_location_id!,
          organizationId: orgId,
          companyId: company.id,
          employeeId: caller.id,
          transactionType: 'manual_adjustment_in', // reverse the transfer_out
          quantity: body.quantity!,
          costPerUnit: costPerUnitAtTransfer,
          referenceType: 'transfer',
          referenceId: transfer.id,
          notes: `REVERSAL: Transfer in failed. Returning stock to source location. Original out txn: ${outResult.transactionId}.`,
        }).catch(() => {}) // best-effort reversal; if this fails too, admin must manually reconcile
        await db.stockTransfer.delete({ where: { id: transfer.id } }).catch(() => {})
        throw new ApiError(500, inErr instanceof Error ? inErr.message : 'Transfer in failed — stock returned to source, transfer rolled back.')
      }

      // Both transactions succeeded — mark the transfer as completed
      await db.stockTransfer.update({
        where: { id: transfer.id },
        data: { status: 'completed' },
      })

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
        entityId: body.org_variant_id!,
        metricKey: 'inventory.stock_transferred',
        numericValue: body.quantity! * costPerUnitAtTransfer,
        dimensions: {
          from_location_id: body.from_location_id,
          to_location_id: body.to_location_id,
          logistics_cost: body.logistics_cost ?? 0,
          quantity: body.quantity,
        },
      })

      return {
        id: transfer.id,
        status: 'completed',
        outTxnId: outResult.transactionId,
        inTxnId: inResult.transactionId,
      }
    }

    if (idempotencyKey) {
      const { withIdempotency } = await import('@/lib/idempotency')
      const { result, wasReplay } = await withIdempotency({
        key: idempotencyKey,
        companyId: company.id,
        employeeId: caller.id,
        actionType: 'inventory.transfer',
        fn: createTransfer,
      })
      return Response.json(result, { status: wasReplay ? 200 : 201 })
    }

    // No idempotency key — normal flow (backwards-compatible)
    const result = await createTransfer()
    return Response.json(result)
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
