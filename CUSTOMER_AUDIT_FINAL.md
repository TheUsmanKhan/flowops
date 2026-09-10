# Customer Management Module — Audit Report

**Task ID:** CUSTOMER-AUDIT
**Mode:** READ-ONLY (no code modified)
**Date:** 2026-09-10
**Auditor:** Explore sub-agent
**Scope:** Models (Customer, CustomerPhone, CustomerAddress, CustomerExternalIdentity), Routes (`src/app/api/customers/**`), Actions (`src/lib/actions/customer.actions.ts`), Validations (`src/lib/validations/customer.schemas.ts`), Frontend (`customers-view.tsx`, `customer-detail-view.tsx`, `CreateCustomerForm.tsx`, `CustomerSearchAutocomplete.tsx`, `AddressSelector.tsx`), Cross-module: `order.actions.ts`, `order-return.actions.ts`.

---

## Executive Summary

The Customer Management module is **architecturally sound** (clear org-scoped design, phone normalization strategy, cached-stats-with-auto-flag, row-level order scoping in detail view) but contains **3 critical data-integrity bugs**, **4 permission gaps**, and **2 frontend form bugs** that together corrupt data and silently break the High-RTO auto-flag feature.

**Most serious findings:**
1. `phoneNormalized` column contains **3 distinct formats for the same number** (`03001234567`, `+92 300 1234567`, `+923001234567`) — the dedup invariant is broken.
2. **2 customers have ZERO phones** and **7 customers have ZERO addresses** — both violate the module's hard invariant ("a customer must always have ≥1 phone and ≥1 address").
3. **1 customer (Fatima Ahmed) has 11 RTOs but is NOT flagged** — the auto-flag has never fired in production (audit log shows 0 `customer.auto_flagged` entries).
4. **Permission check missing** on `getCustomerDetail`, `searchCustomerByPhone`, `searchCustomersDetailed` — any authenticated user (even with no `customers.view` permission) can fetch any customer's full record by ID.
5. **Country field stored inconsistently** as both alpha-2 code (`'PK'`) and country name (`'Pakistan'`) depending on which code path created the address — breaks `CityMatchInfo`, `AddressSelector`, and the city-validation background job.

**DB snapshot:**
- 38 customers across 9 organizations
- 36 phones, 33 addresses, 0 external identities
- 0 orders with NULL customerId, 0 orphaned orders, 0 mismatched address/phone refs

---

## DB Query Results (Live)

### Counts
| Metric | Value |
|---|---|
| Total customers | 38 (across 9 orgs) |
| Total phones | 36 |
| Total addresses | 33 |
| Total external identities | 0 |
| Customers flagged (High RTO) | 0 |
| Customers flagged (any reason) | 0 |

### Duplicate phones (normalized string shared across customers — cross-org OK, intra-org NOT OK)
| phoneNormalized | customer_count | cross-org? |
|---|---|---|
| `+92 300 1234567` (with spaces) | 3 | ✅ 3 different orgs |
| `+923001234567` (correct E.164) | 4 | ✅ 4 different orgs |
| `+923009876543` | 2 | ✅ 2 different orgs |

**Note:** No intra-org duplicates exist (the `(organizationId, phoneNormalized)` unique constraint is enforced). But the **same `phoneRaw` value (`03001234567`) is stored with 3 different `phoneNormalized` values** — see CUS-002.

### Customers with NO primary phone (DB invariant violation)
| Customer ID | Name | phone_count | primary_count |
|---|---|---|---|
| `cmthm3ci30003rm5irmm3msmn` | Test Customer Karachi | 0 | 0 |
| `cms4kdynw0001rvpgaq4rfuh0` | Exchange Test Customer | 0 | 0 |

### Customers with NO phone at all (hard invariant violation)
Same 2 customers above.

### Customers with NO default address (DB invariant violation)
7 customers — `Test Customer Karachi`, `Test 1785160607`, `Usman Khan`, `Fix Test 1785159036`, `Fatima Ahmed`, `Test Customer 1785150542`, `Exchange Test Customer`.

### Customers with NO address at all (hard invariant violation)
Same 7 customers above.

### Customers with multiple primary phones (would violate the partial unique index)
0 — the partial unique index is correctly enforced.

### Stale cached stats (totalOrdersCount or totalRtoCount ≠ actual)
| Customer | cached_orders | actual_orders | cached_rto | actual_rto |
|---|---|---|---|---|
| Test Booking Customer | 14 | 0 | 0 | 0 |
| City Test Customer | 2 | 0 | 0 | 0 |
| Test Customer 1785150542 | 7 | 5 | 0 | 0 |
| Test Bad City Customer | 1 | 0 | 0 | 0 |
| MZ Web | 2 | 1 | 0 | 0 |

5 customers have stale cached order counts — most severe drift is 14 (Test Booking Customer). All 5 have **0 actual non-cancelled orders** despite non-zero cached counts, indicating `updateCustomerStats()` has never successfully recomputed for them.

### Orphaned orders / orphaned address-phone refs
- 0 orders with `customerId` pointing to a non-existent Customer.
- 0 orders with NULL `customerId`.
- 0 orders with `usedCustomerAddressId` pointing to a different customer's address.
- 0 orders with `usedCustomerPhoneId` pointing to a different customer's phone.
- 0 orders with `usedCustomerAddressId`/`usedCustomerPhoneId` pointing to deleted rows.
- 0 Customer↔Order `organizationId` mismatches.

### Country field inconsistency (alpha-2 code vs country name)
| Country value stored | count |
|---|---|
| `'PK'` (alpha-2 code — correct) | 29 |
| `'Pakistan'` (country name — WRONG) | 4 |
| Other | 0 |

4 rows have the country name string instead of the alpha-2 code. These rows break:
- `validateCustomerAddressCity()` country guard (line 915: `if (country && country !== 'PK') return`)
- `CityMatchInfo` UI component (line 1174: same check)
- `AddressSelector` component (line 81: `deliveryCountry: addr.country ?? 'PK'`)
- `CountrySelector` (which expects alpha-2 codes only)

### City validation pending
31 distinct customers have addresses with `cityValidatedAt IS NULL` — the fire-and-forget `validateCustomerAddressCity()` background job has either not run or has silently failed for these rows.

### Inconsistent phone normalization (same `phoneRaw`, different `phoneNormalized`)
| phoneRaw | norm_count | normalized values |
|---|---|---|
| `03001234567` | 3 | `+92 300 1234567`, `+923001234567`, `03001234567` |
| `03007654321` | 2 | `+923007654321`, `03007654321` |
| `03009876543` | 2 | `+92 300 9876543`, `+923009876543` |
| `03196273245` | 2 | `+92 319 6273245`, `+923196273245` |
| `03247545352` | 2 | `+92 324 7545352`, `+923247545352` |

### Customers that SHOULD be flagged for High RTO but aren't (actual_rto ≥ 3)
| Customer | cached_rto | actual_rto | is_flagged |
|---|---|---|---|
| Fatima Ahmed | 11 | 11 | false |

