# Purchase Orders & Production Orders — Plain Language Explanation of Every Issue

> This document explains every issue found in the PO & Production Orders audit in plain language. For each issue: what's broken, what happens in real-world use, what happens to data, and a recommendation.

---

## PO-001 — Anyone Can Trigger Made-to-Order Production (Critical)

### What's Broken
The "fulfill MTO" API endpoint (which triggers fabric consumption + creates a ProductionOrder) has no permission check. Any logged-in user — even a Sales person with zero inventory permissions — can trigger production. Worse, the endpoint accepts a `company_id` from the request body (not from the session), so a user from Company A can trigger production for Company B.

### What Happens in Real-World Use
- A Sales rep accidentally (or intentionally) triggers fabric consumption for a variant they shouldn't touch
- Fabric stock disappears from the wrong company's inventory
- A ProductionOrder appears in a company the user doesn't even belong to
- The warehouse team sees fabric missing but no explanation — no audit trail connects it to the right person

### What Happens to Data
- InventoryPool.onHand decreases for the fabric variant (fabric is consumed)
- A ProductionOrder is created with fabricTxnId linked
- The fabric decrease is REAL and PERMANENT — it's a real inventory transaction
- If triggered for the wrong company, the wrong company's stock is affected

### Recommendation
**Fix immediately.** Replace `getCurrentUser()` with `getWorkspace()` + `requirePermission(INVENTORY_MANAGE_PRODUCTION)`. Remove `company_id` from the request body — always derive it from the session. This is a 5-line fix that closes a critical security hole.

---

## PO-002 — Completed Production Orders Silently Lose Stitched Stock (Critical)

### What's Broken
When you mark a ProductionOrder as "completed", the system is supposed to add the finished stitched product to inventory (create an `opening_stock` transaction). But this only happens if the ProductionOrder is linked to an OrderItem (`order.orderItemId` is set). ProductionOrders created manually or via exchange-shipment flow have `orderItemId=NULL`, so the stitched product is NEVER added to inventory.

### What Happens in Real-World Use
- Tailor stitches 2 suits from fabric (fabric consumed, stock decreased)
- Production order marked "completed"
- The 2 finished suits DON'T appear in inventory
- Warehouse shows: fabric gone, no stitched product available
- When someone tries to order the stitched variant, system says "out of stock" even though 2 suits were just made
- The stitched stock is effectively LOST in the system

### What Happens to Data
- Fabric InventoryPool.onHand: CORRECTLY decreased (fabric was consumed)
- Stitched variant InventoryPool: NEVER CREATED (no opening_stock transaction)
- InventoryTransaction for stitched product: MISSING
- AvgCostHistory for stitched product: MISSING
- The system thinks the stitched variant has zero stock, even though production was completed

### Current DB Evidence
- 2 of 3 ProductionOrders in the database are completed with `orderItemId=NULL`
- Both have ZERO `opening_stock` transactions
- Both have ZERO InventoryPool rows for their stitched variants
- The stitched variants are invisible in inventory views

### Recommendation
**Fix immediately.** Remove the `if (order.orderItemId)` guard — the completion automation should ALWAYS create the `opening_stock` transaction for the stitched variant, regardless of whether an order is linked. If an order IS linked, additionally create an `order_reserved` transaction. If NOT linked, the stock sits available for future orders. Also backfill the 2 orphaned completed ProductionOrders.

---

## PO-003 — 3 Pools Show "500 Incoming" Forever (High)

### What's Broken
3 inventory pools show `incoming=500` but there are ZERO open PurchaseOrders for those variants. This means the "incoming" projection is permanently inflated. The system thinks 500 units are on the way, but they're not.

### What Happens in Real-World Use
- Warehouse dashboard shows "500 units incoming" for 3 SKUs
- Operations team plans around this incoming stock (e.g., "we don't need to order more, 500 is coming")
- The 500 never arrives because there's no PO for it
- Stock runs out unexpectedly — orders can't be fulfilled
- Planning decisions based on false incoming data lead to stockouts

### What Happens to Data
- `InventoryPool.incoming = 500` (should be 0)
- This doesn't affect `onHand` or `reserved` — those are correct
- But the "available + incoming" calculation (used for reorder decisions) is wrong
- The stale `incoming` value persists forever — nothing ever resets it

### Root Cause
These pools were created BEFORE the INV-007 fix (which routes all incoming changes through `incrementIncomingStock()` / `decrementIncomingStock()`). The old code had a path that skipped the decrement when a PO was received or cancelled. The current code is correct, but the historical data was never cleaned up.

### Recommendation
**Fix the data:** Set `incoming=0` for these 3 pools (one-time SQL update + audit log). The weekly drift detection job should be extended to check `incoming` consistency, not just `reserved`.

---

## PO-004 — 4 Old Fabric Consumption Transactions Have No Link Back to ProductionOrder (Medium)

### What's Broken
4 InventoryTransaction records of type `fabric_consumed_for_stitching` have `referenceId=NULL`. This means you can't trace which ProductionOrder caused the fabric consumption. The forward link (ProductionOrder → transaction) works via `fabricTxnId`, but the reverse link (transaction → ProductionOrder) is broken.

