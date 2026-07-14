import { z } from 'zod'

/**
 * Inventory, Warehouse, Purchase Order & Supplier validation schemas.
 */

// ──────────────────────────────────────────────────────────────
// LOCATIONS
// ──────────────────────────────────────────────────────────────

export const locationSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  location_type: z.enum(['warehouse', 'dispatch_hub', 'retail_store', 'transit', 'damaged_hold']).default('warehouse'),
  company_id: z.string().nullable().optional(),
  city: z.string().max(80).default('Lahore'),
  province: z.string().max(80).default('Punjab'),
  country_code: z.string().length(2).default('PK'),
  postal_code: z.string().max(20).optional().or(z.literal('')),
  contact_person: z.string().max(100).optional().or(z.literal('')),
  contact_phone: z.string().max(40).optional().or(z.literal('')),
  is_default: z.boolean().default(false),
})
export type LocationInput = z.infer<typeof locationSchema>

// ──────────────────────────────────────────────────────────────
// SUPPLIERS
// ──────────────────────────────────────────────────────────────

export const supplierSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  contact_person: z.string().max(100).optional().or(z.literal('')),
  phone: z.string().max(40).optional().or(z.literal('')),
  email: z.string().email().optional().or(z.literal('')),
  address: z.string().optional().or(z.literal('')),
  payment_terms: z.enum(['immediate', 'net_15', 'net_30', 'net_45', 'net_60']).default('immediate'),
  company_id: z.string().nullable().optional(),
})
export type SupplierInput = z.infer<typeof supplierSchema>

// ──────────────────────────────────────────────────────────────
// RECEIVE STOCK (direct, non-PO)
// ──────────────────────────────────────────────────────────────

export const receiveStockItemSchema = z.object({
  org_variant_id: z.string().min(1),
  quantity: z.number().int().positive('Quantity must be positive'),
  cost_per_unit: z.number().min(0, 'Cost must be 0 or positive'),
})
export type ReceiveStockItemInput = z.infer<typeof receiveStockItemSchema>

export const receiveStockSchema = z.object({
  location_id: z.string().min(1, 'Location is required'),
  purchase_date: z.string().optional(),
  supplier_name: z.string().optional().or(z.literal('')),
  po_reference: z.string().optional().or(z.literal('')),
  notes: z.string().max(1000).optional().or(z.literal('')),
  items: z.array(receiveStockItemSchema).min(1, 'At least one item is required'),
})
export type ReceiveStockInput = z.infer<typeof receiveStockSchema>

// ──────────────────────────────────────────────────────────────
// ADJUST STOCK (manual)
// ──────────────────────────────────────────────────────────────

export const adjustStockSchema = z.object({
  org_variant_id: z.string().min(1),
  location_id: z.string().min(1),
  quantity: z.number().int().refine((v) => v !== 0, 'Quantity must be non-zero (positive to add, negative to remove)'),
  reason: z.string().min(3, 'Reason is required').max(500),
  notes: z.string().max(1000).optional().or(z.literal('')),
})
export type AdjustStockInput = z.infer<typeof adjustStockSchema>

// ──────────────────────────────────────────────────────────────
// STOCK TRANSFER
// ──────────────────────────────────────────────────────────────

export const transferStockSchema = z
  .object({
    org_variant_id: z.string().min(1),
    from_location_id: z.string().min(1),
    to_location_id: z.string().min(1),
    quantity: z.number().int().positive('Quantity must be positive'),
    logistics_cost: z.number().min(0).default(0),
    notes: z.string().max(1000).optional().or(z.literal('')),
  })
  .refine((d) => d.from_location_id !== d.to_location_id, {
    message: 'From and to locations must be different',
    path: ['to_location_id'],
  })
export type TransferStockInput = z.infer<typeof transferStockSchema>

// ──────────────────────────────────────────────────────────────
// PURCHASE ORDERS
// ──────────────────────────────────────────────────────────────

