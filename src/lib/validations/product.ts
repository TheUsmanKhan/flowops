import { z } from 'zod'

/**
 * Product Catalog validation schemas.
 * Shopify-compatible: max 3 attribute keys per variant.
 */

// ──────────────────────────────────────────────────────────────
// CATALOG SETTINGS SCHEMAS
// ──────────────────────────────────────────────────────────────

export const categorySchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  parentId: z.string().optional().or(z.literal('')),
  imageUrl: z.string().url().optional().or(z.literal('')),
  displayOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
})
export type CategoryInput = z.infer<typeof categorySchema>

export const brandSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  logoUrl: z.string().url().optional().or(z.literal('')),
  isActive: z.boolean().default(true),
})
export type BrandInput = z.infer<typeof brandSchema>

export const attributeSchema = z.object({
  name: z.string().min(2).max(50),
  displayName: z.string().min(2).max(100),
  attributeType: z.enum(['select', 'color']).default('select'),
  displayOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
})
export type AttributeInput = z.infer<typeof attributeSchema>

export const attributeValueSchema = z.object({
  value: z.string().min(1).max(100),
  displayValue: z.string().min(1).max(50),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().or(z.literal('')),
  skuCode: z.string().max(50).optional().or(z.literal('')),
  displayOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
})
export type AttributeValueInput = z.infer<typeof attributeValueSchema>

// ──────────────────────────────────────────────────────────────
// VARIANT SCHEMA (with Shopify max-3-keys refinement)
// ──────────────────────────────────────────────────────────────

