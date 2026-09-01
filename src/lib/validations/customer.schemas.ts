import { z } from 'zod'

/**
 * Customer Management System — validation schemas.
 *
 * These schemas validate all customer / phone / address mutations. Every
 * server action in customer.actions.ts validates its input against one of
 * these before touching the database.
 *
 * IMPORTANT: There is NO province field anywhere in this system (per explicit
 * product decision). Addresses consist only of `address` + `city`.
 *
 * Phone numbers arrive in inconsistent Pakistani formats ("0300-1234567",
 * "+92 300 1234567", "923001234567") and are normalized to E.164
 * ("+923001234567") server-side via the normalize_phone() SQL function
 * before storage or matching. The schemas below accept the raw form and
 * only do a light sanity check — full canonicalization happens at the
 * action layer.
 */

// ──────────────────────────────────────────────────────────────
// PHONE INPUT
// ──────────────────────────────────────────────────────────────

/**
 * A single phone number entry for a customer.
 * - `phone` is the raw form as entered/received (kept for display).
 * - `label` is optional ("Personal", "Husband's number", "Work").
 * - `is_primary` marks this as the customer's primary contact. At most one
 *   phone per customer may be primary (enforced at the DB layer via a
 *   partial unique index, and at the action layer by unsetting others).
 */
export const phoneInputSchema = z.object({
  phone: z
    .string()
    .min(7, 'Phone number is required')
    .max(20, 'Phone number is too long')
    // Must contain at least 7 digits — the action layer normalizes to E.164.
    .refine((v) => (v.match(/\d/g) || []).length >= 7, 'Phone number must contain at least 7 digits'),
  label: z.string().max(50).optional().or(z.literal('')),
  is_primary: z.boolean().default(false),
})
export type PhoneInput = z.infer<typeof phoneInputSchema>

// ──────────────────────────────────────────────────────────────
// ADDRESS INPUT
// ──────────────────────────────────────────────────────────────

/**
 * A single delivery address for a customer.
 * - NO province field (per product decision).
 * - `country` stores the ISO 3166-1 alpha-2 CODE (e.g. "PK", "GB", "AE") —
 *   NOT the country name. This matches CountrySelector's output (returns
 *   alpha-2 codes) + Shopify's default_address.country_code directly, with
 *   no translation at the form boundary. Optional with default "PK"
 *   (current majority use case) — callers that don't send it get the
 *   sensible default, so this is additive and non-breaking for existing
 *   flows that don't yet ask for country.
 * - `is_default` marks this as the customer's default delivery address. At
 *   most one address per customer may be default (enforced at the DB layer
 *   via a partial unique index, and at the action layer by unsetting others).
 */
export const addressInputSchema = z.object({
  label: z.string().max(50).optional().or(z.literal('')),
  address: z.string().min(2, 'Address is required').max(500),
  city: z.string().min(2, 'City is required').max(100),
  country: z.string().max(2).optional().default('PK'),
  is_default: z.boolean().default(false),
})
export type AddressInput = z.infer<typeof addressInputSchema>

// ──────────────────────────────────────────────────────────────
// CREATE CUSTOMER
// ──────────────────────────────────────────────────────────────

/**
 * Create a new customer with at least one phone and one address.
 *
 * Refinements:
 *  - At least one phone is required (min 1).
 *  - Exactly one phone must have is_primary=true. If zero or more than one
 *    are marked primary, validation fails with a clear message.
 *  - At least one address is required (min 1).
 *  - Exactly one address must have is_default=true.
 */
export const createCustomerSchema = z
  .object({
    name: z
      .string()
      .min(2, 'Customer name must be at least 2 characters')
      .max(200),
    email: z.string().email('Invalid email').optional().or(z.literal('')),
    phones: z.array(phoneInputSchema).min(1, 'At least one phone number is required'),
    addresses: z.array(addressInputSchema).min(1, 'At least one address is required'),
  })
  .refine(
    (data) => data.phones.filter((p) => p.is_primary).length === 1,
    {
      message: 'Exactly one phone must be marked as primary',
      path: ['phones'],
    },
  )
  .refine(
    (data) => data.addresses.filter((a) => a.is_default).length === 1,
    {
      message: 'Exactly one address must be marked as default',
      path: ['addresses'],
    },
  )
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>

// ──────────────────────────────────────────────────────────────
// UPDATE CUSTOMER
// ──────────────────────────────────────────────────────────────

/**
 * Update a customer's name/email only. Phones and addresses have their own
 * dedicated add/remove/update actions. At least one of name/email must be
 * provided.
 */
export const updateCustomerSchema = z
  .object({
    customer_id: z.string().min(1, 'Customer ID is required'),
    name: z
      .string()
      .min(2, 'Customer name must be at least 2 characters')
      .max(200)
      .optional(),
    email: z.string().email('Invalid email').optional().or(z.literal('')),
  })
  .refine((data) => data.name !== undefined || data.email !== undefined, {
    message: 'At least one of name or email must be provided',
    path: ['name'],
  })
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>

// ──────────────────────────────────────────────────────────────
// CROSS-PLATFORM MATCHING
// ──────────────────────────────────────────────────────────────

/**
 * Input for matchOrCreateExternalCustomer — the entry point a future
 * Shopify/Daraz/Instagram webhook will call. Maps platform customer IDs
 * to internal FlowOps customer IDs using the layered strategy implemented
 * in the match_or_create_customer() SQL function (Step 1).
 */
export const matchExternalCustomerSchema = z.object({
  platform: z.enum(['shopify', 'daraz', 'instagram']),
  external_customer_id: z.string().min(1, 'External customer ID is required'),
  phone: z.string().max(20).optional().or(z.literal('')),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
  name: z.string().max(200).optional().or(z.literal('')),
  // Optional country (alpha-2 code, e.g. "PK", "GB"). When provided, persisted
  // onto the customer_addresses row created for newly-created customers.
  // Falls back to "PK" server-side if absent. Sourced from Shopify's
  // default_address.country_code (preferred) or default_address.country
  // (name, normalized to alpha-2 by the caller).
  country: z.string().max(2).optional().or(z.literal('')),
})
export type MatchExternalCustomerInput = z.infer<typeof matchExternalCustomerSchema>

// ──────────────────────────────────────────────────────────────
// LIST FILTERS
// ──────────────────────────────────────────────────────────────

/**
 * Filters for listCustomers. `search` matches customer name OR any
 * associated phone (raw or normalized). Date range filters on created_at.
 */
export const listCustomersFiltersSchema = z.object({
  search: z.string().max(200).optional().or(z.literal('')),
  is_flagged: z.boolean().optional(),
  date_from: z.string().datetime().optional().or(z.literal('')),
  date_to: z.string().datetime().optional().or(z.literal('')),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
})
export type ListCustomersFilters = z.infer<typeof listCustomersFiltersSchema>