### What Happens in Real-World Use
- Auditor asks: "Who consumed 5 meters of fabric on July 14?"
- System can show the transaction exists, but can't link it to a specific ProductionOrder
- The ProductionOrder itself knows its `fabricTxnId`, so you CAN find it by reverse lookup
- But standard "trace from transaction to source" queries fail for these 4 records
- Any report that joins InventoryTransaction to ProductionOrder via `referenceId` will miss these 4

### What Happens to Data
- The transactions themselves are CORRECT (right quantity, right variant, right cost)
- Only the `referenceId` field is NULL (the link is missing)
- No data corruption — just a missing metadata link

### Recommendation
**Backfill the 4 records.** The reverse link (`ProductionOrder.fabricTxnId → InventoryTransaction.id`) exists, so you can set `referenceId = ProductionOrder.id` via a simple UPDATE query. The INV-004 fix already prevents new records from having this problem.

---

## PO-005 — 2 Old Returned-Stitched Records Have No Link to Inventory Transaction (Medium)

### What's Broken
2 `ReturnedStitchedInventory` rows (representing returned stitched items that are available for reuse) have `inventoryTxnId=NULL`. The link between the register row (the returned item) and the ledger entry (the stock movement) is broken for these 2 records.

### What Happens in Real-World Use
- System shows 2 returned stitched items available for reuse
- But the link to the inventory transaction that added them to stock is missing
- If you ask "when was this returned item added to stock?", the system can't answer
- Reconciliation queries that join `ReturnedStitchedInventory` to `InventoryTransaction` will miss these 2 rows
- The items ARE in stock (onHand includes them), but the audit trail is broken

### Recommendation
**Backfill the 2 records.** Find the matching `return_stitched_received` transaction by matching `orgVariantId + locationId + approximate createdAt`, then set `inventoryTxnId`. The INV-002 fix already prevents new records from having this problem.

---

## PO-006 — Cancel Dialog Tells Users Fabric Is Lost (Medium)

### What's Broken
When cancelling a ProductionOrder, the confirmation dialog says: "Fabric has already been consumed and cannot be restored automatically." But this is FALSE — the API DOES automatically restore fabric to inventory on cancel (via a `manual_adjustment_in` transaction). The message hasn't been updated since the fix was added.

### What Happens in Real-World Use
- User wants to cancel a production order (e.g., wrong fabric was selected)
- Dialog says "fabric can't be restored" — user thinks it's permanent
- User decides NOT to cancel, leaving a wrong production order in progress
- Wrong fabric continues to be consumed, wrong product gets stitched
- All because the user was afraid of "losing" the fabric

### Recommendation
**Fix the message.** Update to: "Cancelling this production order will automatically return the consumed fabric back to inventory. This action cannot be undone." Simple text change, no logic change needed.

---

## PO-007 — Frontend Says "No Manual Creation" But API Allows It (Low)

### What's Broken
The Production Orders page header says "Created automatically — no manual creation." But the POST API route allows manual creation. All 3 ProductionOrders in the database were created manually (not via the order MTO flow).

### What Happens in Real-World Use
- User reads "no manual creation" and assumes they can't create one
- But the API accepts manual creation, and tools like Postman or curl can create them
- Manual ProductionOrders have `orderItemId=NULL`, which triggers PO-002 (stitched stock lost on completion)
- The mismatch between what the UI says and what the API does creates confusion

### Recommendation
**Option A (Recommended):** Remove the POST handler from the API — only allow automated creation via `checkAndFulfillMadeToOrderVariant()`. This eliminates PO-002 for manual POs entirely.

**Option B:** Keep the POST route but update the frontend text and ensure PO-002 fix handles manual POs correctly.

---

## PO-008 — No Production Order Detail View (Low)

### What's Broken
There's no drill-down page for individual ProductionOrders. The list view only shows summary columns. Users can't see fabric transaction details, stitching costs, completion timeline, or audit history for a specific production order.

### What Happens in Real-World Use
- User sees a completed production order in the list
- Wants to know: "How much fabric was consumed? What was the stitching cost? Who completed it?"
- Can't click through to a detail page — only dropdown actions are available
- Has to query the database directly to get details
- The GET `/api/production-orders/[id]` route exists and returns rich data, but no UI consumes it

### Recommendation
Create a `production-order-detail-view.tsx` component that fetches from the existing GET route and displays: stitched variant details, fabric variant details, fabric location, fabric transaction, costs, timeline, audit history.

---

## PO-009 — PO and Production Order Detail Pages Accessible to All Employees (Medium)

### What's Broken
The GET detail routes for PurchaseOrders and ProductionOrders have no `requirePermission()` check. Any employee in the company (even a Sales person with no inventory permissions) can read full PO/ProductionOrder details including supplier pricing, fabric costs, and stitch costs.