export const variantSchema = z
  .object({
    sku: z.string().min(1, 'SKU is required').max(100),
    barcode: z.string().max(100).optional().or(z.literal('')),
    attribute_values: z.record(z.string(), z.string()).default({}),
    cost_price: z.number().min(0, 'Cost must be 0 or positive'),
    fabric_cost: z.number().min(0).optional(),
    // fabric_cost is the raw fabric input; cost_price = fabric_cost + stitching_charges for made_to_order
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
    sale_price: z.number().min(0, 'Sale price is required'),
  })
  .superRefine((data, ctx) => {
    // Shopify limit: max 3 attribute keys
    const keys = Object.keys(data.attribute_values)
    if (keys.length > 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Variants can have at most 3 attributes (Shopify limit). This variant has ${keys.length}.`,
        path: ['attribute_values'],
      })
    }
    // stitching_type required when made_to_order + stitchable product
    // (the product-level is_stitchable check is done in the API route,
    //  but we enforce the consistency here too)
    if (data.fulfillment_type === 'made_to_order' && data.stitching_type) {
      if (data.stitching_type === 'unstitched') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'unstitched stitching_type must use stock_based fulfillment.',
          path: ['stitching_type'],
        })
      }
    }
  })
export type VariantInput = z.infer<typeof variantSchema>

// ──────────────────────────────────────────────────────────────
// PRODUCT SCHEMA
// ──────────────────────────────────────────────────────────────

export const productSchema = z.object({
  title: z.string().min(1, 'Title is required').max(255),
  base_sku: z.string().max(50).optional().or(z.literal('')),
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

/** Shell-only product creation (no variants in this step). */
export const createProductShellSchema = z.object({
  title: z.string().min(2, 'Title must be at least 2 characters').max(255),
  base_sku: z.string().max(50).optional().or(z.literal('')),
  description: z.string().optional().or(z.literal('')),
  short_description: z.string().max(500).optional().or(z.literal('')),
  product_type: z.enum(['simple', 'variable', 'bundle', 'service']).default('variable'),
  category_id: z.string().optional().or(z.literal('')),
  brand_id: z.string().optional().or(z.literal('')),
  is_stitchable: z.boolean().default(false),
  stitching_base_price: z.number().min(0).default(0),
  has_size_variants: z.boolean().default(false),
  is_featured: z.boolean().default(false),
})
export type CreateProductShellInput = z.infer<typeof createProductShellSchema>

export const updateProductSchema = z.object({
  title: z.string().min(2).max(255).optional(),
  base_sku: z.string().max(50).optional().or(z.literal('')),
  description: z.string().optional().or(z.literal('')),
  short_description: z.string().max(500).optional().or(z.literal('')),
  category_id: z.string().optional().or(z.literal('')),
  brand_id: z.string().optional().or(z.literal('')),
  is_stitchable: z.boolean().optional(),
  stitching_base_price: z.number().min(0).optional(),
  has_size_variants: z.boolean().optional(),
  is_active: z.boolean().optional(),
  is_featured: z.boolean().optional(),
})
export type UpdateProductInput = z.infer<typeof updateProductSchema>

// ──────────────────────────────────────────────────────────────
// VARIANT GENERATION (pure calculation)
// ──────────────────────────────────────────────────────────────

export const generateCombinationsSchema = z.object({
  selected_attributes: z
    .array(
      z.object({
        attribute_id: z.string().min(1),
        attribute_name: z.string().min(1),
        selected_values: z
          .array(
            z.object({
              value_id: z.string().min(1),
              value: z.string().min(1),
              display_value: z.string().min(1),
            }),
          )
          .min(1, 'Select at least one value'),
      }),
    )
    .min(1, 'Select at least one attribute'),
  is_stitchable: z.boolean().default(false),
  product_slug: z.string().min(1),
})
export type GenerateCombinationsInput = z.infer<typeof generateCombinationsSchema>

// ──────────────────────────────────────────────────────────────
// COMPANY PRICING
// ──────────────────────────────────────────────────────────────

export const companyPricingSchema = z.object({
  org_variant_id: z.string().min(1),
  sale_price: z.number().positive('Sale price must be positive'),
  compare_price: z.number().min(0).optional(),
})
  .refine((data) => {
    if (data.compare_price !== undefined && data.compare_price <= data.sale_price) {
      return false
    }
    return true
  }, {
    message: 'Compare price must be greater than sale price',
    path: ['compare_price'],
  })
export type CompanyPricingInput = z.infer<typeof companyPricingSchema>

export const setCompanyPricingSchema = z.object({
  pricing: z.array(companyPricingSchema).min(1, 'At least one pricing entry is required'),
})
export type SetCompanyPricingInput = z.infer<typeof setCompanyPricingSchema>

// ──────────────────────────────────────────────────────────────
// CATALOG SHARING
// ──────────────────────────────────────────────────────────────

export const promoteProductSchema = z.object({
  target_scope: z.enum(['organization', 'selective']),
  selected_company_ids: z.array(z.string()).default([]),
})
export type PromoteProductInput = z.infer<typeof promoteProductSchema>

export const demoteProductSchema = z.object({
  new_scope: z.enum(['private', 'selective']),
  reason: z.string().min(3, 'Reason must be at least 3 characters').max(500),
})
export type DemoteProductInput = z.infer<typeof demoteProductSchema>

export const selectiveAccessSchema = z.object({
  company_id: z.string().min(1),
})
export type SelectiveAccessInput = z.infer<typeof selectiveAccessSchema>

// ──────────────────────────────────────────────────────────────
// RETURNED STITCHED INVENTORY
// ──────────────────────────────────────────────────────────────

export const returnedStitchedInventorySchema = z.object({
  org_variant_id: z.string().min(1),
  quantity: z.number().int().positive().default(1),
  condition: z.enum(['perfect', 'good', 'open_box', 'damaged']),
  total_cost: z.number().positive('Total cost must be positive'),
  suggested_resale_price: z.number().min(0).optional(),
  return_reason: z.string().min(3, 'Return reason is required').max(500),
  original_order_reference: z.string().optional().or(z.literal('')),
  photos: z.array(z.string().url()).default([]),
  notes: z.string().max(1000).optional().or(z.literal('')),
})
export type ReturnedStitchedInput = z.infer<typeof returnedStitchedInventorySchema>

export const markSoldSchema = z.object({
  sold_order_reference: z.string().min(1, 'Order reference is required'),
})
export type MarkSoldInput = z.infer<typeof markSoldSchema>

export const writeOffSchema = z.object({
  reason: z.string().min(3, 'Reason is required').max(500),
})
export type WriteOffInput = z.infer<typeof writeOffSchema>

// ──────────────────────────────────────────────────────────────
// FULFILLMENT COST
// ──────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────
// GENERATE-STITCHED HELPER
// ──────────────────────────────────────────────────────────────

export const generateStitchedSchema = z.object({
  product_slug: z.string().min(1),
  base_sku: z.string().optional().or(z.literal('')),
  sizes: z.array(z.string()).default([]),
  stitching_types: z
    .array(z.enum(['stitched_basic', 'stitched_heavy', 'custom_order']))
    .min(1),
  base_fabric_cost: z.number().min(0),
  base_stitching: z.number().min(0),
  heavy_stitching: z.number().min(0),
  custom_stitching: z.number().min(0).default(0),
  include_unstitched: z.boolean().default(true),
})
export type GenerateStitchedInput = z.infer<typeof generateStitchedSchema>
