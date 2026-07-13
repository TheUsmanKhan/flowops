/**
 * Fulfillment & stitching type constants for FlowOps products.
 * Maps to Shopify's inventory_management + inventory_policy fields.
 */

export const FULFILLMENT_TYPES = {
  STOCK_BASED: 'stock_based',
  MADE_TO_ORDER: 'made_to_order',
} as const

export const STITCHING_TYPES = {
  UNSTITCHED: 'unstitched',
  BASIC: 'stitched_basic',
  HEAVY: 'stitched_heavy',
  CUSTOM: 'custom_order',
} as const

export const FULFILLMENT_LABELS: Record<string, string> = {
  stock_based: 'Stock Tracked',
  made_to_order: 'Made to Order',
}

export const STITCHING_LABELS: Record<string, string> = {
  unstitched: 'Unstitched',
  stitched_basic: 'Basic Stitching',
  stitched_heavy: 'Heavy Embroidery',
  custom_order: 'Custom Order',
}

export const STITCHING_SHORT: Record<string, string> = {
  unstitched: 'UN',
  stitched_basic: 'BASIC',
  stitched_heavy: 'HVY',
  custom_order: 'CUST',
}

export const PRODUCT_TYPES = ['simple', 'variable', 'bundle', 'service'] as const
export const PRODUCT_SCOPES = ['private', 'organization', 'selective', 'archived'] as const

export const PRODUCT_SCOPE_LABELS: Record<string, string> = {
  private: 'Private',
  organization: 'Organization',
  selective: 'Selective',
  archived: 'Archived',
}

export const PRODUCT_TYPE_LABELS: Record<string, string> = {
  simple: 'Simple',
  variable: 'Variable',
  bundle: 'Bundle',
  service: 'Service',
}

/** Shopify inventory_management mapping. */
export function getShopifyInventoryManagement(
  fulfillmentType: string,
): string | null {
  return fulfillmentType === 'stock_based' ? 'shopify' : null
}

/** Shopify inventory_policy mapping. */
export function getShopifyInventoryPolicy(
  fulfillmentType: string,
  allowBackorder = false,
): 'deny' | 'continue' {
  if (fulfillmentType !== 'stock_based') return 'continue'
  return allowBackorder ? 'continue' : 'deny'
}

/** Sync fulfillment_type ↔ inventory_policy. */
export function syncInventoryPolicy(
  fulfillmentType: string,
  allowBackorder = false,
): string {
  if (fulfillmentType === 'stock_based') {
    return allowBackorder ? 'continue' : 'deny'
  }
  return 'continue'
}

/** Standard clothing sizes for the variant builder. */
export const STANDARD_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']

/** Production days defaults per stitching type. */
export const DEFAULT_PRODUCTION_DAYS: Record<string, number> = {
  unstitched: 0,
  stitched_basic: 5,
  stitched_heavy: 10,
  custom_order: 15,
}
