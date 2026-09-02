-- Migration 018: Add 'exchange_shipment' to IntegrationActionLog.relatedEntityType CHECK
--
-- The original migration 004 only allowed ('order', 'product'). The exchange
-- shipment booking flow (from /api/booking-workbench/book route and the
-- PostEx polling job) passes 'exchange_shipment' as the relatedEntityType,
-- which caused a silent CHECK violation — the INSERT failed inside
-- executeLoggedIntegrationAction's try/catch, so the parent operation
-- succeeded but the audit log row was permanently lost.
--
-- This migration adds 'exchange_shipment' to the allowed values.
--
-- NOTE: Any audit-log entries for exchange_shipment actions that occurred
-- BEFORE this fix are permanently lost — the INSERT failed silently.
-- This cannot be recovered, only prevented going forward.

ALTER TABLE "integration_action_logs" DROP CONSTRAINT IF EXISTS "integration_action_logs_relatedEntityType_check";
ALTER TABLE "integration_action_logs" ADD CONSTRAINT "integration_action_logs_relatedEntityType_check"
  CHECK ("relatedEntityType" IS NULL OR "relatedEntityType" IN ('order','product','exchange_shipment'));
