/**
 * Customer Management System — server actions.
 *
 * This is the standalone Customer Management System (Step 2). It owns all
 * CRUD for customers / phones / addresses, the cross-platform identity
 * matching wrapper, cached-stats recomputation with auto-flagging, and the
 * listing/detail endpoints.
 *
 * The Order system (order.actions.ts) CONSUMES this module's data and the
 * `markAddressAsUsed` / `updateCustomerStats` helpers — it does not touch
 * customer_phones / customer_addresses / customer_external_identities
 * directly.
 *
 * DESIGN RULES (enforced throughout):
 *  1. Phone normalization is ALWAYS done via the normalize_phone() SQL
 *     function (single source of truth). Raw phone strings are never
 *     compared directly.
 *  2. A customer must always have >= 1 phone and >= 1 address. The
 *     remove-actions refuse to delete the last remaining phone/address.
 *  3. At most one is_primary phone and one is_default address per customer
 *     (DB partial unique indexes + action-layer unsetting).
 *  4. Every mutation calls insertAuditLog() and returns { success, data?, error? }.
 *  5. All reads are organization-scoped via getWorkspace().
 */

import { db } from '@/lib/db'
import { getWorkspace, requirePermission, ApiError } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import {
  createCustomerSchema,
  updateCustomerSchema,
  addressInputSchema,
  phoneInputSchema,
  matchExternalCustomerSchema,
  type CreateCustomerInput,
  type UpdateCustomerInput,
  type AddressInput,
  type PhoneInput,
  type MatchExternalCustomerInput,
} from '@/lib/validations/customer.schemas'
import type { Prisma } from '@prisma/client'

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

/** A customer's phone row, shaped for API responses. */
interface PhoneDTO {
  id: string
  phoneRaw: string
  phoneNormalized: string
  label: string | null
  isPrimary: boolean
  createdAt: Date
}

