import { z } from 'zod'

/**
 * Item Exchange System — validation schemas.
 *
 * An exchange can only be created against an order_item belonging to a
 * DELIVERED order. Two exchange methods with distinct sequencing:
 *   - courier_replacement: new item dispatched immediately, courier collects old
 *   - customer_self_return: customer ships old item back FIRST, it's manually
 *     verified, THEN the new item is dispatched (strict sequential gate)
 */

// ──────────────────────────────────────────────────────────────
// CREATE EXCHANGE REQUEST
// ──────────────────────────────────────────────────────────────
export const createExchangeRequestSchema = z.object({
  original_order_item_id: z.string().min(1, 'Original order item is required'),
  new_org_variant_id: z.string().min(1, 'New variant is required'),
  exchange_method: z.enum(['courier_replacement', 'customer_self_return']),
  reason: z.string().min(3, 'A reason (min 3 chars) is required').max(500),
})
export type CreateExchangeRequestInput = z.infer<typeof createExchangeRequestSchema>

// ──────────────────────────────────────────────────────────────
// CONFIRM CUSTOMER SHIPPED (customer_self_return path only)
// ──────────────────────────────────────────────────────────────
export const confirmCustomerShippedSchema = z.object({
  exchange_id: z.string().min(1, 'Exchange ID is required'),
  customer_return_tracking_number: z.string().max(100).optional().or(z.literal('')),
  customer_return_courier: z.string().max(100).optional().or(z.literal('')),
})
export type ConfirmCustomerShippedInput = z.infer<typeof confirmCustomerShippedSchema>

// ──────────────────────────────────────────────────────────────
// VERIFY OLD ITEM RECEIVED (shared by both methods — the ONLY function
// that processes the old item's return in inventory)
// ──────────────────────────────────────────────────────────────
export const verifyOldItemReceivedSchema = z.object({
  exchange_id: z.string().min(1, 'Exchange ID is required'),
  condition: z.enum(['perfect', 'good', 'open_box', 'damaged']),
  evidence_urls: z.array(z.string().url()).max(10).optional().default([]),
  notes: z.string().max(1000).optional().or(z.literal('')),
})
export type VerifyOldItemReceivedInput = z.infer<typeof verifyOldItemReceivedSchema>

// ──────────────────────────────────────────────────────────────
// SETTLE PRICE DIFFERENCE
// ──────────────────────────────────────────────────────────────
export const settlePriceDifferenceSchema = z.object({
  exchange_id: z.string().min(1, 'Exchange ID is required'),
  settled_amount: z.number().min(0, 'Settled amount must be 0 or positive'),
  settlement_type: z.enum(['collected_from_customer', 'refunded_to_customer']),
  // Refund fields (required when settlement_type='refunded_to_customer')
  refund_method: z.enum(['cash', 'bank_transfer', 'store_credit', 'other']).optional(),
  refund_reference: z.string().max(500).optional().or(z.literal('')),
}).refine(
  (data) => {
    // When refunding, refund_method and refund_reference are required
    if (data.settlement_type === 'refunded_to_customer') {
      return !!data.refund_method && !!data.refund_reference?.trim()
    }
    return true
  },
  { message: 'Refund method and reference are required for refunds', path: ['refund_method'] },
)
export type SettlePriceDifferenceInput = z.infer<typeof settlePriceDifferenceSchema>

// ──────────────────────────────────────────────────────────────
// MARK AS NOT RETURNED ("customer did not return" terminal outcome)
// ──────────────────────────────────────────────────────────────
export const markNotReturnedSchema = z.object({
  exchange_id: z.string().min(1, 'Exchange ID is required'),
  not_returned_reason: z.string().min(3, 'A reason is required').max(500),
  recovery_status: z.enum(['pending', 'recovered', 'written_off']),
  recovery_amount: z.number().min(0).optional(),
})
export type MarkNotReturnedInput = z.infer<typeof markNotReturnedSchema>

// ──────────────────────────────────────────────────────────────
// CANCEL EXCHANGE
// ──────────────────────────────────────────────────────────────
export const cancelExchangeSchema = z.object({
  exchange_id: z.string().min(1, 'Exchange ID is required'),
  reason: z.string().min(3, 'A reason is required').max(500),
})
export type CancelExchangeInput = z.infer<typeof cancelExchangeSchema>

// ──────────────────────────────────────────────────────────────
// LIST FILTERS
// ──────────────────────────────────────────────────────────────
export const listExchangesFiltersSchema = z.object({
  status: z.string().optional(),
  exchange_method: z.enum(['courier_replacement', 'customer_self_return']).optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  company_id: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
})
export type ListExchangesFilters = z.infer<typeof listExchangesFiltersSchema>
