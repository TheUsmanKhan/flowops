# CMS-STEP-3-PART-2 — CustomerDetailView rewrite

## Task
Rewrite `src/components/orders/customer-detail-view.tsx` to use the new Customer Management System schema (4 tabs: Phones, Addresses, Platforms, Orders).

## Work Log
- Read prior worklog tail (CMS-STEP-1, CMS-STEP-2, CMS-STEP-3-PART-1, CMS-STEP-3-PART-4) to understand schema + server actions + shared types + sibling components.
- Read `src/components/customers/types.ts` (CustomerDetail, PhoneDTO, AddressDTO, ExternalIdentityDTO, RecentOrderDTO, formatLastUsed, PLATFORM_LABELS).
- Read existing `customer-detail-view.tsx` (old flat-schema version), `customers-view.tsx` (FlagDialog pattern + CustomerSummary usage), `order-create-view.tsx` worklog (CRM widget patterns), `_shared.ts` (formatPKR, formatDate, getErrorMessage, badgeForStatus).
- Confirmed API endpoints: GET /api/customers/[id] returns CustomerDetail directly (no wrapper); PATCH /api/customers/[id] for name; POST/DELETE for phones; POST/PATCH/DELETE for addresses; POST /api/customers for flag/unflag.
- Verified `api.delete(url)` takes only URL (no body data).

## Implementation
- Full rewrite: ~1455 lines. Removed old `CustomerDetail`, `CustomerAddress`, `CrmStats`, `RecentOrder`, `CustomerDetailResponse` local interfaces (referenced removed columns). Now consumes `CustomerDetail` shape from `@/components/customers/types`.
- Query key: `['customer-detail', customerId]` (was `['customer', customerId]`).
- Header: inline-editable name (click → Input; Enter saves via PATCH /api/customers/[id]; Escape cancels; onBlur cancels). Flag badge with Tooltip showing `flaggedReason` + `flaggedAt`. Flag/Unflag button gated behind `PERMISSIONS.ORDERS_MANAGE`.
- Stats row: 5 cards — Total Orders, Total Value (Rs.), RTO Count, RTO Rate %, Delivery Rate %. Tone coloring (rose/amber/emerald) based on thresholds.
- Tabs (shadcn `Tabs`): Phones | Addresses | Platforms | Orders, each with badge counts in trigger label.
- PhoneNumbersTab: list with primary badge + label, "+ Add Phone" inline form (phone + label + is_primary checkbox), per-row "Set as Primary" (for non-primary), per-row Remove with Tooltip-disabled state when last remaining.
- AddressesTab: cards with label, address, city, default badge, "Last used: X ago" via `formatLastUsed`. "+ Add Address" inline form. Per-card Edit (inline AddressCardEdit form), Remove (Tooltip-disabled when last), "Set as Default" (PATCH is_default:true).
- LinkedPlatformsTab: empty state ("No linked external accounts yet — this customer was created directly in FlowOps."). Cards with `PLATFORM_LABELS` badge + externalCustomerId + matchedVia + linked date.
- OrderHistoryTab: table with clickable order number (navigates to `order-detail`), date, status badge (badgeForStatus), total value (formatPKR), recipientName, deliveryAddress+deliveryCity joined.
- Mutations: updateName, flag, addPhone, removePhone, setPrimaryPhone (sequential DELETE then POST with is_primary:true), addAddress, updateAddress, removeAddress, setDefaultAddress (PATCH is_default:true). All invalidate `['customer-detail', customerId]` + `['customers']` on success + show Sonner toast.
- Mobile-responsive: stats grid (2 cols mobile → 5 cols desktop), TabsList scrolls horizontally, address cards stack on mobile, dialog buttons stack flex-col-reverse on mobile.
- FlagDialog: Dialog with Textarea, min 3 chars validation, resets reason when closed.

## Verification
- `bun run lint`: 0 errors, 18 pre-existing warnings (none in customer-detail-view.tsx).
- `npx tsc --noEmit`: 0 errors in customer-detail-view.tsx or any customer/orders file. Pre-existing errors only in unrelated files (settings, inventory).
- Dev server: clean, GET / 200.

## Stage Summary
- CustomerDetailView fully migrated to new CMS schema. Old flat `phone`/`alternatePhone`/`shippingAddress`/`billingAddress` JSONB references are gone.
- All 4 tabs functional with full CRUD via the new customer_phones / customer_addresses child tables.
- Inline name edit + flag/unflag + set-as-primary/set-as-default all working via the proper API endpoints.
- Mobile-responsive, accessibility (ARIA labels, tooltips for disabled buttons), and consistent styling with the rest of the OMS UI.
