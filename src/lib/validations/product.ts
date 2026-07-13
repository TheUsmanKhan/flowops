import { z } from 'zod'

/**
 * Product & Variant validation schemas.
 * Shopify-compatible: max 3 attribute keys per variant.
 */

export const variantSchema = z.object({
  sku: z.string().min(1, 'SKU is required').max(100),
  barcode: z.string().max(100).optional().or(z.literal('')),
  attribute_values: z.record(z.string(), z.string()).default({}),
  // e.g. { "Size": "M", "Piece Type": "Stitched" } — max 3 keys

  cost_price: z.number().min(0, 'Cost must be 0 or positive'),
  stitching_charges: z.number().min(0).default(0),
  compare_price: z.number().min(0).optional(),
  weight_grams: z.number().int().min(0).default(0),
  dimensions: z
    .object({
      length_cm: z.number().min(0).optional(),
      width_cm: z.number().min(0).optional(),
      height_cm: z.number().min(0).optional(),
    })
    .optional(),

  fulfillment_type: z.enum(['stock_based', 'made_to_order']).default('stock_based'),
  stitching_type: z
    .enum(['unstitched', 'stitched_basic', 'stitched_heavy', 'custom_order'])
    .optional(),
  production_days: z.number().int().min(0).default(0),
  allow_backorder: z.boolean().default(false),
  requires_shipping: z.boolean().default(true),
  is_taxable: z.boolean().default(true),
  is_active: z.boolean().default(true),
  is_default: z.boolean().default(false),

  // Per-company pricing (set by the creating company)
  sale_price: z.number().min(0, 'Sale price is required'),
})
export type VariantInput = z.infer<typeof variantSchema>

export const productSchema = z.object({
  title: z.string().min(1, 'Title is required').max(255),
  description: z.string().optional().or(z.literal('')),
  short_description: z.string().max(500).optional().or(z.literal('')),
  product_type: z.enum(['simple', 'variable', 'bundle', 'service']).default('variable'),
  category_id: z.string().optional().or(z.literal('')),
  brand_id: z.string().optional().or(z.literal('')),
  product_scope: z.enum(['private', 'organization', 'selective', 'archived']).default('private'),

  is_stitchable: z.boolean().default(false),
  stitching_base_price: z.number().min(0).default(0),
  has_size_variants: z.boolean().default(false),

  is_active: z.boolean().default(true),
  is_featured: z.boolean().default(false),

  variants: z.array(variantSchema).min(1, 'At least one variant is required'),
})
export type ProductInput = z.infer<typeof productSchema>

/** Generate-stitched helper input. */
export const generateStitchedSchema = z.object({
  product_slug: z.string().min(1),
  sizes: z.array(z.string()).default([]),
  stitching_types: z.array(z.enum(['stitched_basic', 'stitched_heavy', 'custom_order'])).min(1),
  base_fabric_cost: z.number().min(0),
  base_stitching: z.number().min(0),
  heavy_stitching: z.number().min(0),
  custom_stitching: z.number().min(0).default(0),
  include_unstitched: z.boolean().default(true),
})
export type GenerateStitchedInput = z.infer<typeof generateStitchedSchema>

/** Fulfillment cost logging input. */
export const logFulfillmentCostSchema = z.object({
  org_variant_id: z.string().min(1),
  order_reference: z.string().optional().or(z.literal('')),
  fabric_cost: z.number().min(0),
  stitching_cost: z.number().min(0),
  embroidery_cost: z.number().min(0).default(0),
  other_cost: z.number().min(0).default(0),
  sale_price: z.number().min(0),
  tailor_name: z.string().optional().or(z.literal('')),
  notes: z.string().optional().or(z.literal('')),
})
export type LogFulfillmentCostInput = z.infer<typeof logFulfillmentCostSchema>
