-- ============================================================================
-- FlowOps — Exchange Refund Tracking + Delivery Charge Folding
-- ============================================================================
-- Phase 1: Schema additions for exchange financial flows.
--
-- 1. CompanyOrderSetting.deductDeliveryChargeFromRefund (Boolean, default false)
--    Controls whether the delivery charge is deducted from the customer's
--    refund amount in a refund_due scenario.
--
-- 2. order_exchanges refund tracking fields:
--    refundMethod, refundReference, refundProcessedAt, refundProcessedBy, refundAmount
--    These track the actual refund payout when the business owes the customer.
-- ============================================================================

BEGIN;

ALTER TABLE "CompanyOrderSetting"
  ADD COLUMN IF NOT EXISTS "deductDeliveryChargeFromRefund" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE order_exchanges
  ADD COLUMN IF NOT EXISTS "refundMethod" TEXT
    CHECK ("refundMethod" IS NULL OR "refundMethod" IN ('cash', 'bank_transfer', 'store_credit', 'other')),
  ADD COLUMN IF NOT EXISTS "refundReference" TEXT,
  ADD COLUMN IF NOT EXISTS "refundProcessedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "refundProcessedBy" TEXT REFERENCES "Employee"(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "refundAmount" DECIMAL(14,2);

COMMIT;
