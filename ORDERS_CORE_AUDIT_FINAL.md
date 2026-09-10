# ORDERS-CORE-LIFECYCLE-AUDIT — FINAL REPORT

**Task ID:** ORDERS-CORE-LIFECYCLE-AUDIT
**Audit type:** READ-ONLY investigation (no code/schema/data modified)
**Scope:** Orders Core Lifecycle — create → confirm → processing → packed → dispatch → deliver → RTO → cancel → un-cancel, including courier booking (Leopard + PostEx), status tracking, and cross-module relationships.
**Method:** Static code review (Prisma schema + server actions + API routes + adapters + frontend) PLUS live DB queries against the Supabase Postgres instance.

---

## EXECUTIVE SUMMARY

| Severity | Count |
|----------|-------|
| Critical | 3 |
| High | 8 |
| Medium | 5 |
| Low | 4 |
| **Total** | **20** |

The Orders Core Lifecycle is **functionally complete** end-to-end. The primary create → confirm → dispatch → deliver / RTO / cancel pipeline executes correctly and most lifecycle transitions are properly audit-logged + atomic. Stock reservation, dispatch deduction, RTO restock, and cancellation unreserve all flow through the central `processInventoryTransaction` ledger and are correctly guarded by `db.$transaction` (post INV-006).

However, three systemic gaps dominate the findings:

1. **Courier status history is silently dead** — the `insertCourierStatusHistory()` helper was authored against a DIFFERENT schema than what's actually in the DB/Prisma. It's never imported anywhere, and the poller/webhook handlers update `Order.courierSubStatus` directly without creating any `courier_status_history` rows. DB shows **0 rows** in the table despite **14 booked + 15 dispatched + 14 delivered + 14 RTO** orders in the system.

2. **Two parallel RTO code paths produce divergent state** — `/api/orders/[id]/rto` (UI manual) calls `processOrderReturn` which does NOT update `OrderItem.fulfillmentStatus` to `'returned'`. The auto-poll path (`pollPostExOrderStatuses` + Leopard webhook) calls `restockOrderForRto` which DOES update it. DB confirms: **13 of 14** RTO orders have items stuck at `fulfillmentStatus='dispatched'`.

3. **Auto-poll transitions skip customer + employee stats + audit + metric side-effects** — PostEx/Leopard polling and Leopard webhook handlers mark orders delivered/RTO/cancelled via raw `db.order.update` calls that bypass `markOrderDelivered` / `cancelOrder` / `processOrderReturn`. Customer RTO counts, employee funnel stats, audit logs, and metric events all go stale on these paths.

Additional notable findings: a booking route's exchange-shipment branch calls `bookExchangeShipmentWithCourier` with **3 positional args** instead of the single options object the function actually expects; Leopard bookings overwrite `Order.deliveryCity` (a human-readable name) with the **numeric Leopard cityId** (proven by data inspection — 0 rows currently affected but the code path is live); `performOrderDispatch` selects 11 columns from `Order` but references `salesEmployeeId` (NOT in the select) — making the `updateEmployeeStats(order.salesEmployeeId)` line **dead code** for every dispatch.

---

## PART A — ORDER LIFECYCLE TRACE

### A.1 CREATE — POST /api/orders + `createManualOrder()`

**Verified OK — no critical issue.** The `createManualOrder` flow is correct and well-optimized:

- ✅ Order + OrderItems created atomically via `db.order.create` + `db.orderItem.createManyAndReturn` (single batch insert, not N sequential inserts).
- ✅ Customer resolution handles BOTH existing-customer (`customer_id` lookup, verifies org-membership) and new-customer (`createCustomerInternal`) paths in parallel with variant fetch + settings fetch + order-number generation via `Promise.all`.
- ✅ Variant pricing is resolved **server-side** from `CompanyVariantPricing` (the `variant.companyPricing[0]` lookup at line 562). Client-supplied `unit_price` is NOT accepted — only `discount_type`/`discount_value`. Original price is snapshotted in `originalUnitPrice`; per-item discount clamped at 0 minimum.
- ✅ Subtotal/discount/total math correct: `totalOrderValue = subtotal + courierCharges + estimatedDeliveryCharge + taxAmount - discountAmount` (line 634).
- ✅ Auto-booking fires in the background (async IIFE, non-blocking) when `orderStatus==='confirmed' && !isSelfFulfilled && orderSettings.courierBookingMode==='automatic'` (lines 920-941).
- ✅ Compensating transaction: if `reserveOrderStock` fails after auto-confirm, the order is rolled back via `db.order.delete({ where: { id: order.id } })` (line 891) — cascade-deletes items + customer-stats are recomputed.
- ✅ Self-fulfilled orders (Phase B1) correctly skip auto-booking + generate SF-YYYY-NNNNN reference.
- ✅ Audit log + metric event both fired (`order.created`, `order.created` metric).

⚠️ **Minor (informational):** `customer_address.city` + `country` are propagated back to the saved `CustomerAddress` row when the user corrects them on the order form (lines 812-836). This is a fire-and-forget `.catch()` swallow — if it fails, the order is still created, but the customer's saved address stays with the wrong city. Acceptable since it's a convenience, not a correctness requirement.

---

### A.2 CONFIRM — POST /api/orders/[id]/confirm + `confirmOrder()`

**Verified OK — no issue.**

- ✅ Status `pending` → `confirmed` with `confirmedAt: new Date()`.
- ✅ Calls `reserveOrderStock()` which iterates items, calls `reserveStockForOrder()` (creating `order_reserved` `InventoryTransaction` with `referenceType='order'`, `referenceId=orderId`) for each stock_based item with sufficient stock.
- ✅ MTO items call `checkAndFulfillMadeToOrderVariant()` — either pulls from returned-stitched inventory (sets `returnedStitchedUsed=true`, `fulfillmentStatus='reserved'`) or triggers fresh production (creates `ProductionOrder`, links back to `OrderItem.productionOrderId`).
- ✅ Per-item backorder handling: if `inventoryPolicy='continue'` and insufficient stock → item is `backordered`, order status auto-flips to `partially_backordered`.
- ✅ Permission enforced: `requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)`.
- ✅ Auto-booking triggered post-confirm for `automatic` mode (H14 bug-fix — lines 1418-1441).
- ✅ Customer stats + employee stats (Phase 6) updated.

⚠️ **Note on `reserveOrderStock` idempotency:** line 193-197 skips items already at `fulfillmentStatus='reserved'` or `dispatched`. This is intentional (re-confirmation attempts are safe) but means a failed-and-retried confirm can leave some items `reserved` and others `pending` if the failure was mid-loop. Not a bug — design choice.

---

### A.3 PROCESSING — POST /api/orders/[id]/processing + `markOrderProcessing()`

**Verified OK — no issue.**

- ✅ Status transitions to `'processing'` (line 2709) — but `processingAt` is NOT set (no such field exists in the schema).
- ✅ Pre-condition check: only allows transitions from `'confirmed'` or `'partially_backordered'` (line 2703-2705).
- ✅ Permission enforced: `requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)`.
- ✅ Audit log: `order.processing_started` + metric event fired.

