# Customer Management System — Complete Solutions with Explanations

> Every issue from the Customer audit, explained in plain language with the recommended fix at each level (Backend, API, DB, Frontend) and prevention measures.

---

## CUS-001 — 2 Customers with ZERO Phones (Critical)

### What's Broken
Every customer MUST have at least one phone number — this is a fundamental business rule. But 2 customers in the database have zero phone records. These customers can't be called, can't receive courier notifications, and can't have new orders created for them (since order creation requires a phone).

### How This Happens
A code path created the Customer record but failed to create the associated CustomerPhone record. This could be:
- A race condition in `createCustomerInternal()` where the customer was created but the phone insert failed silently
- A direct DB insert (manual/test data) that bypassed the action function
- An import script that created customers without phones

### Solution

**DB (one-time data repair):**
- Query the 2 customers: `SELECT id, name, organizationId FROM "Customer" WHERE id NOT IN (SELECT DISTINCT "customerId" FROM "CustomerPhone")`
- For each: either add a placeholder phone (if the real phone is known) or mark the customer as inactive
- If the customers are test artifacts, delete them: `DELETE FROM "Customer" WHERE id IN (...)`

**Backend (prevention):**
- Add a DB-level trigger that prevents INSERT on Customer without at least one CustomerPhone:
```sql
CREATE OR REPLACE FUNCTION enforce_customer_has_phone()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "CustomerPhone" WHERE "customerId" = NEW.id) THEN
    RAISE EXCEPTION 'Customer % must have at least one phone number', NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```
- OR: wrap `createCustomerInternal()` in `db.$transaction()` that includes both customer + phone creation (already done in most paths — verify all paths)

---

## CUS-002 — Phone Normalization Produces 3 Different Formats (Critical)

### What's Broken
The same phone number `03001234567` is stored with 3 different `phoneNormalized` values:
1. `03001234567` (raw, no normalization)
2. `+92 300 1234567` (spaces included — wrong)
3. `+923001234567` (correct E.164)

The unique index on `(organizationId, phoneNormalized)` is supposed to prevent duplicate customers with the same phone. But since the same phone produces 3 different normalized values, duplicates slip through — the same person gets 3 different customer records.

### Real-World Impact
- Customer "Ahmed" orders 3 times — each time a NEW customer record is created because the phone normalizes differently
- His order history is split across 3 records — the system thinks he's 3 different people
- His RTO count is split (e.g., 2 RTOs on record 1, 1 RTO on record 2, 0 on record 3) — never hits the 3-RTO flag threshold
- Customer service sees 3 different "Ahmed" records and can't figure out which one is the real one
- Marketing/messaging sends 3 duplicate messages to the same person

### Solution

**Backend (root cause fix):**
File: `src/lib/phone-validation.ts` — the normalization function

Audit ALL normalization code paths and ensure they ALL produce the same E.164 format:
```typescript
// The CORRECT normalization:
// Input: "03001234567" → Output: "+923001234567"
// Input: "+92 300 1234567" → Output: "+923001234567"
// Input: "0300-1234567" → Output: "+923001234567"

export function normalizePhoneInternational(phone: string): string {
  // 1. Strip ALL non-digit characters (spaces, dashes, parens)
  const digits = phone.replace(/\D/g, '')
  // 2. If starts with 0 (Pakistani local), replace with +92
  if (digits.startsWith('0')) return '+92' + digits.slice(1)
  // 3. If starts with 92 (already has country code), add +
  if (digits.startsWith('92')) return '+' + digits
  // 4. If starts with + already, keep as-is
  if (phone.startsWith('+')) return digits.startsWith('+') ? phone : '+' + digits
  // 5. Default: assume Pakistani
  return '+92' + digits
}
```

Key: ensure EVERY code path that calls `normalizePhoneInternational()` gets the SAME result for the SAME input. The bug is likely that one path strips spaces before normalizing and another doesn't.

**DB (data repair):**
- Re-normalize ALL existing `phoneNormalized` values:
```sql
-- First, find duplicates that would collide
SELECT "phoneNormalized", count(*) as cnt, array_agg(id) as phone_ids
FROM "CustomerPhone"
GROUP BY "phoneNormalized"
HAVING count(*) > 1;
-- Then merge duplicate customers (complex — needs manual review)
```
- For simple cases (same customer, different normalization): merge the phone records and update the customer reference
- For complex cases (genuinely different customers with same phone): merge into one customer record

**Prevention:**
- Add a unit test that verifies: `normalizePhoneInternational('03001234567') === normalizePhoneInternational('+92 300 1234567') === normalizePhoneInternational('+923001234567')`
- Add a DB trigger that RE-normalizes on INSERT/UPDATE to catch any code path that produces a non-standard format

---

## CUS-003 — 7 Customers with ZERO Addresses (Critical)

