import { db } from './db'
import { Decimal } from '@prisma/client/runtime/library'

/**
 * THE CORE INVENTORY FUNCTION.
 *
 * This is the single point of truth for all stock movements. It:
 *   1. Finds or creates the inventory_pools row for variant+location
 *   2. Validates sufficient stock for OUT-direction transactions
 *   3. Recalculates WAC (weighted average cost) for IN-direction transactions
 *   4. Updates on_hand / reserved / avg_cost on the pool
 *   5. Inserts the immutable inventory_transactions ledger row
 *   6. Records avg_cost_history when avg_cost changes
 *   7. Flips track_inventory TRUE on made_to_order variants on first return
 *
 * IMPORTANT: inventory_pools is NEVER written to directly from any other
 * code path — only through this function. This guarantees the ledger
 * and pool always agree.
 */

export type TransactionType =
  | 'opening_stock'
  | 'purchase_received'
  | 'sale_dispatched'
  | 'order_reserved'
  | 'order_unreserved'
  | 'return_resellable'
  | 'return_damaged'
  | 'return_stitched_received'
  | 'transfer_out'
  | 'transfer_in'
  | 'cycle_count_adjust'
  | 'damage_writeoff'
  | 'theft_writeoff'
  | 'missing_writeoff'
  | 'transit_loss'
  | 'supplier_return'
  | 'fabric_consumed_for_stitching'

const OUT_TYPES: TransactionType[] = [
  'sale_dispatched',
  'transfer_out',
  'damage_writeoff',
  'theft_writeoff',
  'missing_writeoff',
  'transit_loss',
  'supplier_return',
  'fabric_consumed_for_stitching',
]

const WAC_RECALC_TYPES: TransactionType[] = [
  'opening_stock',
  'purchase_received',
  'return_stitched_received',
  'transfer_in',
  'return_resellable',
]

interface ProcessTxnInput {
  orgVariantId: string
  locationId: string
  organizationId: string
  companyId?: string | null
  employeeId?: string | null
  transactionType: TransactionType
  quantity: number // positive = in, negative = out
  costPerUnit?: number | null // if null, uses current avg_cost for OUT, or new_cost for IN
  referenceType?: string | null
  referenceId?: string | null
  notes?: string | null
  metadata?: Record<string, unknown> | null
}

interface ProcessTxnResult {
  success: boolean
  transactionId?: string
  poolState?: {
    onHand: number
    reserved: number
    available: number
    avgCost: number
  }
  error?: string
}

/**
 * Calculate new weighted average cost.
 * new_avg = (existing_qty × old_avg + new_qty × new_cost) / total_qty
 */
function calculateNewAvgCost(
  existingQty: number,
  oldAvg: number,
  newQty: number,
  newCost: number,
): number {
  const totalQty = existingQty + newQty
  if (totalQty <= 0) return 0
  return (existingQty * oldAvg + newQty * newCost) / totalQty
}

/**
 * Process a single inventory transaction.
 * This function is the ONLY way to modify inventory_pools.
 */
