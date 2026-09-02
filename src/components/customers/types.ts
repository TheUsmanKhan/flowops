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
  isValidFormat?: boolean
  createdAt: string
}

export interface AddressDTO {
  id: string
  label: string | null
  address: string
  city: string
  /** Country NAME (e.g. "Pakistan"), NOT an alpha-2 code. Nullable for
   *  rows created before the country-system phase (default applied at DB
   *  layer going forward). */
  country: string | null
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
  /** Country NAME snapshot at order creation (nullable for historical
   *  orders pre-dating the country-system phase). */
  deliveryCountry: string | null
  usedCustomerAddressId: string | null
  usedCustomerPhoneId: string | null
  /** Phase 4: sales attribution — present on full-detail rows, OMITTED on limited rows. */
  salesEmployeeId?: string | null
  /** True if this order was attributed to the current viewer (salesEmployeeId === viewer's employeeId). */
  isOwnOrder?: boolean
  /** True if this row is a limited-view row (non-own order + viewer scope='own'). Limited rows show only orderNumber/date/status. */
  isLimitedView?: boolean
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
  /** Country NAME (e.g. "Pakistan"). Optional — server defaults to
   *  "Pakistan" when absent. NOT an alpha-2 code. */
  country?: string
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