export const purchaseOrderItemSchema = z.object({
  org_variant_id: z.string().min(1),
  ordered_quantity: z.number().int().positive('Ordered quantity must be positive'),
  cost_per_unit: z.number().min(0, 'Cost must be 0 or positive'),
})
export type PurchaseOrderItemInput = z.infer<typeof purchaseOrderItemSchema>

export const createPurchaseOrderSchema = z.object({
  supplier_id: z.string().min(1, 'Supplier is required'),
  order_date: z.string().optional(),
  expected_delivery_date: z.string().optional().or(z.literal('')),
  delivery_location_id: z.string().min(1, 'Delivery location is required'),
  advance_payment: z.number().min(0).default(0),
  payment_method: z.string().max(50).optional().or(z.literal('')),
  notes: z.string().max(1000).optional().or(z.literal('')),
  items: z.array(purchaseOrderItemSchema).min(1, 'At least one item is required'),
  status: z.enum(['draft', 'ordered']).default('draft'),
})
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>

export const receivePOItemSchema = z
  .object({
    purchase_order_item_id: z.string().min(1),
    received_quantity: z.number().int().min(0),
    actual_cost_per_unit: z.number().min(0, 'Cost must be 0 or positive'),
    shortage_reason: z.string().max(500).optional().or(z.literal('')),
  })
  .refine(
    (d) => d.received_quantity > 0 || d.shortage_reason,
    { message: 'Shortage reason required when received_quantity is 0', path: ['shortage_reason'] },
  )
export type ReceivePOItemInput = z.infer<typeof receivePOItemSchema>

export const receivePOSchema = z.object({
  purchase_order_id: z.string().min(1),
  notes: z.string().max(1000).optional().or(z.literal('')),
  items: z.array(receivePOItemSchema).min(1, 'At least one item is required'),
})
export type ReceivePOInput = z.infer<typeof receivePOSchema>

// ──────────────────────────────────────────────────────────────
// SUPPLIER RETURNS
// ──────────────────────────────────────────────────────────────

export const supplierReturnSchema = z.object({
  purchase_order_id: z.string().optional().or(z.literal('')),
  supplier_id: z.string().min(1, 'Supplier is required'),
  org_variant_id: z.string().min(1, 'Variant is required'),
  location_id: z.string().min(1, 'Location is required'),
  quantity: z.number().int().positive('Quantity must be positive'),
  cost_per_unit: z.number().min(0, 'Cost must be 0 or positive'),
  reason: z.enum(['defective', 'wrong_item', 'quality_issue', 'excess_quantity', 'other']),
  photos: z.array(z.string().url()).default([]),
  notes: z.string().max(1000).optional().or(z.literal('')),
})
export type SupplierReturnInput = z.infer<typeof supplierReturnSchema>

export const resolveSupplierReturnSchema = z.object({
  return_id: z.string().min(1),
  resolution_type: z.enum(['refund', 'replacement', 'credit_note']),
  resolution_amount: z.number().min(0).optional(),
  replacement_po_id: z.string().optional().or(z.literal('')),
})
export type ResolveSupplierReturnInput = z.infer<typeof resolveSupplierReturnSchema>

// ──────────────────────────────────────────────────────────────
// STOCK LOSS
// ──────────────────────────────────────────────────────────────

export const stockLossSchema = z.object({
  org_variant_id: z.string().min(1, 'Variant is required'),
  location_id: z.string().min(1, 'Location is required'),
  loss_type: z.enum(['damaged', 'theft', 'missing', 'transit_loss']),
  sub_type: z.enum(['confirmed', 'suspected', 'admin_error', 'manufacturing']).optional(),
  damage_type: z
    .enum(['water_moisture', 'physical_impact', 'manufacturing_defect', 'transit_damage', 'storage_damage', 'other'])
    .optional(),
  quantity: z.number().int().positive('Quantity must be positive'),
  cost_per_unit: z.number().min(0, 'Cost must be 0 or positive'),
  notes: z.string().max(1000).optional().or(z.literal('')),
  responsible_party: z.enum(['warehouse', 'courier', 'customer', 'employee', 'unknown']).optional(),
})
export type StockLossInput = z.infer<typeof stockLossSchema>

