# Task: CMS-STEP-3-PART-1 — Rewrite CustomersView for new CMS schema

**Agent**: full-stack-developer
**Task ID**: CMS-STEP-3-PART-1
**Date**: 2025-07-28

## Context (from prior agents)

- **CMS-STEP-1-SCHEMA**: Customer table reshaped — legacy `phone`, `alternatePhone`, `shippingAddress`, `billingAddress` columns dropped. New child tables `customer_phones`, `customer_addresses`, `customer_external_identities` added. SQL functions `normalize_phone()` + `match_or_create_customer()` live. RLS enabled on all 4 customer tables.
- **CMS-STEP-2-SERVER-ACTIONS**: `listCustomers()` returns `{ customers: CustomerSummary[], total: number }` where CustomerSummary has `primaryPhone` + `defaultAddress` (NOT flat `phone`/`alternatePhone`). POST `/api/customers` handles both create + flag/unflag. Query param is `is_flagged` (NOT `flagged`).
- Shared components in `src/components/customers/`: `CreateCustomerForm` (self-handles API call + toast, calls `onCreated(customerId)` on success), `CustomerSearchAutocomplete`, `AddressSelector`, plus `types.ts` with `CustomerSummary`, `PhoneDTO`, `AddressDTO`, etc.

## What I did

Rewrote `/home/z/my-project/src/components/orders/customers-view.tsx`:

1. **Types**: Replaced local `CustomerRow`/`CustomersResponse` (which referenced removed `phone`/`alternatePhone`) with `CustomerSummary` from `@/components/customers/types` + `CustomersListResponse = { customers: CustomerSummary[]; total: number }`.
2. **API query**: Changed `flagged=true` → `is_flagged=true`. Reads `response.total` instead of removed `response.stats.total`.
3. **Stats cards**: Now 3 cards (was 2): Total Customers (from API total), Flagged Customers (client-filtered count), New This Month (client-filtered count via `isThisMonth()` helper).
4. **Table columns**: Customer (avatar initials + name + email), Phone (primaryPhone), City (defaultAddress.city with MapPin), Orders, Value (Rs.), RTO, Status (flag badge), Joined (formatDate createdAt), Actions (view + flag/unflag). Removed the standalone Email column — moved under name as secondary line.
5. **Add Customer**: New `[+ Add Customer]` button in PageHeader. Opens Dialog with `<CreateCustomerForm compact />`. On `onCreated(customerId)`: close dialog, invalidate `['customers']`, toast, navigate to `customer-detail`.
6. **Empty state**: Differentiates "no customers at all" (shows Add Customer CTA) vs "no customers match filters" (suggests clearing filters).
7. **FlagDialog**: Updated customer prop type to `CustomerSummary`. Mobile-friendly button stacking (`flex-col-reverse sm:flex-row`).
8. **Mobile-responsive** throughout; no `any` types; no province field anywhere.

## Verification

- `bun run lint`: 0 errors, 18 warnings (all pre-existing, 0 new).
- `npx tsc --noEmit`: 0 errors in any `src/components/orders/*` or `src/components/customers/*` file.
- Dev server: GET / 200, no errors in dev.log.

## Files touched

- `src/components/orders/customers-view.tsx` (full rewrite, ~450 lines)
- `worklog.md` (appended task record)

## For downstream agents

- `CustomersView` export name preserved (page.tsx imports it — no change needed there).
- The "New This Month" stat counts customers whose `createdAt` falls within the current calendar month (client-side, from loaded list). If a downstream agent wants server-side total counts (independent of search/flag filter), they'd need to extend the `/api/customers` endpoint to return separate `stats` — but the spec explicitly says "compute from the loaded list", so client-side is correct.
- `CreateCustomerForm` handles its own toast — do NOT add another toast in the parent on creation success (would double-toast). I added a separate "opening profile" toast after `onCreated` since that's a navigation action, not a creation confirmation.