### What Happens in Real-World Use
- Sales rep can see exactly how much you pay suppliers for fabric
- Sales rep can see stitching costs and profit margins
- Competitor (if they had an employee account) could see your entire supply chain pricing
- The list endpoints correctly block them (403), but the detail endpoints don't — a user who knows a PO ID can fetch full details

### Recommendation
**Fix:** Add `requirePermission(ctx, PERMISSIONS.INVENTORY_VIEW)` to both detail GET routes. Replace the legacy `getCurrentUser()` pattern with `getWorkspace()`.

---

## PO-010 — PO Create Doesn't Validate Items Belong to Org (Observation)

### What's Broken
When creating a PurchaseOrder, the system doesn't validate that the variant IDs in the items list actually belong to the caller's organization. A user could pass a variant ID from a different organization.

### What Happens in Real-World Use
- User accidentally pastes a variant ID from a different org
- PO is created with an item pointing to a variant that doesn't belong to their org
- When the PO is received, stock is added to the wrong variant in the wrong org
- Inventory numbers for both orgs become incorrect

### Recommendation
Add a validation check: fetch all variant IDs from the org before creating the PO. Reject if any don't match.

---

## PO-011 — PO Confirm Is Not Atomic (Observation)

### What's Broken
When confirming a PurchaseOrder (draft → ordered), the system updates the PO status FIRST, then loops through items calling `incrementIncomingStock()` one by one. If the loop fails halfway (e.g., database error on item 3 of 5), the PO is marked "ordered" but only items 1-2 have incoming projections.

### What Happens in Real-World Use
- PO with 5 items is confirmed
- Items 1-2 get incoming projections (500 each)
- Item 3 fails (database error)
- Items 4-5 never get incoming projections
- PO shows as "ordered" but warehouse only sees 1000 incoming instead of 2500
- When items 4-5 are received, the system can't decrement incoming (it was never set)

### Recommendation
Wrap the PO status update + all `incrementIncomingStock()` calls in `db.$transaction()`.

---

## PO-012 — PO Receive Allows Receiving More Than Ordered (Observation)

### What's Broken
The receive endpoint doesn't validate that `received_quantity + already_received <= ordered_quantity`. A user could receive 100 units of an item that was only ordered for 50.

### What Happens in Real-World Use
- PO orders 50 shirts
- Warehouse receives 100 (supplier sent extra)
- System accepts all 100, marks PO as "received"
- InventoryPool.onHand increases by 100 (instead of 50)
- The extra 50 units appear in inventory but have no PO justification
- If supplier bills for 100, finance sees a mismatch with the PO

### Recommendation
Add validation: `if (totalReceived > orderedQuantity) return 400 ("Cannot receive more than ordered")`.

---

## PO-013 — PO Cancel Is Not Atomic (Observation)

### What's Broken
Same pattern as PO-011 — PO status update + `decrementIncomingStock()` loop is not wrapped in a transaction. If the loop fails halfway, the PO is cancelled but some items still show incoming.

### Recommendation
Wrap in `db.$transaction()`.

---

## PO-014 — Production Order PATCH Has No Zod Validation (Observation)

### What's Broken
The PATCH endpoint for ProductionOrder status updates uses `readBody<{...}>()` (TypeScript-typed but not runtime-validated). A user could send unexpected fields or invalid enum values.

### Recommendation
Create a `patchProductionOrderSchema` with Zod and use it in the handler.

---

## PO-015 — No Pagination on PO List (Observation)

### What's Broken
The PO list endpoint returns a maximum of 50 records with no pagination support. For organizations with many POs, older records silently disappear from the list.

### What Happens in Real-World Use
- Company has 200 POs
- User opens PO list — sees only the latest 50
- Older POs are invisible without any warning
- User thinks POs are missing/deleted

### Recommendation
Add `page` and `pageSize` query parameters with proper pagination metadata in the response.

---

## PO-016 — PO Receive Accepts Negative Cost (Observation)

### What's Broken
The receive endpoint accepts negative values for `actual_cost`. A user could enter -500 as the cost per unit, which would create an inventory transaction with negative cost, corrupting the weighted average cost calculation.

### Recommendation
Add `.min(0)` validation on the `actual_cost` field in the Zod schema.

---

## Summary: What to Fix First

| Priority | Bug | Impact if not fixed |
|----------|-----|---------------------|
| **Fix NOW** | PO-001 | Security: anyone can consume fabric, trigger production for any company |
| **Fix NOW** | PO-002 | Data loss: stitched products disappear from inventory on completion |
| **Fix NOW** | PO-003 | Wrong data: "500 incoming" forever for 3 SKUs |
| **Fix soon** | PO-009 | Security: anyone can see supplier pricing and fabric costs |
| **Fix soon** | PO-006 | UX: users afraid to cancel production orders |
| **Fix when convenient** | PO-004, PO-005 | Legacy data: 6 old records with missing links |
| **Fix when convenient** | PO-007, PO-008 | UX: frontend/API mismatch, no detail view |
| **Fix when convenient** | PO-010-016 | Validation gaps, atomicity, pagination |