export const resolveStockLossSchema = z.object({
  loss_record_id: z.string().min(1),
  resolution: z.enum(['written_off', 'recovered', 'error_corrected', 'claim_accepted', 'claim_rejected']),
  investigation_status: z.enum(['none', 'open', 'closed']).optional(),
  responsible_party: z.enum(['warehouse', 'courier', 'customer', 'employee', 'unknown']).optional(),
  police_report_ref: z.string().optional().or(z.literal('')),
  insurance_claim_ref: z.string().optional().or(z.literal('')),
  insurance_recovered: z.number().min(0).optional(),
  courier_claim_ref: z.string().optional().or(z.literal('')),
  courier_claim_status: z.enum(['not_filed', 'filed', 'accepted', 'rejected']).optional(),
  courier_recovered: z.number().min(0).optional(),
  notes: z.string().max(1000).optional().or(z.literal('')),
})
export type ResolveStockLossInput = z.infer<typeof resolveStockLossSchema>

// ──────────────────────────────────────────────────────────────
// CYCLE COUNTS
// ──────────────────────────────────────────────────────────────

export const cycleCountSchema = z.object({
  location_id: z.string().min(1, 'Location is required'),
  count_name: z.string().min(2, 'Count name is required').max(200),
  count_type: z.enum(['full', 'partial', 'spot']).default('full'),
  scheduled_at: z.string().optional(),
  notes: z.string().max(1000).optional().or(z.literal('')),
  variant_ids: z.array(z.string()).optional(), // for partial/spot counts
})
export type CycleCountInput = z.infer<typeof cycleCountSchema>

export const submitCountItemSchema = z.object({
  item_id: z.string().min(1),
  counted_quantity: z.number().int().min(0),
  notes: z.string().max(500).optional().or(z.literal('')),
})
export type SubmitCountItemInput = z.infer<typeof submitCountItemSchema>

// ──────────────────────────────────────────────────────────────
// PRODUCTION ORDERS
// ──────────────────────────────────────────────────────────────

export const productionOrderSchema = z.object({
  stitched_variant_id: z.string().min(1),
  fabric_variant_id: z.string().min(1),
  fabric_location_id: z.string().min(1),
  quantity: z.number().int().positive('Quantity must be positive').default(1),
  stitching_cost: z.number().min(0).default(0),
  estimated_completion_date: z.string().optional(),
  assigned_tailor: z.string().max(100).optional().or(z.literal('')),
  notes: z.string().max(1000).optional().or(z.literal('')),
})
export type ProductionOrderInput = z.infer<typeof productionOrderSchema>

export const fulfillMadeToOrderSchema = z.object({
  org_variant_id: z.string().min(1),
  quantity: z.number().int().positive(),
  company_id: z.string().min(1),
  preferred_location_id: z.string().optional(),
})
export type FulfillMadeToOrderInput = z.infer<typeof fulfillMadeToOrderSchema>

// ──────────────────────────────────────────────────────────────
// RETURNED STITCHED ITEM
// ──────────────────────────────────────────────────────────────

export const receiveReturnedStitchedSchema = z.object({
  org_variant_id: z.string().min(1),
  location_id: z.string().min(1),
  quantity: z.number().int().positive(),
  condition: z.enum(['perfect', 'good', 'open_box', 'damaged']),
  total_cost: z.number().positive('Total cost must be positive'),
  return_reason: z.string().min(3, 'Return reason is required').max(500),
  photos: z.array(z.string().url()).default([]),
  notes: z.string().max(1000).optional().or(z.literal('')),
  original_order_reference: z.string().optional().or(z.literal('')),
})
export type ReceiveReturnedStitchedInput = z.infer<typeof receiveReturnedStitchedSchema>
