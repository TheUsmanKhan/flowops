import { z } from 'zod'
import {
  createCustomerSchema,
  type CreateCustomerInput,
} from '@/lib/validations/customer.schemas'

/**
 * OMS — Order Management System validation schemas.
 *
 * These schemas validate all order creation, payment conversion, and
 * lifecycle transition inputs. Every server action in order.actions.ts
 * validates its input against one of these before touching the database.
 *
 * The inline new-customer shape (when creating an order for a brand-new
 * customer without a saved record) is reused from customer.schemas.ts so
 * there is a single source of truth for customer validation.
 */

// ──────────────────────────────────────────────────────────────
// CUSTOMER (inline new-customer shape — re-exported from customer.schemas.ts)
// ──────────────────────────────────────────────────────────────
// The legacy `customerInputSchema` (flat phone/shippingAddress/billingAddress)
// was removed when the Customer Management System schema replaced the
// simplified customer design. Inline new-customer creation now uses the full
// createCustomerSchema (name + email + phones[] + addresses[]).
export { createCustomerSchema, type CreateCustomerInput }

// ──────────────────────────────────────────────────────────────
// ORDER ITEM
// ──────────────────────────────────────────────────────────────

export const orderItemInputSchema = z.object({
  org_variant_id: z.string().min(1, 'Variant is required'),
  quantity: z.number().int().positive('Quantity must be a positive integer'),
  unit_price: z
    .number()
    .min(0, 'Unit price must be 0 or positive')
    // Auto-filled from company_variant_pricing but overridable for manual
    // orders (e.g. wholesale discounts)
    .optional(),
})
export type OrderItemInput = z.infer<typeof orderItemInputSchema>

// ──────────────────────────────────────────────────────────────
// CREATE MANUAL ORDER
// ──────────────────────────────────────────────────────────────
// Accepts EITHER:
//   - customer_id (existing) + optional used_customer_address_id +
//     used_customer_phone_id (saved phone/address selection)
//   - new_customer (full createCustomerSchema) to create inline
// Plus:
//   - recipient_name (optional — defaults to customer.name server-side)
//   - delivery_address + delivery_city (always required — the order's own
//     editable snapshot; pre-filled from a selected saved address but can
//     be edited per-order without altering the saved customer_addresses row)
//   - save_address_for_next_time (optional — when true AND a new one-off
//     address was typed, persists it as a new customer_addresses row after
//     order creation. Step 3's frontend will expose this as a checkbox.)
export const createManualOrderSchema = z
  .object({
    // Existing customer path
    customer_id: z.string().min(1).optional(),
    used_customer_address_id: z.string().min(1).optional(),
    used_customer_phone_id: z.string().min(1).optional(),
    // New customer path (full createCustomerSchema from customer.schemas.ts)
    new_customer: createCustomerSchema.optional(),
    // Recipient name (may differ from customer.name — e.g. son orders, mother receives)
    recipient_name: z.string().max(200).optional().or(z.literal('')),
    // Order items
    items: z.array(orderItemInputSchema).min(1, 'At least one item is required'),
    // Payment
    payment_type: z.enum(['full_cod', 'partial_advance', 'fully_prepaid']).default('full_cod'),
    advance_amount: z.number().min(0).optional(),
    advance_payment_method: z.string().max(50).optional().or(z.literal('')),
    advance_payment_reference: z.string().max(200).optional().or(z.literal('')),
    // Delivery (always required — the order's editable snapshot)
    delivery_address: z.string().min(2, 'Delivery address is required'),
    delivery_city: z.string().min(2, 'Delivery city is required'),
    // Logistics
    courier_name: z.string().max(100).optional().or(z.literal('')),
    dispatch_location_id: z.string().min(1, 'Dispatch location is required'),
    notes_for_courier: z.string().max(500).optional().or(z.literal('')),
    discount_amount: z.number().min(0).optional(),
    discount_reason: z.string().max(200).optional().or(z.literal('')),
    courier_charges: z.number().min(0).optional(),
    // Delivery charge + tax (migration 012)
    estimated_delivery_charge: z.number().min(0).optional(),
    tax_amount: z.number().min(0).optional(),
    tax_label: z.string().max(100).optional().or(z.literal('')),
    // Step 3 frontend flag: when true AND a new one-off address was typed
    // (i.e. used_customer_address_id is null), persist delivery_address as
    // a new customer_addresses row after order creation.
    save_address_for_next_time: z.boolean().optional().default(false),
  })
  .refine((data) => data.customer_id || data.new_customer, {
    message: 'Either customer_id (existing) or new_customer is required',
    path: ['customer_id'],
  })
  .refine(
    (data) => {
      // advance_amount is required if payment_type='partial_advance'
      if (data.payment_type === 'partial_advance') {
        return data.advance_amount !== undefined && data.advance_amount > 0
      }
      return true
    },
    {
      message: 'Advance amount is required for partial_advance payment type',
      path: ['advance_amount'],
    },
  )
