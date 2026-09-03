-- Migration 027: Stock-loss system unification — schema changes
--
-- Adds the columns needed to unify the stock-loss system across 8 disconnected
-- code paths. See STOCKLOSS_INVESTIGATION.md for the full design proposal.
--
-- Changes:
-- 1. StockLossRecord: add sourceModule (which module created the loss)
-- 2. StockLossRecord: add cycleCountItemId FK (link cycle count shortages to losses)
-- 3. StockLossRecord: add dedup partial unique index on (orderItemId, lossType, sourceModule)
--    WHERE orderItemId IS NOT NULL — prevents the same loss being recorded
--    twice for the same order item + loss type + source module.
-- 4. ReturnedStitchedInventory: add inventoryTxnId FK (link to the ledger
--    transaction that added the stock back, so the register and pool stay
--    in sync)
--
-- This migration is IDEMPOTENT — uses IF NOT EXISTS for all DDL.

-- ── 1. StockLossRecord.sourceModule ──
-- Tracks which module created the loss record:
--   'stock_loss' | 'rto' | 'cycle_count' | 'adjust_stock' |
--   'returned_stitched' | 'supplier_return' | 'exchange' | 'return_scan'
-- NULL for legacy rows (backwards-compatible — existing records pre-date this field).
ALTER TABLE "stock_loss_records"
  ADD COLUMN IF NOT EXISTS "sourceModule" TEXT;

-- ── 2. StockLossRecord.cycleCountItemId ──
-- FK to cycle_count_items.id — set when a cycle count shortage creates a loss.
-- Allows tracing "which cycle count item caused this loss record".
ALTER TABLE "stock_loss_records"
  ADD COLUMN IF NOT EXISTS "cycleCountItemId" TEXT;

-- Add the FK constraint (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'stock_loss_records_cycleCountItemId_fkey'
      AND table_name = 'stock_loss_records'
  ) THEN
    ALTER TABLE "stock_loss_records"
      ADD CONSTRAINT "stock_loss_records_cycleCountItemId_fkey"
      FOREIGN KEY ("cycleCountItemId") REFERENCES "cycle_count_items"("id")
      ON DELETE SET NULL;
  END IF;
END $$;

-- ── 3. Dedup partial unique index ──
-- Prevents the same loss being recorded twice for the same order item.
-- Only applies when orderItemId is NOT NULL (some losses aren't order-linked,
-- like warehouse damage with no specific order).
-- This is the KEY prevention mechanism for the double-decrement bug:
--   if a loss already exists for (orderItemId, lossType, sourceModule),
--   the second attempt will fail with a unique constraint error, which
--   recordStockLoss() catches and treats as a no-op (dedup success).
CREATE UNIQUE INDEX IF NOT EXISTS "stock_loss_orderitem_dedup_idx"
  ON "stock_loss_records" ("orderItemId", "lossType", "sourceModule")
  WHERE "orderItemId" IS NOT NULL;

-- ── 4. ReturnedStitchedInventory.inventoryTxnId ──
-- FK to inventory_transactions.id — links the returned-stitched register
-- to the ledger transaction that added the stock back to the pool.
-- When a returned-stitched record is created, the route also creates an
-- inventory_transaction (return_stitched_received) and stores its ID here.
-- This makes the register and the pool stay in sync — every register row
-- has a corresponding ledger entry.
ALTER TABLE "returned_stitched_inventory"
  ADD COLUMN IF NOT EXISTS "inventoryTxnId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'returned_stitched_inventory_inventoryTxnId_fkey'
      AND table_name = 'returned_stitched_inventory'
  ) THEN
    ALTER TABLE "returned_stitched_inventory"
      ADD CONSTRAINT "returned_stitched_inventory_inventoryTxnId_fkey"
      FOREIGN KEY ("inventoryTxnId") REFERENCES "inventory_transactions"("id")
      ON DELETE SET NULL;
  END IF;
END $$;

-- Index for sourceModule filtering (e.g. "show me all losses from cycle counts")
CREATE INDEX IF NOT EXISTS "stock_loss_source_module_idx"
  ON "stock_loss_records" ("sourceModule")
  WHERE "sourceModule" IS NOT NULL;
