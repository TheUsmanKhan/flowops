# Orders Core Lifecycle — Complete Solutions with Explanations

> Every issue from the Orders audit, explained in plain language with the recommended fix at each level (Backend, API, DB, Frontend) and prevention measures.

---

## ORD-001 — Employee Stats Never Updated on Dispatch (Critical)

### What's Broken
When an order is dispatched, the system is supposed to update the sales rep's performance stats (dispatch count, revenue, etc.). But the code that fetches the order for dispatch forgot to include `salesEmployeeId` in the database query. So when it tries to call `updateEmployeeStats(order.salesEmployeeId)`, the value is `undefined` — and the entire stats update is skipped silently.

### Real-World Impact
- Sales rep dispatches 50 orders in a month
- Their performance dashboard shows 0 dispatches
- Commission calculations are wrong
- KPI dashboards show wrong revenue per sales rep
- Managers can't see which reps are performing well

### What Happens to Data
- Order itself is correctly dispatched (tracking number set, stock deducted)
- EmployeeStats table is NOT updated (dispatch count stays stale)
- No error is thrown — the `if (order.salesEmployeeId)` guard evaluates to `false` and silently skips

### Solution

**Backend (API):**
File: `src/lib/actions/order.actions.ts` — `performOrderDispatch()` function

Add `salesEmployeeId` to the `select` clause:

```typescript
// BEFORE (line ~2456):
const order = await db.order.findUnique({
  where: { id: orderId },
  select: {
    id: true, status: true, trackingNumber: true,
    courierCompanyIntegrationId: true, dispatchLocationId: true,
    organizationId: true, companyId: true, customerId: true,
    totalOrderValue: true, packedAt: true,
    // salesEmployeeId is MISSING
  },
})

// AFTER:
const order = await db.order.findUnique({
  where: { id: orderId },
  select: {
    id: true, status: true, trackingNumber: true,
    courierCompanyIntegrationId: true, dispatchLocationId: true,
    organizationId: true, companyId: true, customerId: true,
    totalOrderValue: true, packedAt: true,
    salesEmployeeId: true,  // ← ADDED
  },
})
```

**Prevention:**
- Add a TypeScript `satisfies` check or use `Pick<Order, typeof selectKeys>` to ensure all referenced fields are in the select clause
- Or: use `db.order.findUnique` without `select` (fetches all fields) when the function uses many fields

---

## ORD-003 — Auto-Poll "Delivered" Skips Customer Stats + Audit Logs (Critical)

