import { db } from './db'
import { Decimal } from '@prisma/client/runtime/library'
import type { Prisma } from '@prisma/client'
import { insertAuditLog } from './audit'

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
 * ATOMICITY (INV-006 fix): Steps 1–7 are wrapped in a single
 * `db.$transaction` — either all writes commit, or none do. The
 * "ledger and pool always agree" guarantee now holds under partial failure.
 *
 * RESERVATION INVARIANT (INV-001 fix): For onHand-reducing transaction
 * types (cycle_count_adjust, damage_writeoff, theft_writeoff,
 * missing_writeoff, transit_loss, supplier_return,
 * fabric_consumed_for_stitching, transfer_out), if the new onHand drops
 * below the current reserved count, the newest-reserved OrderItems for
 * this variant+location are bumped to 'backordered' (oldest first
 * protected) until `reserved <= onHand` is restored. If bumping all
 * matching OrderItems still doesn't close the gap (ghost reservations
 * with no OrderItem row), newReserved is clamped to newOnHand and a
 * WARNING audit log is emitted.
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

/**
 * Transaction types that REDUCE onHand (rather than just moving it between
 * pools, like transfer_out which is also a reducer at the source pool).
 *
 * Used by the reservation-invariant protection (INV-001 fix): if any of
 * these transaction types drops `newOnHand < newReserved`, the
 * newest-reserved OrderItems at this variant+location are bumped to
 * 'backordered' until the invariant is restored.
 */
