/**
 * Unified Stock-Loss Recording Helper.
 *
 * This is the SINGLE entry point for all stock-loss creation across the
 * entire system. Every module that decreases stock due to damage/theft/
 * loss/transit-issue MUST call this function — NOT create StockLossRecord
 * rows directly.
 *
 * WHY THIS EXISTS:
 *   Before this helper, stock loss was created in 8 disconnected code paths
 *   (Stock Losses module, RTO flow, cycle count, adjust stock, returned-
 *   stitched, exchange, supplier return, return scan). This caused:
 *     - Double-decrements (same loss recorded twice in different modules)
 *     - Missing records (cycle count/adjust stock decremented onHand but
 *       created no StockLossRecord → Stock Losses dashboard under-reported)
 *     - No order linking (courier losses had no way to reference the order)
 *
 * DEDUP MECHANISM:
 *   The `stock_loss_orderitem_dedup_idx` partial unique index on
 *   (orderItemId, lossType, sourceModule) WHERE orderItemId IS NOT NULL
 *   prevents the same loss from being recorded twice for the same order
 *   item + loss type + source module. If a duplicate is attempted, this
 *   function catches the unique-constraint error and returns success=true
 *   with wasDuplicate=true (idempotent — the loss was already recorded,
 *   no action needed).
 *
 * Usage:
 *   import { recordStockLoss } from '@/lib/stock-loss'
 *   const result = await recordStockLoss({
 *     organizationId, companyId, orgVariantId, locationId,
 *     lossType: 'damaged',
 *     sourceModule: 'cycle_count',
 *     quantity: 2,
 *     costPerUnit: 500,
 *     orderItemId: '...', // optional — enables dedup
 *     cycleCountItemId: '...', // optional — for cycle count traceability
 *     employeeId: '...',
 *     notes: 'Cycle count found 2 damaged',
 *   })
 *   if (result.wasDuplicate) {
 *     // Loss already recorded for this order item — no action needed
 *   }
 */

import { db } from '@/lib/db'

export type StockLossSourceModule =
  | 'stock_loss'           // dedicated Stock Losses module
  | 'rto'                  // RTO flow in Orders
  | 'cycle_count'          // cycle count shortage
  | 'adjust_stock'         // manual negative adjustment
  | 'returned_stitched'    // returned-stitched module
  | 'supplier_return'       // supplier return dispute
  | 'exchange'              // exchange old-item loss
  | 'return_scan'           // inline from return order scan

export type StockLossType =
  | 'damaged'
  | 'theft'
  | 'missing'
  | 'transit_loss'
  | 'supplier_dispute'

export interface RecordStockLossInput {
  organizationId: string
  companyId: string
  orgVariantId: string
  locationId: string

  /** Type of loss — drives the inventory transaction type created. */
  lossType: StockLossType
  /** Which module is creating this loss record (for dedup + filtering). */
  sourceModule: StockLossSourceModule

  /** How many units were lost/damaged. Must be positive. */
  quantity: number
  /** Cost per unit (used for WAC + total loss value). */
  costPerUnit: number

  /** The order item this loss is linked to (enables dedup). Optional —
   * some losses aren't order-linked (e.g. warehouse damage). */
  orderItemId?: string | null
  /** The cycle count item this shortage came from (traceability). */
  cycleCountItemId?: string | null

  /** Who is reporting/recording this loss. */
  employeeId: string

  // ── Loss detail fields (all optional, used by the dedicated Stock Losses
  //    module form; other modules like cycle count pass only what they have) ──
  subType?: string | null              // confirmed | suspected | admin_error | manufacturing
  damageType?: string | null           // water_moisture | physical_impact | ...
  responsibleParty?: string | null     // warehouse | courier | customer | employee | unknown | supplier
  notes?: string | null

  /** Whether to also create the inventory transaction (decrement onHand).
   * Default true. Set false if the caller already decremented onHand
   * (e.g. cycle_count_adjust already set onHand — we just need the loss
   * record for tracking, no additional stock movement). */
  createInventoryTransaction?: boolean
}

export interface RecordStockLossResult {
  success: boolean
  lossRecordId?: string
  inventoryTxnId?: string | null
  /** True if a loss record already existed for this (orderItemId, lossType,
   * sourceModule) — the call was a no-op (idempotent). This is NOT an error. */
  wasDuplicate?: boolean
  error?: string
}

/**
 * Record a stock loss — the unified entry point.
 *
 * Creates a StockLossRecord (+ optionally an InventoryTransaction that
 * decrements onHand). Uses the dedup unique index to prevent the same
 * loss from being recorded twice for the same order item + type + source.
 *
 * ATOMIC: the loss record + inventory transaction are created in sequence.
 * If the inventory transaction fails, the loss record is deleted (rollback).
 * If the loss record insert hits the dedup unique constraint, returns
 * wasDuplicate=true (idempotent success — no error thrown).
 */