### Audit log entries for customer.* events
| Action | Count |
|---|---|
| customer.created | 33 |
| customer.address_added | 2 |
| customer.flagged (manual) | 1 |
| customer.unflagged | 1 |
| customer.auto_flagged | **0** |

**The auto-flag has NEVER fired in production.** The single manual flag + unflag pair corresponds to Fatima Ahmed — she was manually flagged, manually unflagged, and the auto-flag in `updateCustomerStats()` has never re-flagged her despite 11 RTOs.

---

## Manual Stats Verification — 3 Sample Customers

### Sample 1: Fatima Ahmed (`cms1ns3s9000ttdjo64gk3oap`)
| Metric | Cached | Actual | Match? |
|---|---|---|---|
| totalOrdersCount | 81 | 81 (non-cancelled) | ✅ |
| totalRtoCount | 11 | 11 | ✅ |
| totalOrderValue | 228,050 | 228,050 (sum of delivered+dispatched) | ✅ |
| Status counts | — | pending:12, confirmed:12, processing:12, dispatched:12, delivered:11, rto:11, refunded:11 | — |

**Stats are accurate**, but she is **NOT flagged** despite crossing the RTO threshold by 8 (3→11). The cached `totalRtoCount=11` is correct, so `updateCustomerStats` HAS been called for her — the auto-flag branch should fire. See CUS-007.

### Sample 2: Test Booking Customer (`cmshgvufn0000p680a7qlnc7e`)
| Metric | Cached | Actual | Match? |
|---|---|---|---|
| totalOrdersCount | 14 | 0 | ❌ |
| totalRtoCount | 0 | 0 | ✅ |
| totalOrderValue | 4,990 | 0 | ❌ |
| Status counts | — | (no orders at all) | — |

**Stats are STALE.** 14 orders existed at some point and were hard-deleted (not just cancelled). `updateCustomerStats` was never re-run for this customer. See CUS-006.

### Sample 3: Test Customer (`cmtlv0cag000cp50w73co0i1r`)
| Metric | Cached | Actual | Match? |
|---|---|---|---|
| totalOrdersCount | 8 | 8 | ✅ |
| totalRtoCount | 2 | 2 | ✅ |
| totalOrderValue | 0 | 0 (no delivered/dispatched orders) | ✅ |
| Status counts | — | confirmed:6, rto:2 | — |

**Stats are accurate.** No issues with this customer.

---

## Issues Found

### CUS-001 — Customers with zero phones violate hard invariant
- **Layer:** Data
- **Severity:** Critical
- **Location:** DB (2 rows); root cause likely `match_or_create_customer()` SQL function or test seed scripts
- **Description:** 2 customers exist with zero `customer_phones` rows: `Test Customer Karachi` (cmthm3ci30003rm5irmm3msmn), `Exchange Test Customer` (cms4kdynw0001rvpgaq4rfuh0). The module documents the invariant "a customer must always have ≥1 phone" (customer.actions.ts:18-19) and the action-layer `removeCustomerPhone` enforces it (line 851-856). The customers-view.tsx UI (`{c.primaryPhone ? <p>…</p> : <span>—</span>}`) renders a dash for these but does not flag them for repair.
- **Expected:** All customers have ≥1 phone. Customers with zero phones are surfaced as data-quality issues (e.g., a "needs repair" filter in the list view).
- **Actual:** 2 customers silently violate the invariant; nothing in the UI surfaces them as broken.
- **Repro Steps:** `SELECT id, name FROM "Customer" c LEFT JOIN customer_phones cp ON cp."customerId" = c.id GROUP BY c.id, c.name HAVING COUNT(cp.*) = 0` → returns 2 rows.

---

### CUS-002 — Phone normalization produces 3 distinct formats for the same number
- **Layer:** Data + Action
- **Severity:** Critical
- **Location:** `customer_phones.phoneNormalized` column; caused by mixing `normalize_phone()` SQL function (legacy) and `normalizePhoneInternational()` JS function (current)
- **Description:** The same `phoneRaw` value `03001234567` is stored with three different `phoneNormalized` values: `+92 300 1234567` (with spaces — legacy SQL `formatInternational()` output), `+923001234567` (correct E.164 — JS `normalizePhoneInternational()` output), and `03001234567` (raw, no normalization at all). The `phone-validation.ts:60-65` comment explicitly warns: "Do NOT use formatInternational() — it adds spaces (+92 300 1234567) which won't match the stored phoneNormalized values." Despite this, 17 rows in the DB have the spaces-format and at least 2 rows have the raw un-normalized form. The unique constraint on `(organizationId, phoneNormalized)` means duplicate customers CAN be created when normalization is inconsistent — a new customer with phone `03001234567` normalizes to `+923001234567` (JS path) which doesn't match the existing `+92 300 1234567` (SQL path) and passes the uniqueness check, creating a duplicate.
- **Expected:** All `phoneNormalized` values use canonical E.164 format (no spaces, leading `+`).
- **Actual:** 3 different formats coexist in the same column. Same `phoneRaw` maps to different `phoneNormalized` values across rows. Dedup invariant is silently broken.
- **Repro Steps:** `SELECT "phoneRaw", COUNT(DISTINCT "phoneNormalized"), array_agg(DISTINCT "phoneNormalized") FROM customer_phones GROUP BY "phoneRaw" HAVING COUNT(DISTINCT "phoneNormalized") > 1` → returns 5 phoneRaw values with multiple normalized forms.

---

### CUS-003 — Customers with zero addresses violate hard invariant
- **Layer:** Data
- **Severity:** Critical
- **Location:** DB (7 rows); root cause likely test seed scripts or `match_or_create_customer()` SQL function
- **Description:** 7 customers exist with zero `customer_addresses` rows. The action-layer `removeCustomerAddress` enforces ≥1 (line 1141-1149). The customers-view.tsx renders `c.defaultAddress?.city` (null-safe) so these rows show "—" for city with no warning.
- **Expected:** All customers have ≥1 address.
- **Actual:** 7 customers have zero addresses — invariant violated.
- **Repro Steps:** `SELECT id, name FROM "Customer" c LEFT JOIN customer_addresses ca ON ca."customerId" = c.id GROUP BY c.id, c.name HAVING COUNT(ca.*) = 0` → 7 rows.

---

