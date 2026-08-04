-- ============================================================================
-- FlowOps — Fix PostEx integration_providers seed data
-- ============================================================================
-- Updates the PostEx provider row to reflect confirmed API behavior:
--   1. supportsWebhook = FALSE (PostEx does NOT support webhooks — use polling)
--   2. Remove 'calculate_rate' from capabilities (PostEx does NOT provide a rate API)
--   3. Update configSchema key from 'api_token' to 'token' (matches the adapter)
-- ============================================================================

BEGIN;

UPDATE integration_providers
SET
  "supportsWebhook" = FALSE,
  capabilities = '["book_shipment","track_shipment","cancel_shipment","track_shipment_bulk","generate_load_sheet","fetch_operational_cities","create_pickup_address","fetch_existing_pickup_addresses"]'::jsonb,
  "configSchema" = '[{"key":"token","label":"API Token","type":"password","required":true}]'::jsonb
WHERE "providerKey" = 'postex';

COMMIT;