/** A customer's address row, shaped for API responses. */
interface AddressDTO {
  id: string
  label: string | null
  address: string
  city: string
  isDefault: boolean
  lastUsedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

interface CustomerSummaryDTO {
  id: string
  name: string
  email: string | null
  primaryPhone: string | null
  defaultAddress: { address: string; city: string } | null
  totalOrdersCount: number
  totalOrderValue: number
  totalRtoCount: number
  isFlagged: boolean
  flaggedReason: string | null
  createdAt: Date
}

interface CustomerDetailDTO {
  id: string
  name: string
  email: string | null
  totalOrdersCount: number
  totalOrderValue: number
  totalRtoCount: number
  // Live-computed rates (not cached — derived from actual order statuses).
  // rtoRate = rto / dispatched-or-later orders * 100
  // deliveryRate = delivered / dispatched-or-later orders * 100
  // where "dispatched-or-later" = status IN ('dispatched','delivered','rto')
  rtoRate: number
  deliveryRate: number
  isFlagged: boolean
  flaggedReason: string | null
  flaggedAt: Date | null
  createdAt: Date
  updatedAt: Date
  phones: PhoneDTO[]
  addresses: AddressDTO[]
  externalIdentities: Array<{
    id: string
    platform: string
    externalCustomerId: string
    matchedVia: string
    createdAt: Date
  }>
  recentOrders: Array<{
    id: string
    flowopsOrderNumber: string
    status: string
    totalOrderValue: number
    createdAt: Date
    recipientName: string | null
    deliveryAddress: string | null
    deliveryCity: string | null
    usedCustomerAddressId: string | null
    usedCustomerPhoneId: string | null
  }>
}

// ──────────────────────────────────────────────────────────────
// Helper: normalize_phone via the DB function (single source of truth)
// ──────────────────────────────────────────────────────────────

/**
 * Call the normalize_phone() SQL function. Returns the E.164 canonical form
 * (e.g. "+923001234567") or null for empty/invalid input.
 *
 * Why a DB call instead of a TS port: the SQL function is the authoritative
 * normalizer used by customer_phones indexes, match_or_create_customer(),
 * and all matching logic. Keeping a single implementation guarantees the
 * client debounce-preview and the server agree on what "matches".
 */
async function normalizePhone(raw: string): Promise<string | null> {
  const rows = await db.$queryRaw<{ normalized: string | null }[]>`
    SELECT normalize_phone(${raw}::TEXT) AS normalized
  `
  return rows[0]?.normalized ?? null
}

/**
 * Format a Prisma customer_phones row into a PhoneDTO.
 */
function toPhoneDTO(p: {
  id: string
  phoneRaw: string
  phoneNormalized: string
  label: string | null
  isPrimary: boolean
  createdAt: Date
}): PhoneDTO {
  return {
    id: p.id,
    phoneRaw: p.phoneRaw,
    phoneNormalized: p.phoneNormalized,
    label: p.label,
    isPrimary: p.isPrimary,
    createdAt: p.createdAt,
  }
}

/**
 * Format a Prisma customer_addresses row into an AddressDTO.
 */
function toAddressDTO(a: {
  id: string
  label: string | null
  address: string
  city: string
  isDefault: boolean
  lastUsedAt: Date | null
  createdAt: Date
  updatedAt: Date
}): AddressDTO {
  return {
    id: a.id,
    label: a.label,
    address: a.address,
    city: a.city,
    isDefault: a.isDefault,
    lastUsedAt: a.lastUsedAt,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }
}

// ══════════════════════════════════════════════════════════════
// PART 2 — CORE CUSTOMER SERVER ACTIONS
// ══════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────
// searchCustomerByPhone
// ──────────────────────────────────────────────────────────────
/**
 * Used by the Order creation page's live search. Normalizes the input via
 * the SQL function, then looks up customer_phones within the active org.
 *
 * If found, returns the FULL customer record with ALL their phones and
 * ALL their addresses (so the order form can populate the address dropdown
 * and let the user pick which saved address to ship to).
 *
 * Returns { found: false } when no match — the caller decides whether to
 * show an inline "create new customer" form.
 */
export async function searchCustomerByPhone(
  phone: string,
): Promise<ActionResult<{
  found: boolean
  customer?: {
    id: string
    name: string
    email: string | null
    totalOrdersCount: number
    totalRtoCount: number
    isFlagged: boolean
    flaggedReason: string | null
    phones: PhoneDTO[]
    addresses: AddressDTO[]
  }
}>> {
  try {
    const ctx = await getWorkspace()

    if (!phone || !phone.trim()) {
      return { success: true, data: { found: false } }
    }

    const normalized = await normalizePhone(phone.trim())
    if (!normalized) {
      return { success: true, data: { found: false } }
    }

    // Find the customer_phones row for this normalized phone in this org.
    const phoneRow = await db.customerPhone.findFirst({
      where: {
        organizationId: ctx.company.organizationId,
        phoneNormalized: normalized,
      },
      select: { customerId: true },
    })

    if (!phoneRow) {
      return { success: true, data: { found: false } }
    }

    // Fetch the full customer + all phones + all addresses.
    const customer = await db.customer.findFirst({
      where: {
        id: phoneRow.customerId,
        organizationId: ctx.company.organizationId,
      },
      include: {
        phones: { orderBy: { isPrimary: 'desc' } },
        addresses: {
          orderBy: [
            { isDefault: 'desc' },
            { lastUsedAt: { sort: 'desc', nulls: 'last' } },
          ],
        },
      },
    })

    if (!customer) {
      return { success: true, data: { found: false } }
    }

    return {
      success: true,
      data: {
        found: true,
        customer: {
          id: customer.id,
          name: customer.name,
          email: customer.email,
          totalOrdersCount: customer.totalOrdersCount,
          totalRtoCount: customer.totalRtoCount,
          isFlagged: customer.isFlagged,
          flaggedReason: customer.flaggedReason,
          phones: customer.phones.map(toPhoneDTO),
          addresses: customer.addresses.map(toAddressDTO),
        },
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to search customer by phone',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// createCustomer
// ──────────────────────────────────────────────────────────────
/**
 * Create a new customer with at least one phone and one address.
 *
 * Before inserting, normalizes each phone and checks for org-wide
 * phone_normalized conflicts. If any phone already belongs to another
 * customer, returns a clear error suggesting the caller search for the
 * existing customer instead of creating a duplicate.
 *
 * All inserts run in a single transaction so a partial failure (e.g. an
 * address insert fails) rolls back the customer + phones too.
 */
export async function createCustomer(
  input: CreateCustomerInput,
): Promise<ActionResult<{ customerId: string }>> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_CREATE)

    const parsed = createCustomerSchema.safeParse(input)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid customer data',
      }
    }
    const d = parsed.data

    // 1. Normalize every phone via the SQL function (single source of truth).
    const phonesWithNormalized: Array<{
      phoneRaw: string
      phoneNormalized: string
      label: string | null
      isPrimary: boolean
    }> = []
    for (const p of d.phones) {
      const normalized = await normalizePhone(p.phone.trim())
      if (!normalized) {
        return {
          success: false,
          error: `Could not normalize phone "${p.phone}" — please enter a valid phone number`,
        }
      }
      phonesWithNormalized.push({
        phoneRaw: p.phone.trim(),
        phoneNormalized: normalized,
        label: p.label?.trim() || null,
        isPrimary: p.is_primary,
      })
    }

    // 2. Check for org-wide phone conflicts BEFORE inserting.
    //    A normalized phone maps to exactly one customer per org (DB unique
    //    constraint). If any of the provided phones already belongs to
    //    another customer, we refuse and point the caller to that customer.
    if (phonesWithNormalized.length > 0) {
      const conflicts = await db.customerPhone.findMany({
        where: {
          organizationId: ctx.company.organizationId,
          phoneNormalized: { in: phonesWithNormalized.map((p) => p.phoneNormalized) },
        },
        select: {
          phoneNormalized: true,
          customerId: true,
          customer: { select: { name: true } },
        },
      })
      if (conflicts.length > 0) {
        const c = conflicts[0]
        return {
          success: false,
          error: `Phone ${c.phoneNormalized} already belongs to customer "${c.customer.name}". Use search to find this existing customer instead of creating a duplicate.`,
        }
      }
    }

    // 3. Normalize addresses (no province — only address + city).
    const addressesData = d.addresses.map((a) => ({
      label: a.label?.trim() || null,
      address: a.address.trim(),
      city: a.city.trim(),
      isDefault: a.is_default,
      lastUsedAt: null,
    }))

    // 4. Insert customer + phones + addresses in a single transaction.
    const customer = await db.$transaction(async (tx) => {
      const created = await tx.customer.create({
        data: {
          organizationId: ctx.company.organizationId,
          name: d.name.trim(),
          email: d.email?.trim() || null,
          createdBy: ctx.employee.id,
        },
      })

      await tx.customerPhone.createMany({
        data: phonesWithNormalized.map((p) => ({
          customerId: created.id,
          organizationId: ctx.company.organizationId,
          phoneRaw: p.phoneRaw,
          phoneNormalized: p.phoneNormalized,
          label: p.label,
          isPrimary: p.isPrimary,
        })),
      })

      await tx.customerAddress.createMany({
        data: addressesData.map((a) => ({
          customerId: created.id,
          organizationId: ctx.company.organizationId,
          label: a.label,
          address: a.address,
          city: a.city,
          isDefault: a.isDefault,
          lastUsedAt: a.lastUsedAt,
        })),
      })

      return created
    })

    // 5. Audit log.
    await insertAuditLog({
      action: 'customer.created',
      entityType: 'customer',
      entityId: customer.id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: {
        name: customer.name,
        email: customer.email,
        phoneCount: phonesWithNormalized.length,
        addressCount: addressesData.length,
      },
    })

    return { success: true, data: { customerId: customer.id } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to create customer',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// updateCustomer — name/email only
// ──────────────────────────────────────────────────────────────
export async function updateCustomer(
  input: UpdateCustomerInput,
): Promise<ActionResult<{ customerId: string }>> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_CREATE)

    const parsed = updateCustomerSchema.safeParse(input)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid customer data',
      }
    }
    const d = parsed.data

    const existing = await db.customer.findFirst({
      where: { id: d.customer_id, organizationId: ctx.company.organizationId },
    })
    if (!existing) return { success: false, error: 'Customer not found' }

    const updateData: Prisma.CustomerUncheckedUpdateInput = {}
    if (d.name !== undefined && d.name.trim() !== existing.name) {
      updateData.name = d.name.trim()
    }
    if (d.email !== undefined) {
      const newEmail = d.email.trim() || null
      if (newEmail !== existing.email) updateData.email = newEmail
    }

    if (Object.keys(updateData).length === 0) {
      return { success: true, data: { customerId: existing.id } }
    }

    await db.customer.update({ where: { id: existing.id }, data: updateData })

    await insertAuditLog({
      action: 'customer.updated',
      entityType: 'customer',
      entityId: existing.id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      oldValues: { name: existing.name, email: existing.email },
      newValues: updateData,
    })

    return { success: true, data: { customerId: existing.id } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to update customer',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// addCustomerPhone
// ──────────────────────────────────────────────────────────────
export async function addCustomerPhone(
  customerId: string,
  input: PhoneInput,
): Promise<ActionResult<{ phoneId: string }>> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_CREATE)

    const parsed = phoneInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid phone data',
      }
    }
    const d = parsed.data

    const customer = await db.customer.findFirst({
      where: { id: customerId, organizationId: ctx.company.organizationId },
    })
    if (!customer) return { success: false, error: 'Customer not found' }

    const normalized = await normalizePhone(d.phone.trim())
    if (!normalized) {
      return {
        success: false,
        error: `Could not normalize phone "${d.phone}" — please enter a valid phone number`,
      }
    }

    // Org-wide uniqueness: a normalized phone maps to exactly one customer.
    const conflict = await db.customerPhone.findFirst({
      where: {
        organizationId: ctx.company.organizationId,
        phoneNormalized: normalized,
        customerId: { not: customerId },
      },
      select: { customer: { select: { name: true } } },
    })
    if (conflict) {
      return {
        success: false,
        error: `Phone ${normalized} already belongs to customer "${conflict.customer.name}".`,
      }
    }

    // If this new phone is primary, unset any existing primary first.
    const phone = await db.$transaction(async (tx) => {
      if (d.is_primary) {
        await tx.customerPhone.updateMany({
          where: { customerId, isPrimary: true },
          data: { isPrimary: false },
        })
      }
      return tx.customerPhone.create({
        data: {
          customerId,
          organizationId: ctx.company.organizationId,
          phoneRaw: d.phone.trim(),
          phoneNormalized: normalized,
          label: d.label?.trim() || null,
          isPrimary: d.is_primary,
        },
      })
    })

    await insertAuditLog({
      action: 'customer.phone_added',
      entityType: 'customer',
      entityId: customerId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { phoneId: phone.id, phoneNormalized: normalized, isPrimary: d.is_primary },
    })

    return { success: true, data: { phoneId: phone.id } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to add customer phone',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// removeCustomerPhone
// ──────────────────────────────────────────────────────────────
/**
 * Remove a phone from a customer. Refuses to delete the LAST remaining
 * phone — a customer must always have at least one phone.
 */
export async function removeCustomerPhone(phoneId: string): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_CREATE)

    const phone = await db.customerPhone.findUnique({
      where: { id: phoneId },
      include: { customer: { select: { organizationId: true } } },
    })
    if (!phone || phone.customer.organizationId !== ctx.company.organizationId) {
      return { success: false, error: 'Phone not found' }
    }

    // Count this customer's phones — refuse to delete the last one.
    const phoneCount = await db.customerPhone.count({
      where: { customerId: phone.customerId },
    })
    if (phoneCount <= 1) {
      return {
        success: false,
        error: 'A customer must always have at least one phone number. Add another phone before removing this one.',
      }
    }

    await db.customerPhone.delete({ where: { id: phoneId } })

    await insertAuditLog({
      action: 'customer.phone_removed',
      entityType: 'customer',
      entityId: phone.customerId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      oldValues: { phoneId, phoneNormalized: phone.phoneNormalized },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to remove customer phone',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// addCustomerAddress
// ──────────────────────────────────────────────────────────────
export async function addCustomerAddress(
  customerId: string,
  input: AddressInput,
): Promise<ActionResult<{ addressId: string }>> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_CREATE)

    const parsed = addressInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid address data',
      }
    }
    const d = parsed.data

    const customer = await db.customer.findFirst({
      where: { id: customerId, organizationId: ctx.company.organizationId },
    })
    if (!customer) return { success: false, error: 'Customer not found' }

    // If this new address is default, unset any existing default first.
    const address = await db.$transaction(async (tx) => {
      if (d.is_default) {
        await tx.customerAddress.updateMany({
          where: { customerId, isDefault: true },
          data: { isDefault: false },
        })
      }
      return tx.customerAddress.create({
        data: {
          customerId,
          organizationId: ctx.company.organizationId,
          label: d.label?.trim() || null,
          address: d.address.trim(),
          city: d.city.trim(),
          isDefault: d.is_default,
        },
      })
    })

    await insertAuditLog({
      action: 'customer.address_added',
      entityType: 'customer',
      entityId: customerId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { addressId: address.id, city: address.city, isDefault: d.is_default },
    })

    return { success: true, data: { addressId: address.id } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to add customer address',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// updateCustomerAddress
// ──────────────────────────────────────────────────────────────
export async function updateCustomerAddress(
  addressId: string,
  input: AddressInput,
): Promise<ActionResult<{ addressId: string }>> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_CREATE)

    const parsed = addressInputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid address data',
      }
    }
    const d = parsed.data

    const address = await db.customerAddress.findUnique({
      where: { id: addressId },
      include: { customer: { select: { organizationId: true } } },
    })
    if (!address || address.customer.organizationId !== ctx.company.organizationId) {
      return { success: false, error: 'Address not found' }
    }

    // If promoting to default, unset any existing default first.
    const updated = await db.$transaction(async (tx) => {
      if (d.is_default && !address.isDefault) {
        await tx.customerAddress.updateMany({
          where: { customerId: address.customerId, isDefault: true },
          data: { isDefault: false },
        })
      }
      return tx.customerAddress.update({
        where: { id: addressId },
        data: {
          label: d.label?.trim() || null,
          address: d.address.trim(),
          city: d.city.trim(),
          isDefault: d.is_default,
        },
      })
    })

    await insertAuditLog({
      action: 'customer.address_updated',
      entityType: 'customer',
      entityId: address.customerId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      oldValues: {
        label: address.label,
        address: address.address,
        city: address.city,
        isDefault: address.isDefault,
      },
      newValues: {
        label: updated.label,
        address: updated.address,
        city: updated.city,
        isDefault: updated.isDefault,
      },
    })

    return { success: true, data: { addressId: updated.id } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to update customer address',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// removeCustomerAddress
// ──────────────────────────────────────────────────────────────
/**
 * Remove an address from a customer. Refuses to delete the LAST remaining
 * address — a customer must always have at least one address.
 */
export async function removeCustomerAddress(addressId: string): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_CREATE)

    const address = await db.customerAddress.findUnique({
      where: { id: addressId },
      include: { customer: { select: { organizationId: true } } },
    })
    if (!address || address.customer.organizationId !== ctx.company.organizationId) {
      return { success: false, error: 'Address not found' }
    }

    const addressCount = await db.customerAddress.count({
      where: { customerId: address.customerId },
    })
    if (addressCount <= 1) {
      return {
        success: false,
        error: 'A customer must always have at least one address. Add another address before removing this one.',
      }
    }

    await db.customerAddress.delete({ where: { id: addressId } })

    await insertAuditLog({
      action: 'customer.address_removed',
      entityType: 'customer',
      entityId: address.customerId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      oldValues: { addressId, address: address.address, city: address.city },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to remove customer address',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// markAddressAsUsed — internal helper (called by order creation flow)
// ──────────────────────────────────────────────────────────────
/**
 * Bump `lastUsedAt` on a customer_addresses row to NOW(). Called from the
 * Order creation flow when an order is submitted using that address, so the
 * UI can sort saved addresses by recency.
 */
export async function markAddressAsUsed(addressId: string): Promise<ActionResult> {
  try {
    await db.customerAddress.update({
      where: { id: addressId },
      data: { lastUsedAt: new Date() },
    })
    return { success: true }
  } catch (err) {
    // Non-fatal — never block order creation on this.
    console.error('[customer] markAddressAsUsed failed:', err)
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to mark address as used',
    }
  }
}

// ══════════════════════════════════════════════════════════════
// PART 3 — CROSS-PLATFORM MATCHING
// ══════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────
// matchOrCreateExternalCustomer
// ──────────────────────────────────────────────────────────────
/**
 * Thin wrapper around the match_or_create_customer() SQL function built in
 * Step 1. Implements the layered matching strategy:
 *   1. exact_identity  — existing (org, platform, external_customer_id) mapping
 *   2. phone_match     — normalize phone, match customer_phones
 *   3. email_match     — match Customer.email within org
 *   4. create          — create new customer + primary phone + external identity
 *
 * A future Shopify/Daraz/Instagram webhook handler will call this directly.
 * No live webhook exists in this step — this is built so integration work
 * later is a drop-in call rather than new logic.
 *
 * NOTE: this function does NOT require a workspace session — it's intended
 * to be called from a webhook context where there's no logged-in user.
 * The SQL function is SECURITY DEFINER so it can insert into Customer /
 * customer_phones / customer_external_identities regardless of caller
 * permissions. The caller MUST supply organizationId (resolved from the
 * webhook's target company).
 */
export async function matchOrCreateExternalCustomer(
  input: MatchExternalCustomerInput & { organizationId: string },
): Promise<ActionResult<{
  customerId: string
  wasNewlyCreated: boolean
  matchedVia: string
}>> {
  try {
    const parsed = matchExternalCustomerSchema.safeParse(input)
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid external customer input',
      }
    }
    const d = parsed.data

    // Check whether an external identity mapping already exists BEFORE
    // calling the SQL function, so we can report wasNewlyCreated accurately.
    const existingMapping = await db.customerExternalIdentity.findUnique({
      where: {
        organizationId_platform_externalCustomerId: {
          organizationId: input.organizationId,
          platform: d.platform,
          externalCustomerId: d.external_customer_id,
        },
      },
      select: { customerId: true, matchedVia: true },
    })

    // Call the SQL function — it handles all 4 layers race-safely.
    const rows = await db.$queryRaw<{ customer_id: string }[]>`
      SELECT match_or_create_customer(
        ${input.organizationId}::TEXT,
        ${d.platform}::TEXT,
        ${d.external_customer_id}::TEXT,
        ${d.phone || null}::TEXT,
        ${d.email || null}::TEXT,
        ${d.name || null}::TEXT
      ) AS customer_id
    `
    const customerId = rows[0]?.customer_id
    if (!customerId) {
      return { success: false, error: 'match_or_create_customer() returned no customer_id' }
    }

    const wasNewlyCreated = !existingMapping
    const matchedVia = existingMapping?.matchedVia ?? 'exact_identity'

    return {
      success: true,
      data: { customerId, wasNewlyCreated, matchedVia },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to match or create external customer',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// getCustomerExternalIdentities
// ──────────────────────────────────────────────────────────────
/**
 * List all platform mappings for a customer (for display on their profile —
 * e.g. "Linked to Shopify Customer #7891234567").
 */
export async function getCustomerExternalIdentities(
  customerId: string,
): Promise<ActionResult<{
  identities: Array<{
    id: string
    platform: string
    externalCustomerId: string
    matchedVia: string
    createdAt: Date
  }>
}>> {
  try {
    const ctx = await getWorkspace()

    const customer = await db.customer.findFirst({
      where: { id: customerId, organizationId: ctx.company.organizationId },
      select: { id: true },
    })
    if (!customer) return { success: false, error: 'Customer not found' }

    const identities = await db.customerExternalIdentity.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        platform: true,
        externalCustomerId: true,
        matchedVia: true,
        createdAt: true,
      },
    })

    return { success: true, data: { identities } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to get external identities',
    }
  }
}

