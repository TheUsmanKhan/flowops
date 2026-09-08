# Purchase Orders & Production Orders — Complete Recommended Solutions

> This document covers every bug and observation found in the PO & Production Orders audit, with detailed recommended solutions at every level (Backend, API, DB, Frontend) and prevention measures to ensure the same bugs never reoccur.

---

## PO-001 — fulfill-mto Route Has No Permission Check (Critical)

### What's Broken
The `/api/inventory/fulfill-mto` endpoint triggers Made-to-Order fulfillment (fabric consumption + ProductionOrder creation). It has NO `requirePermission()` call — only `getCurrentUser()` checks that the user is logged in. Worse, `company_id` comes from the request body, not from the session, so any authenticated user can trigger MTO for ANY company.

### Recommended Solution

**Backend (API):**
- Replace `getCurrentUser()` with `getWorkspace()` + `requirePermission(ctx, PERMISSIONS.INVENTORY_MANAGE_PRODUCTION)`
- Derive `companyId` from `ctx.company.id` instead of from `body.company_id` — never trust client-supplied company identity
- Remove `company_id` from the Zod schema entirely
```typescript
// BEFORE:
const user = await getCurrentUser()
if (!user) throw new ApiError(401, 'Not authenticated')
const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
const companyId = settings?.activeCompanyId

// AFTER:
const ctx = await getWorkspace()
await requirePermission(ctx, PERMISSIONS.INVENTORY_MANAGE_PRODUCTION)
const companyId = ctx.company.id  // from session, not body
```

**Prevention:**
- Add a lint rule or CI check that greps for `getCurrentUser()` in API routes that don't also call `requirePermission()` — any route using the legacy auth pattern should be flagged
- The `getWorkspace()` function already resolves company from session — body-supplied `company_id` should NEVER be used for authorization decisions

---

## PO-002 — ProductionOrders with NULL orderItemId Lose Stitched Stock (Critical)

### What's Broken
When a ProductionOrder is marked "completed", the auto-stock-on-completion logic only runs if `order.orderItemId` is set. Manual ProductionOrders and exchange-shipment-triggered ones have `orderItemId=NULL`, so the stitched product is never created — fabric is consumed but the output disappears.

### Recommended Solution

**Backend (API):**
- File: `src/app/api/production-orders/[id]/route.ts` — the PATCH handler's completion automation
- Remove the `if (order.orderItemId)` guard around the `opening_stock` + `order_reserved` transactions
- For ALL completed ProductionOrders (regardless of orderItemId):
  1. Create `opening_stock` transaction for the stitched variant at `fabricLocationId`
  2. If `orderItemId` IS set: also create `order_reserved` transaction (links to the order)
  3. If `orderItemId` is NOT set: create `opening_stock` only (stock sits available for future orders)

```typescript
// BEFORE (line ~219):
if (order.orderItemId) {
  // create opening_stock + order_reserved
}

// AFTER:
// ALWAYS create opening_stock for the stitched variant
await processInventoryTransaction({
  orgVariantId: order.stitchedVariantId,
  locationId: order.fabricLocationId,
  organizationId: order.organizationId,
  companyId: order.companyId,
  transactionType: 'opening_stock',
  quantity: order.quantity,
  costPerUnit: Number(order.stitchingCost) + Number(order.fabricCost),
  referenceType: 'production_order',
  referenceId: order.id,
})

// Only create order_reserved if linked to an order item
if (order.orderItemId) {
  await processInventoryTransaction({
    transactionType: 'order_reserved',
    quantity: order.quantity,
    referenceType: 'order_item',
    referenceId: order.orderItemId,
    ...
  })
}
```