### CUS-004 — `getCustomerDetail` has no permission check
- **Layer:** API/Action
- **Severity:** High
- **Location:** `src/lib/actions/customer.actions.ts:1769-1913` (`getCustomerDetail`)
- **Description:** `getCustomerDetail()` calls `getWorkspace()` (line 1773) but never calls `requirePermission(ctx, PERMISSIONS.CUSTOMERS_VIEW)`. Any authenticated user with an active workspace — even with a role that grants zero permissions — can fetch the full customer detail (phones, addresses, all order history, salesEmployeeId attribution) by passing any valid customer ID. Compare with `listCustomers()` (line 1670) which DOES require `CUSTOMERS_VIEW`. The org-scoping (`where: { id: customerId, organizationId: ctx.company.organizationId }`) limits the blast radius to within-org, but a low-privilege employee (e.g. a `scan_operator`) could enumerate customer IDs and exfiltrate the full customer directory + each customer's order history.
- **Expected:** `getCustomerDetail` calls `requirePermission(ctx, PERMISSIONS.CUSTOMERS_VIEW)` before fetching.
- **Actual:** No permission check — any in-org authenticated user can fetch any customer's full record.
- **Repro Steps:** With a session for an employee whose role has NO `customers.view` permission, `GET /api/customers/<any-customer-id-in-this-org>` → returns 200 with full customer detail.

---

### CUS-005 — `searchCustomerByPhone` and `searchCustomersDetailed` have no permission check
- **Layer:** API/Action
- **Severity:** High
- **Location:** `src/lib/actions/customer.actions.ts:234-319` (`searchCustomerByPhone`), `339-469` (`searchCustomersDetailed`)
- **Description:** Both search functions call `getWorkspace()` (lines 251 and 356) but neither calls `requirePermission()`. The `GET /api/customers?detailed=1&search=...` route (route.ts:46-55) calls `searchCustomersDetailed` directly with no permission gate. The `GET /api/customers` route (route.ts:32-74) goes to `listCustomers` (which DOES check `CUSTOMERS_VIEW`) for non-detailed mode, but bypasses the check for detailed mode.
- **Expected:** Both functions call `requirePermission(ctx, PERMISSIONS.CUSTOMERS_VIEW)` (or at minimum `ORDERS_CREATE` since the main consumer is the order-create page).
- **Actual:** No permission check. Same blast radius as CUS-004.
- **Repro Steps:** With a low-privilege session, `GET /api/customers?detailed=1&search=0300` → returns the first matching customer's full record.

---

### CUS-006 — Stale cached stats when orders are hard-deleted
- **Layer:** Action (cross-module)
- **Severity:** High
- **Location:** `src/lib/actions/order.actions.ts:896` (delete in rollback path) — `updateCustomerStats` IS called after but only for that one order; if multiple orders are deleted in bulk (e.g., via a script, admin tool, or test cleanup), the stats are never recomputed.
- **Description:** 5 customers have stale `totalOrdersCount` / `totalOrderValue` cached values. The most severe: `Test Booking Customer` has `cached_orders=14` but `actual_orders=0` (14 orders were hard-deleted at some point). `updateCustomerStats` is only triggered on order creation, status change, and the backfill endpoint — NOT on order hard-deletion outside the rollback path. There's no scheduled job or DB trigger to recompute.
- **Expected:** Cached stats match actual non-cancelled order counts. Either:
  (a) `updateCustomerStats` is called after every `db.order.delete`, OR
  (b) A nightly job recomputes stats for all customers, OR
  (c) The `POST /api/customers/backfill-stats` endpoint is invoked.
- **Actual:** 5 customers have stale stats. None have been recomputed. The backfill endpoint exists (route at `src/app/api/customers/backfill-stats/route.ts`) but has never been called (no audit log entry, no metric event).
- **Repro Steps:** `SELECT c.id, c.name, c."totalOrdersCount", COUNT(o.id) FILTER (WHERE o.status <> 'cancelled') as actual FROM "Customer" c LEFT JOIN "Order" o ON o."customerId" = c.id GROUP BY c.id, c.name, c."totalOrdersCount" HAVING c."totalOrdersCount" <> COUNT(o.id) FILTER (WHERE o.status <> 'cancelled')` → 5 rows.

---

### CUS-007 — Auto-flag at 3+ RTO never fires
- **Layer:** Action
- **Severity:** High
- **Location:** `src/lib/actions/customer.actions.ts:1497-1506` (auto-flag branch in `updateCustomerStats`); `src/lib/actions/order-return.actions.ts:222-229` (auto-flag call in `processOrderReturn`)
- **Description:** Customer `Fatima Ahmed` has `totalRtoCount=11` (verified against actual order data) but `isFlagged=false, flaggedReason=null`. The audit log shows 0 `customer.auto_flagged` entries — the auto-flag has never fired in production. There are two compounding root causes:

  **Root cause A — `processOrderReturn` calls the PUBLIC `flagCustomer` (which requires `CUSTOMERS_EDIT` permission).** If the user processing the RTO has `ORDERS_MANAGE` but NOT `CUSTOMERS_EDIT`, the `flagCustomer` call throws `ApiError(403, 'You lack the required permission: customers.edit')` — and since the call is `await`ed (line 228), the entire `processOrderReturn` returns `{success: false, error: '...'}` even though the order has ALREADY been marked `rto`, items have been returned to inventory, and audit/metric logs have been written. The user sees an error message but the RTO processing has silently succeeded.

  **Root cause B — `flagCustomerInternal` is NOT exported.** `order-return.actions.ts` cannot import it. The internal variant (`customer.actions.ts:1545`) skips the permission check — exactly what the auto-flag needs — but it's module-private. `updateCustomerStats` calls it correctly (line 1504) but `processOrderReturn` cannot.

  **Additional inconsistency:** the two auto-flag paths use DIFFERENT reason strings:
  - `updateCustomerStats` uses `'High RTO rate (3+ returns)'`
  - `processOrderReturn` uses `` `High RTO rate (${customer.totalRtoCount} returns)` `` (e.g. `'High RTO rate (11 returns)'`)

  Both start with `'High RTO'` so the LIKE-based `shouldFlagRto` query finds them, but the idempotency check (`customer.flaggedReason === reason`) doesn't match across the two paths — so they keep re-flagging each other if both fire.

- **Expected:** Any customer with `totalRtoCount >= 3` has `isFlagged=true` and `flaggedReason` starting with `'High RTO rate'`. The auto-flag fires reliably on every order status change, regardless of the caller's permissions.
- **Actual:** 0 customers are auto-flagged. Fatima Ahmed has 11 RTOs and is NOT flagged. The audit log shows 0 `customer.auto_flagged` events.
- **Repro Steps:**
  1. Pick a customer with no orders, no flag.
  2. Create + dispatch + return (RTO) 3 orders for them via the UI.
  3. After the 3rd RTO, check `customers.is_flagged` — should be `true`. Currently remains `false`.

---