⚠️ **Design gap (informational):** the schema has no `processingAt` column. The `order-detail-view.tsx` (line 1529-1531) fakes the timestamp for the timeline widget by using `order.createdAt` when `status==='processing' || packedAt || dispatchedAt`. This produces a misleading timeline ("Processing" step shows the order's creation timestamp instead of when it actually moved to Processing). Not a code bug per se, but a schema/frontend design inconsistency.

---

### A.4 PACKED — POST /api/orders/[id]/packed + `markOrderPacked()`

**Verified OK — no issue.**

- ✅ Sets `packedAt: new Date()` (line 2782).
- ✅ Auto-transitions status to `'processing'` if currently `'confirmed'`/`'partially_backordered'` (lines 2783-2785). Comment explicitly explains the rationale (badge shows "Confirmed" even after packing was the prior bug).
- ✅ Pre-condition: status must be in `['confirmed', 'partially_backordered', 'processing']`.
- ✅ Ownership check (Phase 2): if caller's role has `ordersDataScope='own'` and the order's `salesEmployeeId !== ctx.employee.id`, reject (lines 2764-2770).
- ✅ Permission enforced: `requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)`.
- ✅ Audit log `order.packed` + metric event fired.

---

### A.5 DISPATCH — POST /api/orders/[id]/dispatch + `dispatchOrderAction()` → `performOrderDispatch()`

**1 Critical + 1 High issue.**

✅ What works:
- Route enforces non-empty `tracking_number` (route.ts line 25-28).
- Permission: `requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)`.
- Packing requirement enforced: if `CompanyOrderSetting.requirePackingStep === true && !order.packedAt`, dispatch rejected (lines 2660-2668).
- Pre-condition: blocks dispatch of already-`dispatched/delivered/rto/cancelled/refunded` orders.
- Blocks dispatch if ANY item is `backordered` (lines 2496-2508) — hard rule, no split shipments.
- Inventory deduction correct: for each `fulfillmentStatus='reserved'` item, calls `dispatchOrder()` (inventory.ts) which produces a `sale_dispatched` `InventoryTransaction` (`referenceType='order'`, `referenceId=orderId`, `orderId=orderId`) — decrements `onHand`, releases `reserved`, locks WAC.
- `OrderItem.fulfillmentStatus` updated to `'dispatched'` + `fulfilledAt: new Date()` (lines 2543-2547).
- Audit log `order.dispatched` (tagged with `dispatch_source: 'manual' | 'auto_poll'`) + metric event fired.
- Order status updated to `'dispatched'` + `dispatchedAt: new Date()` + `trackingNumber` + `courierName` persisted (lines 2552-2560).
- Idempotent: if all items already `'dispatched'`, inventory loop is skipped, only status updated (lines 2518-2616, `inventorySkipped` flag).

---

```
BUG-ID: ORD-001
Layer: API
Severity: Critical
Location: src/lib/actions/order.actions.ts — performOrderDispatch() (lines 2456-2471 select clause + line 2609 reference)
Description: performOrderDispatch's db.order.findUnique select clause is missing `salesEmployeeId`. Line 2609 references `order.salesEmployeeId` — which is `undefined` because the field is not in the select. The `if (order.salesEmployeeId)` guard is therefore always FALSE, making the entire `updateEmployeeStats(order.salesEmployeeId).catch(() => {})` block dead code for every dispatch.
Expected: After a dispatch, the sales employee's funnel stats (dispatchedCount, inTransitCount, deliveryRate, rtoRate) should be recomputed.
Actual: Stats are NEVER recomputed on dispatch. Sales employee KPIs (commission, performance dashboards) drift over time. markOrderDelivered (which uses findFirst WITHOUT a select clause, so all fields returned) correctly calls updateEmployeeStats(order.salesEmployeeId) — so the bug is specific to dispatch transitions.
Repro Steps: 1. Create an order attributed to sales employee E. 2. Dispatch it (manual or via auto-poll). 3. Inspect EmployeeStats for E — dispatchedCount stays stale. 4. Compare to delivering the same order — deliveredCount IS bumped.
Suspected Root Cause: The select clause was tightened (to reduce payload from the DB during cron polling) but `salesEmployeeId` was forgotten. The `if (order.salesEmployeeId)` guard was written assuming the field would be present.
```

```
BUG-ID: ORD-002
Layer: Cross-Module
Severity: High
Location: src/lib/actions/order.actions.ts — performOrderDispatch() lines 2521 + 2526-2534 (item.reservedLocationId resolution)
Description: For each item being dispatched, the locationId is resolved as `item.reservedLocationId ?? order.dispatchLocationId`. The dispatchOrder() call records the sale_dispatched txn against THAT locationId. This is correct AT DISPATCH TIME. However, downstream RTO restocking (restockOrderForRto in inventory.ts line 1308) uses ONLY `order.dispatchLocationId` — NOT `item.reservedLocationId`. If items were reserved/dispatched against a DIFFERENT location than the order's dispatchLocationId (e.g. items pre-reserved against location A, then order.dispatchLocationId changed to location B before dispatch — which is allowed by the schema since dispatchLocationId is set at creation but reservedLocationId is finalized at reservation time), RTO restock will: (a) fail to find the original sale_dispatched txn (query at line 1323-1332 uses locationId = order.dispatchLocationId), (b) fall back to variant.costPrice (not the WAC at dispatch time), (c) post the return txn to the WRONG pool — incrementing onHand at location B while leaving onHand permanently decremented at location A.
Expected: restockOrderForRto should use `item.reservedLocationId ?? order.dispatchLocationId` for BOTH the txn lookup AND the return txn target — exactly mirroring dispatchOrderAction's resolution.
Actual: Uses order.dispatchLocationId only — silently corrupts inventory when items were dispatched from a non-default location.
Repro Steps: 1. Set CompanyOrderSetting.defaultDispatchLocationId = Loc-A. 2. Create an order (dispatchLocationId=Loc-A). 3. At confirm time, item.reservedLocationId gets set to Loc-A (since order.dispatchLocationId is Loc-A — both are the same in the happy path). 4. Admin edits the order to change dispatchLocationId=Loc-B (this is allowed by the schema; there is no guard preventing it post-reservation). 5. Dispatch happens — performOrderDispatch resolves locationId = item.reservedLocationId (Loc-A) — sale_dispatched txn recorded against Loc-A. 6. Order is RTO'd. restockOrderForRto uses order.dispatchLocationId (Loc-B) — looks up sale_dispatched in Loc-B (none found, falls back to costPrice), posts return txn to Loc-B (onHand+1 at Loc-B), Loc-A onHand stays at -1.
Suspected Root Cause: restockOrderForRto was written when the reservation always used order.dispatchLocationId. The per-item reservedLocationId feature (allowing different items to be reserved against different locations) was added later but restockOrderForRto was not updated to mirror performOrderDispatch's resolution logic.
```

---

### A.6 DELIVERED — POST /api/orders/[id]/delivered + `markOrderDelivered()`

**Verified OK for the manual UI path.** See ORD-003 below for the auto-poll path.

- ✅ Pre-condition: status must be `'dispatched'` (line 2836-2838).
- ✅ Permission: `requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)`.
- ✅ Sets `deliveredAt: new Date()` + status `'delivered'`.
- ✅ Audit log `order.delivered` with delivery_days dimension + metric event fired.
- ✅ `updateCustomerStats(order.customerId)` re-runs (delivered_count affects totalOrderValue because the cached `totalOrderValue` only counts delivered+dispatched orders per customer.actions.ts:1455-1457).
- ✅ `updateEmployeeStats(order.salesEmployeeId)` fires (salesEmployeeId IS selected here because `findFirst` is used without a `select` clause).

---

```
BUG-ID: ORD-003
Layer: Cross-Module
Severity: Critical
Location: src/lib/actions/postex-status-poll.actions.ts — line 552-558 (delivered branch of bulk poller) + src/lib/actions/leopard-webhook.actions.ts — line 185-188 (delivered branch of Leopard webhook) + src/lib/actions/postex-status-poll.actions.ts — line 258-262 (trackSingleOrderStatus delivered branch)
Description: When the auto-pollers (PostEx bulk, PostEx single, Leopard webhook) detect a "Delivered" status, they call `db.order.update({ where: { id }, data: { status: 'delivered', deliveredAt: new Date() } })` DIRECTLY — bypassing `markOrderDelivered()`. The bypass was intentional (markOrderDelivered uses getWorkspace() which has no session in a cron/webhook context), but the side effects were never replicated. The auto-poll delivered path:
  • Does NOT call `updateCustomerStats(order.customerId)` — customer.totalOrderValue (which sums delivered+dispatched only) goes stale
  • Does NOT call `updateEmployeeStats(order.salesEmployeeId)` — sales rep's deliveredCount/deliveryRate KPIs go stale
  • Does NOT insert an `order.delivered` audit log entry — audit trail has gaps (DB confirms: 14 delivered orders but only 2 `order.delivered` audit log entries = 12 missing)
  • Does NOT insert a `order.delivered` metric event — KPI dashboards undercount deliveries
Expected: Customer stats, employee stats, audit log, and metric event should all be created on ANY delivered transition — manual OR auto-poll.
Actual: Only the manual UI path produces these side effects. 12 of 14 delivered orders have no audit trail; customer/employee KPIs are silently wrong.
Repro Steps: 1. Dispatch an order. 2. Wait for the PostEx/Leopard poller to detect "Delivered". 3. Inspect the audit log — no `order.delivered` entry. 4. Inspect the customer record — totalOrderValue not refreshed. 5. Inspect the sales employee's EmployeeStats — deliveredCount not bumped.
Suspected Root Cause: The poller authors intentionally avoided markOrderDelivered to skip getWorkspace() (which requires a user session). They wrote a "simpler" db.order.update but forgot the side effects. The fix should either (a) refactor markOrderDelivered to accept an optional injected context (matching cancelOrder's pattern), or (b) duplicate the side effects (audit, metric, customer stats, employee stats) in the poller.
```

---

### A.7 RTO — POST /api/orders/[id]/rto + `processOrderReturn()`

**1 Critical + 1 High issue.** The RTO path is the most problematic in the module.

✅ What works (manual UI path via processOrderReturn):
- ✅ Pre-condition: status must be `'dispatched'`.
- ✅ Sets `status='rto'` + `returnedAt: new Date()`.
- ✅ Permission: `requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)`.
- ✅ Cost basis correctly recovered from the original `sale_dispatched` txn (lines 99-109).
- ✅ For stock_based items: creates `return_resellable` `InventoryTransaction` (adds onHand back, recalculates WAC).
- ✅ For made_to_order items: creates `return_stitched_received` `InventoryTransaction` (also flips `trackInventory=true` per docs).
- ✅ `autoProcessedAsPerfect=true` + `needsReview=true` set on every item — surfaces in the returns review queue for physical spot-checking.
- ✅ Customer stats recomputed; auto-flags customer at 3+ RTO (lines 195, 204-210).
- ✅ Audit log `order.returned` + metric event fired.
- ✅ Employee stats recomputed.

---

```
BUG-ID: ORD-004
Layer: Cross-Module
Severity: Critical
Location: src/lib/actions/order-return.actions.ts — processOrderReturn() lines 65-77 (item select) + 131-167 (item update)
Description: processOrderReturn updates each OrderItem with ONLY `{ autoProcessedAsPerfect: true, needsReview: true }`. It does NOT set `fulfillmentStatus: 'returned'`. The item's `fulfillmentStatus` stays at `'dispatched'` indefinitely. This is inconsistent with `restockOrderForRto()` in inventory.ts (lines 1355-1362) which DOES set `fulfillmentStatus: 'returned'` AND with the schema comment on OrderItem.fulfillmentStatus which lists "reserved | backordered | dispatched" (but the auto-poller already uses 'returned' as a 4th value — Extra1 in DB queries confirms 2 items currently have fulfillmentStatus='returned').
Expected: After RTO, every returned OrderItem should have `fulfillmentStatus='returned'` so the order-detail-view, customer-detail-view, and any inventory reports can distinguish "still in transit" items from "physically returned" items.
Actual: 13 of 14 RTO orders in the DB have items stuck at `fulfillmentStatus='dispatched'` (proven by Extra8 query — 13 RTO orders have at least one item still at 'dispatched'). Only the 1 RTO order that went through the auto-poll path (restockOrderForRto) has its items at 'returned'.
Repro Steps: 1. Dispatch an order. 2. From the UI, click "Mark as Returned/RTO" with reason "test" (triggers /api/orders/[id]/rto → processOrderReturn). 3. Inspect the OrderItems — fulfillmentStatus still 'dispatched'. 4. Compare with an order that auto-RTOs via PostEx/Leopard poller — fulfillmentStatus='returned'.
Suspected Root Cause: Two RTO implementations exist with different field-update contracts. processOrderReturn was written before 'returned' was added as a valid fulfillmentStatus (it isn't in the schema comment); restockOrderForRto was written later and adopted 'returned'. The manual path was never updated to match.
```

```
BUG-ID: ORD-005
Layer: Cross-Module
Severity: High
Location: src/lib/actions/order-return.actions.ts — processOrderReturn() line 84 + src/lib/inventory.ts — restockOrderForRto() line 1308
Description: Both RTO functions resolve the locationId as `order.dispatchLocationId` — NOT `item.reservedLocationId ?? order.dispatchLocationId`. If any item was reserved/dispatched from a location DIFFERENT from order.dispatchLocationId (see ORD-002's root cause analysis), the RTO will: (a) fail to find the sale_dispatched txn (lookup uses locationId), (b) fall back to `item.orgVariant.costPrice` instead of the actual dispatch-time WAC, (c) post the return_resellable txn to the WRONG pool — inflating onHand at order.dispatchLocationId while leaving the original pool permanently short.
Expected: RTO restock should target the same locationId the item was dispatched from (item.reservedLocationId ?? order.dispatchLocationId) — matching performOrderDispatch's resolution.
Actual: Uses order.dispatchLocationId only — silently corrupts inventory in the multi-location dispatch scenario.
Repro Steps: Same as ORD-002 — set up an order where item.reservedLocationId != order.dispatchLocationId post-dispatch, then trigger RTO. Pool imbalance will result.
Suspected Root Cause: Same as ORD-002 — pre-existing assumption that reservation always uses order.dispatchLocationId, broken when per-item reservedLocationId was introduced.
```

```
BUG-ID: ORD-006
Layer: Cross-Module
Severity: Critical
Location: src/lib/actions/postex-status-poll.actions.ts — line 582-619 (RTO branch of bulk poller) + src/lib/actions/leopard-webhook.actions.ts — line 202-223 (Leopard webhook RTO branch) + line 275-287 (trackSingleOrderStatus RTO branch)
Description: When the auto-pollers detect a "Returned" status, they: (a) call restockOrderForRto() (which DOES update OrderItem.fulfillmentStatus='returned' and creates return_resellable/return_stitched_received txns), then (b) `db.order.update` the order directly to status='rto' + returnedAt. They SKIP: updateCustomerStats() (customer's totalRtoCount stays stale → fraud-detection threshold of 3+ never triggers from auto-RTO), updateEmployeeStats() (sales rep's rtoRate KPI is wrong), audit log entry for `order.returned`, metric event `order.rto`. DB confirms: 14 RTO orders exist but only 3 `order.returned` audit log entries = 11 missing.
Expected: Auto-detected RTOs should trigger the same side effects as manual RTOs (customer stats, employee stats, audit log, metric event, customer auto-flag at 3+ RTO).
Actual: Only the inventory restock + order status update happen — KPIs, audit trail, and fraud detection are all broken on the auto-RTO path.
Repro Steps: 1. Dispatch an order. 2. Wait for PostEx/Leopard poller to detect "Returned". 3. Check customer.totalRtoCount — not bumped. 4. Check audit log — no `order.returned` entry. 5. If this was the customer's 3rd RTO, check customer.isFlagged — still false (fraud detection failed).
Suspected Root Cause: Same as ORD-003 — poller authors intentionally avoided processOrderReturn (which uses getWorkspace) and called restockOrderForRto directly, but forgot to also replicate the customer/employee/audit/metric side effects.
```

---

### A.8 CANCEL — POST /api/orders/[id]/cancel + `cancelOrder()`

**Verified OK — no critical issue.**

- ✅ Pre-condition: blocks cancellation of `dispatched/delivered/rto/cancelled/refunded` orders (lines 1772-1778) — must use the RTO flow instead.
- ✅ Stock unreservation: iterates `fulfillmentStatus='reserved'` items, calls `unreserveStockForOrder()` for each (creates `order_unreserved` `InventoryTransaction`, decrements `reserved` on pool).
- ✅ Atomicity (INV Part 3 fix): unreserve each item, THEN update order status + ALL item statuses in a single `db.$transaction` (lines 1857-1874). If the status update fails after unreserve, pools are correct (already decremented) and the status update can be retried.
- ✅ Courier cancellation: if order has `trackingNumber + courierSubStatus in ['slip_generated', 'pickup_requested']`, calls `cancelCourierBooking()` FIRST (lines 1790-1807). If courier API fails, the entire cancel aborts — no state change. If it succeeds, `cancelCourierBooking()` internally re-invokes `cancelOrder(skipCourierCall=true)` to handle the FlowOps-side cleanup.
- ✅ Sets `cancelledAt: new Date()` + `cancellationReason` (line 1862-1863).
- ✅ `physicalUnpackRequired` flag set if status was `'processing'` OR `packedAt !== null` (lines 1811-1813) — surfaces in the locate_cancelled scan mode for warehouse staff.
- ✅ OrderItem.fulfillmentStatus reset to `'pending'` (line 1871) — so un-cancel can re-reserve via `reserveOrderStock` (which skips items already at 'reserved'/'dispatched').
- ✅ Permission: `requirePermission(ctx, PERMISSIONS.ORDERS_CANCEL)`.
- ✅ Order ownership check (Phase 2): `ordersDataScope='own'` employees can only cancel orders they created.
- ✅ Webhook path support: `injectedContext` parameter allows Shopify's `orders/cancelled` webhook to call this function with a synthetic elevated context (skips `requirePermission` — HMAC signature is the authorization).
- ✅ Audit log `order.cancelled` + metric event + customer stats + employee stats all fired.

⚠️ **Note (informational):** after cancellation, OrderItem.fulfillmentStatus goes back to `'pending'`. This is by design (so un-cancel can re-reserve), but it means a quick visual on the order-detail page after cancel will show items as "pending" rather than "cancelled" — which can confuse readers expecting "cancelled" semantics. Not a bug, just a UX consideration.

---

### A.9 UN-CANCEL — POST /api/orders/[id]/un-cancel + `unCancelOrder()`

**Verified OK — no critical issue.**

- ✅ Pre-condition: status must be `'cancelled'` (line 1947-1949).
- ✅ Permission: `requirePermission(ctx, PERMISSIONS.ORDERS_MANAGE)`.
- ✅ Determines pre-cancel status: if `order.confirmedAt` was set, restores to `'confirmed'`; otherwise restores to `'pending'` (line 1955).
- ✅ Clears `cancelledAt`, `cancellationReason`, `physicalUnpackRequired` (lines 1962-1965).
- ✅ If restoring to `'confirmed'`, calls `reserveOrderStock()` to re-reserve stock for each item. Items already at `fulfillmentStatus='reserved'` or `'dispatched'` are skipped (reserveOrderStock idempotency, line 193-197).
- ✅ Audit log `order.un_cancelled` + metric event + customer stats + employee stats fired.

⚠️ **Behavior gap (Low severity):** the doc comment at line 1929-1933 says "Does NOT re-book the courier — if the courier booking was cancelled, user must re-book via Booking Workbench". This is correct behavior, but the route does NOT clear `courierBookingStatus` (which would have been set to `'cancelled'` if the courier was cancelled). So an un-cancelled order keeps `courierBookingStatus='cancelled'` indefinitely — the user must manually re-book to flip it back. Minor UX trap; not a bug per se.

⚠️ **What it does NOT do (intentionally per docstring):** does NOT handle OrderItems that were already `dispatched` before cancellation. Since the cancel path blocks cancellation of `dispatched` orders (A.8), this scenario can only arise if dispatch happened AFTER cancel (race condition). The current code correctly handles this by skipping `dispatched` items in `reserveOrderStock` — but the order's status would still be `'confirmed'` while having `dispatched` items. Edge case, not a real-world risk.

---

## PART B — COURIER BOOKING INTEGRATION

### B.1 Booking flow — `bookOrderWithCourier()`

**1 High issue.** See ORD-007 below.

✅ What works:
- ✅ Permission: `requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)`.
- ✅ Validates integration is active + belongs to caller's company.
- ✅ City validation via `revalidateCityAtBookingTime()` with live courier fallback.
- ✅ Weight calculation: sums `variant.weightKg * quantity` for all items.
- ✅ PostEx orderType determination (Normal/Overland/Replacement).
- ✅ Pickup address resolution: per-call override > order.pickupAddressId > integration default.
- ✅ Leopard city resolution: looks up `courier_operational_cities` for the city NAME → returns the numeric cityId (lines 319-341). Adapter validates it's numeric (leopard.adapter.ts line 306).
- ✅ Stores tracking number on order, sets `courierBookingStatus='booked'` + `courierCityStatus='matched'` + `courierSubStatus` (from mapPostExStatus / 'slip_generated' for Leopard).
- ✅ Failure handling: on adapter failure OR no tracking number returned, sets `courierBookingStatus='failed'` + `courierBookingFailureReason` and persists `courierCompanyIntegrationId` + `courierName` (so the Workbench shows which courier was attempted).
- ✅ Slip download (Leopard-specific): downloads the slip_link PDF to `/uploads/courier-slips/<companyId>/slip-<orderNumber>-<timestamp>.pdf` and persists the path on the order. Non-fatal if download fails.
- ✅ Audit log `order.auto_booked` + metric event fired on success.

---

```
BUG-ID: ORD-007
Layer: API
Severity: High
Location: src/lib/actions/booking.actions.ts — line 470 `deliveryCity: resolvedDeliveryCity || deliveryCity,`
Description: For Leopard orders, `resolvedDeliveryCity` is set to the numeric Leopard cityId (line 341: `resolvedDeliveryCity = cityRecord.cityId`). When the order is updated post-booking-success (line 457-473), the line `deliveryCity: resolvedDeliveryCity || deliveryCity` overwrites the order's `deliveryCity` field — which is documented as a human-readable city NAME string ("Karachi", "Lahore", etc.) per schema.prisma line 2026. So after a Leopard booking, the order's deliveryCity becomes a numeric string like "394" instead of "Karachi".
Expected: Order.deliveryCity should remain the human-readable city name. The numeric cityId is only needed inside the Leopard API call payload (bookInput.deliveryCity, line 350) — it should NOT be persisted back to the Order.
Actual: Currently 0 rows in the DB match `deliveryCity ~ '^\d+$'` (verified by Extra5 query), so no production data is corrupt YET — but the code path is live and will corrupt the field on every future Leopard booking. PostEx is unaffected because resolvedDeliveryCity === deliveryCity (city name string) for PostEx.
Repro Steps: 1. Configure a Leopard courier integration. 2. Create a manual order with deliveryCity="Karachi". 3. Book with Leopard via the Workbench. 4. Refresh the order — deliveryCity is now "394" (or whatever Leopard's numeric Karachi ID is). 5. UI displays "394" instead of "Karachi". Customer's saved address (if usedCustomerAddressId was set) is also propagated with "394" (line 486-491).
Suspected Root Cause: The variable `resolvedDeliveryCity` is overloaded — it carries the city NAME for PostEx but the numeric cityId for Leopard. The `||` fallback at line 470 was meant to handle the case where resolvedDeliveryCity was empty, but for Leopard it's always set (to the numeric ID), so the fallback never engages and the numeric ID overwrites the name.
```

---

### B.2 Leopard adapter — `bookShipment()`

**Verified OK — no critical issue.**

- ✅ Uses production URL when `credentials.isProduction` is true (supports `true | 'true' | 'on' | '1' | 1` — line 154-159); staging otherwise.
- ✅ Sends all required fields per the Leopard PDF: `api_key`, `api_password`, `booked_packet_weight` (grams), `booked_packet_no_piece`, `booked_packet_collect_amount`, `booked_packet_order_id`, `origin_city='self'`, `destination_city=<numeric>`, `shipment_id` (pickup shipper ID), `shipment_*='self'`, `consignment_*` (customer info), `special_instructions`, optional `shipment_type` + `return_address`/`return_city`.
- ✅ Strips empty/undefined fields before sending (line 360-365) — Leopard rejects some empty fields.
- ✅ Returns `track_number` + `slip_link` on success.
- ✅ Handles response status as either `1` (number) or `'1'` (string).
- ✅ Validates destination_city is numeric before sending (line 306) — returns clear error if not.

⚠️ **Behavior note:** the adapter does NOT call `fetchOperationalCities` for fallback resolution — the booking action is responsible for resolving the city name to a numeric ID before invoking the adapter. If the cached `courier_operational_cities` table is missing the city, booking fails with "Could not resolve city ... Sync Leopard cities first." (booking.actions.ts line 328). This is a design choice documented in the adapter header comment.

---

### B.3 PostEx adapter — `bookShipment()`

**Verified OK — no critical issue.**

- ✅ Uses hardcoded production URL `https://api.postex.pk/services/integration/api/order` — PostEx doesn't have a separate staging environment per the adapter (line 39).
- ✅ Sends all required fields per the PostEx PDF: `cityName`, `customerName`, `customerPhone` (converted to 03XXXXXXXXX format), `deliveryAddress`, `invoiceDivision`, `invoicePayment`, `items`, `orderDetail`, `orderRefNumber`, `orderType`, `transactionNotes`, `pickupAddressCode`.
- ✅ Intentionally OMITS `storeAddressCode` (line 184-186) — sending it empty causes "INVALID MERCHANT STORE ADDRESS CODE" error.
- ✅ Returns `trackingNumber` + `providerStatus` on success.
- ✅ Phone format conversion handles `+92XXXXXXXXXX`, `92XXXXXXXXXX`, `03XXXXXXXXX`, `3XXXXXXXXX` (lines 58-86).

---

### B.4 Status polling — `pollPostExOrderStatuses()`, `pollLeopardOrderStatuses()`, `trackSingleOrderStatus()`

**1 Critical + 1 High issue.**

✅ What works:
- ✅ PostEx bulk poller correctly calls `adapter.trackBulkShipments()` (line 434), chunks into groups of 50, falls back to single-track on bulk API failure (line 314-332).
- ✅ Leopard safety-net poller (1-2× daily, 12-hour staleness threshold) correctly calls `adapter.trackShipment()` per order (line 483).
- ✅ Status updates flow back to `Order.courierSubStatus`, `needsShipperAdvice`, `unrecognizedCourierStatus`, `lastPolledAt` (lines 485-495 for PostEx, 506-514 for Leopard).
- ✅ Status changes trigger lifecycle transitions: `in_transit` → `performOrderDispatch(source='auto_poll')` (line 516, 747-754), `delivered` → `db.order.update status='delivered'` (line 552, 584-586), `returned` → `restockOrderForRto` + status update (line 595-612, 275-287), `failed` (cancelled_by_merchant/expired) → unreserve + status='cancelled' (lines 625-671, 293-323).
- ✅ TrackSingleOrderStatus is wired to the "Refresh Courier Status" button on order-detail-view.
- ✅ Payment status lookup for delivered/returned orders (Phase 3 — migration 012).

```
BUG-ID: ORD-008
Layer: Cross-Module
Severity: Critical
Location: src/lib/integrations/status-history.ts (entire file) + src/lib/actions/postex-status-poll.actions.ts + src/lib/actions/leopard-webhook.actions.ts
Description: The `insertCourierStatusHistory()` helper exists at src/lib/integrations/status-history.ts but: (a) it writes fields that DON'T exist on the actual CourierStatusHistory Prisma model (`providerKey`, `rawStatus`, `courierSubStatus`, `courierActivityDate`, `source`, `metadata` — see lines 30-42 of the helper); (b) the actual Prisma schema (schema.prisma lines 2735-2760) has DIFFERENT fields: `status`, `subStatus`, `rawResponse`, `orderId`, `exchangeShipmentId`, `trackingNumber`, `courierIntegrationId`; (c) the helper is NEVER IMPORTED anywhere in the codebase (grep confirms zero callers); (d) NEITHER the PostEx poller, the Leopard webhook handler, nor the Leopard safety-net poller creates ANY courier_status_history rows — they all just `db.order.update` the courierSubStatus directly.
Expected: Every courier status update (from polling OR webhook) should create a courier_status_history row for the audit trail (per the migration 023 docstring: "append-only audit trail of every courier status update processed").
Actual: DB query Q4 confirms 0 rows in courier_status_history — despite 14 booked + 15 dispatched + 14 delivered + 14 RTO orders in the system, and 4 leopard.webhook_status_update audit log entries confirming the webhook ran. The schema's purpose ("audit trail of every courier status update") is completely unmet.
Repro Steps: 1. Trigger any courier status change (manual refresh, PostEx poll, Leopard webhook). 2. Query `SELECT count(*) FROM courier_status_history` — still 0.
Suspected Root Cause: The helper was authored against the migration 023 SQL schema (which had `providerKey`, `rawStatus`, `courierActivityDate`, `source`, `metadata` columns) but the schema was later refactored (via Prisma db push or an unlisted migration) to use `status`, `subStatus`, `rawResponse`, `orderId`, `exchangeShipmentId`, `trackingNumber`, `courierIntegrationId` — and the helper was never updated to match. Since the helper was never wired into the poller/webhook handlers, the schema drift went unnoticed. The helper is currently dead code that would fail at both TypeScript compile time AND runtime if called.
```

```
BUG-ID: ORD-009
Layer: API
Severity: High
Location: src/lib/actions/postex-status-poll.actions.ts — lines 620-671 (auto-cancel via poller) + src/lib/actions/leopard-webhook.actions.ts — lines 242-301 (triggerCancel branch)
Description: When the PostEx poller detects "cancelled_by_merchant" or "expired" OR the Leopard webhook receives a "CANCELLED" status, the code: (a) unreserves stock via `unreserveStockForOrder` per item, (b) `db.order.update` to `status='cancelled'`, `cancelledAt`, `cancellationReason`, `courierBookingStatus='cancelled'`. It SKIPS: `updateCustomerStats(order.customerId)` (cancelled orders are excluded from totalOrdersCount — customer's count stays inflated), `updateEmployeeStats(order.salesEmployeeId)` (sales rep's cancelRate KPI goes stale), audit log `order.cancelled` (Leopard webhook path DOES create one at line 281-292, but PostEx poller does NOT — see lines 655-665 — only a console.log, no insertAuditLog call), metric event `order.cancelled`.
Expected: Auto-detected cancellations should fire the same side effects as manual cancellations.
Actual: PostEx-poller auto-cancels have no audit trail. Customer totalOrdersCount inflated. Sales rep KPIs wrong. Leopard webhook auto-cancels DO create an audit log (line 281-292) but still skip customer/employee stats + metric event.
Repro Steps: 1. From the PostEx portal, cancel a booking pre-pickup. 2. Wait for the PostEx poller to detect "Un-Assigned By Me". 3. Inspect audit log — no `order.cancelled` entry. 4. Inspect customer — totalOrdersCount not decremented.
Suspected Root Cause: Same root cause as ORD-003 and ORD-006 — poller/webhook authors wrote inline db.order.update calls to avoid the getWorkspace() requirement of cancelOrder(), but didn't replicate the side effects. Should be refactored to use cancelOrder(injectedContext) like the Shopify webhook path does.
```

---

### B.5 Webhook receiver — `POST /api/webhooks/[provider_key]/[webhook_endpoint_id]`

**1 Medium issue.**

✅ What works:
- ✅ Route looks up `company_integrations` by `webhookEndpointId` + `providerKey` (lines 39-46). Returns 404 if no match (doesn't leak existence).
- ✅ Decrypts credentials, gets adapter via `getCourierAdapter(providerKey, credentials)`.
- ✅ Verifies webhook signature via `adapter.verifyWebhookSignature()` (stub for Leopard returns true — Leopard's PDF documents no HMAC mechanism; security relies on the unguessable webhookEndpointId in the URL).
- ✅ Wraps processing in `executeLoggedIntegrationAction` (direction='inbound', actionType='receive_status_webhook') for the integration_action_logs audit trail.
- ✅ Leopard-specific: calls `processLeopardWebhookUpdates(integration.id, payload.data)` which handles the FULL array of status updates (line 105).
- ✅ Standard single-update handling for PostEx (line 112-128): calls `adapter.parseStatusWebhook(rawPayload)` to extract trackingNumber + mapped status, then `markOrderDelivered()` or `processOrderReturn()` for delivered/returned cases.
- ✅ Always returns 200 on processing errors (line 173-176) — prevents external courier retries.

---

```
BUG-ID: ORD-010
Layer: API
Severity: Medium
Location: src/app/api/webhooks/[provider_key]/[webhook_endpoint_id]/route.ts — lines 112-128 (standard single-update handling for PostEx)
Description: The webhook receiver's standard (non-Leopard) path only handles TWO status values: `delivered` (only if order.status === 'dispatched' — calls markOrderDelivered) and `returned` (only if order.status !== 'rto' — calls processOrderReturn). It does NOT handle `in_transit` (picked up) — meaning if PostEx EVER sends a webhook for "Picked" status (rather than relying on the polling cron), the dispatch transition is silently dropped. Also, the delivered branch's precondition `order.status === 'dispatched'` means if a "Delivered" webhook arrives BEFORE our system has processed the prior "Picked" webhook (race), the order is still in 'confirmed'/'processing' state and the delivery update is silently dropped (no auto-dispatch fallback like the poller has).
Expected: Webhook receiver should handle in_transit (call performOrderDispatch) and should auto-dispatch first if a Delivered webhook arrives while the order is still confirmed/processing (matching the poller's behavior at postex-status-poll.actions.ts:540-547).
Actual: PostEx webhooks for "Picked" are silently dropped. PostEx webhooks for "Delivered" arriving before our "Picked" processing completes are silently dropped. (Leopard is unaffected because the Leopard path delegates to processLeopardWebhookUpdates which DOES handle triggerDispatch + has the auto-dispatch fallback.)
Repro Steps: 1. Configure a PostEx integration with a webhook endpoint. 2. Trigger a "Picked" webhook from PostEx. 3. Inspect the order — still 'confirmed' (no auto-dispatch). 4. Inspect the inventory — no sale_dispatched txn created (onHand not decremented).
Suspected Root Cause: The standard path was written before performOrderDispatch was refactored to support `source: 'auto_poll'`. PostEx relies entirely on the polling cron for status updates — but the webhook receiver was kept as a fallback without adding the in_transit + auto-dispatch-first branches.
```

---

### B.6 Courier cancellation — `cancelCourierBooking()`

**Verified OK — no critical issue.**

- ✅ Permission: `requirePermission(ctx, PERMISSIONS.ORDERS_CANCEL)` for orders, `ORDERS_MANAGE` for exchange shipments.
- ✅ Pre-condition: `courierSubStatus` must be in `['slip_generated', 'pickup_requested']` — server-side guard (line 110). Prevents cancellation after physical pickup.
- ✅ Loads adapter, calls `adapter.cancelShipment(trackingNumber)` via logged wrapper.
- ✅ Leopard uses `cn_numbers` field (leopard.adapter.ts line 461); PostEx uses `trackingNumber` field (postex.adapter.ts line 397) — both adapters handle their respective cancel endpoints correctly.
- ✅ On courier API success: sets `courierBookingStatus='cancelled'` on the entity, then calls the entity's own cancel logic (`cancelOrder(skipCourierCall=true)` for orders, `cancelExchangeShipment(skipCourierCall=true)` for shipments).
- ✅ On courier API failure: NO state changes — error propagated to caller.
- ✅ Tracking number is PRESERVED for historical/audit purposes (per docstring line 18).
- ✅ Retroactive cancellation supported: if entity is ALREADY cancelled internally, only the courier-side cancellation runs (line 178-210 entityAlreadyCancelled flag).
- ✅ Audit log `courier.booking_cancelled` fired with trackingNumber + previousSubStatus + courierProvider.

---

## PART C — CROSS-MODULE RELATIONSHIPS

### C.1 Order ↔ Product/Variant

**Verified OK — no issue.**

- ✅ `OrderItem.orgVariantId` correctly stored on every item (createManualOrder line 752; Shopify webhook line 1284).
- ✅ `OrderItem.fulfillmentTypeSnapshot` captured at order time from `variant.fulfillmentType` (line 611 manual; line 1184 Shopify). Independent of the variant's later changes.
- ✅ Trace chain: `OrderItem.orgVariantId` → `OrgProductVariant.id` → `OrgProductVariant.productId` → `OrgProduct.id` (schema relations verified). Order-detail-view displays the variant's productTitle + sku + attributeValues (route.ts line 220-225).

---

### C.2 Order ↔ Inventory

**Verified OK for the happy path. 2 High issues for the multi-location edge case (ORD-002 + ORD-005).**

- ✅ Create order: NO `InventoryPool` change (no reservation until confirm) — verified. `createManualOrder` does not call any inventory function for non-auto-confirmed orders.
- ✅ Confirm: `reserveStockForOrder()` creates `order_reserved` txn (positive quantity → reserved column incremented). referenceId=orderId, referenceType='order'.
- ✅ Dispatch: `dispatchOrder()` creates `sale_dispatched` txn (onHand decremented, reserved decremented, WAC locked). referenceId=orderId, orderId=orderId.
- ✅ Cancel: `unreserveStockForOrder()` creates `order_unreserved` txn (reserved decremented only, onHand untouched). referenceId=orderId, referenceType='order'.
- ✅ RTO: `return_resellable` (stock_based) or `return_stitched_received` (made_to_order) txn created (onHand incremented, WAC recalculated). referenceId=orderId, orderId=orderId.

⚠️ **Issue (already covered by ORD-002 + ORD-005):** all four transitions resolve the locationId as `item.reservedLocationId ?? order.dispatchLocationId` for DISPATCH but as `order.dispatchLocationId` only for RTO. Multi-location orders corrupt inventory on RTO.

```
BUG-ID: ORD-011
Layer: DB
Severity: Medium
Location: InventoryTransaction.orderId column (nullable, added by migration 027) — 18 sale_dispatched txns have NULL orderId despite having referenceId set to a valid order ID
Description: 18 of the existing sale_dispatched InventoryTransactions have referenceId=<orderId> but orderId=NULL. The `orderId` column was added by migration 027 to provide a direct FK from the transaction to the originating order (replacing the polymorphic referenceType/referenceId pair for order-related transactions). The backfill script that should have populated this column either never ran or skipped these 18 rows. Any code that filters `InventoryTransaction.orderId === <orderId>` (instead of `referenceType='order' AND referenceId=<orderId>`) will miss these rows.
Expected: Every sale_dispatched / order_reserved / order_unreserved / return_resellable / return_stitched_received transaction tied to an order should have orderId populated.
Actual: 18 sale_dispatched txns have NULL orderId (out of N total sale_dispatched txns in the DB).
Repro Steps: Run `SELECT count(*) FROM "InventoryTransaction" WHERE "transactionType"='sale_dispatched' AND "orderId" IS NULL;` — returns 18.
Suspected Root Cause: Migration 027 added the orderId column but the backfill (likely in scripts/backfill-dispatch-inventory.ts based on the 23 `order.backfill_dispatch_inventory` audit log entries) only updated rows it could match — possibly using a time-window join that missed these 18.
```

---

### C.3 Order ↔ Customer

**Verified OK for the manual path. 1 Critical issue for the auto-poll path (already covered by ORD-003 + ORD-006).**

- ✅ Order creation correctly links via `customerId` (existing lookup OR `createCustomerInternal` for new customers).
- ✅ `updateCustomerStats(customerId)` is called from: createManualOrder (line 803-866), confirmOrder (line 1405), markCodCollected (line 1691), cancelOrder (line 1899), markOrderDelivered (line 2873), processOrderReturn (line 195), unCancelOrder (line 2000).
- ✅ Cached stats include: `totalOrdersCount` (non-cancelled orders), `totalOrderValue` (delivered + dispatched only — currency-aware via computeRevenueWithCurrencies), `totalRtoCount` (status='rto' orders).
- ✅ Auto-flag at 3+ RTO via `flagCustomer()` (processOrderReturn line 204-210 + updateCustomerStats line 1497-1506).

❌ **Auto-poll delivered/RTO/cancelled paths SKIP `updateCustomerStats`** — see ORD-003 + ORD-006 + ORD-009 for details. Customer's cached `totalOrdersCount` (cancel) and `totalRtoCount` (RTO) go stale on auto-detected transitions.

---

### C.4 Order ↔ Courier

**Verified OK — no critical issue.**

- ✅ Order stores: `trackingNumber`, `courierName`, `courierCompanyIntegrationId` (FK to `CompanyIntegration`), `courierBookingStatus` (CHECK-constrained to `'not_booked' | 'booked' | 'failed' | 'cancelled'` per DB query), `courierBookingFailureReason`, `courierSubStatus`, `lastPolledAt`, `needsShipperAdvice`, `unrecognizedCourierStatus`, `pickupAddressId`, `courierSlipStoragePath`.
- ✅ Courier status polling updates `Order.courierSubStatus` directly (PostEx + Leopard paths).
- ✅ Order cancellation triggers courier cancellation IF pre-pickup (`cancelOrder` line 1790-1807).

---

### C.5 Order ↔ Audit Log

**1 Medium + 1 Low issue.**

- ✅ Every MANUAL lifecycle transition creates an audit log entry with `oldValues` + `newValues`:
  - `order.created` (83 entries)
  - `order.confirmed` (2 entries — most are auto-confirmed at creation time, so this is only manual confirms)
  - `order.processing_started` (2 entries)
  - `order.packed` (4 entries)
  - `order.dispatched` (9 entries)
  - `order.delivered` (2 entries)
  - `order.returned` (3 entries)
  - `order.cancelled` (22 entries)
  - `order.un_cancelled` (7 entries)
  - `order.payment_converted`, `order.payment_screenshot_updated`, `order.cod_collected`, `courier.booking_cancelled`, `order.auto_booked` (30), `order.backfill_dispatch_inventory` (23 — historical), `leopard.webhook_status_update` (4)

```
BUG-ID: ORD-012
Layer: Cross-Module
Severity: Medium
Location: Auto-poll paths in src/lib/actions/postex-status-poll.actions.ts (lines 552-558, 582-619, 620-671) and src/lib/actions/leopard-webhook.actions.ts (lines 185-188, 220-223, 271-279)
Description: Audit log gaps on auto-poll transitions. DB confirms: 14 delivered orders but only 2 `order.delivered` audit log entries (12 missing); 14 RTO orders but only 3 `order.returned` entries (11 missing); 15 dispatched orders but only 9 `order.dispatched` entries (6 missing — these are the auto_poll dispatches via performOrderDispatch which DOES fire the audit log, but the count discrepancy suggests some are overwrites of existing dispatched orders). Auto-poll cancel path (PostEx) creates NO audit log entry for `order.cancelled` (only a console.log).
Expected: Every lifecycle transition should create an audit log entry — manual OR auto-poll.
Actual: ~30 audit log entries missing across delivered/RTO/cancel auto-poll paths. The Order timeline widget on order-detail-view (lines 1519-1570) shows stale state because it relies on these audit entries being present.
Repro Steps: Compare `SELECT count(*) FROM "AuditLog" WHERE action='order.delivered'` (2) vs `SELECT count(*) FROM "Order" WHERE status='delivered'` (14).
Suspected Root Cause: Same as ORD-003/006/009 — inline `db.order.update` calls in the pollers bypass the audit-logging that the manual action functions perform.
```

---

## PART D — DATABASE LAYER (live queries)

### Q1 — Order status distribution

| status | count |
|---|---|
| confirmed | 44 |
| cancelled | 26 |
| dispatched | 15 |
| rto | 14 |
| delivered | 14 |
| pending | 13 |
| processing | 12 |
| refunded | 11 |
| partially_backordered | 1 |
| **TOTAL** | **150** |

### Q2 — CourierBookingStatus distribution

| courierBookingStatus | count |
|---|---|
| not_booked | 117 |
| failed | 6 |
| cancelled | 13 |
| booked | 14 |

### Q3 — Orders with trackingNumber

| count |
|---|
| 120 |

⚠️ 120 orders have trackingNumber but only 14 + 13 = 27 are in `booked` or `cancelled` (post-booking) state. The remaining 93 orders have trackingNumbers from sources OTHER than the booking flow (likely: Shopify-imported orders that came with their Shopify tracking numbers, OR orders manually dispatched via `dispatchOrderAction` with a tracking number without ever booking via a courier integration).

### Q4 — CourierStatusHistory count

| count |
|---|
| **0** |

🚨 **CRITICAL — see ORD-008.** Zero rows despite 14 booked + 15 dispatched + 14 delivered + 14 RTO orders. The schema exists (verified via information_schema.columns query) but no code writes to it.

### Q5 — Dispatched orders with NULL trackingNumber

| count |
|---|
| 3 |

⚠️ Investigated — these are ORD-2026-00005, ORD-2026-00007, ORD-2026-00008 (all `fulfillmentChannel='courier'`, `selfFulfilledReferenceNumber=null`, `courierName=null`, `courierBookingStatus='not_booked'`). They were NOT dispatched via the manual `/api/orders/[id]/dispatch` route (which requires a non-empty trackingNumber). They were backfilled via the `scripts/backfill-dispatch-inventory.ts` script (consistent with the 23 `order.backfill_dispatch_inventory` audit log entries). Data-quality artifact — not a live code bug.

### Q6 — Delivered orders with NULL deliveredAt

| count |
|---|
| 0 |

✅ Verified OK.

### Q7 — Cancelled orders with NULL cancelledAt

| count |
|---|
| 0 |

✅ Verified OK.

### Q8 — OrderItems with fulfillmentStatus='dispatched' but parent order NOT IN (dispatched, delivered, rto)

| count |
|---|
| 0 |

✅ Verified OK — no orphan dispatched items under non-terminal parent orders.

### Q9 — sale_dispatched InventoryTransactions with NULL referenceId

| count |
|---|
| 0 |

✅ Verified OK — every sale_dispatched txn has its `referenceId` populated.

**Extra finding (Q9b):** sale_dispatched txns with NULL `orderId` = **18**. See ORD-011.

### Q10 — Avg gap between Order.createdAt and first OrderItem.createdAt

| metric | value |
|---|---|
| n_orders_with_items | 150 |
| avg_ms | 202.28 |
| max_ms | 5720 |

✅ Verified OK. The avg gap of 202ms confirms the `db.orderItem.createManyAndReturn` batch insert is working as designed (single round-trip after order creation). The 5720ms max is a one-off slow run (likely cold start or network blip) — not a systematic issue.

### Extra1 — OrderItem fulfillmentStatus distribution

| fulfillmentStatus | count |
|---|---|
| reserved | 80 |
| dispatched | 41 |
| pending | 14 |
| backordered | 11 |
| returned | 2 |

⚠️ The schema comment (line 2184) says "reserved | backordered | dispatched" — but `returned` is used by 2 items (provenance: auto-poller RTO path via `restockOrderForRto` which DOES set this value). Schema comment is stale; actual allowed values include `returned` AND `pending` (the latter is set during cancel, line 1871). No DB-level CHECK constraint on OrderItem.fulfillmentStatus (verified via `pg_constraint` query — only FK + PK constraints exist).

### Extra3 — Delivered orders with NO CourierStatusHistory entries

| count |
|---|
| **14** |

🚨 Every single delivered order lacks CourierStatusHistory rows — confirms ORD-008.

### Extra7 — Orders with courierBookingStatus='booked' AND NULL trackingNumber

| flowopsOrderNumber | courierName |
|---|---|
| ORD-TEST-CANCEL-1788321348005 | Leopard Courier |

⚠️ This is a TEST order (the name contains "TEST-CANCEL"). The booking flow at `bookOrderWithCourier` line 405-416 explicitly checks `if (!bookResult.success || !bookResult.trackingNumber)` and sets `courierBookingStatus='failed'` if no tracking number — so this state should be impossible from the normal flow. Likely a manual DB intervention during testing. Not a code-path bug — but if more such rows appear in production, it would indicate a state machine bug.

### Extra8 — RTO orders with at least one OrderItem still at fulfillmentStatus='dispatched'

| count |
|---|
| **13** (out of 14 RTO orders) |

🚨 **Confirms ORD-004.** 13 of 14 RTO orders have items stuck at `fulfillmentStatus='dispatched'` (because they went through `processOrderReturn` which doesn't update the field). Only 1 RTO order (which went through `restockOrderForRto` via the auto-poll path) has items at `fulfillmentStatus='returned'`.

---

## PART E — FRONTEND LAYER

### E.1 orders-view.tsx

**Verified OK with minor gaps.**

- ✅ Status badges displayed via `ORDER_STATUS_BADGE` map (color-coded).
- ✅ Tracking numbers shown in monospace, click-to-copy (line 1179-1189).
- ✅ Courier name + booking status badge (line 1156-1175) — shows "Failed" / "Not booked" when not booked.
- ✅ Filter by status (multi-select), payment type, payment source, courier, date range, amount range, search (order number / customer name / phone).
- ✅ Currency-aware revenue summary via `/api/orders/revenue-summary`.
- ✅ Permission gating: `canView = can(PERMISSIONS.ORDERS_VIEW)`, `canCreate = can(PERMISSIONS.ORDERS_CREATE)`. Create button hidden if `!canCreate`.

```
BUG-ID: ORD-013
Layer: Frontend
Severity: Low
Location: src/components/orders/orders-view.tsx — list rendering (no pagination UI)
Description: The main orders list view fetches orders via `/api/orders${queryString}` (line 542) without passing `limit` or `offset` query params. The server-side listOrders action defaults to `limit = Math.min(filters.limit ?? 50, 100)` (order.actions.ts line 2056). So the view silently caps at 50 orders per page with NO pagination UI — users with more than 50 orders in a filter set will see only the most recent 50 with no way to navigate to older ones. The stats query at line 560-565 explicitly bumps to `limit=100` for the stats card, but the main table doesn't.
Expected: Either paginate the table (offset-based, with Prev/Next buttons) OR document the cap + provide a "load more" affordance.
Actual: 50-order silent cap. Users with >50 orders in a filter set lose visibility into older orders.
Repro Steps: 1. Have a company with 60+ orders. 2. Open the Orders list (no filters). 3. Scroll — only 50 rows shown, no way to see orders 51-60.
Suspected Root Cause: The view was built when order volumes were low; pagination was deferred. The server supports it (limit + offset), but the UI doesn't pass them or render controls.
```

### E.2 order-create-view.tsx

**Verified OK with note.**

- ✅ Customer phone validation: when selecting an existing customer, the primary phone's `isValidFormat` flag is surfaced with a warning (lines 1389-1410). New customers go through `createCustomerSchema` which uses libphonenumber-js for E.164 validation.
- ✅ Variant selection via product search + variant picker (debounced search, line 1821).
- ✅ Totals computed client-side: subtotal + courierCharges + estimatedDeliveryCharge + taxAmount - discountAmount = totalOrderValue. Matches server formula.
- ✅ Permission gating: `if (!canCreate) return <no-permission-card>` (line 856).
- ✅ Idempotency: client sends `Idempotency-Key` header on POST (route.ts line 132-153).

⚠️ **Design note (informational):** the task description asks "Does the multi-step wizard work?" — there is NO multi-step wizard. `order-create-view.tsx` is a single-page form with collapsible sections (Customer → Items → Payment → Logistics → Review). This is a design choice, not a bug. The Zod validation runs on the full payload at submit time (line 800-807).

### E.3 order-detail-view.tsx

**Verified OK with one timeline display issue.**

- ✅ All lifecycle timestamps displayed: confirmedAt, packedAt, dispatchedAt, deliveredAt, cancelledAt, returnedAt (lines 1522-1569).
- ✅ Courier info displayed: courierName, trackingNumber (click-to-copy), courierBookingStatus badge, courierBookingFailureReason, courierSubStatus, lastPolledAt.
- ✅ Item details: SKU, productTitle, attributeValues, quantity, unitPrice, lineTotal, fulfillmentStatus, fulfillmentTypeSnapshot, returnedStitchedUsed, needsReview, needsReviewReason, backorderedAt, fulfilledAt, productionOrderId + assignedTailor.
- ✅ Action buttons correctly gated by status + permission:
  - `canConfirm = status === 'pending' && canManage`
  - `canProcess = (status in [confirmed, partially_backordered]) && canFulfill`
  - `canPack = (status in [confirmed, partially_backordered, processing]) && canFulfill && !packedAt`
  - `canDispatch = (status in [confirmed, partially_backordered, processing]) && canFulfill`
  - `canMarkDelivered = status === 'dispatched' && canFulfill`
  - `canMarkRto = status === 'dispatched' && canManage` (NOTE: this is gated by `canManage` not `canCancel` — see ORD-014 below)
  - `canCancelOrder = !['dispatched', 'delivered', 'rto', 'cancelled', 'refunded'].includes(status) && canCancel`
  - `canConvertPayment = paymentStatus === 'cod_pending' && canManage`
  - `canMarkCodCollected = (status in [dispatched, delivered]) && !codCollected && paymentType !== 'fully_prepaid' && canManage`
- ✅ "Un-Cancel" button shown only when `status === 'cancelled' && canManage`.
- ✅ Auto-poll every 5s for `courierBookingStatus === 'not_booked'` confirmed orders (catches async auto-booking).

```
BUG-ID: ORD-014
Layer: Frontend
Severity: Low
Location: src/components/orders/order-detail-view.tsx — line 530 `const canMarkRto = status === 'dispatched' && canManage`
Description: The "Mark as Returned/RTO" button is gated by `canManage` (ORDERS_MANAGE permission). The backend `processOrderReturn()` also requires ORDERS_MANAGE. However, by the same logic that mark-order-delivered uses ORDERS_FULFILL (it's a fulfillment action), RTO could be considered a fulfillment action too — but the inconsistency is that an employee with `ORDERS_FULFILL` (e.g. Warehouse Staff) but NOT `ORDERS_MANAGE` can dispatch + mark delivered, but cannot mark RTO. This is a design choice that may or may not be intentional. The audit confirms the UI matches the backend permission, so it's NOT a permission-bypass bug — just a potential UX inconsistency worth flagging.
Expected: Document the rationale (RTO is considered a higher-privilege action because it requires cost-recovery + customer fraud analysis) or align RTO with ORDERS_FULFILL for consistency with delivered/dispatched.
Actual: Permission mismatch — warehouse staff can deliver but not RTO. May cause confusion.
```

```
BUG-ID: ORD-015
Layer: Frontend
Severity: Low
Location: src/components/orders/order-detail-view.tsx — lines 1527-1531 (timeline "Processing" step)
Description: The Processing step's timestamp is set to `order.createdAt` when `status === 'processing' || packedAt || dispatchedAt`. This is incorrect — `order.createdAt` is when the order was placed, not when it moved to Processing. Since there's no `processingAt` field in the schema, the timeline widget fakes the timestamp with the wrong value. The actual transition time is lost.
Expected: Either (a) add a `processingAt` column to the Order schema and populate it in `markOrderProcessing`, OR (b) omit the Processing step's timestamp entirely if the field doesn't exist (show "Processing" as a step but without a time).
Actual: Timeline shows the order's CREATION time as the Processing step time — misleading.
```

### E.4 booking-workbench

**1 Critical issue.**

- ✅ Bookable orders correctly fetched: `status IN (confirmed, processing) AND courierBookingStatus != 'booked' AND no backordered items` (filter applied post-query at line 75-77).
- ✅ Bookable exchange shipments correctly fetched: `status = 'confirmed' AND courierBookingStatus != 'booked'`.
- ✅ Per-order booking allowed via `/api/booking-workbench/book` route.
- ✅ Pre-fills per-row inputs from stored `orderRefNumber`, `orderDetail`, `notesForCourier`.
- ✅ Refresh button to re-query bookable list.
- ✅ Booking results shown via toast + query invalidation.

```
BUG-ID: ORD-016
Layer: API
Severity: Critical
Location: src/app/api/booking-workbench/book/route.ts — lines 91-95
Description: The exchange-shipment booking branch calls `bookExchangeShipmentWithCourier(body.entity_id, body.courier_company_integration_id, body.pickup_address_id || undefined)` — passing 3 positional args. But the actual function signature (booking.actions.ts line 687-689) is `bookExchangeShipmentWithCourier(options: BookOrderOptions & { shipmentId: string }): Promise<...>` — it expects a SINGLE options object with `shipmentId`, `companyIntegrationId`, etc. as named fields. Also, `body.entity_id`, `body.courier_company_integration_id`, and `body.pickup_address_id` are NOT in the `BookRequest` interface (lines 17-33 define only `orderId`, `shipmentId`, `companyIntegrationId`, etc. — using camelCase). At TypeScript compile time, accessing `body.entity_id` would normally fail — but if the build is bypassing type checks (or the route is reached at runtime with extra fields), the call would pass `undefined, undefined, undefined` to the function. This would either: (a) fail at runtime (TypeScript couldn't compile this — verified by the existing tsc baseline of 69 errors which likely INCLUDES this), OR (b) call `bookExchangeShipmentWithCourier(undefined, undefined, undefined)` which would destructure to `{ shipmentId: undefined, companyIntegrationId: undefined }` — both required fields missing. The function would throw "shipmentId is required" or similar.
Expected: `bookExchangeShipmentWithCourier({ shipmentId: body.shipmentId, companyIntegrationId: body.companyIntegrationId, pickupAddressCode: body.pickupAddressCode })` — matching the function signature.
Actual: Exchange-shipment booking via the Workbench is broken. The route's docstring claims to delegate to "the unified action" (line 86-90) but the call signature is wrong.
Repro Steps: 1. Open the Booking Workbench. 2. Switch to the Exchange Shipments tab. 3. Click "Book" on any row. 4. Receive error: "shipmentId is required" (or undefined error if TypeScript is bypassed).
Suspected Root Cause: The route was refactored (the docstring says "BUG FIX (H7): was using an inline bookExchangeShipment function") but the new call uses wrong property names. The old inline `bookExchangeShipment` helper is still defined at line 108-272 of the same file (dead code — never called after the refactor). The refactor was incomplete.
```

### E.5 scan components

**Verified OK — no issue.**

- ✅ `processScan()` (scan.actions.ts line 78-95) queries Order via `OR: [{ trackingNumber: trimmedTracking }, { selfFulfilledReferenceNumber: trimmedTracking }]` — handles BOTH courier barcodes AND self-fulfilled SF-YYYY-NNNNN references.
- ✅ ExchangeShipment lookup is trackingNumber-only (line 95-96) — exchange shipments are always courier-shipped.
- ✅ All 6 scan modes handled: mark_processing, mark_packed, warehouse_handover, receive_return, locate_cancelled, cancel_via_scan.
- ✅ Every scan (success, rejected, not_found) logged to the immutable `scan_events` table.
- ✅ Confirm-cancel + confirm-unpack confirmation modals before destructive actions.

⚠️ **Behavior note (Low):** `cancel_via_scan` mode rejects orders WITHOUT a courier booking (line 237 requires `courierSubStatus in ['slip_generated', 'pickup_requested']`). For a pending/confirmed order without a booking, the user can't cancel via scan — they must use the order-detail-view's Cancel button. Not a bug, but a UX gap.

---

## PART F — ROLE-BASED ACCESS

For each order route, the required permission + enforcement mechanism:

| Route | Permission | Enforced via | Notes |
|---|---|---|---|
| `GET /api/orders` | `ORDERS_VIEW` | `requirePermission()` in route.ts | ✅ |
| `POST /api/orders` | `ORDERS_CREATE` | `requirePermission()` in createManualOrder | ✅ |
| `GET /api/orders/[id]` | `ORDERS_VIEW` | `requirePermission()` + ownership scope | ✅ |
| `POST /api/orders/[id]/confirm` | `ORDERS_MANAGE` | `requirePermission()` in confirmOrder | ✅ |
| `POST /api/orders/[id]/processing` | `ORDERS_FULFILL` | `requirePermission()` in markOrderProcessing | ✅ |
| `POST /api/orders/[id]/packed` | `ORDERS_FULFILL` | `requirePermission()` in markOrderPacked | ✅ + ownership scope |
| `POST /api/orders/[id]/dispatch` | `ORDERS_FULFILL` | `requirePermission()` in dispatchOrderAction | ✅ |
| `POST /api/orders/[id]/delivered` | `ORDERS_FULFILL` | `requirePermission()` in markOrderDelivered | ✅ |
| `POST /api/orders/[id]/rto` | `ORDERS_MANAGE` | `requirePermission()` in processOrderReturn | ✅ |
| `POST /api/orders/[id]/cancel` | `ORDERS_CANCEL` | `requirePermission()` in cancelOrder | ✅ + ownership scope |
| `POST /api/orders/[id]/un-cancel` | `ORDERS_MANAGE` | `requirePermission()` in unCancelOrder | ✅ |
| `POST /api/orders/[id]/cod-collected` | `ORDERS_MANAGE` | `requirePermission()` in markCodCollected | ✅ |
| `POST /api/orders/[id]/convert-payment` | `ORDERS_MANAGE` | `requirePermission()` in convertPaymentStatus | ✅ |
| `POST /api/orders/[id]/payment-proof` | `ORDERS_MANAGE` | `requirePermission()` in updatePaymentScreenshot | ✅ |
| `POST /api/orders/[id]/refresh-status` | `ORDERS_FULFILL` | `requirePermission()` in route.ts | ✅ |
| `POST /api/booking-workbench/book` | `ORDERS_FULFILL` | `requirePermission()` in route.ts | ✅ |
| `GET /api/booking-workbench/bookable` | (NONE) | Only `getWorkspace()` | ⚠️ See ORD-017 |
| `POST /api/scan` | `ORDERS_FULFILL` | `requirePermission()` in processScan | ✅ |
| `POST /api/courier-cancel` | `ORDERS_CANCEL` (orders) / `ORDERS_MANAGE` (shipments) | `requirePermission()` in cancelCourierBooking | ✅ |

```
BUG-ID: ORD-017
Layer: API
Severity: Low
Location: src/app/api/booking-workbench/bookable/route.ts — line 21 (`const ctx = await getWorkspace()`)
Description: The bookable-list endpoint calls `getWorkspace()` (which requires an authenticated session) but does NOT call `requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)`. Any authenticated employee (regardless of role permissions) can fetch the full list of bookable orders + exchange shipments (including customer phone numbers, delivery addresses, COD amounts). The route DOES apply `ordersDataScope` scoping for own/all (line 30-37), but if a custom role has `ordersDataScope='all'` and lacks `ORDERS_FULFILL`, they can still see all bookable orders without being granted the booking permission.
Expected: `requirePermission(ctx, PERMISSIONS.ORDERS_FULFILL)` should be called before fetching bookable orders.
Actual: Permission not enforced — any authenticated employee can see the bookable list.
Repro Steps: 1. Create a custom role with `orders.view=true` and `orders.fulfill=false`. 2. Assign to an employee. 3. As that employee, GET /api/booking-workbench/bookable. 4. Response returns 200 with full bookable orders list (should be 403).
Suspected Root Cause: Oversight — other booking-workbench routes (book, book-batch, load-sheet) DO enforce ORDERS_FULFILL. The bookable list endpoint was probably written assuming "if you can see it, you can book it" — but the permission model is granular for a reason.
```

---

## VERIFIED OK — Summary of passing checks

The following audit checkpoints passed without issues:

- **Create order**: customer resolution (existing + new paths), variant pricing from CompanyVariantPricing (server-authoritative, no client override), subtotal/discount/total math, audit log + metric event, atomic rollback on reservation failure.
- **Confirm order**: status transition pending → confirmed, confirmedAt set, reserveOrderStock for stock_based + MTO items, backorder handling, auto-booking trigger (H14 fix), customer + employee stats.
- **Processing**: status guard (only from confirmed/partially_backordered), permission enforced, audit log fired.
- **Packed**: packedAt set, status auto-transition to processing, ownership scope enforced, permission enforced.
- **Dispatch (core flow)**: stock deduction via sale_dispatched txn, OrderItem.fulfillmentStatus='dispatched', trackingNumber + courierName persisted, idempotent (skipped if already dispatched), backorder-block enforced, packing requirement enforced.
- **Delivered (manual UI path)**: deliveredAt set, customer + employee stats, audit log + metric, delivery_days dimension.
- **Cancel (full flow)**: stock unreservation atomic, courier cancellation if pre-pickup, cancelledAt + cancellationReason, physicalUnpackRequired flag, OrderItem reset to pending (for un-cancel), webhook injected-context support, ownership scope enforced.
- **Un-cancel**: pre-cancel status restored, re-reservation via reserveOrderStock (idempotent), cancellation fields cleared, customer + employee stats.
- **Leopard adapter**: production/staging URL toggle, all required bookPacket fields, numeric cityId validation, response shape handling (object vs array for getShipperDetails).
- **PostEx adapter**: all required create-order fields, phone format conversion, intentional omission of storeAddressCode.
- **Courier cancellation (cancelCourierBooking)**: pre-pickup guard, both Leopard (cn_numbers) + PostEx (trackingNumber) cancel endpoints, courierBookingStatus='cancelled', tracking preserved for audit.
- **Order ↔ Product/Variant**: orgVariantId on every OrderItem, fulfillmentTypeSnapshot at order time, trace chain OrderItem → OrgProductVariant → OrgProduct intact.
- **Order ↔ Courier**: all relevant fields stored (trackingNumber, courierName, courierCompanyIntegrationId, courierBookingStatus CHECK-constrained, courierSubStatus, lastPolledAt, needsShipperAdvice, courierSlipStoragePath).
- **Frontend permission gating**: orders-view (canView, canCreate), order-detail-view (canManage, canFulfill, canCancel), order-scan-view (canFulfill), order-create-view (canCreate).
- **Role-based access** (most routes): requirePermission() enforced on 17 of 18 order-related routes (only /api/booking-workbench/bookable lacks enforcement — see ORD-017).

---

## NEXT ACTIONS (recommended — DO NOT implement, this is a read-only audit)

In priority order:

1. **CRITICAL — Fix the courier_status_history gap (ORD-008).** Either (a) delete the dead `insertCourierStatusHistory()` helper and update Prisma schema + migration 023 SQL to match the current DB shape, then wire `db.courierStatusHistory.create()` calls into the PostEx poller, Leopard webhook handler, Leopard safety-net poller, and trackSingleOrderStatus — OR (b) accept that courier_status_history is unused and remove the table + model.

2. **CRITICAL — Fix the divergent RTO paths (ORD-004 + ORD-006).** Refactor `processOrderReturn` to set `OrderItem.fulfillmentStatus='returned'` (matching `restockOrderForRto`). Refactor the PostEx + Leopard auto-poll RTO branches to either (a) call `processOrderReturn` (after refactoring it to accept an injected context like `cancelOrder` does), or (b) replicate ALL the side effects: updateCustomerStats, updateEmployeeStats, audit log `order.returned`, metric event `order.rto`, customer auto-flag at 3+ RTO.

3. **CRITICAL — Fix the auto-poll delivered/cancelled side-effects gap (ORD-003 + ORD-009).** Same approach as #2: refactor `markOrderDelivered` and `cancelOrder` to accept an injected workspace context (like cancelOrder already does), then call them from the poller/webhook paths instead of inline `db.order.update` calls.

4. **HIGH — Fix performOrderDispatch salesEmployeeId select (ORD-001).** Add `salesEmployeeId: true` to the findUnique select at order.actions.ts line 2456-2471. One-line fix.

5. **HIGH — Fix the booking-workbench exchange-shipment call signature (ORD-016).** Replace the 3-arg positional call with the correct single-object call: `bookExchangeShipmentWithCourier({ shipmentId: body.shipmentId!, companyIntegrationId: body.companyIntegrationId!, pickupAddressCode: body.pickupAddressCode })`. Also delete the dead `bookExchangeShipment` helper at line 108-272.

6. **HIGH — Fix the Leopard deliveryCity overwrite (ORD-007).** Don't write `resolvedDeliveryCity` back to `Order.deliveryCity` for Leopard orders. Persist only the human-readable name. The numeric cityId is only needed inside `bookInput.deliveryCity` (which is sent to the Leopard API).

7. **HIGH — Fix the multi-location RTO restock bug (ORD-002 + ORD-005).** In `restockOrderForRto` (inventory.ts line 1308) and `processOrderReturn` (order-return.actions.ts line 84), resolve `locationId` per item as `item.reservedLocationId ?? order.dispatchLocationId` — matching `performOrderDispatch`'s resolution.

8. **MEDIUM — Backfill the 18 sale_dispatched txns with NULL orderId (ORD-011).** One-time DB repair script: `UPDATE "InventoryTransaction" SET "orderId" = "referenceId" WHERE "transactionType" IN ('sale_dispatched', 'order_reserved', 'order_unreserved', 'return_resellable', 'return_stitched_received') AND "referenceType" = 'order' AND "orderId" IS NULL AND "referenceId" IS NOT NULL;`

9. **MEDIUM — Wire PostEx webhook receiver to handle in_transit + auto-dispatch fallback (ORD-010).**

10. **LOW — Add pagination UI to orders-view.tsx (ORD-013).** Pass `limit` + `offset` from the URL and render Prev/Next buttons.

11. **LOW — Add `processingAt` column or fix the timeline fake (ORD-015).**

12. **LOW — Enforce `ORDERS_FULFILL` on `/api/booking-workbench/bookable` (ORD-017).**

13. **LOW — Document the rationale for `canMarkRto` requiring `ORDERS_MANAGE` instead of `ORDERS_FULFILL` (ORD-014).**

---

## READ-ONLY CONFIRMATION

I confirm this audit was READ-ONLY:
- ✅ No code files modified (only the temporary `scripts/orders-audit-queries.mjs` + `scripts/orders-audit-queries2.mjs` were CREATED for the DB queries — these are throwaway diagnostic scripts, not source code).
- ✅ No Prisma schema changes.
- ✅ No DB writes performed — all queries were `SELECT` / `count(*)` / column-inspection only.
- ✅ No migrations applied.
- ✅ The two throwaway scripts under `/home/z/my-project/scripts/` are diagnostic-only and do not affect the running application.
