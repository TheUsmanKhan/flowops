import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { processInventoryTransaction } from '@/lib/inventory'
import { openingStockSchema } from '@/lib/validations/inventory'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/inventory/opening-stock
 *
 * Records opening stock for a SINGLE variant — used by the product-creation
 * wizard and the product-edit page when a user fills in the per-variant
 * "Opening Stock" section (qty + cost + location).
 *
 * This is a thin, dedicated wrapper around `processInventoryTransaction()`
 * (the SAME function every other inventory movement uses — there is no
 * parallel write path). It exists separately from `/api/inventory/receive`
 * so that:
 *   1. Each variant's opening stock can be recorded independently with its
 *      OWN location_id (the receive endpoint batches all items under one
 *      shared location).
 *   2. Per-variant failures can be surfaced clearly to the user (we return
 *      `{success, error}` for this one variant; the frontend loops and
 *      reports which variant failed).
 *   3. Opening-stock-specific Zod validation and audit action
 *      (`inventory.opening_stock_added`) are applied.
 *
 * Behaviour:
 *   - Validates `inventory.receive` permission server-side.
 *   - Validates the location exists and is accessible to this org/company.
 *   - Calls `processInventoryTransaction` with type `opening_stock`.
 *   - For made_to_order variants with track_inventory = FALSE, the core
 *     function flips track_inventory to TRUE (one-way) — this is the
 *     "pre-made bulk stock" confirmation path for MTO variants.
 *   - Inserts an `inventory.opening_stock_added` audit_log row.
 *
 * Returns: `{ success: true, transaction_id, pool_state }` on success,
 *          `{ success: false, error }` on failure (HTTP 400 or 500).
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

    // Permission check — must have inventory.receive
    const caller = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_RECEIVE },
      })) > 0
    if (!allowed) {
      throw new ApiError(403, 'You lack the inventory.receive permission required to record opening stock.')
    }

    // Validate input
    const body = await readBody(req)
    const parsed = openingStockSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid opening stock input')
    }
    const d = parsed.data

    // Validate the variant exists and belongs to this organization
    const variant = await db.orgProductVariant.findUnique({
      where: { id: d.org_variant_id },
      select: {
        id: true,
        sku: true,
        organizationId: true,
        fulfillmentType: true,
        trackInventory: true,
        product: { select: { id: true, title: true } },
      },
    })
    if (!variant) {
      throw new ApiError(404, `Variant ${d.org_variant_id} not found.`)
    }
    if (variant.organizationId !== orgId) {
      throw new ApiError(403, 'Variant does not belong to your organization.')
    }

    // Validate the location exists and is accessible to this org/company
    const location = await db.inventoryLocation.findFirst({
      where: {
        id: d.location_id,
        organizationId: orgId,
        isActive: true,
        OR: [{ companyId: null }, { companyId: company.id }],
      },
      select: { id: true, name: true },
    })
    if (!location) {
      throw new ApiError(
        400,
        'Selected location is not valid for your company. Create a location first in Inventory → Locations.',
      )
    }

    // Core creation logic — wrapped in a closure so it can be run either
    // directly (no idempotency key, backwards-compatible) or via
    // withIdempotency() (prevents duplicate opening-stock submissions).
    const recordOpeningStock = async () => {
      // THE single write path — processInventoryTransaction handles:
      //   - find/create inventory_pools row
      //   - increment on_hand
      //   - recalculate WAC avg_cost
      //   - insert inventory_transactions ledger row
      //   - insert avg_cost_history
      //   - flip track_inventory FALSE → TRUE for made_to_order variants
      const txnResult = await processInventoryTransaction({
        orgVariantId: d.org_variant_id,
        locationId: d.location_id,
        organizationId: orgId,
        companyId: company.id,
        employeeId: caller.id,
        transactionType: 'opening_stock',
        quantity: +d.quantity,
        costPerUnit: d.cost_per_unit,
        referenceType: 'opening',
        referenceId: null,
        notes: d.notes || 'Opening stock recorded at product creation',
      })

      if (!txnResult.success) {
        // Surface the real error — do NOT swallow
        throw new ApiError(500, txnResult.error ?? 'Failed to record opening stock.')
      }

      // Audit log
      insertAuditLog({
        action: 'inventory.opening_stock_added',
        entityType: 'variant',
        entityId: d.org_variant_id,
        companyId: company.id,
        organizationId: orgId,
        userId: user.id,
        employeeId: caller.id,
        newValues: {
          quantity: d.quantity,
          costPerUnit: d.cost_per_unit,
          locationId: d.location_id,
          locationName: location.name,
          sku: variant.sku,
          productTitle: variant.product.title,
        },
      })

      // ── Metric event (CRITICAL—powers stock value KPI; same key as
      //     /api/inventory/receive so opening stock doesn't double-count) ──
      insertMetricEvent({
        companyId: company.id,
        entityType: 'product',
        entityId: d.org_variant_id,
        metricKey: 'inventory.stock_received',
        numericValue: d.quantity * d.cost_per_unit,
        dimensions: {
          location_id: d.location_id,
          quantity: d.quantity,
          cost_per_unit: d.cost_per_unit,
          source: 'opening_stock',
        },
      })

      return {
        success: true,
        transaction_id: txnResult.transactionId,
        pool_state: txnResult.poolState,
        variant_id: d.org_variant_id,
        product_id: variant.product.id,
        location_id: d.location_id,
      }
    }

    if (idempotencyKey) {
      const { withIdempotency } = await import('@/lib/idempotency')
      const { result, wasReplay } = await withIdempotency({
        key: idempotencyKey,
        companyId: company.id,
        employeeId: caller.id,
        actionType: 'inventory.opening_stock',
        fn: recordOpeningStock,
      })
      return Response.json(result, { status: wasReplay ? 200 : 201 })
    }

    // No idempotency key — normal flow (backwards-compatible)
    const result = await recordOpeningStock()
    return Response.json(result)
  } catch (err) {
    return handleError(err)
  }
}