// ══════════════════════════════════════════════════════════════
// PART 4 — CACHED STATS RECOMPUTATION + FLAGGING
// ══════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────
// updateCustomerStats — recomputes cached counts from the orders table
// ──────────────────────────────────────────────────────────────
/**
 * Recompute total_orders_count, total_order_value (sum of delivered orders'
 * total_order_value), and total_rto_count from the orders table for this
 * customer, then persist them to the customer row.
 *
 * Auto-flagging: if total_rto_count >= 3 AND the customer is not already
 * flagged for the high-RTO reason, call flagCustomer() with reason
 * 'High RTO rate (3+ returns)'. Idempotent — won't re-flag if already
 * flagged for this exact reason.
 *
 * This function is called after every order creation and every order status
 * change (delivered / rto / cancelled) to keep the cached counts current.
 */
export async function updateCustomerStats(customerId: string): Promise<ActionResult> {
  try {
    // Note: this is an internal helper often called from order.actions.ts
    // which already has a workspace context. We fetch orders without a
    // workspace check here (the caller is trusted internal code). The
    // cached stats are org-scoped by virtue of the customer row itself
    // being org-scoped.
    //
    // DEFINITIONS (applied consistently between cached writes here and
    // the read-time percentage calculations in customer-detail-view.tsx):
    //   total_orders_count = COUNT of non-cancelled orders
    //   total_order_value  = SUM(total_order_value) for delivered + dispatched
    //                        (orders that have left the warehouse — excludes
    //                        cancelled, refunded, pending, confirmed, processing)
    //   total_rto_count    = COUNT where status = 'rto'
    //   rto_rate / delivery_rate = computed at read-time in the frontend from
    //                        these cached values (no separate cached columns)
    const orders = await db.order.findMany({
      where: { customerId, status: { not: 'cancelled' } },
      select: { totalOrderValue: true, status: true },
    })

    const totalOrdersCount = orders.length
    // total_order_value = sum of delivered + dispatched orders' total_order_value
    // (orders that have actually shipped — reflects real revenue, excludes
    // pending/confirmed orders that may still be cancelled)
    const totalOrderValue = orders
      .filter((o) => o.status === 'delivered' || o.status === 'dispatched')
      .reduce((sum, o) => sum + Number(o.totalOrderValue), 0)
    const totalRtoCount = orders.filter((o) => o.status === 'rto').length

    await db.customer.update({
      where: { id: customerId },
      data: { totalOrdersCount, totalOrderValue, totalRtoCount },
    })

    // Auto-flag at 3+ RTO (idempotent — only flags if not already flagged
    // for the high-RTO reason).
    const RTO_FLAG_REASON = 'High RTO rate (3+ returns)'
    if (totalRtoCount >= 3) {
      const customer = await db.customer.findUnique({
        where: { id: customerId },
        select: { isFlagged: true, flaggedReason: true },
      })
      if (customer && (!customer.isFlagged || customer.flaggedReason !== RTO_FLAG_REASON)) {
        await flagCustomerInternal(customerId, RTO_FLAG_REASON, /* auto */ true)
      }
    }

    return { success: true }
  } catch (err) {
    // CRITICAL: never let a stats-update failure break the calling order
    // action. Log and return failure — the caller continues regardless.
    console.error('[customer] updateCustomerStats failed:', err)
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to update customer stats',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// flagCustomer — manual flagging (requires orders.manage)
// ──────────────────────────────────────────────────────────────
export async function flagCustomer(
  customerId: string,
  reason: string,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)
    return flagCustomerInternal(customerId, reason, /* auto */ false, ctx)
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to flag customer',
    }
  }
}