const ONHAND_REDUCING_TYPES: TransactionType[] = [
  'cycle_count_adjust',
  'damage_writeoff',
  'theft_writeoff',
  'missing_writeoff',
  'transit_loss',
  'supplier_return',
  'fabric_consumed_for_stitching',
  'transfer_out',
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
    // INV-006 fix: wrap the entire sequence (pool find/create → validate →
    // compute → optional reservation-bump → pool.update → ledger.create →
    // avgCostHistory.create) in a single database transaction. Either all
    // writes commit, or none do — restoring the "ledger and pool always
    // agree" guarantee claimed in the header comment.
    const result = await db.$transaction(async (tx) => {
      // 1. Find or create the inventory_pools row
      let pool = await tx.inventoryPool.findUnique({
        where: {
          orgVariantId_locationId: { orgVariantId, locationId },
        },
      })

      if (!pool) {
        // First transaction ever for this variant+location — create pool with zeros
        pool = await tx.inventoryPool.create({
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
          // Throw to abort the transaction — caught below and converted
          // back to a structured INSUFFICIENT_STOCK error response.
          throw new Error(
            `INSUFFICIENT_STOCK: Available ${available}, requested ${absQty}`,
          )
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

      // --- RESERVATION INVARIANT PROTECTION (INV-001 fix) ---
      // After computing newOnHand, check if reserved > onHand.
      // For onHand-reducing transaction types, this means the available pool
      // has dropped below the reservations held against it — bump the
      // newest-reserved OrderItems to 'backordered' (oldest protected).
      if (
        ONHAND_REDUCING_TYPES.includes(transactionType) &&
        newReserved > newOnHand
      ) {
        const shortfall = newReserved - newOnHand

        // Find reserved OrderItems for this variant+location, oldest first.
        // We iterate the list newest-first (reverse) to bump the most
        // recent reservations while protecting the earliest / oldest ones.
        const reservedItems = await tx.orderItem.findMany({
          where: {
            orgVariantId,
            reservedLocationId: locationId,
            fulfillmentStatus: 'reserved',
          },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            quantity: true,
            orderId: true,
            createdAt: true,
          },
        })

        let bumpedQty = 0
        const reviewReason = `Inventory shortage — converted to backorder (${transactionType}${referenceId ? ', ref: ' + referenceId : ''})`

        // Process newest first (end of the sorted-asc list)
        for (
          let i = reservedItems.length - 1;
          i >= 0 && bumpedQty < shortfall;
          i--
        ) {
          const item = reservedItems[i]

          // Unreserve: decrement newReserved by the full item quantity
          newReserved = Math.max(0, newReserved - item.quantity)

          // Set OrderItem to backordered + flag for human review
          await tx.orderItem.update({
            where: { id: item.id },
            data: {
              fulfillmentStatus: 'backordered',
              needsReview: true,
              needsReviewReason: reviewReason,
            },
          })

          // Recompute the parent order's aggregated status from line items
          await tx.$queryRaw`SELECT recompute_order_status(${item.orderId}::TEXT)`

          bumpedQty += item.quantity
        }

        // Edge case: still not enough — "ghost" reservations exist on the
        // pool with no matching OrderItem row (e.g. orphaned by a past bug
        // or manually injected). Clamp newReserved to newOnHand to restore
        // the invariant and emit a WARNING audit log so an operator can
        // investigate the discrepancy.
        if (newReserved > newOnHand) {
          const clampedReserved = newReserved
          const shortfallRemaining = clampedReserved - newOnHand
          newReserved = newOnHand

          insertAuditLog({
            action: 'inventory.reservation_clamp',
            entityType: 'inventory_pool',
            entityId: pool.id,
            organizationId,
            companyId,
            employeeId,
            oldValues: { reserved: clampedReserved, onHand: newOnHand },
            newValues: {
              reserved: newReserved,
              shortfallRemaining,
            },
            metadata: {
              transactionType,
              referenceType,
              referenceId,
              orgVariantId,
              locationId,
              shortfall,
              bumpedQty,
              reason: 'reservation_bump_exhausted_ghost_reservation',
            },
          })
        }
      }
      // --- END INV-001 fix ---

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

      await tx.inventoryPool.update({
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
        const variant = await tx.orgProductVariant.findUnique({
          where: { id: orgVariantId },
          select: { trackInventory: true, fulfillmentType: true },
        })
        if (variant && !variant.trackInventory && variant.fulfillmentType === 'made_to_order') {
          // ONE-WAY flip: FALSE → TRUE (never back to FALSE)
          await tx.orgProductVariant.update({
            where: { id: orgVariantId },
            data: { trackInventory: true },
          })
        }
      }

      // 7. Insert the inventory_transactions ledger row
      const txnQuantity = OUT_TYPES.includes(transactionType) ? -absQty : absQty
      const avgCostChanged = newAvgCost !== oldAvgCost

      const txn = await tx.inventoryTransaction.create({
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
        await tx.avgCostHistory.create({
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
    })

    return result
  } catch (err) {
    // INSUFFICIENT_STOCK is thrown from inside the transaction to force a
    // rollback. Convert it back to a structured error response (preserving
    // the original behavior callers depend on) without logging it as an
    // error — it is a validation failure, not a runtime fault.
    const msg = err instanceof Error ? err.message : 'Unknown inventory transaction error'
    if (msg.startsWith('INSUFFICIENT_STOCK:')) {
      return { success: false, error: msg }
    }
    console.error('[inventory] processInventoryTransaction error:', err)
    return { success: false, error: msg }
  }
}

// ──────────────────────────────────────────────────────────────
// INV-002 fix — canonical returned-stitched receipt processor
// ──────────────────────────────────────────────────────────────

export interface ProcessReturnedStitchedInput {
  organizationId: string
  companyId: string
  orgVariantId: string
  /** Required — the inventory location receiving the returned item.
   * Used to find/create the InventoryPool and link the InventoryTransaction
   * (non-damaged path) or the StockLossRecord (damaged path). */
  locationId: string
  quantity: number
  condition: 'perfect' | 'good' | 'open_box' | 'damaged'
  /** Total cost for all `quantity` units (costPerUnit = totalCost / quantity). */
  totalCost: number
  suggestedResalePrice?: number | null
  originalOrderReference?: string | null
  returnReason: string
  photos?: string[]
  notes?: string | null
  /** Employee creating the record — used as receivedById, writtenOffById
   * (damaged path), and reportedById (StockLossRecord, damaged path). */
  employeeId: string
}

export interface ProcessReturnedStitchedResult {
  success: boolean
  /** ReturnedStitchedInventory.id — always set on success. */
  recordId?: string
  /** InventoryTransaction.id — set on non-damaged path. NULL on damaged path
   * (no stock movement occurs — the returned item was never added to stock). */
  inventoryTxnId?: string | null
  /** StockLossRecord.id — set on damaged path. NULL on non-damaged path. */
  lossRecordId?: string | null
  /** 'available' for non-damaged, 'written_off' for damaged. */
  status?: 'available' | 'written_off'
  /** Damaged path only — true if the loss already existed (idempotent no-op). */
  wasDuplicate?: boolean
  error?: string
}

/**
 * Canonical returned-stitched receipt processor (INV-002 fix).
 *
 * Single entry point for receiving returned-stitched items — unifies the
 * previously split flow across two routes:
 *   - POST /api/returned-stitched                       (created register row only)
 *   - POST /api/inventory/receive-returned-stitched     (created txn only)
 *
 * Both routes now delegate here so that EVERY receipt creates BOTH the
 * ReturnedStitchedInventory register row AND the corresponding ledger /
 * loss entry, with the bidirectional link set:
 *
 *   Non-damaged path (condition ∈ perfect|good|open_box):
 *     1. Calls processInventoryTransaction({ type: 'return_stitched_received' })
 *        → increments onHand, recalculates WAC, flips track_inventory=TRUE
 *       on made_to_order variants (one-way).
 *     2. Creates ReturnedStitchedInventory with status='available' and
 *        inventoryTxnId=txn.id (the link).
 *
 *   Damaged path (condition = 'damaged'):
 *     1. Calls recordStockLoss({ createInventoryTransaction: false })
 *        → creates a StockLossRecord (dedup-safe, sourceModule='returned_stitched')
 *        but does NOT decrement onHand (the returned item was never added to
 *        stock, so there's nothing to remove — preserves the behavior of the
 *        existing /api/inventory/receive-returned-stitched damaged path).
 *     2. Creates ReturnedStitchedInventory with status='written_off',
 *        writtenOffAt=now, writtenOffById=employeeId, inventoryTxnId=NULL
 *        (no stock movement occurred).
 *
 * ATOMICITY: The register-row creation runs inside db.$transaction. Note
 * that processInventoryTransaction / recordStockLoss internally use the
 * global db client (not a passed-in tx), so they execute as SEPARATE
 * transactions — full cross-call atomicity would require refactoring those
 * helpers to accept a tx client (out of INV-002 scope, same caveat as the
 * INV-006 fix). The current arrangement matches the behavior of the
 * existing receive-returned-stitched route and is strictly better than the
 * prior split flow: the register row is now consistently created with the
 * link set, instead of being skipped entirely.
 */
export async function processReturnedStitchedReceipt(
  input: ProcessReturnedStitchedInput,
): Promise<ProcessReturnedStitchedResult> {
  const {
    organizationId,
    companyId,
    orgVariantId,
    locationId,
    quantity,
    condition,
    totalCost,
    suggestedResalePrice = null,
    originalOrderReference = null,
    returnReason,
    photos = [],
    notes = null,
    employeeId,
  } = input

  if (quantity <= 0) {
    return { success: false, error: 'Quantity must be positive.' }
  }

  const isDamaged = condition === 'damaged'
  const costPerUnit = totalCost / quantity

  try {
    if (isDamaged) {
      // ── Damaged path: record loss, no stock movement ──
      const { recordStockLoss } = await import('@/lib/stock-loss')
      const lossResult = await recordStockLoss({
        organizationId,
        companyId,
        orgVariantId,
        locationId,
        lossType: 'damaged',
        sourceModule: 'returned_stitched',
        quantity,
        costPerUnit,
        employeeId,
        subType: 'confirmed',
        damageType: 'other',
        responsibleParty: 'courier',
        notes: `Damaged returned stitched item. ${notes || ''}`,
        // createInventoryTransaction=false — this endpoint does NOT add
        // stock for damaged items (the loss is just recorded, stock stays
        // unchanged since the returned item was never added in the first place)
        createInventoryTransaction: false,
      })

      if (!lossResult.success) {
        return { success: false, error: `Failed to record damaged loss: ${lossResult.error}` }
      }

      // Create the ReturnedStitchedInventory register row with status='written_off'.
      // inventoryTxnId stays NULL — no stock movement occurred. Wrapped in
      // db.$transaction per the INV-002 spec (single write here, but the
      // wrapper documents the atomicity intent for future multi-write extensions).
      const record = await db.$transaction(async (tx) => {
        return tx.returnedStitchedInventory.create({
          data: {
            organizationId,
            companyId,
            orgVariantId,
            quantity,
            condition,
            totalCost,
            suggestedResalePrice,
            originalOrderReference,
            returnReason,
            status: 'written_off',
            photos: JSON.stringify(photos),
            notes,
            receivedById: employeeId,
            writtenOffAt: new Date(),
            writtenOffById: employeeId,
            writeOffReason: 'Damaged on return',
            inventoryTxnId: null,
          },
        })
      })

      return {
        success: true,
        recordId: record.id,
        inventoryTxnId: null,
        lossRecordId: lossResult.lossRecordId ?? null,
        status: 'written_off',
        wasDuplicate: lossResult.wasDuplicate,
      }
    }

    // ── Non-damaged path: increment stock via processInventoryTransaction ──
    const txnResult = await processInventoryTransaction({
      orgVariantId,
      locationId,
      organizationId,
      companyId,
      employeeId,
      transactionType: 'return_stitched_received',
      quantity,
      costPerUnit,
      referenceType: originalOrderReference ? 'order' : 'manual',
      referenceId: originalOrderReference || null,
      notes: `Returned stitched item (${condition}). ${notes || ''}`,
    })

    if (!txnResult.success) {
      return { success: false, error: `Failed to receive returned item: ${txnResult.error}` }
    }

    // Create the ReturnedStitchedInventory register row with status='available'
    // and link it to the inventory transaction id. Wrapped in db.$transaction
    // per the INV-002 spec.
    const record = await db.$transaction(async (tx) => {
      return tx.returnedStitchedInventory.create({
        data: {
          organizationId,
          companyId,
          orgVariantId,
          quantity,
          condition,
          totalCost,
          suggestedResalePrice,
          originalOrderReference,
          returnReason,
          status: 'available',
          photos: JSON.stringify(photos),
          notes,
          receivedById: employeeId,
          inventoryTxnId: txnResult.transactionId ?? null,
        },
      })
    })

    return {
      success: true,
      recordId: record.id,
      inventoryTxnId: txnResult.transactionId ?? null,
      lossRecordId: null,
      status: 'available',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown returned-stitched receipt error'
    console.error('[inventory] processReturnedStitchedReceipt error:', err)
    return { success: false, error: msg }
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
 * Generate a unique, sequential PO number per organization per year.
 *
 * Format: PO-YYYY-NNN (e.g. PO-2026-001, PO-2026-002, ...)
 *
 * ATOMIC & RACE-FREE: uses the get_next_sequence_number() Postgres function
 * which does INSERT ... ON CONFLICT DO UPDATE ... RETURNING in a single
 * atomic statement. Two concurrent calls will each get a DIFFERENT number
 * (guaranteed by Postgres's row-level locking).
 *
 * This REPLACES the old count+1 pattern which raced under concurrency —
 * two simultaneous PO creations would generate the same number, causing
 * a unique-constraint 500 error. See INVENTORY_AUDIT.md CRITICAL #2.
 *
 * The sequence counter persists in the number_sequences table, so it
 * survives restarts and is consistent across all server instances.
 */
export async function generatePoNumber(organizationId: string): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `PO-${year}-`

  const result = await db.$queryRaw<{ n: number }[]>`
    SELECT get_next_sequence_number(${organizationId}::TEXT, 'po_number', ${year}::INT) AS n
  `
  const seq = result[0].n

  return `${prefix}${String(seq).padStart(3, '0')}`
}

/**
 * Increment incoming stock on a pool (for PO ordering).
 * This is the ONLY function that writes to inventory_pools.incoming directly
 * — it's a live projection field, not a ledgered movement.
 * Creates the pool row if it doesn't exist.
 *
 * ATOMICITY (PO-011 / PO-013 fix): accepts an optional `tx` Prisma
 * transaction client. When passed, the upsert runs on the caller's
 * transaction so the increment commits/rolls back together with the
 * PO status update. When omitted, falls back to the global `db` client
 * (backwards-compatible with existing callers).
 */
export async function incrementIncomingStock(
  orgVariantId: string,
  locationId: string,
  organizationId: string,
  qty: number,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const client = tx ?? db
  await client.inventoryPool.upsert({
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
 *
 * ATOMICITY (PO-011 / PO-013 fix): accepts an optional `tx` Prisma
 * transaction client for the same reason as incrementIncomingStock().
 */
export async function decrementIncomingStock(
  orgVariantId: string,
  locationId: string,
  qty: number,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const client = tx ?? db
  const pool = await client.inventoryPool.findUnique({
    where: { orgVariantId_locationId: { orgVariantId, locationId } },
    select: { incoming: true },
  })
  if (!pool) return
  const newIncoming = Math.max(0, pool.incoming - qty)
  await client.inventoryPool.update({
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

  // INV-004 fix: previously the fabric_consumed_for_stitching
  // InventoryTransaction was created BEFORE the ProductionOrder record —
  // leaving the forward link (InventoryTransaction.referenceId →
  // ProductionOrder.id) NULL because the PO id didn't exist yet.
  // Now we create the ProductionOrder FIRST (with fabricTxnId=null),
  // then consume fabric with referenceId=productionOrder.id, then
  // backfill fabricTxnId on the ProductionOrder. All three writes are
  // wrapped in a db.$transaction so a failure in fabric consumption
  // rolls back the ProductionOrder creation (no orphan POs).
  // processInventoryTransaction internally uses db.$transaction (since
  // the INV-006 fix), which Prisma nests as a savepoint inside this
  // outer transaction.
  try {
    const result = await db.$transaction(async (tx) => {
      // 1. Create the ProductionOrder record (fabricTxnId is NULL
      //    at this point — backfilled in step 3).
      const po = await tx.productionOrder.create({
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
          fabricTxnId: null,
        } as Prisma.ProductionOrderUncheckedCreateInput,
      })

      // 2. Consume fabric with referenceId=po.id so the
      //    InventoryTransaction → ProductionOrder forward link is set
      //    at creation time (no subsequent mutation needed).
      const txnResult = await processInventoryTransaction({
        orgVariantId: variant.fabricSourceVariantId,
        locationId: fabricLocation.locationId,
        organizationId: variant.organizationId,
        companyId,
        transactionType: 'fabric_consumed_for_stitching',
        quantity,
        costPerUnit: Number(fabricLocation.avgCost),
        referenceType: 'production_order',
        referenceId: po.id,
      })

      if (!txnResult.success) {
        // Throwing aborts the outer db.$transaction, rolling back the
        // ProductionOrder.create above.
        throw new Error(`Fabric consumption failed: ${txnResult.error}`)
      }

      // 3. Backfill fabricTxnId on the ProductionOrder so the reverse
      //    link (ProductionOrder → InventoryTransaction) is set.
      await tx.productionOrder.update({
        where: { id: po.id },
        data: { fabricTxnId: txnResult.transactionId ?? null },
      })

      return po
    })

    return {
      source: 'fresh_production',
      productionOrderId: result.id,
      estimatedCompletionDate,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { source: 'fresh_production', error: message }
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
  /**
   * Optional metadata to attach to the sale_dispatched transaction at
   * creation time. Used by the exchange-shipment flow to tag txns with
   * `exchangeShipmentId` + `dispatch_source` for the idempotency check
   * (INV-005 fix — replaces the previous pattern of mutating the txn
   * post-creation via db.inventoryTransaction.updateMany, which violated
   * the append-only ledger contract).
   */
  metadata?: Record<string, unknown> | null
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
    metadata: input.metadata ?? null,
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