export async function processInventoryTransaction(
  input: ProcessTxnInput,
): Promise<ProcessTxnResult> {
  const {
    orgVariantId,
    locationId,
    organizationId,
    companyId = null,
    employeeId = null,
    transactionType,
    quantity,
    referenceType = null,
    referenceId = null,
    notes = null,
    metadata = null,
  } = input

  // For OUT transactions, quantity should be positive (we negate internally)
  // For IN transactions, quantity is positive
  const absQty = Math.abs(quantity)

  try {
    // 1. Find or create the inventory_pools row
    let pool = await db.inventoryPool.findUnique({
      where: {
        orgVariantId_locationId: { orgVariantId, locationId },
      },
    })

    if (!pool) {
      // First transaction ever for this variant+location — create pool with zeros
      pool = await db.inventoryPool.create({
        data: {
          orgVariantId,
          locationId,
          organizationId,
          onHand: 0,
          reserved: 0,
          incoming: 0,
          avgCost: 0,
        },
      })
    }

    // 2. Validate sufficient stock for OUT-direction transactions
    if (OUT_TYPES.includes(transactionType)) {
      const available = pool.onHand - pool.reserved
      if (available < absQty) {
        return {
          success: false,
          error: `INSUFFICIENT_STOCK: Available ${available}, requested ${absQty}`,
        }
      }
    }

    // 3. Determine cost_per_unit and compute new avg_cost
    const oldAvgCost = Number(pool.avgCost)
    let costPerUnit = input.costPerUnit ?? null

    // For IN-direction WAC recalculation types
    if (WAC_RECALC_TYPES.includes(transactionType)) {
      if (costPerUnit === null) {
        costPerUnit = oldAvgCost // fallback if not provided
      }
    }

    // For OUT types: use current avg_cost if not explicitly provided
    if (OUT_TYPES.includes(transactionType) && costPerUnit === null) {
      costPerUnit = oldAvgCost
    }

    // For transfer_in: costPerUnit must be passed explicitly (sending location's cost)
    if (transactionType === 'transfer_in' && costPerUnit === null) {
      costPerUnit = oldAvgCost // fallback
    }

    const finalCostPerUnit = costPerUnit ?? 0

    // 4. Compute new pool state
    let newOnHand = pool.onHand
    let newReserved = pool.reserved
    let newAvgCost = oldAvgCost
    let newIncoming = pool.incoming

    switch (transactionType) {
      case 'opening_stock':
        newOnHand += absQty
        newAvgCost = calculateNewAvgCost(pool.onHand, oldAvgCost, absQty, finalCostPerUnit)
        break
      case 'purchase_received':
        newOnHand += absQty
        newIncoming = Math.max(0, newIncoming - absQty)
        newAvgCost = calculateNewAvgCost(pool.onHand, oldAvgCost, absQty, finalCostPerUnit)
        break
      case 'sale_dispatched':
        newOnHand -= absQty
        newReserved = Math.max(0, newReserved - absQty)
        break
      case 'order_reserved':
        newReserved += absQty
        break
      case 'order_unreserved':
        newReserved = Math.max(0, newReserved - absQty)
        break
      case 'return_resellable':
        newOnHand += absQty
        newAvgCost = calculateNewAvgCost(pool.onHand, oldAvgCost, absQty, finalCostPerUnit)
        break
      case 'return_stitched_received':
        newOnHand += absQty
        newAvgCost = calculateNewAvgCost(pool.onHand, oldAvgCost, absQty, finalCostPerUnit)
        break
      case 'return_damaged':
        // No pool change — goes straight to stock_loss_records
        break
      case 'transfer_out':
        newOnHand -= absQty
        break
      case 'transfer_in':
        newOnHand += absQty
        // costPerUnit is the sending location's cost — do NOT recalculate WAC
        // The transferred stock keeps its original cost_per_unit exactly
        newAvgCost = calculateNewAvgCost(pool.onHand, oldAvgCost, absQty, finalCostPerUnit)
        break
      case 'cycle_count_adjust':
        // Set on_hand directly to counted value
        // quantity here represents the NEW on_hand value (positive)
        newOnHand = absQty
        break
      case 'damage_writeoff':
      case 'theft_writeoff':
      case 'missing_writeoff':
      case 'transit_loss':
        newOnHand -= absQty
        break
      case 'supplier_return':
        newOnHand -= absQty
        break
      case 'fabric_consumed_for_stitching':
        newOnHand -= absQty
        break
    }

    // 5. Update timestamps
    const now = new Date()
    const updateData: Record<string, unknown> = {
      onHand: newOnHand,
      reserved: newReserved,
      incoming: newIncoming,
      avgCost: newAvgCost,
      updatedAt: now,
    }
    if (
      transactionType === 'purchase_received' ||
      transactionType === 'opening_stock' ||
      transactionType === 'return_resellable' ||
      transactionType === 'return_stitched_received' ||
      transactionType === 'transfer_in'
    ) {
      updateData.lastReceivedAt = now
    }
    if (transactionType === 'sale_dispatched') {
      updateData.lastSoldAt = now
    }
    if (transactionType === 'cycle_count_adjust') {
      updateData.lastCountedAt = now
    }

    await db.inventoryPool.update({
      where: { id: pool.id },
      data: updateData,
    })

    // 6. Handle track_inventory flip for made_to_order variants on first return
    if (transactionType === 'return_stitched_received') {
      const variant = await db.orgProductVariant.findUnique({
        where: { id: orgVariantId },
        select: { trackInventory: true, fulfillmentType: true },
      })
      if (variant && !variant.trackInventory && variant.fulfillmentType === 'made_to_order') {
        // ONE-WAY flip: FALSE → TRUE (never back to FALSE)
        await db.orgProductVariant.update({
          where: { id: orgVariantId },
          data: { trackInventory: true },
        })
      }
    }

    // 7. Insert the inventory_transactions ledger row
    const txnQuantity = OUT_TYPES.includes(transactionType) ? -absQty : absQty
    const avgCostChanged = newAvgCost !== oldAvgCost

    const txn = await db.inventoryTransaction.create({
      data: {
        orgVariantId,
        locationId,
        organizationId,
        companyId,
        employeeId,
        transactionType,
        quantity: txnQuantity,
        costPerUnit: finalCostPerUnit,
        avgCostBefore: oldAvgCost,
        avgCostAfter: newAvgCost,
        referenceType,
        referenceId,
        notes,
        metadata: metadata ? JSON.stringify(metadata) : '{}',
        recordedAt: now,
      },
    })

    // 8. Insert avg_cost_history if avg_cost changed
    if (avgCostChanged) {
      await db.avgCostHistory.create({
        data: {
          orgVariantId,
          locationId,
          organizationId,
          avgCostBefore: oldAvgCost,
          avgCostAfter: newAvgCost,
          triggeredByTxnId: txn.id,
          triggerReason: transactionType,
        },
      })
    }

    return {
      success: true,
      transactionId: txn.id,
      poolState: {
        onHand: newOnHand,
        reserved: newReserved,
        available: newOnHand - newReserved,
        avgCost: newAvgCost,
      },
    }
  } catch (err) {
    console.error('[inventory] processInventoryTransaction error:', err)
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown inventory transaction error',
    }
  }
}

