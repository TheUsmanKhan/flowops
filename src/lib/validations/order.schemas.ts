import { z } from 'zod'

/**
 * OMS — Order Management System validation schemas.
 *
 * These schemas validate all order creation, payment conversion, and
 * lifecycle transition inputs. Every server action in order.actions.ts
 * and customer.actions.ts validates its input against one of these
 * before touching the database.
 */

// ──────────────────────────────────────────────────────────────
// CUSTOMER
// ──────────────────────────────────────────────────────────────

export const customerInputSchema = z.object({
  name: z.string().min(2, 'Customer name must be at least 2 characters').max(200),
  phone: z
    .string()
    .min(7, 'Phone number is required')
    .max(20)
    // Loose Pakistani phone validation: starts with 0 or +92, digits only
    .regex(/^(?:\+92|0)?3\d{2}[-\s]?\d{7}$|^(?:\+92|0)?\d{9,11}$/, 'Invalid phone format'),
  alternate_phone: z.string().max(20).optional().or(z.literal('')),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
  addresses: z
    .array(
      z.object({
        // 'shipping' | 'billing' — optional for backward compatibility with
        // legacy customers whose addresses were saved without a type field.
        // Untyped addresses are treated as shipping (graceful fallback).
        type: z.enum(['shipping', 'billing']).optional(),
        label: z.string().max(50).optional(),
        address: z.string().min(2, 'Address is required'),
        city: z.string().min(2, 'City is required'),
        province: z.string().optional(),
        is_default: z.boolean().optional(),
      }),
    )
    .min(1, 'At least one address is required'),
})
export type CustomerInput = z.infer<typeof customerInputSchema>

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

export const createManualOrderSchema = z
  .object({
    // Either provide a new customer object OR an existing customer_id
    customer: customerInputSchema.optional(),
    customer_id: z.string().min(1).optional(),
    items: z.array(orderItemInputSchema).min(1, 'At least one item is required'),
    payment_type: z.enum(['full_cod', 'partial_advance', 'fully_prepaid']).default('full_cod'),
    advance_amount: z.number().min(0).optional(),
    advance_payment_method: z.string().max(50).optional().or(z.literal('')),
    advance_payment_reference: z.string().max(200).optional().or(z.literal('')),
    delivery_address: z.string().min(2, 'Delivery address is required'),
    delivery_city: z.string().min(2, 'Delivery city is required'),
    courier_name: z.string().max(100).optional().or(z.literal('')),
    dispatch_location_id: z.string().min(1, 'Dispatch location is required'),
    notes_for_courier: z.string().max(500).optional().or(z.literal('')),
    discount_amount: z.number().min(0).optional(),
    discount_reason: z.string().max(200).optional().or(z.literal('')),
    courier_charges: z.number().min(0).optional(),
  })
  .refine((data) => data.customer || data.customer_id, {
    message: 'Either customer (new) or customer_id (existing) is required',
    path: ['customer'],
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