export async function recordStockLoss(
  input: RecordStockLossInput,
): Promise<RecordStockLossResult> {
  const {
    organizationId,
    companyId,
    orgVariantId,
    locationId,
    lossType,
    sourceModule,
    quantity,
    costPerUnit,
    orderItemId = null,
    cycleCountItemId = null,
    employeeId,
    subType = null,
    damageType = null,
    responsibleParty = null,
    notes = null,
    createInventoryTransaction = true,
  } = input

  if (quantity <= 0) {
    return { success: false, error: 'Quantity must be positive.' }
  }

  // ── Map lossType → inventory transaction type ──
  const txnTypeMap: Record<StockLossType, string> = {
    damaged: 'damage_writeoff',
    theft: 'theft_writeoff',
    missing: 'missing_writeoff',
    transit_loss: 'transit_loss',
    supplier_dispute: 'supplier_return',
  }
  const txnType = txnTypeMap[lossType]

  // ── Step 1: Create the StockLossRecord ──
  // If orderItemId is set AND a loss already exists for
  // (orderItemId, lossType, sourceModule), the unique index will reject
  // the insert → we catch that and return wasDuplicate=true (idempotent).
  let lossRecord
  try {
    lossRecord = await db.stockLossRecord.create({
      data: {
        organizationId,
        companyId,
        orgVariantId,
        locationId,
        lossType,
        subType,
        damageType,
        quantity,
        costPerUnit,
        responsibleParty,
        notes,
        reportedById: employeeId,
        sourceModule,
        orderItemId,
        cycleCountItemId,
        investigationStatus: sourceModule === 'stock_loss' ? 'none' : 'closed',
        resolution: sourceModule === 'stock_loss' ? null : 'written_off',
      },
    })
  } catch (err: unknown) {
    // Check if this is the dedup unique-constraint error (code P2002)
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('stock_loss_orderitem_dedup_idx') || msg.includes('Unique constraint failed')) {
      // Idempotent success — loss already recorded for this order item + type + source
      return {
        success: true,
        wasDuplicate: true,
        lossRecordId: null,
        inventoryTxnId: null,
      }
    }
    // Real error — propagate
    return {
      success: false,
      error: `Failed to create stock loss record: ${msg.slice(0, 100)}`,
    }
  }

  // ── Step 2: Create the inventory transaction (decrement onHand) ──
  if (!createInventoryTransaction) {
    return {
      success: true,
      lossRecordId: lossRecord.id,
      inventoryTxnId: null,
      wasDuplicate: false,
    }
  }

  let inventoryTxnId: string | null = null
  try {
    const { processInventoryTransaction } = await import('@/lib/inventory')
    const txnResult = await processInventoryTransaction({
      orgVariantId,
      locationId,
      organizationId,
      companyId,
      employeeId,
      transactionType: txnType as any,
      quantity,
      costPerUnit,
      referenceType: 'stock_loss',
      referenceId: lossRecord.id,
      notes: notes || `Stock loss (${lossType}) from ${sourceModule}`,
    })

    if (!txnResult.success) {
      // Inventory transaction failed — rollback the loss record so we
      // don't have a loss record with no stock movement.
      await db.stockLossRecord.delete({ where: { id: lossRecord.id } }).catch(() => {})
      return {
        success: false,
        error: `Inventory transaction failed: ${txnResult.error}. Loss record rolled back.`,
      }
    }

    inventoryTxnId = txnResult.transactionId ?? null

    // Link the inventory transaction back to the loss record
    if (inventoryTxnId) {
      await db.stockLossRecord.update({
        where: { id: lossRecord.id },
        data: { inventoryTxnId },
      })
    }

    return {
      success: true,
      lossRecordId: lossRecord.id,
      inventoryTxnId,
      wasDuplicate: false,
    }
  } catch (err: unknown) {
    // Inventory transaction threw — rollback the loss record
    await db.stockLossRecord.delete({ where: { id: lossRecord.id } }).catch(() => {})
    return {
      success: false,
      error: `Inventory transaction error: ${err instanceof Error ? err.message.slice(0, 100) : 'unknown'}. Loss record rolled back.`,
    }
  }
}

/**
 * Check if a loss record already exists for a given order item + loss type +
 * source module. Useful for pre-flight checks before attempting to record
 * a loss (e.g. in the RTO flow — "was this damage already recorded?").
 *
 * Returns true if a loss exists (don't record again).
 */
export async function lossExistsForOrderItem(
  orderItemId: string,
  lossType: StockLossType,
  sourceModule: StockLossSourceModule,
): Promise<boolean> {
  const count = await db.stockLossRecord.count({
    where: {
      orderItemId,
      lossType,
      sourceModule,
    },
  })
  return count > 0
}
