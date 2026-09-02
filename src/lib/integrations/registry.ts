import type { CourierAdapter, EcommerceAdapter } from './types'
import { TcsAdapter } from './couriers/tcs.adapter'
import { LeopardAdapter } from './couriers/leopard.adapter'
import { PostExAdapter } from './couriers/postex.adapter'
import { ShopifyAdapter } from './ecommerce/shopify.adapter'
import { DarazAdapter } from './ecommerce/daraz.adapter'

/**
 * Adapter Registry (Factory).
 *
 * Returns the correct adapter instance based on providerKey. The rest of
 * the application calls these functions — never instantiates adapter
 * classes directly — so the selection mechanism is centralized here.
 *
 * Each adapter receives the decrypted credentials at construction time;
 * the adapter's methods use those credentials to make provider-specific
 * API calls (in real implementations; stubs just throw "not implemented").
 */

const COURIER_FACTORIES: Record<string, (creds: Record<string, string>) => CourierAdapter> = {
  tcs: (creds) => new TcsAdapter(creds),
  leopard: (creds) => new LeopardAdapter(creds),
  postex: (creds) => new PostExAdapter(creds),
}

const ECOMMERCE_FACTORIES: Record<string, (creds: Record<string, string>) => EcommerceAdapter> = {
  shopify: (creds) => new ShopifyAdapter(creds),
  daraz: (creds) => new DarazAdapter(creds),
}

// ──────────────────────────────────────────────────────────────
// Adapter implementation status registry
// ──────────────────────────────────────────────────────────────
//
// Tracks whether each provider's adapter is a REAL implementation or still a
// STUB. Used by the Integrations settings page to show accurate status text
// per provider (instead of the old hardcoded "framework-only/stub" banner
// that incorrectly claimed ALL adapters were stubs).
//
// Values:
//   'live'            — real adapter, all core methods implemented + tested
//                       against the live API. API calls work end-to-end.
//   'framework_ready' — adapter class exists but methods throw "not yet
//                       implemented". Credentials can be saved, but API calls
//                       will fail. Ready to be filled in by a later prompt.
//   'stub'            — no adapter class exists yet (should not happen for
//                       registered providers, but included for completeness).
//
// Update this map when an adapter is upgraded from stub to real.

export type AdapterStatus = 'live' | 'framework_ready' | 'stub'

const COURIER_ADAPTER_STATUS: Record<string, AdapterStatus> = {
  postex: 'live',             // Real implementation — bookShipment, trackShipment, fetchOperationalCities, etc.
  leopard: 'live',            // Real implementation — bookShipment, trackShipment, fetchOperationalCities, createShipper, etc.
  tcs: 'framework_ready',     // Stub — methods throw "not yet implemented". Ready for later prompts.
}

const ECOMMERCE_ADAPTER_STATUS: Record<string, AdapterStatus> = {
  shopify: 'framework_ready', // Stub
  daraz: 'framework_ready',   // Stub
}

/**
 * Get the implementation status of a provider's adapter.
 * Returns 'stub' for unrecognized provider keys.
 */
export function getAdapterStatus(providerKey: string): AdapterStatus {
  if (providerKey in COURIER_ADAPTER_STATUS) return COURIER_ADAPTER_STATUS[providerKey]
  if (providerKey in ECOMMERCE_ADAPTER_STATUS) return ECOMMERCE_ADAPTER_STATUS[providerKey]
  return 'stub'
}

/**
 * Get the courier adapter for a given provider key.
 * Throws a clear error for unrecognized provider keys.
 */
export function getCourierAdapter(
  providerKey: string,
  credentials: Record<string, string>,
): CourierAdapter {
  const factory = COURIER_FACTORIES[providerKey]
  if (!factory) {
    throw new Error(
      `No courier adapter registered for provider key '${providerKey}'. ` +
        `Registered: ${Object.keys(COURIER_FACTORIES).join(', ')}`,
    )
  }
  return factory(credentials)
}

/**
 * Get the ecommerce adapter for a given provider key.
 * Throws a clear error for unrecognized provider keys.
 */
export function getEcommerceAdapter(
  providerKey: string,
  credentials: Record<string, string>,
): EcommerceAdapter {
  const factory = ECOMMERCE_FACTORIES[providerKey]
  if (!factory) {
    throw new Error(
      `No ecommerce adapter registered for provider key '${providerKey}'. ` +
        `Registered: ${Object.keys(ECOMMERCE_FACTORIES).join(', ')}`,
    )
  }
  return factory(credentials)
}

/**
 * Check whether a provider key has a registered adapter (courier or ecommerce).
 * Used by the webhook route to determine how to route the payload.
 */
export function getAdapterCategory(providerKey: string): 'courier' | 'ecommerce' | null {
  if (providerKey in COURIER_FACTORIES) return 'courier'
  if (providerKey in ECOMMERCE_FACTORIES) return 'ecommerce'
  return null
}
