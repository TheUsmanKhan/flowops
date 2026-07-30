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
