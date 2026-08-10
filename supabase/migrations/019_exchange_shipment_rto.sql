-- Migration 019: Exchange Shipment RTO support + order_exchanges terminal state
--
-- Adds 'rto' as a valid status for exchange_shipments (currently impossible —
-- the CHECK constraint only allows pending|confirmed|backordered|dispatched|
-- delivered|cancelled). This means when a courier returns a replacement-item
-- shipment, the system has no way to record that state.
--
-- Also adds 'exchange_item_returned' as a valid status for order_exchanges —
-- a terminal state indicating the replacement item was returned (RTO) and
-- requires manual follow-up. This is INTENTIONALLY terminal — no automatic
-- re-exchange/refund flow is triggered.
--
-- See worklog Task 27 for the full context.

-- ── exchange_shipments: add 'rto' to status CHECK ──────────────────────
-- Drop and recreate the CHECK constraint with 'rto' added.
ALTER TABLE exchange_shipments
  DROP CONSTRAINT IF EXISTS exchange_shipments_status_check;

ALTER TABLE exchange_shipments
  ADD CONSTRAINT exchange_shipments_status_check
  CHECK ("status" IN (
    'pending',
    'confirmed',
    'backordered',
    'dispatched',
    'delivered',
    'rto',
    'cancelled'
  ));

-- Add returnedAt timestamp (mirrors Order.returnedAt)
ALTER TABLE exchange_shipments
  ADD COLUMN IF NOT EXISTS "returnedAt" TIMESTAMPTZ;

-- ── order_exchanges: add 'exchange_item_returned' to status CHECK ──────
-- This is a terminal state for when the replacement item itself was returned
-- (RTO). It signals to staff that manual follow-up is needed — no automatic
-- re-exchange/refund is triggered.
ALTER TABLE order_exchanges
  DROP CONSTRAINT IF EXISTS order_exchanges_status_check;

ALTER TABLE order_exchanges
  ADD CONSTRAINT order_exchanges_status_check
  CHECK ("status" IN (
    'requested',
    'new_item_dispatched',
    'awaiting_old_item_return',
    'awaiting_customer_to_ship_old_item',
    'customer_confirmed_shipped',
    'old_item_manually_verified',
    'completed',
    'customer_did_not_return',
    'exchange_item_returned',
    'cancelled'
  ));

-- ── Update the not_returned_implies_status constraint ──────────────────
-- The existing constraint says: if markedAsNotReturned=true, status must be
-- 'customer_did_not_return'. This is unaffected by the new status — no change
-- needed. But let's verify it still holds (it does, since
-- 'exchange_item_returned' is unrelated to markedAsNotReturned).

-- ── Prisma schema sync note ────────────────────────────────────────────
-- The Prisma schema (schema.prisma) ExchangeShipment model status comment
-- and OrderExchange status comment will be updated separately to reflect
-- the new valid values. The DB-level CHECK is the authoritative constraint.