**Backend (exchange-shipment flow):**
- File: `src/lib/actions/exchange-shipment.actions.ts`
- When creating ProductionOrders via `checkAndFulfillMadeToOrderVariant`, pass `orderItemId` if available (even if it's the exchange shipment's order item, not the original order's)
- If no orderItemId is genuinely available (standalone production), the completion automation now handles it via the fix above

**DB (data repair for 2 orphaned POs):**
- Backfill: create `opening_stock` transactions for the 2 completed ProductionOrders with NULL `orderItemId`
- Set their `stitchedVariantId` InventoryPool rows with the correct onHand

**Prevention:**
- The completion automation should NEVER have an `orderItemId` guard — it should always create stitched stock
- The `orderItemId` should only control whether an `order_reserved` transaction follows (to auto-reserve for the waiting order)
- Add a DB-level CHECK or trigger that prevents `ProductionOrder.status='completed'` without at least one `opening_stock` transaction for the stitched variant

---

## PO-003 — 3 Stale InventoryPool.incoming=500 Rows (High)

### What's Broken
3 InventoryPool rows have `incoming=500` but zero open PurchaseOrders for those variants. The incoming projection is permanently inflated — warehouse shows "500 incoming" that will never arrive.

### Recommended Solution

**DB (one-time data repair):**
- Reset `incoming=0` for these 3 pools:
```sql
UPDATE "InventoryPool" SET incoming = 0
WHERE id IN ('cms1ns2vu000ptdjo7ool9nsn', 'cms1ns324000rtdjoloh7rt6e', 'cms1ns2k8000ntdjom0zi0gzl')
```
- Write audit log entries for each correction

**Backend (prevention):**
- The current code correctly uses `incrementIncomingStock()` / `decrementIncomingStock()` (INV-007 fix) — this is already prevented for new POs
- Add a weekly reconciliation check (similar to the drift detection in Part 4) that verifies `InventoryPool.incoming = SUM(PO items where status IN ('ordered', 'partially_received') AND unreceived > 0)` — if they don't match, log a drift alert

**Prevention:**
- The `decrementIncomingStock()` call in PO receive and PO cancel is now atomic (via INV-007 fix), so this can't happen for new POs
- The weekly drift detection job (already implemented) should be extended to check `incoming` consistency, not just `reserved`

---

## PO-004 — 4 Legacy fabric_consumed_for_stitching Transactions with NULL referenceId (Medium)

### What's Broken
4 old InventoryTransaction rows have `referenceType='production_order'` but `referenceId=NULL`. The INV-004 fix prevents new orphans, but these 4 historical records remain unlinked.

### Recommended Solution

**DB (one-time backfill):**
- For each of the 4 transactions, find the matching ProductionOrder via `ProductionOrder.fabricTxnId` (reverse link exists) and backfill `referenceId`:
```sql
UPDATE "InventoryTransaction" t
SET "referenceId" = po.id
FROM "ProductionOrder" po
WHERE po."fabricTxnId" = t.id
  AND t."transactionType" = 'fabric_consumed_for_stitching'
  AND t."referenceId" IS NULL
```

**Prevention:**
- Already fixed in code (INV-004) — new transactions always set `referenceId=po.id`
- No additional prevention needed

---

## PO-005 — 2 Legacy ReturnedStitchedInventory Rows with NULL inventoryTxnId (Medium)

### What's Broken
2 old ReturnedStitchedInventory rows have `inventoryTxnId=NULL`. The INV-002 fix prevents new orphans, but these 2 remain unlinked.

### Recommended Solution

**DB (one-time backfill):**
- For each of the 2 rows, find the matching `return_stitched_received` InventoryTransaction (same orgVariantId + locationId + approximate createdAt) and set `inventoryTxnId`:
```sql
UPDATE "ReturnedStitchedInventory" r
SET "inventoryTxnId" = t.id
FROM "InventoryTransaction" t
WHERE t."orgVariantId" = r."orgVariantId"
  AND t."transactionType" = 'return_stitched_received'
  AND t."referenceId" IS NULL
  AND r."inventoryTxnId" IS NULL
  AND r.status = 'available'
```

**Prevention:**
- Already fixed in code (INV-002) — `processReturnedStitchedReceipt()` always sets `inventoryTxnId`
- No additional prevention needed

---

## PO-006 — Cancel Dialog Says Fabric Cannot Be Restored (Medium)

### What's Broken
The cancel-ProductionOrder dialog tells users "Fabric has already been consumed and cannot be restored automatically." But the API DOES restore fabric automatically via `manual_adjustment_in` transaction. Users are misled and avoid cancelling.

### Recommended Solution

**Frontend:**
- File: `src/components/inventory/production-orders-view.tsx`
- Update the AlertDialog description to accurately reflect the behavior:

```tsx
// BEFORE:
<AlertDialogDescription>
  Fabric has already been consumed and cannot be restored automatically.
  Are you sure you want to cancel this production order?
</AlertDialogDescription>

// AFTER:
<AlertDialogDescription>
  Cancelling this production order will automatically return the consumed
  fabric back to inventory. This action cannot be undone.
  Are you sure you want to cancel?
</AlertDialogDescription>
```

**Prevention:**
- UI text should always be verified against actual API behavior — add a comment in the component linking to the API route's reversal logic for future maintainers

---

## PO-007 — Frontend Says "No Manual Creation" But API Allows It (Low)

### What's Broken
The ProductionOrders page header says "Created automatically — no manual creation." But the POST route allows manual creation, and all 3 ProductionOrders in the DB were created manually.

### Recommended Solution

**Option A (Recommended): Remove manual creation from the API**
- File: `src/app/api/production-orders/route.ts`
- Remove the POST handler entirely (or return 405 Method Not Allowed)
- ProductionOrders should only be created via `checkAndFulfillMadeToOrderVariant()` in `inventory.ts` — this is the canonical creation path
- This also prevents PO-002 from occurring for manually-created POs

**Option B: Allow manual creation but fix the completion automation**
- Keep the POST route, update the frontend header text to: "Production orders can be created manually or automatically when made-to-order variants are fulfilled."
- Ensure PO-002 fix handles manual POs correctly (the fix above does)

**Recommendation:** Option A is cleaner — manual creation enables PO-002 and has no UI to support it

---

## PO-008 — No ProductionOrder Detail View (Low)

### What's Broken
There's no drill-down view for individual ProductionOrders. Users can only see summary columns in the list.

### Recommended Solution

**Frontend:**
- Create `src/components/inventory/production-order-detail-view.tsx`
- Register it in `src/app/page.tsx` as `inventory-production-order-detail`
- Fetch data from `GET /api/production-orders/[id]` (route already exists and returns rich data)
- Show: stitched variant details, fabric variant details, fabric location, fabric transaction, stitching cost, fabric cost, total cost, assigned tailor, estimated/actual completion dates, status timeline, audit history
- Make rows in the list view clickable: `navigate({ name: 'inventory-production-order-detail', id: po.id })`

---

## PO-009 — PO and ProductionOrder Detail GET Routes Missing Permission Check (Medium)

### What's Broken
`GET /api/purchase-orders/[id]` and `GET /api/production-orders/[id]` have no `requirePermission()`. Any employee can read full PO/ProductionOrder details including pricing.

### Recommended Solution

**Backend (API):**
- Both routes: replace `getCurrentUser()` pattern with `getWorkspace()` + `requirePermission(ctx, PERMISSIONS.INVENTORY_VIEW)`

```typescript
// BEFORE:
const user = await getCurrentUser()
if (!user) throw new ApiError(401, 'Not authenticated')
const settings = await db.userSetting.findUnique({ where: { userId: user.id } })

// AFTER:
const ctx = await getWorkspace()
await requirePermission(ctx, PERMISSIONS.INVENTORY_VIEW)
```

**Prevention:**
- Same as PO-001: CI check for `getCurrentUser()` in routes without `requirePermission()`

---

## PO-010 — PO Create Doesn't Validate Items Belong to Org (Observation)

### Recommended Solution
- In the PO create route, after parsing the items, validate each `orgVariantId` belongs to the caller's organization:
```typescript
const validVariants = await db.orgProductVariant.findMany({
  where: { id: { in: variantIds }, organizationId: ctx.company.organizationId },
  select: { id: true }
})
if (validVariants.length !== variantIds.length) {
  throw new ApiError(400, 'One or more variants do not belong to your organization.')
}
```

---

## PO-011 — PO Confirm Not Atomic (Observation)

### Recommended Solution
- Wrap the PO status update + `incrementIncomingStock()` loop in `db.$transaction()`:
```typescript
await db.$transaction(async (tx) => {
  await tx.purchaseOrder.update({ where: { id }, data: { status: 'ordered' } })
  for (const item of items) {
    await incrementIncomingStock(...)  // Note: uses db internally — needs tx support
  }
})
```
- If `incrementIncomingStock` doesn't accept a `tx` client, either add that parameter or move the loop to use `tx.inventoryPool.upsert()` directly (matching the pattern already used inside inventory.ts)

---

## PO-012 — PO Receive Allows received_quantity > orderedQuantity (Observation)

### Recommended Solution
- In the receive route, add a validation check before processing each item:
```typescript
const alreadyReceived = item.receivedQuantity
const totalReceived = alreadyReceived + receiptQty
if (totalReceived > item.orderedQuantity) {
  throw new ApiError(400, `Cannot receive ${receiptQty} units — only ${item.orderedQuantity - alreadyReceived} remaining for this item.`)
}
```
- Also add a Zod refinement on the `received_quantity` field to reject 0 and negative values (currently only clamps to >= 0)

---

## PO-013 — PO Cancel Not Atomic (Observation)

### Recommended Solution
- Same as PO-011: wrap the PO status update + `decrementIncomingStock()` loop in `db.$transaction()`

---

## PO-014 — ProductionOrders PATCH Has No Zod Validation (Observation)

### Recommended Solution
- Create a `patchProductionOrderSchema` in `src/lib/validations/inventory.ts`:
```typescript
const patchProductionOrderSchema = z.object({
  status: z.enum(['fabric_reserved', 'in_production', 'completed', 'dispatched', 'cancelled']).optional(),
  assignedTailor: z.string().max(100).optional(),
  estimatedCompletionDate: z.string().datetime().optional().or(z.null()),
  actualCompletionDate: z.string().datetime().optional().or(z.null()),
})
```
- Use it in the PATCH handler: `const parsed = patchProductionOrderSchema.safeParse(body)`

---

## PO-015 — No Pagination on PO List (Observation)

### Recommended Solution
- Add `page` and `pageSize` query parameters to `GET /api/purchase-orders`
- Use Prisma's `skip` and `take` for pagination
- Return `{ orders, total, page, pageSize }` instead of just `{ orders }`

---

## PO-016 — PO Receive Accepts Negative actualCost (Observation)

### Recommended Solution
- Add Zod validation on the `actual_cost` field in the receive schema:
```typescript
actual_cost: z.number().min(0, 'Cost cannot be negative').optional()
```

---

## Summary: Prevention Measures Across All Bugs

### 1. Permission Check Enforcement
**Problem:** Multiple routes use legacy `getCurrentUser()` pattern without `requirePermission()`.
**System-wide fix:** Add a CI script that greps for `getCurrentUser()` in `src/app/api/` routes and flags any that don't also call `requirePermission()`. This catches PO-001, PO-009, and any future routes that forget the check.

### 2. Atomicity for Multi-Step Operations
**Problem:** PO confirm, PO receive, and PO cancel each do multiple writes without `$transaction`.
**System-wide fix:** Any operation that modifies >1 DB row must be wrapped in `db.$transaction()`. Add a code review checklist item: "Is this operation atomic?"

### 3. Body-Supplied Company ID
**Problem:** fulfill-mto trusts `company_id` from the request body.
**System-wide fix:** Never use body-supplied `company_id` for authorization. Always derive from `ctx.company.id` via `getWorkspace()`. Grep for `body.company_id` or `body.companyId` in API routes and flag.

### 4. Completion Automation Guards
**Problem:** ProductionOrder completion only fires when `orderItemId` is set.
**System-wide fix:** Automation should never be gated on a nullable link field. If the automation is needed, it should run unconditionally — the link field should only control additional side effects (like reservation), not the core behavior.

### 5. Legacy Data Backfill
**Problem:** Old records from before code fixes remain orphaned.
**System-wide fix:** After every code fix that changes how links are created, write and run a one-time backfill script. The `correct-drift-pools.ts` pattern should be followed for all future fixes.

### 6. UI Text Accuracy
**Problem:** Cancel dialog says fabric can't be restored, but it can.
**System-wide fix:** UI text that describes API behavior must be verified against the actual code, not assumptions. Add a comment linking to the relevant API route.

### 7. Input Validation Completeness
**Problem:** No validation for received_quantity > ordered, negative costs, etc.
**System-wide fix:** Every Zod schema should include range validation (`.min()`, `.max()`, `.refine()`) for numeric fields. Add a code review checklist item: "Are all numeric inputs range-validated?"
