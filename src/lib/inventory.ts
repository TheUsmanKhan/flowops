import { db } from './db'
import { Decimal } from '@prisma/client/runtime/library'
import type { Prisma } from '@prisma/client'

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
  | 'manual_adjustment_in'
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
      case 'manual_adjustment_in':
        // Manual positive adjustment — INCREMENT on_hand by the quantity
        // (unlike cycle_count_adjust which SETS on_hand to the quantity)
        newOnHand += absQty
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

    // 6. Handle track_inventory flip for made_to_order variants on first
    //    return OR on opening_stock entry (e.g. user confirms "pre-made bulk
    //    stock" for an MTO variant during product creation). One-way FALSE → TRUE.
    if (
      transactionType === 'return_stitched_received' ||
      transactionType === 'opening_stock'
    ) {
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

  const result: Array<{
    variantId: string
    sku: string
    fulfillmentType: string
    trackInventory: boolean
    totalOnHand: number
    totalReserved: number
    totalAvailable: number
    totalValue: number
    locations: Array<{
      locationId: string
      locationName: string
      onHand: number
      reserved: number
      available: number
      avgCost: number
      incoming: number
    }>
  }> = []
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

/**
 * Increment incoming stock on a pool (for PO ordering).
 * This is the ONLY function that writes to inventory_pools.incoming directly
 * — it's a live projection field, not a ledgered movement.
 * Creates the pool row if it doesn't exist.
 */
export async function incrementIncomingStock(
  orgVariantId: string,
  locationId: string,
  organizationId: string,
  qty: number,
): Promise<void> {
  await db.inventoryPool.upsert({
    where: { orgVariantId_locationId: { orgVariantId, locationId } },
    update: { incoming: { increment: qty } },
    create: {
      orgVariantId,
      locationId,
      organizationId,
      incoming: qty,
    },
  })
}

/**
 * Decrement incoming stock (never below 0).
 * Used when cancelling POs or receiving against POs.
 */
export async function decrementIncomingStock(
  orgVariantId: string,
  locationId: string,
  qty: number,
): Promise<void> {
  const pool = await db.inventoryPool.findUnique({
    where: { orgVariantId_locationId: { orgVariantId, locationId } },
    select: { incoming: true },
  })
  if (!pool) return
  const newIncoming = Math.max(0, pool.incoming - qty)
  await db.inventoryPool.update({
    where: { orgVariantId_locationId: { orgVariantId, locationId } },
    data: { incoming: newIncoming },
  })
}

/**
 * Check and fulfill a made-to-order variant.
 *
 * The central decision function:
 * 1. Check if returned stock is available for this variant
 * 2. If yes: return { source: 'existing_stock', location_id, available }
 * 3. If no: create a production order, consume fabric, return { source: 'fresh_production' }
 */
export async function checkAndFulfillMadeToOrderVariant(
  orgVariantId: string,
  quantity: number,
  companyId: string,
  preferredLocationId?: string,
): Promise<{
  source: 'existing_stock' | 'fresh_production'
  locationId?: string
  available?: number
  productionOrderId?: string
  estimatedCompletionDate?: Date
  error?: string
}> {
  // 1. Check returned stock availability
  const availability = await checkReturnedStockAvailability(orgVariantId)
  const totalAvailable = availability.reduce((sum, a) => sum + a.available, 0)

  if (totalAvailable >= quantity) {
    // Use existing stock — find the best location (most available)
    const best = availability
      .filter((a) => a.available > 0)
      .sort((a, b) => b.available - a.available)[0]
    return {
      source: 'existing_stock',
      locationId: best.locationId,
      available: best.available,
    }
  }

  // 2. Not enough returned stock — create a production order
  const variant = await db.orgProductVariant.findUnique({
    where: { id: orgVariantId },
    select: {
      id: true,
      fabricSourceVariantId: true,
      stitchingCharges: true,
      productionDays: true,
      organizationId: true,
    },
  })

  if (!variant) return { source: 'fresh_production', error: 'Variant not found' }
  if (!variant.fabricSourceVariantId) {
    return { source: 'fresh_production', error: 'No fabric source variant linked to this made_to_order variant' }
  }

  // Find fabric stock at the preferred location or any location with stock
  const fabricPools = await db.inventoryPool.findMany({
    where: {
      orgVariantId: variant.fabricSourceVariantId,
      onHand: { gt: 0 },
    },
    include: { location: { select: { id: true, name: true } } },
  })

  const fabricLocation = preferredLocationId
    ? fabricPools.find((p) => p.locationId === preferredLocationId)
    : fabricPools[0]

  if (!fabricLocation || fabricLocation.onHand - fabricLocation.reserved < quantity) {
    return {
      source: 'fresh_production',
      error: `Insufficient fabric stock. Available: ${fabricLocation?.onHand ?? 0}, required: ${quantity}`,
    }
  }

  const fabricCost = Number(fabricLocation.avgCost) * quantity
  const estimatedCompletionDate = new Date()
  estimatedCompletionDate.setDate(estimatedCompletionDate.getDate() + (variant.productionDays || 5))

  // Consume fabric
  const txnResult = await processInventoryTransaction({
    orgVariantId: variant.fabricSourceVariantId,
    locationId: fabricLocation.locationId,
    organizationId: variant.organizationId,
    companyId,
    transactionType: 'fabric_consumed_for_stitching',
    quantity,
    costPerUnit: Number(fabricLocation.avgCost),
    referenceType: 'production_order',
  })

  if (!txnResult.success) {
    return { source: 'fresh_production', error: `Fabric consumption failed: ${txnResult.error}` }
  }

  // Create production order
  const productionOrder = await db.productionOrder.create({
    data: {
      organizationId: variant.organizationId,
      companyId,
      stitchedVariantId: orgVariantId,
      fabricVariantId: variant.fabricSourceVariantId,
      fabricLocationId: fabricLocation.locationId,
      quantity,
      status: 'fabric_reserved',
      stitchingCost: new Decimal(Number(variant.stitchingCharges) || 0),
      fabricCost: new Decimal(fabricCost),
      estimatedCompletionDate,
      fabricTxnId: txnResult.transactionId ?? null,
    } as Prisma.ProductionOrderUncheckedCreateInput,
  })

  return {
    source: 'fresh_production',
    productionOrderId: productionOrder.id,
    estimatedCompletionDate,
  }
}

/**
 * Quarantine stock for theft/missing loss investigations.
 * Directly increments inventory_pools.reserved — does NOT call
 * process_inventory_transaction() since no actual movement has occurred.
 * This is a soft-hold that reduces available stock without touching on_hand.
 */
export async function quarantineStock(
  orgVariantId: string,
  locationId: string,
  quantity: number,
): Promise<{ success: boolean; error?: string }> {
  const pool = await db.inventoryPool.findUnique({
    where: { orgVariantId_locationId: { orgVariantId, locationId } },
  })
  if (!pool) {
    return { success: false, error: 'No inventory pool exists for this variant+location.' }
  }
  const available = pool.onHand - pool.reserved
  if (available < quantity) {
    return { success: false, error: `Insufficient available stock. Available: ${available}, required: ${quantity}.` }
  }
  await db.inventoryPool.update({
    where: { id: pool.id },
    data: { reserved: { increment: quantity } },
  })
  return { success: true }
}

/**
 * Release quarantined stock (reverse of quarantineStock).
 * Directly decrements inventory_pools.reserved.
 * Used when resolving theft/missing investigations (regardless of outcome —
 * the write_off path creates a separate transaction that decrements on_hand).
 */
export async function releaseQuarantine(
  orgVariantId: string,
  locationId: string,
  quantity: number,
): Promise<void> {
  const pool = await db.inventoryPool.findUnique({
    where: { orgVariantId_locationId: { orgVariantId, locationId } },
  })
  if (!pool) return
  const newReserved = Math.max(0, pool.reserved - quantity)
  await db.inventoryPool.update({
    where: { id: pool.id },
    data: { reserved: newReserved },
  })
}

// ──────────────────────────────────────────────────────────────
// OMS hooks — reservation / unreservation / dispatch
// ──────────────────────────────────────────────────────────────
// These are thin wrappers around processInventoryTransaction() that
// the Order Management System calls at specific lifecycle points.
// They were stubbed in the original Inventory design and are now
// implemented for OMS Step 3.

/**
 * Reserve stock for an order item. Increments inventory_pools.reserved
 * (does NOT touch on_hand — that happens at dispatch time). Records
 * an order_reserved transaction in the ledger.
 *
 * @returns { success, error? } — fails if insufficient available stock.
 */
export async function reserveStockForOrder(input: {
  orgVariantId: string
  locationId: string
  organizationId: string
  companyId: string
  employeeId?: string | null
  quantity: number
  orderId?: string
}): Promise<{ success: boolean; error?: string }> {
  // Check available stock first (available = onHand - reserved)
  const pool = await db.inventoryPool.findUnique({
    where: {
      orgVariantId_locationId: {
        orgVariantId: input.orgVariantId,
        locationId: input.locationId,
      },
    },
  })
  if (!pool) {
    return { success: false, error: 'No inventory pool exists for this variant+location.' }
  }
  const available = pool.onHand - pool.reserved
  if (available < input.quantity) {
    return {
      success: false,
      error: `Insufficient available stock. Available: ${available}, required: ${input.quantity}.`,
    }
  }

  const result = await processInventoryTransaction({
    orgVariantId: input.orgVariantId,
    locationId: input.locationId,
    organizationId: input.organizationId,
    companyId: input.companyId,
    employeeId: input.employeeId,
    transactionType: 'order_reserved',
    quantity: input.quantity,
    referenceType: 'order',
    referenceId: input.orderId,
  })

  if (!result.success) {
    return { success: false, error: result.error }
  }
  return { success: true }
}

/**
 * Unreserve stock for an order item (e.g. on order cancellation).
 * Decrements inventory_pools.reserved. Records an order_unreserved
 * transaction. Does NOT touch on_hand.
 */
export async function unreserveStockForOrder(input: {
  orgVariantId: string
  locationId: string
  organizationId: string
  companyId: string
  employeeId?: string | null
  quantity: number
  orderId?: string
}): Promise<{ success: boolean; error?: string }> {
  const result = await processInventoryTransaction({
    orgVariantId: input.orgVariantId,
    locationId: input.locationId,
    organizationId: input.organizationId,
    companyId: input.companyId,
    employeeId: input.employeeId,
    transactionType: 'order_unreserved',
    quantity: input.quantity,
    referenceType: 'order',
    referenceId: input.orderId,
  })

  if (!result.success) {
    return { success: false, error: result.error }
  }
  return { success: true }
}

/**
 * Dispatch stock for an order item — deducts on_hand AND releases
 * the reservation. Records a sale_dispatched transaction. COGS is
 * locked at the pool's current avg_cost.
 */
export async function dispatchOrder(input: {
  orgVariantId: string
  locationId: string
  organizationId: string
  companyId: string
  employeeId?: string | null
  quantity: number
  orderId?: string
}): Promise<{ success: boolean; error?: string }> {
  const result = await processInventoryTransaction({
    orgVariantId: input.orgVariantId,
    locationId: input.locationId,
    organizationId: input.organizationId,
    companyId: input.companyId,
    employeeId: input.employeeId,
    transactionType: 'sale_dispatched',
    quantity: input.quantity,
    costPerUnit: null, // uses current avg_cost (locked at dispatch time)
    referenceType: 'order',
    referenceId: input.orderId,
  })

  if (!result.success) {
    return { success: false, error: result.error }
  }
  return { success: true }
}

/**
 * Restock inventory for an RTO (Return To Origin) order — session-free
 * version for use by courier polling jobs and webhooks (which have no user
 * session and therefore can't call processOrderReturn() which uses
 * getWorkspace()).
 *
 * For each DISPATCHED order item:
 *   - Looks up the original sale_dispatched transaction to recover the
 *     cost-per-unit that was locked at dispatch time.
 *   - Calls processInventoryTransaction with type 'return_resellable'
 *     (for stock_based items) or 'return_stitched_received' (for
 *     made_to_order items) — which increments onHand AND recalculates WAC.
 *   - Marks the order item with fulfillmentStatus='returned' +
 *     autoProcessedAsPerfect=true + needsReview=true so it surfaces in the
 *     exception-review queue for physical spot-checking (same as the manual
 *     processOrderReturn path).
 *
 * For CONFIRMED/PROCESSING (not-yet-dispatched) reserved items: calls
 * unreserveStockForOrder to release the reservation (no onHand change since
 * onHand was never decremented).
 *
 * This function is IDEMPOTENT — it skips items whose fulfillmentStatus is
 * already 'returned' (set by a prior restock call) so re-running a poll
 * cycle doesn't double-restock.
 *
 * @returns { success, itemsRestocked } — never throws (errors logged per-item).
 */
export async function restockOrderForRto(
  orderId: string,
  context: {
    organizationId: string
    companyId: string
    employeeId?: string | null
    returnReason?: string
  },
): Promise<{ success: boolean; itemsRestocked: number }> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      dispatchLocationId: true,
      organizationId: true,
      companyId: true,
      items: {
        include: {
          orgVariant: {
            select: { id: true, sku: true, costPrice: true, fulfillmentType: true },
          },
        },
      },
    },
  })
  if (!order) return { success: false, itemsRestocked: 0 }

  const locationId = order.dispatchLocationId
  if (!locationId) {
    console.error(`[restockOrderForRto] Order ${orderId} has no dispatchLocationId — cannot restock`)
    return { success: false, itemsRestocked: 0 }
  }

  let itemsRestocked = 0

  for (const item of order.items) {
    // Idempotency: skip items already processed (fulfillmentStatus='returned')
    if (item.fulfillmentStatus === 'returned') continue

    if (item.fulfillmentStatus === 'dispatched') {
      // Dispatched item — onHand was decremented at dispatch. Restock it.
      // Recover the cost-per-unit from the original sale_dispatched txn.
      const dispatchTxn = await db.inventoryTransaction.findFirst({
        where: {
          orgVariantId: item.orgVariantId,
          locationId,
          transactionType: 'sale_dispatched',
          referenceType: 'order',
          referenceId: orderId,
        },
        select: { costPerUnit: true },
        orderBy: { recordedAt: 'desc' },
      })
      const costPerUnit = dispatchTxn ? Number(dispatchTxn.costPerUnit) : Number(item.orgVariant.costPrice)

      const txnType = item.fulfillmentTypeSnapshot === 'made_to_order'
        ? 'return_stitched_received'
        : 'return_resellable'

      const txnResult = await processInventoryTransaction({
        orgVariantId: item.orgVariantId,
        locationId,
        organizationId: order.organizationId,
        companyId: order.companyId,
        employeeId: context.employeeId ?? null,
        transactionType: txnType,
        quantity: item.quantity,
        costPerUnit,
        referenceType: 'order',
        referenceId: orderId,
        notes: `Auto-processed RTO return (assumed ${txnType === 'return_resellable' ? 'resellable' : 'perfect'}). Reason: ${context.returnReason ?? 'courier returned'}`,
      })

      if (txnResult.success) {
        await db.orderItem.update({
          where: { id: item.id },
          data: {
            fulfillmentStatus: 'returned',
            autoProcessedAsPerfect: true,
            needsReview: true,
          },
        })
        itemsRestocked++
      } else {
        console.error(`[restockOrderForRto] Failed to restock item ${item.id}: ${txnResult.error}`)
      }
    } else if (item.fulfillmentStatus === 'reserved') {
      // Reserved but not dispatched — just release the reservation.
      const unreserveResult = await unreserveStockForOrder({
        orgVariantId: item.orgVariantId,
        locationId,
        organizationId: order.organizationId,
        companyId: order.companyId,
        employeeId: context.employeeId ?? null,
        quantity: item.quantity,
        orderId,
      })
      if (unreserveResult.success) {
        await db.orderItem.update({
          where: { id: item.id },
          data: { fulfillmentStatus: 'returned' },
        })
        itemsRestocked++
      } else {
        console.error(`[restockOrderForRto] Failed to unreserve item ${item.id}: ${unreserveResult.error}`)
      }
    }
    // backordered / pending items: no inventory action needed
  }

  return { success: true, itemsRestocked }
}