/**
 * Internal flag helper shared by manual flagCustomer() and the auto-flag
 * path in updateCustomerStats(). The auto path skips the permission check
 * (it's triggered by an order status change, not a user action) and skips
 * the metric event (to avoid metric spam during bulk recomputes).
 */
async function flagCustomerInternal(
  customerId: string,
  reason: string,
  auto: boolean,
  ctx?: {
    company: { id: string; organizationId: string }
    user: { id: string }
    employee: { id: string }
  },
): Promise<ActionResult> {
  const organizationId = ctx?.company.organizationId
  const customer = ctx
    ? await db.customer.findFirst({
        where: { id: customerId, organizationId },
      })
    : await db.customer.findUnique({ where: { id: customerId } })
  if (!customer) return { success: false, error: 'Customer not found' }

  // Idempotent: skip if already flagged for this exact reason.
  if (customer.isFlagged && customer.flaggedReason === reason) {
    return { success: true }
  }

  await db.customer.update({
    where: { id: customerId },
    data: {
      isFlagged: true,
      flaggedReason: reason,
      flaggedAt: new Date(),
      flaggedBy: ctx?.employee.id ?? null,
    },
  })

  if (ctx) {
    await insertAuditLog({
      action: auto ? 'customer.auto_flagged' : 'customer.flagged',
      entityType: 'customer',
      entityId: customerId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { reason, auto },
    })

    if (!auto) {
      await insertMetricEvent({
        companyId: ctx.company.id,
        entityType: 'customer',
        entityId: customerId,
        metricKey: 'customer.flagged',
        numericValue: 1,
        dimensions: { reason },
      }).catch(() => {})
    }
  }

  return { success: true }
}

