-- Migration 029: Order status CHECK constraint
--
-- Adds a DB-level CHECK constraint on Order.status to prevent illegal
-- status values. Previously status was a free-form String with no DB
-- enforcement — a bug or future caller could set status='delivered'
-- directly on a pending order with no guardrail.
--
-- Allowed values: pending | confirmed | partially_backordered | processing |
-- dispatched | delivered | rto | cancelled | refunded
-- (matches the comment on Order.status in schema.prisma line ~1985)
--
-- Idempotent — drops + recreates the constraint.

DO $$
BEGIN
  -- Drop the old constraint if it exists
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'order_status_check'
      AND table_name = 'Order'
  ) THEN
    ALTER TABLE "Order" DROP CONSTRAINT order_status_check;
  END IF;

  -- Add the new constraint
  ALTER TABLE "Order" ADD CONSTRAINT order_status_check
    CHECK (status IN (
      'pending',
      'confirmed',
      'partially_backordered',
      'processing',
      'dispatched',
      'delivered',
      'rto',
      'cancelled',
      'refunded'
    ));
END $$;
