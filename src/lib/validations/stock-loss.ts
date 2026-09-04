import { z } from 'zod'

/**
 * Stock Loss validation schemas — 5 loss types with distinct inventory behavior.
 *
 * - Damaged: instant write-off (damage_writeoff transaction)
 * - Theft: quarantine (reserved++), resolve later (written_off or recovered)
 * - Missing: same as theft, triggered from cycle counts (not standalone form)
 * - Transit Loss: no inventory transaction (stock already gone at dispatch)
 * - Supplier Dispute: auto-created from rejected supplier returns (no transaction)
 */

// ──────────────────────────────────────────────────────────────
// DAMAGED — single-stage, instant write-off
// ──────────────────────────────────────────────────────────────

export const reportDamagedLossSchema = z.object({
  org_variant_id: z.string().min(1, 'Variant is required'),
  location_id: z.string().min(1, 'Location is required'),
  quantity: z.number().int().positive('Quantity must be positive'),
  damage_type: z.enum([
    'water_moisture',
    'physical_impact',
    'manufacturing_defect',
    'transit_damage',
    'storage_damage',
    'other',
  ]),
  responsible_party: z.enum([
    'warehouse',
    'courier',
    'customer',
    'employee',
  ]),
  evidence_urls: z.array(z.string().url()).default([]),
  notes: z.string().max(1000).optional().or(z.literal('')),
  // Optional: link to an order item (required when responsible_party='courier').
  // Enables dedup — prevents the same loss being recorded twice for the
  // same order item + damaged + stock_loss source.
  order_item_id: z.string().optional().or(z.literal('')),
})
export type ReportDamagedLossInput = z.infer<typeof reportDamagedLossSchema>

// ──────────────────────────────────────────────────────────────
// THEFT — two-stage: quarantine → investigate → resolve
// ──────────────────────────────────────────────────────────────

export const reportTheftLossSchema = z.object({
  org_variant_id: z.string().min(1, 'Variant is required'),
  location_id: z.string().min(1, 'Location is required'),
  quantity: z.number().int().positive('Quantity must be positive'),
  sub_type: z.enum(['confirmed', 'suspected']),
  police_report_ref: z.string().max(100).optional().or(z.literal('')),
  evidence_urls: z.array(z.string().url()).default([]),
  notes: z.string().max(1000).optional().or(z.literal('')),
})
export type ReportTheftLossInput = z.infer<typeof reportTheftLossSchema>

// ──────────────────────────────────────────────────────────────
// MISSING — internal, triggered from cycle counts
// ──────────────────────────────────────────────────────────────

export const reportMissingLossSchema = z.object({
  org_variant_id: z.string().min(1),
  location_id: z.string().min(1),
  quantity: z.number().int().positive(),
  cycle_count_id: z.string().min(1),
  cycle_count_item_id: z.string().min(1),
  discrepancy_reason: z.enum(['theft_suspected', 'unknown']),
})
export type ReportMissingLossInput = z.infer<typeof reportMissingLossSchema>

// ──────────────────────────────────────────────────────────────
// TRANSIT LOSS — no inventory transaction
// ──────────────────────────────────────────────────────────────

export const reportTransitLossSchema = z.object({
  org_variant_id: z.string().min(1, 'Variant is required'),
  location_id: z.string().min(1, 'Dispatch location is required'),
  quantity: z.number().int().positive('Quantity must be positive'),
  order_reference_id: z.string().min(1, 'Order reference is required'),
  courier_claim_ref: z.string().max(100).optional().or(z.literal('')),
  notes: z.string().max(1000).optional().or(z.literal('')),
})
export type ReportTransitLossInput = z.infer<typeof reportTransitLossSchema>

// ──────────────────────────────────────────────────────────────
// RESOLVE — theft/missing (two-stage)
// ──────────────────────────────────────────────────────────────

export const resolveTheftOrMissingLossSchema = z.object({
  loss_id: z.string().min(1),
  resolution: z.enum(['written_off', 'recovered', 'error_corrected']),
  notes: z.string().max(1000).optional().or(z.literal('')),
})
export type ResolveTheftOrMissingLossInput = z.infer<typeof resolveTheftOrMissingLossSchema>

// ──────────────────────────────────────────────────────────────
// RESOLVE — transit loss (claim tracking)
// ──────────────────────────────────────────────────────────────

export const resolveTransitLossSchema = z.object({
  loss_id: z.string().min(1),
  resolution: z.enum(['claim_accepted', 'claim_rejected']),
  courier_recovered: z.number().min(0).optional(),
  notes: z.string().max(1000).optional().or(z.literal('')),
})
export type ResolveTransitLossInput = z.infer<typeof resolveTransitLossSchema>

// ──────────────────────────────────────────────────────────────
// SUPPLIER DISPUTE — internal, triggered from supplier return rejection
// ──────────────────────────────────────────────────────────────

export const createSupplierDisputeLossSchema = z.object({
  supplier_return_id: z.string().min(1),
})
export type CreateSupplierDisputeLossInput = z.infer<typeof createSupplierDisputeLossSchema>
