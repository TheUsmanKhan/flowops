/**
 * Customer Management System — shared TypeScript types.
 *
 * Used by both the standalone /customers pages AND the Order Creation page
 * so they share the same shape definitions (no duplicate interfaces).
 */

export interface PhoneDTO {
  id: string
  phoneRaw: string
  phoneNormalized: string
  label: string | null
  isPrimary: boolean
  createdAt: string
}

export interface AddressDTO {
  id: string
  label: string | null
  address: string
  city: string
  isDefault: boolean
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
  // City validation (Phase 7 — early warning, not blocking).
  // List of courier providerKeys (e.g. ['postex', 'tcs']) whose cached
  // operational cities include this address's city. Empty array = no
  // connected courier recognizes this city (soft warning).
  // The authoritative check is always revalidateCityAtBookingTime() at booking.
  cityMatchedCouriers: string[]
  cityValidatedAt: string | null
}

export interface ExternalIdentityDTO {
  id: string
  platform: string
  externalCustomerId: string
  matchedVia: string
  createdAt: string
}

export interface RecentOrderDTO {
  id: string
  flowopsOrderNumber: string
  status: string
  totalOrderValue: number
  createdAt: string
  recipientName: string | null
  deliveryAddress: string | null
  deliveryCity: string | null
  usedCustomerAddressId: string | null
  usedCustomerPhoneId: string | null
}

/** Customer row in the list view (primary phone + default address joined in). */
export interface CustomerSummary {
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
  createdAt: string
}

/** Full customer detail (phones, addresses, external identities, recent orders). */
export interface CustomerDetail {
  id: string
  name: string
  email: string | null
  totalOrdersCount: number
  totalOrderValue: number
  totalRtoCount: number
  /** Live-computed: rto / dispatched-or-later orders * 100 */
  rtoRate: number
  /** Live-computed: delivered / dispatched-or-later orders * 100 */
  deliveryRate: number
  isFlagged: boolean
  flaggedReason: string | null
  flaggedAt: string | null
  createdAt: string
  updatedAt: string
  phones: PhoneDTO[]
  addresses: AddressDTO[]
  externalIdentities: ExternalIdentityDTO[]
  recentOrders: RecentOrderDTO[]
}

/** The response shape from searchCustomerByPhone (GET /api/customers?detailed=1&search=...). */
export interface CustomerSearchResult {
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
}

/** Input shapes matching the Zod schemas in customer.schemas.ts. */
export interface PhoneInput {
  phone: string
  label?: string
  is_primary: boolean
}

export interface AddressInput {
  label?: string
  address: string
  city: string
  is_default: boolean
}

export interface CreateCustomerInput {
  name: string
  email?: string
  phones: PhoneInput[]
  addresses: AddressInput[]
}

export interface UpdateCustomerInput {
  customer_id: string
  name?: string
  email?: string
}

/** Format lastUsedAt as a relative time string ("3 days ago", "Never used"). */
export function formatLastUsed(iso: string | null): string {
  if (!iso) return 'Never used'
  const date = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  const diffHours = Math.floor(diffMs / 3_600_000)
  const diffDays = Math.floor(diffMs / 86_400_000)
  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins} min ago`
  if (diffHours < 24) return `${diffHours} hr ago`
  if (diffDays < 30) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`
  return date.toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** Platform display metadata (icon label + display name). */
export const PLATFORM_LABELS: Record<string, { label: string; color: string }> = {
  shopify: { label: 'Shopify', color: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  daraz: { label: 'Daraz', color: 'bg-orange-100 text-orange-700 border-orange-200' },
  instagram: { label: 'Instagram', color: 'bg-pink-100 text-pink-700 border-pink-200' },
}