### CUS-008 — `deliveryCountry` field returned as `undefined` in customer detail API
- **Layer:** API/Action
- **Severity:** Medium
- **Location:** `src/lib/actions/customer.actions.ts:1820-1904` (`getCustomerDetail` recentOrders query + response mapping)
- **Description:** The `select` clause for `recentOrders` (lines 1822-1834) does NOT include `deliveryCountry`. The response mapping (line 1884) returns `deliveryCountry: o.deliveryCountry` for full-detail rows. Since the field was never selected, `o.deliveryCountry` is `undefined` at runtime — but the TypeScript types declare it as `string | null` (`src/components/customers/types.ts:59`). The frontend (`customer-detail-view.tsx`) does not currently display `deliveryCountry`, so the bug is silent, but any future consumer relying on this field will get `undefined` instead of the actual country code.
- **Expected:** `deliveryCountry` is included in the `select` clause OR removed from the response mapping + DTO type.
- **Actual:** Field is in the response shape but always `undefined`. The DTO type lies.
- **Repro Steps:** `GET /api/customers/<id>` → inspect any `recentOrders[i].deliveryCountry` field — always `undefined` despite the type saying `string | null`.

---

### CUS-009 — Country stored as `'Pakistan'` (name) instead of `'PK'` (code) in some addresses
- **Layer:** Action
- **Severity:** High
- **Location:** `src/lib/actions/customer.actions.ts:999` (`addCustomerAddress` fallback) and `:1076` (`updateCustomerAddress` fallback)
- **Description:** When `d.country` is absent (no country field in the request body), both `addCustomerAddress` and `updateCustomerAddress` default `country` to `'Pakistan'` (the country NAME) — NOT `'PK'` (the alpha-2 CODE). Compare with `createCustomerInternal` (line 600) which correctly defaults to `'PK'`. The Prisma schema (`prisma/schema.prisma:1590-1596`) explicitly states: "country stores the ISO 3166-1 alpha-2 CODE (e.g. 'PK', 'GB', 'AE') — NOT the country name. This matches CountrySelector's output." The `customer-detail-view.tsx` add-address form (lines 944-958) and edit-address form (`AddressCardEdit` lines 1220-1309) do NOT include a Country field — they only have Address, City, and Label. So every address added/edited via the customer detail page is saved with `country='Pakistan'` (the name). 4 rows in the DB have this wrong value.

  **Downstream impact:**
  - `validateCustomerAddressCity()` (line 915) guards `if (country && country !== 'PK') return` — so for `country='Pakistan'`, the city-validation background job ALWAYS returns early without setting `cityValidatedAt`. This explains why 31 customers have `cityValidatedAt IS NULL`.
  - `CityMatchInfo` UI (customer-detail-view.tsx:1174) same guard — shows "International address — courier city matching N/A" for what are actually Pakistani addresses.
  - `AddressSelector` (line 81) `deliveryCountry: addr.country ?? 'PK'` — propagates `'Pakistan'` to the order create form, where `CountrySelector` fails to find a matching country code (shows "Select country" placeholder) and the city autocomplete (line 174: `deliveryCountry === 'PK'`) falls through to the plain Input (no city suggestions).
  - If an order is created from such an address without manually fixing the country, the order's `deliveryCountry` is set to `'Pakistan'` (per `order-create-view` defaulting logic), which then breaks the currency-aware revenue computation in `updateCustomerStats` (which expects alpha-2 codes for market resolution).

- **Expected:** Country always stored as alpha-2 code. The fallback should be `'PK'`, NOT `'Pakistan'`.
- **Actual:** 4 rows have `country='Pakistan'`. The two action fallbacks use the wrong string.
- **Repro Steps:** `SELECT id, address, city, country FROM customer_addresses WHERE country = 'Pakistan'` → 4 rows. Or: create an address via the customer-detail-view (which has no country field) → the saved row has `country='Pakistan'`.

---

### CUS-010 — Customer detail view add/edit address forms have no Country field
- **Layer:** Frontend
- **Severity:** Medium
- **Location:** `src/components/orders/customer-detail-view.tsx:944-958` (inline add form), `:1278-1287` (AddressCardEdit form)
- **Description:** Both the inline "Add Address" form and the "Edit Address" card in the customer-detail view have only Address, City, and Label fields — no Country field. The `CreateCustomerForm` (`src/components/customers/CreateCustomerForm.tsx:316-322`) DOES include a CountrySelector. The `AddressSelector` (used in order-create) also has a Country field. So the customer-detail-view forms are inconsistent with the rest of the app. Combined with CUS-009, every address created/edited via the detail view is silently saved with `country='Pakistan'` (the name string).
- **Expected:** Both forms include a `CountrySelector` defaulting to `'PK'`, matching `CreateCustomerForm` and `AddressSelector`.
- **Actual:** No Country field. Addresses are saved with the wrong default.
- **Repro Steps:** Open any customer detail page → "Add Address" → fill in address + city + label → save. Inspect the saved row in DB → `country='Pakistan'`.

---