/**
 * Check returned stock availability for a made_to_order variant.
 * Returns available inventory_pools rows across all locations.
 */
export async function checkReturnedStockAvailability(variantId: string) {
  const pools = await db.inventoryPool.findMany({
    where: {
      orgVariantId: variantId,
      onHand: { gt: 0 },
    },
    include: {
      location: { select: { id: true, name: true } },
    },
  })
  return pools.map((p) => ({
    locationId: p.locationId,
    locationName: p.location.name,
    available: p.onHand - p.reserved,
    avgCost: Number(p.avgCost),
  }))
}

/**
 * Get inventory summary for a product — powers the product detail Inventory tab.
 */
export async function getProductInventorySummary(productId: string) {
  const variants = await db.orgProductVariant.findMany({
    where: { productId },
    select: { id: true, sku: true, fulfillmentType: true, trackInventory: true },
  })

  const result = []
  for (const variant of variants) {
    const pools = await db.inventoryPool.findMany({
      where: { orgVariantId: variant.id },
      include: {
        location: { select: { id: true, name: true } },
      },
    })

    const totalOnHand = pools.reduce((sum, p) => sum + p.onHand, 0)
    const totalReserved = pools.reduce((sum, p) => sum + p.reserved, 0)
    const totalAvailable = totalOnHand - totalReserved
    const totalValue = pools.reduce((sum, p) => sum + Number(p.onHand) * Number(p.avgCost), 0)

    result.push({
      variantId: variant.id,
      sku: variant.sku,
      fulfillmentType: variant.fulfillmentType,
      trackInventory: variant.trackInventory,
      totalOnHand,
      totalReserved,
      totalAvailable,
      totalValue,
      locations: pools.map((p) => ({
        locationId: p.locationId,
        locationName: p.location.name,
        onHand: p.onHand,
        reserved: p.reserved,
        available: p.onHand - p.reserved,
        avgCost: Number(p.avgCost),
        incoming: p.incoming,
      })),
    })
  }

  return result
}

/**
 * Generate the next PO number: PO-{year}-{sequence}
 * Sequence resets per calendar year per organization.
 */
export async function generatePoNumber(organizationId: string): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `PO-${year}-`

  // Count existing POs this year for this org
  const count = await db.purchaseOrder.count({
    where: {
      organizationId,
      poNumber: { startsWith: prefix },
    },
  })

  return `${prefix}${String(count + 1).padStart(3, '0')}`
}