### What's Broken
When PostEx or Leopard polling detects that an order has been "Delivered", the system directly updates the order status to 'delivered' in the database — but it BYPASSES the `markOrderDelivered()` function. This was intentional (the poller doesn't have a user session), but the side effects that `markOrderDelivered()` performs were never replicated:

- Customer stats NOT updated (totalDeliveredCount, lastDeliveredAt)
- Employee stats NOT updated (delivery count, revenue)
- Audit log NOT created (12 of 14 delivered orders have NO `order.delivered` audit entry)
- Metric events NOT fired

### Real-World Impact
- Customer's profile shows wrong delivery count (affects fraud detection)
- Sales rep's delivery KPI is wrong
- Audit trail has gaps — if someone asks "when was this order delivered?", there's no audit log entry
- Dashboard metrics (total delivered, delivery rate) are wrong

### What Happens to Data
- Order status is correctly set to 'delivered' + deliveredAt timestamp
- But ALL downstream effects are missing — customer/employee stats, audit logs, metrics
- The data is partially correct (order status right, everything else wrong)

### Solution

**Backend:**
The root cause is that `markOrderDelivered()` uses `getWorkspace()` which requires an HTTP session — but the poller runs in a background job with no session. 

**Recommended approach:** Refactor `markOrderDelivered()` to accept an optional `injectedContext` parameter (same pattern already used by `cancelOrder()` for Shopify webhooks):

```typescript
// BEFORE:
export async function markOrderDelivered(orderId: string): Promise<ActionResult> {
  const ctx = await getWorkspace()  // ← fails in poller context
  await requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)
  // ... update customer stats, employee stats, audit log, metrics
}

// AFTER:
export async function markOrderDelivered(
  orderId: string,
  injectedContext?: WorkspaceContext  // ← poller passes a synthetic context
): Promise<ActionResult> {
  const ctx = injectedContext ?? (await getWorkspace())
  if (!injectedContext) {
    await requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)
  }
  // ... same logic, but now works from poller too
}
```

Then in the poller:
```typescript
// postex-status-poll.actions.ts line ~552:
// BEFORE:
await db.order.update({ where: { id }, data: { status: 'delivered', deliveredAt: new Date() } })

// AFTER:
const { markOrderDelivered } = await import('./order.actions')
await markOrderDelivered(id, syntheticContext)
```

The poller would need to create a synthetic `WorkspaceContext` from the order's `companyId` + `organizationId` (which it already has). Same pattern for the Leopard webhook handler.

**Alternative (simpler but less clean):** Extract the side-effects (customer stats, employee stats, audit log, metrics) into a shared `handleOrderDeliveredSideEffects(orderId, ctx)` function that both `markOrderDelivered()` and the poller call.

**Prevention:**
- Any function that transitions order status should have a "system" invocation path that doesn't require a session
- Never use direct `db.order.update` for status transitions — always go through the action function

---

## ORD-004 — RTO Items Stuck at 'dispatched' Status (Critical)

### What's Broken
When an order is marked as RTO (Return to Origin), the system is supposed to update each OrderItem's `fulfillmentStatus` from 'dispatched' to 'returned'. But the manual RTO function (`processOrderReturn()`) only sets `autoProcessedAsPerfect: true` and `needsReview: true` — it forgets to set `fulfillmentStatus: 'returned'`.

### Real-World Impact
- Order shows status "rto" but items show "dispatched" — confusing
- Warehouse team sees items as "dispatched" even though the parcel was returned
- Inventory reports show wrong counts (items counted as dispatched when they're actually returned)
- If someone queries "how many items are currently dispatched?", the count is inflated

### What Happens to Data
- Order status: correctly 'rto'
- OrderItem.fulfillmentStatus: INCORRECTLY stays 'dispatched' (should be 'returned')
- InventoryPool: correctly restocked (return_resellable transaction created)
- The inventory is correct but the OrderItem metadata is wrong

### Solution

**Backend:**
File: `src/lib/actions/order-return.actions.ts` — `processOrderReturn()`

Add `fulfillmentStatus: 'returned'` to the OrderItem update:

```typescript
// BEFORE (line ~131):
await db.orderItem.update({
  where: { id: item.id },
  data: {
    autoProcessedAsPerfect: true,
    needsReview: true,
  },
})

// AFTER:
await db.orderItem.update({
  where: { id: item.id },
  data: {
    fulfillmentStatus: 'returned',  // ← ADDED
    autoProcessedAsPerfect: true,
    needsReview: true,
  },
})
```

**DB (one-time backfill):**
Update the 13 affected OrderItems:
```sql
UPDATE "OrderItem" oi
SET "fulfillmentStatus" = 'returned'
FROM "Order" o
WHERE oi."orderId" = o.id
  AND o.status = 'rto'
  AND oi."fulfillmentStatus" = 'dispatched'
```

**Prevention:**
- Add a DB-level CHECK constraint: if Order.status = 'rto', then all OrderItems must have fulfillmentStatus IN ('returned', 'backordered')
- Or: add a code review checklist item: "Does this status transition update ALL related OrderItem fields?"

---

## ORD-006 — Auto-Poll RTO Skips Customer Stats + Audit Logs (Critical)

### What's Broken
Same pattern as ORD-003 but for RTO: when the poller detects "Returned" status, it calls `restockOrderForRto()` (which correctly handles inventory) and then directly updates the order status — but skips:
- `updateCustomerStats()` — customer's RTO count stays stale (fraud detection threshold of 3+ never triggers from auto-RTO)
- `updateEmployeeStats()` — sales rep's RTO rate KPI is wrong
- Audit log `order.returned` — 11 of 14 RTO orders have NO audit entry
- Metric event `order.rto`

### Real-World Impact
- A customer who has 5 RTOs (all auto-detected) shows 0 RTOs in their profile
- The fraud detection system (which flags customers with 3+ RTOs) NEVER triggers
- Bad customers keep ordering and returning without being flagged
- Sales reps' RTO rates are wrong — can't identify who has high return rates

### Solution
Same approach as ORD-003: refactor `processOrderReturn()` to accept an optional `injectedContext`, then have the poller call it instead of doing direct `db.order.update`.

---

## ORD-008 — CourierStatusHistory Table Has ZERO Rows (Critical)

### What's Broken
The `CourierStatusHistory` table was designed to track every courier status change (e.g., "Booked" → "Picked Up" → "In Transit" → "Delivered"). But:
1. The `insertCourierStatusHistory()` helper writes fields that DON'T EXIST on the Prisma schema
2. The helper is NEVER IMPORTED anywhere — it's dead code
3. None of the pollers or webhook handlers create any `CourierStatusHistory` rows

### Real-World Impact
- No courier status history is tracked
- Can't answer "when did the courier status change from 'picked up' to 'in transit'?"
- Can't audit courier performance (e.g., "how long between pickup and delivery for Leopard vs PostEx?")
- Can't debug "why did the status jump from 'booked' to 'delivered' without showing 'in transit'?"
- The courier status history page in the UI would show nothing

### Solution

**Backend:**
1. Rewrite `insertCourierStatusHistory()` to match the actual Prisma schema fields:

```typescript
// The actual schema fields (from prisma/schema.prisma):
// status, subStatus, rawResponse, orderId, exchangeShipmentId,
// trackingNumber, courierIntegrationId

export async function insertCourierStatusHistory(entry: {
  orderId?: string
  exchangeShipmentId?: string
  trackingNumber: string
  courierIntegrationId: string
  status: string
  subStatus?: string | null
  rawResponse?: Record<string, unknown>
  organizationId: string
  companyId: string
}) {
  await db.courierStatusHistory.create({
    data: {
      orderId: entry.orderId ?? null,
      exchangeShipmentId: entry.exchangeShipmentId ?? null,
      trackingNumber: entry.trackingNumber,
      courierIntegrationId: entry.courierIntegrationId,
      status: entry.status,
      subStatus: entry.subStatus ?? null,
      rawResponse: entry.rawResponse ? JSON.stringify(entry.rawResponse) : null,
      organizationId: entry.organizationId,
      companyId: entry.companyId,
    },
  }).catch((e) => console.error('[courier-status-history] insert failed:', e))
}
```

2. Import and call it in:
   - `postex-status-poll.actions.ts` — every time a status change is detected
   - `leopard-webhook.actions.ts` — every time a webhook is received
   - `booking.actions.ts` — when a booking succeeds (status = "Booked")

**Prevention:**
- Add a test that verifies CourierStatusHistory rows are created after a status poll cycle
- CI check: grep for `courierStatusHistory.create` — if zero calls exist, fail the build

---

## ORD-016 — Exchange Shipment Booking Uses Wrong Function Signature (Critical)

### What's Broken
The booking-workbench route calls `bookExchangeShipmentWithCourier(entity_id, courier_company_integration_id, pickup_address_id)` with 3 positional arguments. But the function expects a SINGLE options object with named fields (`shipmentId`, `companyIntegrationId`). This means the function receives `undefined` for all parameters and would fail at runtime.

### Real-World Impact
- Exchange shipment booking via the Booking Workbench is completely broken
- User clicks "Book" on an exchange shipment → the API call fails
- The exchange shipment can't be booked with a courier

### Solution

**Backend (API):**
File: `src/app/api/booking-workbench/book/route.ts`

Fix the function call to pass a proper options object:

```typescript
// BEFORE:
const result = await bookExchangeShipmentWithCourier(
  body.entity_id,
  body.courier_company_integration_id,
  body.pickup_address_id || undefined
)

// AFTER:
const result = await bookExchangeShipmentWithCourier({
  shipmentId: body.shipmentId,
  companyIntegrationId: body.companyIntegrationId,
  pickupAddressCode: body.pickupAddressCode || undefined,
})
```

Also ensure the `BookRequest` interface includes `shipmentId` and `companyIntegrationId` (it already does per the audit — the bug is just in how the function is called).

---

## ORD-002 + ORD-005 — RTO Restocks Wrong Location (High)

### What's Broken
When items are dispatched, the system correctly records which location they were dispatched from (`item.reservedLocationId`). But when the order is returned (RTO), the system uses `order.dispatchLocationId` instead of `item.reservedLocationId` to determine where to restock. If an item was reserved/dispatched from Location A but the order's `dispatchLocationId` is Location B, the RTO restocks to Location B — leaving Location A permanently short.

### Real-World Impact
- Location A: 10 items dispatched, 5 returned → onHand should be 5 but shows 0 (return went to B)
- Location B: 0 items dispatched, but 5 items "returned" → onHand shows 5 phantom items
- Warehouse at Location A reorders more stock unnecessarily (thinks they're out)
- Warehouse at Location B has phantom stock that doesn't really exist
- Inventory valuation is wrong across locations

### Solution

**Backend:**
Files: `src/lib/actions/order-return.actions.ts` + `src/lib/inventory.ts` (restockOrderForRto)

Use `item.reservedLocationId ?? order.dispatchLocationId` instead of just `order.dispatchLocationId`:

```typescript
// BEFORE (order-return.actions.ts line 84):
const locationId = order.dispatchLocationId

// AFTER:
const locationId = item.reservedLocationId ?? order.dispatchLocationId

// BEFORE (inventory.ts restockOrderForRto line 1308):
const locationId = order.dispatchLocationId

// AFTER:
// Resolve per-item, not per-order
for (const item of items) {
  const itemLocationId = item.reservedLocationId ?? order.dispatchLocationId
  // ... restock to itemLocationId
}
```

---

## ORD-007 — Leopard Booking Overwrites City Name with Numeric ID (High)

### What's Broken
After a successful Leopard booking, the code updates the order's `deliveryCity` field with `resolvedDeliveryCity` — which is the NUMERIC Leopard city ID (e.g., "394"). But `deliveryCity` is supposed to be a human-readable city NAME (e.g., "Karachi"). So after booking, the order shows "394" as the delivery city instead of "Karachi".

### Real-World Impact
- Order detail page shows "Delivery City: 394" instead of "Delivery City: Karachi"
- Customer-facing documents (slips, invoices) show wrong city
- City-based reports break (can't group by city name)
- Customer service can't quickly identify which city an order is going to

### Solution

**Backend:**
File: `src/lib/actions/booking.actions.ts` — `bookOrderWithCourier()`

Don't overwrite `deliveryCity` with the numeric city ID. The numeric ID is only needed for the API call — it should NOT be persisted on the order:

```typescript
// BEFORE (line ~470):
deliveryCity: resolvedDeliveryCity || deliveryCity,

// AFTER:
// Don't overwrite deliveryCity — it's a human-readable name.
// The numeric cityId is only used for the API call, not stored.
// deliveryCity: deliveryCity,  // ← keep the original city name
```

---

## ORD-009 — Auto-Poll Cancel Skips Stats + Audit Logs (High)

### What's Broken
Same pattern as ORD-003/006 but for cancellation: when PostEx poller detects "cancelled_by_merchant" or "expired", it unreserves stock + updates order status — but skips customer stats, employee stats, and audit logs (PostEx path creates NO audit entry at all, only a console.log).

### Solution
Same approach as ORD-003: refactor `cancelOrder()` to accept `injectedContext` and call it from the poller instead of doing direct `db.order.update`.

---

## ORD-010 — Webhook Receiver Doesn't Handle "In Transit" (Medium)

### What's Broken
The webhook receiver only handles "delivered" and "returned" statuses. If PostEx sends a webhook for "in_transit" (picked up), the dispatch transition is silently dropped. Also, if a "Delivered" webhook arrives before the system has processed the "Picked" status, the delivery is silently dropped.

### Solution
Add handling for "in_transit" status → trigger dispatch. Also add a fallback: if "delivered" arrives but order is still in 'confirmed'/'processing', auto-dispatch first then mark delivered.

---

## ORD-011 — 18 sale_dispatched Transactions Have NULL orderId (Medium)

### What's Broken
Migration 027 added an `orderId` column to `InventoryTransaction` for direct FK from transaction to order. But 18 existing `sale_dispatched` transactions have NULL `orderId` — the backfill never ran.

### Solution
One-time DB backfill:
```sql
UPDATE "InventoryTransaction" t
SET "orderId" = t."referenceId"
WHERE t."transactionType" = 'sale_dispatched'
  AND t."referenceType" = 'order'
  AND t."referenceId" IS NOT NULL
  AND t."orderId" IS NULL
```

---

## ORD-012 — Audit Log Gaps on Auto-Poll Transitions (Medium)

### What's Broken
12 missing `order.delivered`, 11 missing `order.returned`, 6 missing `order.dispatched` audit log entries. Caused by ORD-003/006/009 — the auto-poll paths bypass the action functions that create audit logs.

### Solution
Fixed by the ORD-003/006/009 solution (refactoring action functions to accept `injectedContext`).

---

## ORD-013 — Orders List Caps at 50 with No Pagination (Low)

### What's Broken
The orders list silently truncates at 50 records with no pagination UI. Users with more than 50 orders see only the most recent 50.

### Solution
Add pagination (page, pageSize, total) to the orders list API + frontend pagination controls.

---

## ORD-014 — RTO Button Requires ORDERS_MANAGE but Dispatch Only Requires ORDERS_FULFILL (Low)

### What's Broken
Warehouse Staff can dispatch orders (ORDERS_FULFILL) but can't mark RTO (requires ORDERS_MANAGE). This may be intentional but creates UX friction.

### Solution
Decision needed from Usman: should RTO be ORDERS_FULFILL or ORDERS_MANAGE? If warehouse staff should handle RTOs, change the permission. If only managers should, keep as-is and document the rationale.

---

## ORD-015 — Processing Timeline Shows Wrong Timestamp (Low)

### What's Broken
There's no `processingAt` field in the schema. The timeline widget fakes it with `order.createdAt` — which is when the order was placed, not when it moved to Processing.

### Solution
Either add a `processingAt` field to the Order schema, or accept that the Processing timestamp is approximate and remove it from the timeline.

---

## ORD-017 — Bookable List Endpoint Has No Permission Check (Low)

### What's Broken
`GET /api/booking-workbench/bookable` calls `getWorkspace()` but doesn't call `requirePermission(ORDERS_FULFILL)`. Any employee can see the full list of bookable orders including customer phone numbers and COD amounts.

### Solution
Add `requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)` to the route.

---

## Summary: Prevention Measures

### 1. Never Use Direct `db.order.update` for Status Transitions
**Problem:** Auto-pollers bypass action functions, skipping side effects.
**Fix:** All status transitions must go through action functions (markOrderDelivered, processOrderReturn, cancelOrder). These functions should accept an `injectedContext` parameter for system/poller invocation.

### 2. Select Clause Completeness
**Problem:** Missing fields in `select` cause silent `undefined` references.
**Fix:** Use TypeScript's `satisfies` operator or `Pick` type to ensure all referenced fields are in the select clause.

### 3. OrderItem Status Consistency
**Problem:** OrderItem.fulfillmentStatus not updated when Order.status changes.
**Fix:** Every Order.status transition that affects items must update ALL related OrderItem fields. Add a checklist item.

### 4. Dead Code Prevention
**Problem:** `insertCourierStatusHistory()` was dead code for months.
**Fix:** CI check: if a function is exported but never imported, flag it. If a table has 0 rows after a feature ships, alert.

### 5. Location Resolution Consistency
**Problem:** Dispatch uses `item.reservedLocationId` but RTO uses `order.dispatchLocationId`.
**Fix:** Always resolve location per-item: `item.reservedLocationId ?? order.dispatchLocationId`. Never use order-level location for item-level operations.

### 6. Don't Overwrite Human-Readable Fields with Machine IDs
**Problem:** Leopard city ID overwrites city name.
**Fix:** Machine IDs (numeric city IDs, provider-specific codes) should be stored in dedicated fields or metadata — never overwrite human-readable fields.