### CUS-011 — Address display shows raw alpha-2 code instead of country name
- **Layer:** Frontend
- **Severity:** Low
- **Location:** `src/components/orders/customer-detail-view.tsx:1067-1072`
- **Description:** The address card displays `{address.city}{address.country ? `, ${address.country}` : ''}` — directly rendering the stored `country` value (an alpha-2 code like `'PK'` or the country name `'Pakistan'`, depending on which path created it). So a Pakistani address shows as `"Lahore, PK"` (when created via `CreateCustomerForm`) or `"Lahore, Pakistan"` (when created via the detail view's add form). Neither matches the user-friendly country name display the rest of the app uses (CountrySelector shows flag + name).
- **Expected:** Render the country name (e.g. "Pakistan"), not the alpha-2 code (e.g. "PK"), OR render flag + name like the CountrySelector does.
- **Actual:** Inconsistent — shows code or name depending on which path created the address.
- **Repro Steps:** View any customer detail page → Addresses tab → look at any address with country set.

---

### CUS-012 — `flagCustomer` reason string inconsistency between auto-flag paths
- **Layer:** Action
- **Severity:** Low
- **Location:** `src/lib/actions/customer.actions.ts:1497` (`'High RTO rate (3+ returns)'`) vs `src/lib/actions/order-return.actions.ts:228` (`` `High RTO rate (${customer.totalRtoCount} returns)` ``)
- **Description:** Two auto-flag paths use different reason strings. The `flagCustomerInternal` idempotency check (`customer.flaggedReason === reason`) only matches the EXACT same string. If the first path flags with `'High RTO rate (3+ returns)'` and the second path is called later (with the current count being 5), it would attempt to re-flag with `'High RTO rate (5 returns)'`. The condition `!customer.isFlagged || customer.flaggedReason !== RTO_FLAG_REASON` evaluates to `false || (true) = true` → re-flags the already-flagged customer, overwriting `flaggedAt` and `flaggedBy`. This produces duplicate audit log entries (`customer.auto_flagged`) for the same logical event.
- **Expected:** Both paths use the SAME constant reason string (e.g. `'High RTO rate (3+ returns)'`) — the count is already in the `totalRtoCount` column, no need to embed it in the reason.
- **Actual:** Two different reason strings. Idempotency check fails to deduplicate.
- **Repro Steps:** Hard to reproduce without triggering both paths on the same customer. Look at audit_logs for a customer who was RTO'd multiple times — would see duplicate `customer.auto_flagged` entries with different `flaggedReason` values.

---

### CUS-013 — Customer detail view "Set as Primary phone" deletes the phone then re-creates it
- **Layer:** Frontend
- **Severity:** Low
- **Location:** `src/components/orders/customer-detail-view.tsx:169-183` (`setPrimaryPhoneMutation`)
- **Description:** The mutation does `await api.delete(/api/customers/${customerId}/phones/${phone.id})` then `api.post(/api/customers/${customerId}/phones, { phone: phone.phoneRaw, label, is_primary: true })`. This is a two-step delete-and-recreate. If the DELETE succeeds but the POST fails (network error, validation error on re-normalization, etc.), the customer is left with one fewer phone than before — potentially violating the "≥1 phone" invariant if it was the last non-primary phone. The new phone row also gets a NEW ID, breaking any foreign-key references from orders that had `usedCustomerPhoneId` pointing at the old row (the FK is `onDelete: SetNull`, so those orders' `usedCustomerPhoneId` would become null).

  The CORRECT approach would be a PATCH endpoint that toggles `isPrimary` on the existing phone (with the action-layer unsetting other primaries in the same transaction) — like the address "Set as Default" path which uses `PATCH .../addresses/[addressId]` with `{ is_default: true }` (customer-detail-view.tsx:229-240).

- **Expected:** "Set as Primary" is a single PATCH request that updates `isPrimary` on the existing phone row (preserving the ID).
- **Actual:** Two-step DELETE + POST. Loses the phone ID. Loses the FK references on orders. Risk of invariant violation on partial failure.
- **Repro Steps:** Click "Set as Primary" on a non-primary phone in the customer detail page. Inspect the phone rows before and after — the new primary has a different ID than before.

---

### CUS-014 — Customer summary DTO type omits `country` field
- **Layer:** Type
- **Severity:** Low
- **Location:** `src/components/customers/types.ts:76` (`CustomerSummary.defaultAddress`) vs `src/lib/actions/customer.actions.ts:87` (`CustomerSummaryDTO.defaultAddress`)
- **Description:** The DTO returned by `listCustomers` (action line 1741-1743) includes `country: c.addresses[0].country`. The frontend `CustomerSummary` type only declares `{ address: string; city: string }` — no `country`. The list view (`customers-view.tsx`) doesn't display the country so this is silent, but the type is incomplete and any future consumer will miss the country field.
- **Expected:** `CustomerSummary.defaultAddress: { address: string; city: string; country: string | null } | null` to match the actual API response.
- **Actual:** `country` is sent by the API but not declared in the type.
- **Repro Steps:** `GET /api/customers` → response includes `customers[i].defaultAddress.country` — but TypeScript types say it doesn't exist.

---

### CUS-015 — Type comment lies about country format
- **Layer:** Type/Docs
- **Severity:** Low
- **Location:** `src/components/customers/types.ts:23-26` (AddressDTO.country comment) and `:135-137` (AddressInput.country comment)
- **Description:** The AddressDTO comment says "Country NAME (e.g. 'Pakistan'), NOT an alpha-2 code." The AddressInput comment says "Country NAME (e.g. 'Pakistan'). Optional — server defaults to 'Pakistan' when absent. NOT an alpha-2 code." Both directly contradict the Prisma schema (`prisma/schema.prisma:1590-1596`) which explicitly states country is stored as the alpha-2 code. The `CreateCustomerForm` uses `CountrySelector` (which returns alpha-2 codes). The `customer-detail-view.tsx:1174` `CityMatchInfo` checks `country !== 'PK'` (alpha-2 code comparison). The actual code is consistent with alpha-2 codes; only the type comments are wrong.
- **Expected:** Type comments match the schema (alpha-2 codes).
- **Actual:** Type comments say "Country NAME" — misleading for future developers.
- **Repro Steps:** Read `src/components/customers/types.ts:23-26`.

---

### CUS-016 — `validateCustomerAddressCity` silently fails (fire-and-forget with `.catch(() => {})`)
- **Layer:** Action
- **Severity:** Medium
- **Location:** `src/lib/actions/customer.actions.ts:1021` (after `addCustomerAddress`) and `:1109` (after `updateCustomerAddress`)
- **Description:** The city-validation background job is called via `validateCustomerAddressCity(...).catch(() => {})` — fire-and-forget with error swallowing. 31 customers have addresses with `cityValidatedAt IS NULL`, indicating the job has either not run or has failed silently for them. The function (lines 900-955) makes 1-N DB queries (one to fetch integrations, one per integration to check `courierOperationalCity`). If any of those queries fail (e.g., transient DB connection issue, prisma timeout), the function throws, the `.catch(() => {})` swallows it, and the address's `cityValidatedAt` remains null forever. There's no retry, no error log, no metric event.
- **Expected:** City validation either succeeds (sets `cityValidatedAt`) or logs a warning + queues a retry. Failed validations should be observable.
- **Actual:** 31 addresses with `cityValidatedAt IS NULL` — no way to tell if validation is pending, failed, or never attempted.
- **Repro Steps:** Create a customer address via the API → check `cityValidatedAt` immediately and 5 seconds later — for most addresses, it's still NULL.

---

### CUS-017 — Customer detail "Recent Orders" tab loads ALL orders (no pagination)
- **Layer:** Action/Frontend
- **Severity:** Low
- **Location:** `src/lib/actions/customer.actions.ts:1820-1836` (`recentOrders` query — no `take`/`skip`)
- **Description:** The customer-detail API returns ALL orders for the customer (verified by the comment at line 1810-1813: "Fetch ALL orders for this customer (not just 20) so the Orders tab matches the stat card's totalOrdersCount."). For Fatima Ahmed (81 orders), this is fine. But for a customer with 1,000+ orders (high-volume repeat buyer), this would return a 1,000-row JSON payload on every detail page load, slowing page render and consuming bandwidth. The frontend renders them all in a scrollable table (`max-h-96 overflow-y-auto`), so it works but is not scalable.
- **Expected:** Paginated fetch (e.g., 50 at a time) with infinite scroll or "Load more" button.
- **Actual:** Unbounded fetch. Works for current data volumes (max 81 orders) but won't scale.
- **Repro Steps:** Create a customer with 100+ orders → load their detail page → observe payload size and render time.

---

### CUS-018 — `processOrderReturn` re-flag failure surfaces as a 500 to the user despite successful RTO processing
- **Layer:** Action (cross-module)
- **Severity:** Medium
- **Location:** `src/lib/actions/order-return.actions.ts:222-229`
- **Description:** When `processOrderReturn` runs the auto-flag call (`await flagCustomer(order.customerId, ...)`) and the user lacks `CUSTOMERS_EDIT` permission, `flagCustomer` throws `ApiError(403)`. Since the call is `await`ed (not fire-and-forget), the error propagates up through the surrounding try/catch and the function returns `{ success: false, error: 'You lack the required permission: customers.edit' }`. By the time this happens, the order has ALREADY been:
  - Updated to status='rto'
  - All items processed (inventory transactions created, `OrderItem.fulfillmentStatus='returned'`)
  - Audit log `order.returned` written
  - Metric event `order.rto` written
  - `updateCustomerStats(order.customerId)` completed

  The user sees an error message saying they lack permission — but the RTO has actually been fully processed. They may retry the action, which would fail again at the same step (the order is no longer in 'dispatched' status, so the second call would fail with "Can only return a dispatched order").

  Fix: wrap the auto-flag in `.catch(() => {})` (fire-and-forget) OR call `flagCustomerInternal` directly (which requires exporting it from customer.actions.ts).

- **Expected:** Auto-flag failures don't break RTO processing. Either fire-and-forget or use the internal variant.
- **Actual:** RTO succeeds but the API returns an error — confusing UX.
- **Repro Steps:** As a user with `ORDERS_MANAGE` but NOT `CUSTOMERS_EDIT`, dispatch + RTO an order for a customer with 3+ RTOs. The order is marked RTO but the API returns 403 "You lack the required permission: customers.edit".

---

### CUS-019 — Search autocomplete only shows ONE customer result
- **Layer:** Frontend
- **Severity:** Low
- **Location:** `src/components/customers/CustomerSearchAutocomplete.tsx:73-81` (useQuery) + `src/lib/actions/customer.actions.ts:419` (`db.customer.findFirst`)
- **Description:** The order-create customer search uses `searchCustomersDetailed` which calls `db.customer.findFirst` — only the FIRST matching customer is returned. The autocomplete dropdown shows that one match + a "Create new customer" option. If multiple customers match a partial phone (e.g., typing "0300" matches 5 customers with phones starting with 0300), the user sees only ONE result and may miss the others — potentially creating a duplicate customer (which the action layer would refuse with a uniqueness error, but the user wouldn't know which existing customer to pick).

  The DB query at line 419-440 uses OR across name/email/phone with `contains` (case-insensitive) — so a 3-character search like "ay" matches every customer named "Ayesha", every customer with a phone containing "ay" (unlikely but possible), etc. Only the first one is returned.

- **Expected:** Show top N (5-10) matches in the dropdown, with the most-relevant first.
- **Actual:** Only one match shown. If that's the wrong one, the user has no way to pick a different match.
- **Repro Steps:** In the order-create page, type a partial phone number that matches multiple customers → only one shows in the dropdown.

---

### CUS-020 — `POST /api/customers` (create) does not validate request body via Zod at the route layer
- **Layer:** API
- **Severity:** Low
- **Location:** `src/app/api/customers/route.ts:96-172` (POST handler)
- **Description:** The route delegates directly to `createCustomer(input)` (line 162) with `body as unknown as CreateCustomerInput` — no Zod parse at the route layer. The action's `createCustomerInternal` (line 520) does call `createCustomerSchema.safeParse(input)`, so validation DOES happen. This is not a security bug, just a defense-in-depth gap — the route layer trusts the action to validate. The PATCH route (`src/app/api/customers/[id]/route.ts:32-51`) has the same pattern. The phone/address sub-routes (`[id]/phones/route.ts`, `[id]/addresses/route.ts`, `[id]/addresses/[addressId]/route.ts`) construct the input object manually with `typeof body.X === 'string' ? body.X : ''` etc. — they don't pass the raw body through, but they also don't validate it. The action's `phoneInputSchema.safeParse` / `addressInputSchema.safeParse` is the only validation gate.
- **Expected:** For defense-in-depth, the route layer should also validate via Zod (or at minimum check that required fields are present and well-typed before delegating).
- **Actual:** Only the action layer validates. Works, but a single point of failure.
- **Repro Steps:** `POST /api/customers` with `{"name": "X", "phones": "not-an-array", "addresses": []}` → the action returns `{success: false, error: 'Expected array, received string'}` — no Zod validation at the route layer.

---

### CUS-021 — `customer_phones.isValidFormat` flag is set to `false` but never surfaced in the UI
- **Layer:** Frontend/Action
- **Severity:** Low
- **Location:** `src/lib/actions/customer.actions.ts:1330-1345` (sets `isValidFormat: false` for invalid external-platform phones); `src/components/orders/customer-detail-view.tsx:762-787` (Phone list rendering — does NOT display `isValidFormat`)
- **Description:** 1 phone row in the DB has `isValidFormat=false` (e.g., `cmsykxb7z0003smmhgmf2ouyy` with `phoneRaw='12345', phoneNormalized='invalid-12345'`). The PhoneDTO includes `isValidFormat?: boolean` (`src/components/customers/types.ts:14`), but the customer-detail-view's phone list renders only the phone number, primary badge, label, and creation date — no warning icon or "invalid format" indicator. So users can't tell which phones failed format validation (and may need correction).
- **Expected:** Invalid-format phones show a warning icon/tooltip in the phone list, prompting the user to correct them.
- **Actual:** Silent. The `isValidFormat=false` flag exists in the DB but is never displayed.
- **Repro Steps:** Look at customer `cmsykxb7z0001smmhcweuj58b` in the customer detail view — their phone `12345` is invalid but no warning is shown.

---

## Cross-Module Verification

### Order creation → customer linkage
✅ `createManualOrder` (order.actions.ts:416-488) correctly resolves the customer via `customer_id` OR creates a new one via `createCustomerInternal`. Org-scoped verification on the existing-customer path (line 419). Both `usedCustomerAddressId` and `usedCustomerPhoneId` are verified to belong to the same customer in the same org (lines 432, 437, 449, 458).

### RTO → stats update
✅ `processOrderReturn` (order-return.actions.ts:214) calls `updateCustomerStats(order.customerId)` after marking the order as RTO. Stats recompute correctly when this succeeds. **BUT** the auto-flag call afterwards (line 228) can throw and break the response — see CUS-018.

### Auto-poll / webhook → stats update
✅ `handleOrderStatusSideEffects` (order.actions.ts:2947-2993) is called by the PostEx/Leopard pollers and webhook receivers. It calls `updateCustomerStats(order.customerId)` with `.catch()` — non-fatal. Auto-flag fires inside `updateCustomerStats` via `flagCustomerInternal` (no permission check, so it works for system contexts).

### Order cancel → stats update
✅ `cancelOrder` (order.actions.ts:1904) and `unCancelOrder` (line 2005) both call `updateCustomerStats(order.customerId).catch(() => {})` — non-fatal.

### Order dispatch → stats update
✅ `performOrderDispatch` (order.actions.ts:2632) calls `updateCustomerStats(order.customerId).catch()`.

### Order mark delivered → stats update
✅ `markOrderDelivered` (order.actions.ts:2903) calls `updateCustomerStats(order.customerId).catch()`.

### Manual confirm → stats update
✅ `confirmOrder` (order.actions.ts:1410) calls `updateCustomerStats(order.customerId).catch()`.

### Stock reservation rollback → customer stats
✅ `createManualOrder` rollback path (order.actions.ts:896-897) deletes the order AND calls `updateCustomerStats(customerId).catch()` — so the cached count is recomputed. **HOWEVER** — for bulk hard-deletes outside this path (admin scripts, test cleanup, etc.), no stats recompute happens. See CUS-006.

### Customer stats accuracy — 3 sample customers verified
✅ Sample 1 (Fatima Ahmed, 81 orders): cached=actual for all 3 stats. **BUT** she's not flagged despite 11 RTOs (CUS-007).
❌ Sample 2 (Test Booking Customer, 14 cached / 0 actual): stale by 14 (CUS-006).
✅ Sample 3 (Test Customer, 8 orders): cached=actual for all 3 stats.

---

## Frontend Audit

### Search works (customers-view.tsx)
✅ Debounced 300ms (line 92), querySearch state used as the API search param. URLSearchParams correctly builds the query string. Empty search returns full list (no `search` param).
✅ Flagged-only filter toggle works (line 220-227).
⚠️ **Search UX limitation** — the customers-view search uses `listCustomers` which does OR-matching across name/email/phone with `contains` (case-insensitive). It returns up to 50 results (default limit). But for the order-create page's autocomplete (CustomerSearchAutocomplete.tsx), only the FIRST match is returned — see CUS-019.

### Detail view complete (customer-detail-view.tsx)
✅ All 4 tabs present: Phones, Addresses, Platforms, Orders.
✅ Stats row shows all 5 metrics: Total Orders, Total Value, RTO Count, RTO Rate, Delivery Rate.
✅ RTO Rate + Delivery Rate are live-computed server-side (correct denominator: dispatched+delivered+rto orders).
✅ Flagged badge + reason tooltip works.
✅ Limited-view orders (non-own orders when viewer scope='own') correctly greyed out and stripped of detail.
❌ Address forms have no Country field — CUS-010.
❌ Address display shows raw alpha-2 code — CUS-011.
❌ "Set as Primary phone" uses delete+re-create instead of PATCH — CUS-013.
❌ `deliveryCountry` field on recentOrders is `undefined` despite the type saying it's `string | null` — CUS-008.

### Buttons permission-gated
✅ Flag/Unflag buttons gated on `canManage = can(PERMISSIONS.ORDERS_MANAGE)` (customers-view.tsx:79, customer-detail-view.tsx:98).
⚠️ **Inconsistency:** the customer module defines `CUSTOMERS_EDIT` permission (PERMISSIONS.CUSTOMERS_EDIT) for customer mutations, but the frontend gates the Flag/Unflag buttons on `ORDERS_MANAGE` — a DIFFERENT permission. So a user with `ORDERS_MANAGE` but NOT `CUSTOMERS_EDIT` would see the Flag button in the UI, but the `flagCustomer` action would throw 403 because it requires `CUSTOMERS_EDIT`. The user would see the button, click it, and get an error. This is a minor UX inconsistency — not a security issue (the action layer correctly enforces `CUSTOMERS_EDIT`).
⚠️ **Same inconsistency for "Add Phone", "Add Address", "Edit Address", "Remove Phone/Address", "Set as Primary/Default" buttons** — all gated on `canManage = can(ORDERS_MANAGE)` (customer-detail-view.tsx:533, 547, 1011, etc.) but the underlying actions require `CUSTOMERS_EDIT`. So users with `ORDERS_MANAGE` only will see the buttons but get 403s when they click them.

✅ Inline name edit gated on `canManage` (line 357).
✅ "Add Customer" button visible to all (the `createCustomer` action requires `CUSTOMERS_CREATE` — if a user without that permission clicks it, they'd get a 403 from the API). The button itself is NOT gated — should probably be hidden for users without `CUSTOMERS_CREATE`.

### Responsive
✅ `customers-view.tsx`:
  - Stats grid: `grid gap-4 sm:grid-cols-3` (1 col mobile, 3 col desktop).
  - Search + filter: `flex flex-col sm:flex-row`.
  - Table: `overflow-x-auto` wrapper.
  - Dialog: `sm:max-w-2xl max-h-[90vh] overflow-y-auto`.

✅ `customer-detail-view.tsx`:
  - Profile header: `flex flex-col sm:flex-row sm:items-start sm:justify-between`.
  - Stats row: `grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5`.
  - TabsList: `w-full sm:w-auto overflow-x-auto`.
  - Phone rows: `flex flex-col sm:flex-row sm:items-center`.
  - Address cards: `grid sm:grid-cols-2`.
  - Inline add forms: `grid sm:grid-cols-2`.

✅ `CreateCustomerForm.tsx`:
  - Name/email: `grid sm:grid-cols-2`.
  - Phone entries: `flex flex-col sm:flex-row sm:items-end`.
  - Address grid: `grid sm:grid-cols-2`.

✅ `CustomerSearchAutocomplete.tsx`:
  - Dropdown: `w-full max-h-72 overflow-y-auto`.

Mobile responsiveness is solid across the module.

---

## Summary Table

| ID | Layer | Severity | Location | Description |
|---|---|---|---|---|
| CUS-001 | Data | Critical | DB | 2 customers have zero phones (hard invariant violated) |
| CUS-002 | Data+Action | Critical | customer_phones.phoneNormalized | 3 distinct formats for same number — dedup broken |
| CUS-003 | Data | Critical | DB | 7 customers have zero addresses (hard invariant violated) |
| CUS-004 | Action | High | customer.actions.ts:1769 | `getCustomerDetail` missing permission check |
| CUS-005 | Action | High | customer.actions.ts:234,339 | `searchCustomerByPhone`/`searchCustomersDetailed` missing permission check |
| CUS-006 | Action | High | DB (stale stats) | 5 customers have stale cached `totalOrdersCount` |
| CUS-007 | Action | High | customer.actions.ts:1497; order-return.actions.ts:228 | Auto-flag at 3+ RTO never fires — Fatima Ahmed (11 RTOs) not flagged |
| CUS-008 | Action | Medium | customer.actions.ts:1820-1904 | `deliveryCountry` field returned as `undefined` (not in `select`) |
| CUS-009 | Action | High | customer.actions.ts:999, 1076 | Country default `'Pakistan'` (name) instead of `'PK'` (code) — 4 rows affected |
| CUS-010 | Frontend | Medium | customer-detail-view.tsx:944, 1278 | Add/edit address forms have no Country field |
| CUS-011 | Frontend | Low | customer-detail-view.tsx:1067 | Address display shows raw alpha-2 code instead of country name |
| CUS-012 | Action | Low | customer.actions.ts:1497 vs order-return.actions.ts:228 | Auto-flag reason string inconsistency between paths |
| CUS-013 | Frontend | Low | customer-detail-view.tsx:169 | "Set as Primary" deletes+recreates phone (loses ID + FK refs) |
| CUS-014 | Type | Low | customers/types.ts:76 | `CustomerSummary.defaultAddress` type omits `country` |
| CUS-015 | Type/Docs | Low | customers/types.ts:23,135 | Type comments lie about country format (says NAME, code is CODE) |
| CUS-016 | Action | Medium | customer.actions.ts:1021, 1109 | `validateCustomerAddressCity` fire-and-forget swallows errors — 31 addresses pending validation |
| CUS-017 | Action/Frontend | Low | customer.actions.ts:1820 | Customer detail loads ALL orders (no pagination) |
| CUS-018 | Action | Medium | order-return.actions.ts:222-229 | Auto-flag failure surfaces as error despite successful RTO processing |
| CUS-019 | Frontend | Low | CustomerSearchAutocomplete.tsx | Search shows only ONE match (uses `findFirst`) |
| CUS-020 | API | Low | api/customers/route.ts:96 | No Zod validation at route layer (relies on action) |
| CUS-021 | Frontend | Low | customer-detail-view.tsx:762 | `isValidFormat=false` phones not surfaced in UI |

**Totals:** 21 issues — 3 Critical, 6 High, 5 Medium, 7 Low.

---

## Recommended Priorities

### P0 — Fix immediately (data corruption / security)
1. **CUS-002** — Backfill-correct all `phoneNormalized` values to canonical E.164 (single migration script using `normalizePhoneInternational()`). Audit the `normalize_phone()` SQL function and the JS function for any remaining drift.
2. **CUS-001 + CUS-003** — Repair the 2 customers with zero phones and 7 with zero addresses (either by adding placeholder phone/address rows or by deleting the broken customers if they're test data).
3. **CUS-004 + CUS-005** — Add `requirePermission(ctx, PERMISSIONS.CUSTOMERS_VIEW)` to `getCustomerDetail`, `searchCustomerByPhone`, `searchCustomersDetailed`. (Consider whether `ORDERS_CREATE` should also grant these — since order creation needs to search customers.)

### P1 — Fix soon (silent functional bugs)
4. **CUS-007 + CUS-018** — Export `flagCustomerInternal` from `customer.actions.ts` and call it from `processOrderReturn` (instead of the public `flagCustomer`). Wrap in `.catch(() => {})` so failures don't break RTO processing. Run the backfill endpoint to retroactively flag Fatima Ahmed and any other qualifying customers.
5. **CUS-009 + CUS-010** — Change the action fallback to `'PK'` (not `'Pakistan'`). Add a `CountrySelector` to the customer-detail-view add/edit address forms. Backfill-correct the 4 rows currently storing `'Pakistan'`.
6. **CUS-006** — Run `POST /api/customers/backfill-stats` to recompute cached stats for all 5 affected customers. Consider adding a nightly cron job for ongoing stats integrity.
7. **CUS-016** — Make `validateCustomerAddressCity` log errors (not silently swallow). Run a one-time backfill to set `cityValidatedAt` for the 31 affected customers.

### P2 — Fix when convenient (UX / type / consistency)
8. **CUS-008** — Either add `deliveryCountry` to the `select` clause OR remove it from the response mapping + DTO type.
9. **CUS-011** — Use `getCountryByCode()` to display the country name + flag in the address card.
10. **CUS-013** — Add a `PATCH /api/customers/[id]/phones/[phoneId]` endpoint for setting primary (mirror the address pattern). Update the frontend to use it.
11. **CUS-012** — Standardize the reason string to `'High RTO rate (3+ returns)'` in both paths.
12. **CUS-014, CUS-015** — Fix the type definitions and comments.
13. **CUS-017** — Add server-side pagination for `recentOrders`.
14. **CUS-019** — Change `searchCustomersDetailed` to `findMany` with `take: 5` and update the autocomplete UI to render all matches.
15. **CUS-020** — Add Zod validation at the route layer for defense-in-depth.
16. **CUS-021** — Surface `isValidFormat=false` phones in the UI with a warning icon.

### Button-permission consistency
17. The frontend gates customer mutation buttons on `ORDERS_MANAGE` but the actions require `CUSTOMERS_EDIT`. Either:
    - Change the frontend gate to `can(PERMISSIONS.CUSTOMERS_EDIT)`, OR
    - Change the actions to require `ORDERS_MANAGE` (less granular), OR
    - Make `ORDERS_MANAGE` imply `CUSTOMERS_EDIT` in the role system.

---

## Files Reviewed

- `prisma/schema.prisma` (Customer, CustomerPhone, CustomerAddress, CustomerExternalIdentity models)
- `src/lib/validations/customer.schemas.ts`
- `src/lib/phone-validation.ts`
- `src/lib/permissions.ts`
- `src/lib/workspace.ts`
- `src/lib/actions/customer.actions.ts` (1913 lines)
- `src/lib/actions/order.actions.ts` (2994 lines — relevant sections: 380-940 createManualOrder, 1390-1410 confirmOrder, 1880-1910 cancelOrder, 2000-2010 unCancelOrder, 2600-2640 performOrderDispatch, 2857-2920 markOrderDelivered, 2940-2990 handleOrderStatusSideEffects)
- `src/lib/actions/order-return.actions.ts` (518 lines — relevant sections: 52-238 processOrderReturn, 222-229 auto-flag)
- `src/app/api/customers/route.ts`
- `src/app/api/customers/[id]/route.ts`
- `src/app/api/customers/[id]/phones/route.ts`
- `src/app/api/customers/[id]/phones/[phoneId]/route.ts`
- `src/app/api/customers/[id]/addresses/route.ts`
- `src/app/api/customers/[id]/addresses/[addressId]/route.ts`
- `src/app/api/customers/backfill-stats/route.ts`
- `src/components/orders/customers-view.tsx` (546 lines)
- `src/components/orders/customer-detail-view.tsx` (1587 lines)
- `src/components/customers/CreateCustomerForm.tsx` (366 lines)
- `src/components/customers/CustomerSearchAutocomplete.tsx` (253 lines)
- `src/components/customers/AddressSelector.tsx` (238 lines)
- `src/components/customers/types.ts`
- `src/components/ui/country-selector.tsx`

## DB Queries Executed (read-only)

1. Customer / phone / address / external-identity counts
2. Per-org customer breakdown
3. Duplicate phones (cross-customer)
4. Customers with no primary phone / no default address / no phone / no address
5. Customers with multiple primary phones
6. Orphaned orders + NULL customerId orders
7. Country field distribution (PK vs Pakistan vs other)
8. Stale cached stats (totalOrdersCount, totalRtoCount mismatches)
9. High-RTO-flagged customer count + should-be-flagged + wrongly-flagged
10. Sample customer stats verification (3 customers with full order status breakdown)
11. Mismatched address/phone refs (orders pointing to different customer's address/phone)
12. Orphaned address/phone refs (orders pointing to deleted rows)
13. Customer-Order org mismatches
14. Audit log event distribution for customer.* actions
15. Flagged customers without audit log entries
16. Invalid-format phones count
17. Pending city validation count
18. Inconsistent phone normalization (same phoneRaw, different phoneNormalized)

No writes were made to the database. No code was modified.