### What's Broken
Same as CUS-001 but for addresses — 7 customers have no address records. Orders can't be created for them because there's no delivery address.

### Solution
Same approach as CUS-001:
- **DB:** Delete test customers or add placeholder addresses for real ones
- **Backend:** Same trigger pattern — prevent Customer INSERT without at least one CustomerAddress
- **Prevention:** Verify all customer creation paths create both phone AND address

---

## CUS-004 + CUS-005 — Customer Detail/Search Routes Have No Permission Check (High)

### What's Broken
`getCustomerDetail()`, `searchCustomerByPhone()`, and `searchCustomersDetailed()` have no `requirePermission()` call. Any authenticated employee — even with zero permissions — can fetch any customer's full record including phone numbers, addresses, order history, and RTO stats.

### Real-World Impact
- A Warehouse Staff member (who should only see orders, not customer data) can look up any customer's phone number
- A Sales rep from Company A can search customers in Company B (same org)
- Sensitive customer data (addresses, phone numbers) is exposed to anyone with a login

### Solution

**Backend:**
Add `requirePermission(ctx, PERMISSIONS.CUSTOMERS_VIEW)` to all 3 functions:

```typescript
// BEFORE:
export async function getCustomerDetail(customerId: string) {
  const ctx = await getWorkspace()
  // ... no permission check
}

// AFTER:
export async function getCustomerDetail(customerId: string) {
  const ctx = await getWorkspace()
  await requirePermission(ctx, PERMISSIONS.CUSTOMERS_VIEW)
  // ... rest of function
}
```

Apply the same to `searchCustomerByPhone()` and `searchCustomersDetailed()`.

**Prevention:**
- CI check: grep for `getWorkspace()` in action functions that don't also call `requirePermission()`

---

## CUS-006 — 5 Customers Have Stale Cached Stats (High)

### What's Broken
Customer stats (totalOrders, totalOrderValue, totalRtoCount, etc.) are cached on the Customer record for performance. But when orders are hard-deleted (not just cancelled), the stats are never recomputed. One customer shows 14 orders but actually has 0 — the orders were deleted but the cache wasn't updated.

### Real-World Impact
- Customer profile shows "14 orders, Rs 42,000 total" but the customer has never actually ordered
- RTO rate is wrong (shows 3 RTOs from deleted orders → triggers false fraud flag)
- Dashboard KPIs are wrong (total customers with 3+ RTOs is inflated)
- Sales team wastes time investigating "high-RTO" customers who have never ordered

### Solution

**DB (one-time repair):**
Run `updateCustomerStats()` for ALL customers to recompute from actual order data:
```sql
UPDATE "Customer" c SET
  "totalOrders" = COALESCE((SELECT count(*) FROM "Order" WHERE "customerId" = c.id), 0),
  "totalOrderValue" = COALESCE((SELECT SUM("totalOrderValue") FROM "Order" WHERE "customerId" = c.id), 0),
  "totalRtoCount" = COALESCE((SELECT count(*) FROM "Order" WHERE "customerId" = c.id AND status = 'rto'), 0),
  "lastOrderAt" = (SELECT MAX("createdAt") FROM "Order" WHERE "customerId" = c.id)
WHERE c.id IN (/* the 5 affected customer IDs */);
```

**Backend (prevention):**
- If hard-delete of orders is ever needed in the future, ALWAYS call `updateCustomerStats(customerId)` after the delete
- Better: never hard-delete orders — always soft-delete (status='cancelled' or a new 'deleted' status)
- Add a weekly reconciliation job (similar to the inventory drift detection) that verifies cached stats match actual order counts

---

## CUS-007 — Auto-Flag at 3+ RTO Never Fires (High)

### What's Broken
The system is supposed to automatically flag customers who have 3+ RTOs (Return to Origin) as "high return rate" customers. But this has NEVER fired in production — 0 audit log entries for `customer.auto_flagged`. One customer has 11 RTOs but is NOT flagged.

### Root Cause
`processOrderReturn()` calls `flagCustomer()` to flag the customer. But `flagCustomer()` requires `CUSTOMERS_EDIT` permission — and the RTO handler only has `ORDERS_MANAGE` permission. The flag call gets a 403 error, which breaks the entire RTO response (CUS-018). The no-permission variant `flagCustomerInternal()` exists but is not exported.

### Real-World Impact
- Serial returners (customers who order and return repeatedly) are never flagged
- Staff can't identify problem customers at a glance
- The "flagged customer" warning doesn't appear on order creation
- Fraud detection (e.g., ordering to get free delivery then returning) is completely non-functional

### Solution