export type CreateManualOrderInput = z.infer<typeof createManualOrderSchema>

// ──────────────────────────────────────────────────────────────
// CONVERT PAYMENT STATUS
// ──────────────────────────────────────────────────────────────

export const convertPaymentSchema = z.object({
  order_id: z.string().min(1, 'Order ID is required'),
  new_payment_type: z.enum(['partial_advance', 'fully_prepaid']),
  advance_amount: z
    .number()
    .min(0, 'Advance amount must be 0 or positive')
    .optional(),
  advance_payment_method: z.string().max(50).optional().or(z.literal('')),
  advance_payment_reference: z.string().max(200).optional().or(z.literal('')),
  advance_payment_screenshot_url: z.string().url().optional().or(z.literal('')),
})
export type ConvertPaymentInput = z.infer<typeof convertPaymentSchema>

// ──────────────────────────────────────────────────────────────
// UPDATE PAYMENT SCREENSHOT
// ──────────────────────────────────────────────────────────────

/**
 * Lightweight schema for post-creation payment proof uploads.
 * Used when an order is created with a payment type that requires a
 * screenshot but the file could only be uploaded AFTER the order_id existed.
 *
 * The URL must be either empty (clear) or a valid URL pointing to the
 * /uploads/payment-proofs/... path returned by /api/upload.
 */
export const updatePaymentScreenshotSchema = z.object({
  order_id: z.string().min(1, 'Order ID is required'),
  advance_payment_screenshot_url: z
    .string()
    .url('Invalid screenshot URL')
    .optional()
    .or(z.literal('')),
})
export type UpdatePaymentScreenshotInput = z.infer<typeof updatePaymentScreenshotSchema>

// ──────────────────────────────────────────────────────────────
// MARK COD COLLECTED
// ──────────────────────────────────────────────────────────────

export const markCodCollectedSchema = z.object({
  order_id: z.string().min(1, 'Order ID is required'),
  collected_amount: z.number().min(0, 'Collected amount must be 0 or positive'),
})
export type MarkCodCollectedInput = z.infer<typeof markCodCollectedSchema>

// ──────────────────────────────────────────────────────────────
// CANCEL ORDER
// ──────────────────────────────────────────────────────────────

export const cancelOrderSchema = z.object({
  order_id: z.string().min(1, 'Order ID is required'),
  cancellation_reason: z.string().min(3, 'Reason is required').max(500),
})
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>

// ──────────────────────────────────────────────────────────────
// COMPANY ORDER SETTINGS
// ──────────────────────────────────────────────────────────────

export const updateCompanyOrderSettingsSchema = z.object({
  require_order_confirmation: z.boolean().optional(),
  require_packing_step: z.boolean().optional(),
  default_courier: z.string().max(100).optional().or(z.literal('')),
  default_dispatch_location_id: z.string().optional().or(z.literal('')),
  deduct_delivery_charge_from_refund: z.boolean().optional(),
})
export type UpdateCompanyOrderSettingsInput = z.infer<typeof updateCompanyOrderSettingsSchema>

// ──────────────────────────────────────────────────────────────
// SHOPIFY WEBHOOK PAYLOAD (for createOrderFromShopifyWebhook stub)
// ──────────────────────────────────────────────────────────────

export const shopifyOrderWebhookSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string(),
  financial_status: z.enum(['pending', 'authorized', 'partially_paid', 'paid', 'partially_refunded', 'refunded', 'voided']),
  total_price: z.string(),
  subtotal_price: z.string(),
  total_discounts: z.string(),
  customer: z.object({
    id: z.union([z.string(), z.number()]).optional(),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    default_address: z
      .object({
        address1: z.string().nullable().optional(),
        city: z.string().nullable().optional(),
        province: z.string().nullable().optional(),
      })
      .optional(),
  }),
  line_items: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      sku: z.string().nullable().optional(),
      quantity: z.number().int().positive(),
      price: z.string(),
    }),
  ),
})
export type ShopifyOrderWebhook = z.infer<typeof shopifyOrderWebhookSchema>