// ──────────────────────────────────────────────────────────────
// unflagCustomer
// ──────────────────────────────────────────────────────────────
export async function unflagCustomer(customerId: string): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)

    const customer = await db.customer.findFirst({
      where: { id: customerId, organizationId: ctx.company.organizationId },
    })
    if (!customer) return { success: false, error: 'Customer not found' }

    await db.customer.update({
      where: { id: customerId },
      data: {
        isFlagged: false,
        flaggedReason: null,
        flaggedAt: null,
        flaggedBy: null,
      },
    })

    await insertAuditLog({
      action: 'customer.unflagged',
      entityType: 'customer',
      entityId: customerId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      oldValues: { reason: customer.flaggedReason },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to unflag customer',
    }
  }
}

// ══════════════════════════════════════════════════════════════
// PART 5 — LISTING & DETAIL
// ══════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────
// listCustomers
// ──────────────────────────────────────────────────────────────
/**
 * Paginated customer list. `search` matches customer name OR any
 * associated phone (raw or normalized). Each row includes the primary
 * phone and default address summary joined in.
 */
export async function listCustomers(filters: {
  search?: string
  isFlagged?: boolean
  dateFrom?: string
  dateTo?: string
  limit?: number
  offset?: number
} = {}): Promise<ActionResult<{ customers: CustomerSummaryDTO[]; total: number }>> {
  try {
    const ctx = await getWorkspace()
    const limit = Math.min(filters.limit ?? 50, 100)
    const offset = filters.offset ?? 0

    const where: Prisma.CustomerWhereInput = {
      organizationId: ctx.company.organizationId,
    }
    if (filters.isFlagged !== undefined) {
      where.isFlagged = filters.isFlagged
    }
    if (filters.dateFrom || filters.dateTo) {
      where.createdAt = {}
      if (filters.dateFrom) where.createdAt.gte = new Date(filters.dateFrom)
      if (filters.dateTo) where.createdAt.lte = new Date(filters.dateTo)
    }

    // Search across name + any associated phone (raw or normalized).
    // We resolve matching customer IDs via a customer_phones query first,
    // then OR them into the customer name search.
    let searchCustomerIds: string[] | null = null
    if (filters.search && filters.search.trim()) {
      const q = filters.search.trim()
      // Try normalizing the search term as a phone — if it normalizes to
      // something, search customer_phones by the normalized form too.
      const normalizedSearch = await normalizePhone(q)
      const phoneWhere: Prisma.CustomerPhoneWhereInput = {
        organizationId: ctx.company.organizationId,
        OR: [
          { phoneRaw: { contains: q, mode: 'insensitive' } },
          ...(normalizedSearch ? [{ phoneNormalized: { contains: normalizedSearch } }] : []),
        ],
      }
      const phoneMatches = await db.customerPhone.findMany({
        where: phoneWhere,
        select: { customerId: true },
        distinct: ['customerId'],
      })
      searchCustomerIds = phoneMatches.map((p) => p.customerId)

      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        ...(searchCustomerIds.length > 0 ? [{ id: { in: searchCustomerIds } }] : []),
      ]
    }

    const [customers, total] = await Promise.all([
      db.customer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          phones: {
            where: { isPrimary: true },
            take: 1,
          },
          addresses: {
            where: { isDefault: true },
            take: 1,
          },
        },
      }),
      db.customer.count({ where }),
    ])

    const customerDTOs: CustomerSummaryDTO[] = customers.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      primaryPhone: c.phones[0]?.phoneRaw ?? null,
      defaultAddress: c.addresses[0]
        ? { address: c.addresses[0].address, city: c.addresses[0].city }
        : null,
      totalOrdersCount: c.totalOrdersCount,
      totalOrderValue: Number(c.totalOrderValue),
      totalRtoCount: c.totalRtoCount,
      isFlagged: c.isFlagged,
      flaggedReason: c.flaggedReason,
      createdAt: c.createdAt,
    }))

    return { success: true, data: { customers: customerDTOs, total } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list customers',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// getCustomerDetail
// ──────────────────────────────────────────────────────────────
/**
 * Full customer record + all phones (primary first) + all addresses
 * (default first, then by lastUsedAt desc) + external identities + recent
 * order history (most recent first).
 */
export async function getCustomerDetail(
  customerId: string,
): Promise<ActionResult<CustomerDetailDTO>> {
  try {
    const ctx = await getWorkspace()

    const customer = await db.customer.findFirst({
      where: { id: customerId, organizationId: ctx.company.organizationId },
      include: {
        phones: { orderBy: { isPrimary: 'desc' } },
        addresses: {
          orderBy: [
            { isDefault: 'desc' },
            { lastUsedAt: { sort: 'desc', nulls: 'last' } },
          ],
        },
        externalIdentities: { orderBy: { createdAt: 'desc' } },
      },
    })
    if (!customer) return { success: false, error: 'Customer not found' }

    // Live-compute RTO rate + delivery rate from actual order statuses.
    // "Dispatched-or-later" = orders that have left the warehouse (dispatched,
    // delivered, rto) — the denominator per the spec. Pending/confirmed/
    // processing orders are excluded (they haven't shipped yet, so their
    // outcome is unknown).
    const statusCounts = await db.order.groupBy({
      by: ['status'],
      where: { customerId },
      _count: { status: true },
    })
    const statusMap = new Map(statusCounts.map((s) => [s.status, s._count.status]))
    const dispatchedOrLater =
      (statusMap.get('dispatched') ?? 0) +
      (statusMap.get('delivered') ?? 0) +
      (statusMap.get('rto') ?? 0)
    const deliveredCount = statusMap.get('delivered') ?? 0
    const rtoCount = statusMap.get('rto') ?? 0
    const rtoRate = dispatchedOrLater > 0 ? Math.round((rtoCount / dispatchedOrLater) * 100) : 0
    const deliveryRate = dispatchedOrLater > 0 ? Math.round((deliveredCount / dispatchedOrLater) * 100) : 0

    // Fetch ALL orders for this customer (not just 20) so the Orders tab
    // matches the stat card's totalOrdersCount. The Orders tab renders a
    // scrollable table (max-h-96 overflow-y-auto) so even 100+ orders are
    // manageable in the UI.
    const recentOrders = await db.order.findMany({
      where: { customerId },
      select: {
        id: true,
        flowopsOrderNumber: true,
        status: true,
        totalOrderValue: true,
        createdAt: true,
        recipientName: true,
        deliveryAddress: true,
        deliveryCity: true,
        usedCustomerAddressId: true,
        usedCustomerPhoneId: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    return {
      success: true,
      data: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        totalOrdersCount: customer.totalOrdersCount,
        totalOrderValue: Number(customer.totalOrderValue),
        totalRtoCount: customer.totalRtoCount,
        rtoRate,
        deliveryRate,
        isFlagged: customer.isFlagged,
        flaggedReason: customer.flaggedReason,
        flaggedAt: customer.flaggedAt,
        createdAt: customer.createdAt,
        updatedAt: customer.updatedAt,
        phones: customer.phones.map(toPhoneDTO),
        addresses: customer.addresses.map(toAddressDTO),
        externalIdentities: customer.externalIdentities.map((e) => ({
          id: e.id,
          platform: e.platform,
          externalCustomerId: e.externalCustomerId,
          matchedVia: e.matchedVia,
          createdAt: e.createdAt,
        })),
        recentOrders: recentOrders.map((o) => ({
          id: o.id,
          flowopsOrderNumber: o.flowopsOrderNumber,
          status: o.status,
          totalOrderValue: Number(o.totalOrderValue),
          createdAt: o.createdAt,
          recipientName: o.recipientName,
          deliveryAddress: o.deliveryAddress,
          deliveryCity: o.deliveryCity,
          usedCustomerAddressId: o.usedCustomerAddressId,
          usedCustomerPhoneId: o.usedCustomerPhoneId,
        })),
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to get customer detail',
    }
  }
}