**Backend:**
1. Export `flagCustomerInternal()` from `customer.actions.ts` (it already exists but isn't exported)
2. In `processOrderReturn()` (order-return.actions.ts), replace the call to `flagCustomer()` with `flagCustomerInternal()`:

```typescript
// BEFORE (order-return.actions.ts ~line 228):
const { flagCustomer } = await import('./customer.actions')
await flagCustomer({ customer_id: order.customerId, reason: 'Auto-flagged: RTO rate exceeded threshold' })

// AFTER:
const { flagCustomerInternal } = await import('./customer.actions')
await flagCustomerInternal(order.customerId, 'Auto-flagged: RTO rate exceeded threshold (3+)')
```

This single fix also resolves CUS-018 (the 500 error on RTO processing).

**DB (one-time backfill):**
Flag all customers who currently have 3+ RTOs but aren't flagged:
```sql
UPDATE "Customer"
SET "isFlagged" = true, "flagReason" = 'Auto-flagged: 3+ RTO rate (backfill)'
WHERE "totalRtoCount" >= 3 AND "isFlagged" = false;
```

**Prevention:**
- System-initiated actions should NEVER call permission-gated functions — always use the `Internal` variant
- Add a test: create a customer with 3 RTOs and verify the flag is set

---

## CUS-008 — deliveryCountry Returned as undefined (Medium)

### What's Broken
The customer detail API returns `deliveryCountry: undefined` instead of the actual country code. The field is included in the query but the response shape doesn't map it correctly.

### Solution
Fix the response mapping in `getCustomerDetail()` to include `deliveryCountry` from the default address.

---

## CUS-009 — Country Stored as Name Instead of Code (High)

### What's Broken
4 customer addresses have `country='Pakistan'` (the name) instead of `country='PK'` (the ISO code). The system expects alpha-2 codes everywhere — `CountrySelector`, city matching, courier booking. These 4 addresses break city validation and courier matching.

### Real-World Impact
- When ordering for these customers, the city autocomplete doesn't work (country mismatch → city list is empty)
- Courier booking may fail (Leopard expects a city ID that's resolved via country → city mapping)
- The AddressSelector shows "Pakistan" as text instead of using the flag/code-based selector
- 31 addresses are "pending validation" because the city validator can't match the country

### Solution

**DB (one-time repair):**
```sql
UPDATE "CustomerAddress" SET country = 'PK' WHERE country = 'Pakistan';
-- Also check for other country names:
UPDATE "CustomerAddress" SET country = 'AE' WHERE country = 'United Arab Emirates';
UPDATE "CustomerAddress" SET country = 'GB' WHERE country = 'United Kingdom';
UPDATE "CustomerAddress" SET country = 'US' WHERE country = 'United States';
```

**Frontend (prevention):**
Add a `CountrySelector` component to the customer-detail-view's "Add Address" and "Edit Address" forms (CUS-010 fix). The `CreateCustomerForm` already has one — the detail view is inconsistent.

---

## CUS-010 — Customer Detail Address Forms Have No Country Field (Medium)

### What's Broken
The "Add Address" and "Edit Address" forms in the customer detail view have only Address, City, and Label fields — no Country selector. Every address created via this form defaults to `country='Pakistan'` (the name, not the code). The `CreateCustomerForm` DOES have a CountrySelector — the detail view is inconsistent.

### Solution
Add the `CountrySelector` component to both forms in `customer-detail-view.tsx`, matching the pattern used in `CreateCustomerForm`.

---

## CUS-011 — Address Display Shows Code Instead of Name (Low)

### What's Broken
The customer detail view shows `PK` instead of `Pakistan` for the country. Technically correct (the DB stores the code), but not user-friendly.

### Solution
Add a `countryCodeToName()` helper (or use the existing `countries.ts` data) to display the full country name in the UI while keeping the code in the data layer.

---

## CUS-012 — Flag Reason String Inconsistency (Low)

### What's Broken
Different code paths that auto-flag customers use different reason strings (e.g., "High RTO rate" vs "Auto-flagged: RTO rate exceeded threshold"). This makes it hard to filter audit logs by reason.

### Solution
Standardize the reason string across all auto-flag paths. Use a constant:
```typescript
const AUTO_FLAG_RTO_REASON = 'Auto-flagged: 3+ RTO rate exceeded'
```

---

## CUS-013 — "Set as Primary Phone" Deletes and Re-creates (Low)

### What's Broken
When setting a phone as primary, the UI deletes the existing phone record and creates a new one. This loses the `createdAt` timestamp and any metadata. It should just UPDATE the existing record.

### Solution
Use `db.customerPhone.update()` to set `isPrimary=true` on the new phone and `isPrimary=false` on the old primary, instead of delete + create.

---

## CUS-014 — Customer Summary Type Omits Country (Low)

### What's Broken
The `CustomerSummary` TypeScript type in `customers/types.ts` doesn't include `country` in the `defaultAddress` object, even though the API returns it.

### Solution
Add `country: string | null` to the type definition.

---

## CUS-015 — Type Comments Lie About Country Format (Low)

### What's Broken
Type comments say country is stored as a NAME (e.g., "Pakistan") but the code actually stores it as a CODE (e.g., "PK"). This misleads developers.

### Solution
Update the type comments to accurately reflect that country is stored as an ISO 3166-1 alpha-2 code.

---

## CUS-016 — City Validation Silently Fails (Medium)

### What's Broken
`validateCustomerAddressCity()` is called fire-and-forget (`.catch(() => {})`). If it fails, the error is silently swallowed. 31 addresses are "pending validation" because the function failed but nobody knows.

### Solution
Log the failure (don't swallow it silently):
```typescript
// BEFORE:
validateCustomerAddressCity(...).catch(() => {})

// AFTER:
validateCustomerAddressCity(...).catch((e) => {
  console.error('[customer] City validation failed:', e.message)
  // Still non-fatal — don't block the address creation
})
```

Also: add a weekly job that retries pending validations.

---

## CUS-017 — Customer Detail Loads ALL Orders with No Pagination (Low)

### What's Broken
The customer detail "Recent Orders" tab fetches ALL orders for the customer with no limit or pagination. For customers with hundreds of orders, this causes slow load times and potential memory issues.

### Solution
Add pagination (limit + offset) to the orders query in `getCustomerDetail()`.

---

## CUS-018 — Auto-Flag Failure Surfaces as 500 (Medium)

### What's Broken
When `processOrderReturn()` calls `flagCustomer()` and it fails with 403 (permission denied), the error propagates and the entire RTO response returns 500 — even though the RTO itself was processed successfully. The user sees an error when the RTO actually worked.

### Solution
Fixed by CUS-007 — using `flagCustomerInternal()` (no permission check) instead of `flagCustomer()`. The flag call should be non-fatal:
```typescript
// Non-fatal — flag failure shouldn't break RTO
try {
  await flagCustomerInternal(customerId, reason)
} catch (e) {
  console.error('[RTO] Auto-flag failed:', e.message)
}
```

---

## CUS-019 — Search Autocomplete Shows Only ONE Result (Low)

### What's Broken
The customer search autocomplete in the order-create form only shows the first matching customer. If multiple customers match (e.g., "Ahmed" matches Ahmed Khan and Ahmed Ali), only the first appears.

### Solution
Return multiple results from the search and show a dropdown list for the user to pick from.

---

## CUS-020 — POST /api/customers Has No Zod Validation at Route Layer (Low)

### What's Broken
The customer create route uses `readBody<CreateCustomerInput>()` (typed but not runtime-validated). Unexpected fields or invalid types could be passed through.

### Solution
Add a Zod schema (`createCustomerRouteSchema`) and use `safeParse` in the route handler.

---

## CUS-021 — isValidFormat Flag Never Surfaced in UI (Low)

### What's Broken
The `isValidFormat` flag on `CustomerPhone` is set to `false` when a phone number doesn't match expected formats, but this information is never shown in the UI. Staff can't see which phones have format issues.

### Solution
Show a small warning badge next to phones with `isValidFormat=false` in the customer detail view, with a tooltip explaining the issue.

---

## Summary: Prevention Measures

### 1. Phone Normalization Consistency
**Problem:** 3 different normalization formats for the same number.
**Fix:** Single normalization function, unit-tested, with a DB trigger that re-normalizes on insert/update.

### 2. Customer Creation Integrity
**Problem:** Customers created without phones or addresses.
**Fix:** DB triggers that enforce at least 1 phone + 1 address per customer. All creation paths wrapped in `$transaction`.

### 3. System-Initiated Actions Should Bypass Permissions
**Problem:** Auto-flag fails because it calls a permission-gated function.
**Fix:** Always export `Internal` variants of action functions for system/poller/webhook use. Never call permission-gated functions from background jobs.

### 4. Stats Cache Reconciliation
**Problem:** Cached stats go stale when orders are hard-deleted.
**Fix:** Weekly reconciliation job that recomputes stats from actual order data. Never hard-delete orders.

### 5. Country Code Consistency
**Problem:** Country stored as name in some places, code in others.
**Fix:** Always store ISO 3166-1 alpha-2 codes. Add CountrySelector to ALL address forms. DB trigger that rejects non-alpha-2 values.

### 6. Permission Check Completeness
**Problem:** Detail/search routes missing permission checks.
**Fix:** CI check for `getWorkspace()` without `requirePermission()` in action functions.

### 7. Fire-and-Forget Error Logging
**Problem:** Silent error swallowing in fire-and-forget patterns.
**Fix:** Always log errors in `.catch()` blocks, even if non-fatal. Add monitoring alerts for frequent failures.
