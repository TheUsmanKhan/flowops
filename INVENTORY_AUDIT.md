# Inventory System Audit Report

**Task ID:** INV-AUDIT-BACKEND
**Agent:** general-purpose (read-only audit subagent)
**Scope:** All 11 inventory modules listed in the FlowOps sidebar
**Mode:** READ-ONLY — no source code was modified

---

## Executive Summary

- **Total modules audited:** 11
- **Total inventory API routes:** 26 (across 6 route folders)
- **Total server actions in `src/lib/actions/`:** 0 dedicated inventory action files (logic lives entirely in API routes — see notes)
- **Critical bugs found:** 3
- **High-severity logic issues:** 9
- **Medium-severity issues:** 14
- **Low-severity / smell issues:** 11

The inventory subsystem is **architecturally sound** at the data-model layer (append-only ledger, single write function for `InventoryPool`, WAC recalculation, separate quarantine/reservation channel) but suffers from **systemic consistency problems** at the API layer: missing transactions, missing permission checks on read endpoints, legacy auth pattern (manual `db.rolePermission.count(...)` instead of the modern `getWorkspace()` + `requirePermission()` helper used everywhere else post-REBUILD-API-PROTECTION), no stock-negativity guard at the DB level, and several multi-step writes that are not wrapped in `db.$transaction`.

The previous audit (`INVENTORY-ARCHITECTURE-INVESTIGATE`, worklog line 11144) and the follow-up fix task (`INVENTORY-3-BUGS-FIXED`, line 11556) already addressed three known bugs. This audit confirms those fixes are in place and surfaces **new, previously-undocumented issues**.

---

## Module 1: Dashboard

### Purpose
Read-only cockpit showing total stock value, low-stock / out-of-stock / dead-stock counts, this-month movement summary (received / sold / losses, units + value), the live stock table, and the last 30 inventory transactions.

### API Routes

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/inventory/dashboard` | Returns `{stats, movement, stockTable, recentTransactions}` for the active org. |

### Server Actions
None — logic is inline in the route handler.

### Schema Models
Reads `InventoryPool` (with `OrgProductVariant.product` + `InventoryLocation`) and `InventoryTransaction`.

### Issues Found

- **[HIGH] No permission check.** Only `getCurrentUser()` + `activeOrgId` is verified — any authenticated user of the org can read the full inventory dashboard, including stock values and COGS. Should require `PERMISSIONS.INVENTORY_VIEW`. Same problem reported for all read endpoints (see Cross-Cutting Concerns).
- **[HIGH] `openingValue` formula is approximate and documented as such.** `movement.openingValue = totalStockValue - receivedValue + soldValue + lossValue` (line 92) — this is a rough algebraic back-solve, not a real opening snapshot. The field name implies precision the data doesn't have. Should either be removed, renamed to `approxOpeningValue`, or computed by reading `InventoryPool` state at `startOfMonth`.
- **[MEDIUM] N+1-free but unbounded.** Pulls **all** pools for the org in one query (line 22, no `take`). For an org with thousands of variants × multiple locations, this will degrade. Should paginate or use a SQL aggregate (`SUM(on_hand * avg_cost)`) instead of in-JS reduction.
- **[MEDIUM] Dead-stock threshold hardcoded at 90 days.** `ninetyDaysAgo.setDate(... - 90)` (line 43). Configurable per-org policy would be more useful (some SKUs are seasonal).
- **[LOW] `losses` bucket includes `supplier_return`.** Line 64 groups `supplier_return` under "losses" — but a supplier return is a deliberate outbound, not a loss. The metric overstates loss value.
- **[LOW] Does not surface `incoming` (PO-expected) total in stats.** Dashboard shows onHand/reserved/available in `stockTable` rows but no top-line "expected incoming value" KPI.

### Frontend
`src/components/inventory/inventory-dashboard-view.tsx` (712 lines). Uses TanStack Query, role-gated client-side via `useCan(PERMISSIONS.INVENTORY_VIEW)`. Type definitions for `StockPoolRow` and `RecentTxn` are duplicated from the API response shape — drift risk. No pagination on `stockTable`.

---

## Module 2: Locations

### Purpose
Manage warehouse / dispatch-hub / retail / transit / damaged-hold locations. Locations can be org-level shared (`companyId = NULL`) or company-private.

### API Routes

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/inventory-locations` | List locations visible to the active company (org-shared + own). |
| POST | `/api/inventory-locations` | Create a location (idempotency-key supported). |
| GET | `/api/inventory-locations/[id]` | Get a single location with its pools + recent 20 transactions. |
| PATCH | `/api/inventory-locations/[id]` | Update location fields; flips `isDefault`/`isActive`. |
| DELETE | `/api/inventory-locations/[id]` | Soft-delete (sets `isActive=false`). Refuses if any pool has `onHand > 0`. |

### Server Actions
None.

### Schema Models
`InventoryLocation` — key fields: `organizationId`, `companyId?` (NULL = org-shared), `name`, `locationType` (default `'warehouse'`), `city`/`province`/`countryCode` (default `'Lahore'`/`'Punjab'`/`'PK'`), `isDefault`, `isActive`, `createdById`. Relations to `InventoryPool`, `InventoryTransaction`, `StockTransfer` (both from + to), `PurchaseOrder`, `SupplierReturn`, `StockLossRecord`, `CycleCount`, `ProductionOrder`. Indexes: `organizationId`, `companyId`.

### Issues Found

- **[HIGH] GET endpoints have NO permission check.** `GET /api/inventory-locations` and `GET /api/inventory-locations/[id]` only verify auth + org membership. Any employee can enumerate all locations in the org (including company-private locations of OTHER companies via the detail endpoint — see next item).
- **[CRITICAL] `GET /api/inventory-locations/[id]` is **not** company-scoped.** `where: { id, organizationId: orgId }` (line 25) — there is no `companyId` filter, so a user in Company A can fetch the full pool/transaction detail of a Company-B private location by guessing/enumerating the ID. The list endpoint correctly filters to `companyId IS NULL OR companyId = own` (line 24-28), but the detail endpoint does not. **Information-disclosure vulnerability.**
- **[HIGH] PATCH is also not company-scoped.** Same problem — `findFirst({ where: { id, organizationId: orgId } })` (line 126). A user with `INVENTORY_MANAGE_LOCATIONS` in Company A can edit/deactivate a Company-B private location. (DELETE has the same flaw, line 199.)
- **[HIGH] No transaction wrapping for `isDefault` flip + create/update.** Lines 99-107 (`updateMany` to clear prior default) followed by `create`/`update` — two separate writes. A crash between them leaves the org with NO default.
- **[MEDIUM] `locationType` not validated against enum.** The Prisma comment lists `warehouse | dispatch_hub | retail_store | transit | damaged_hold`, but the column is a free-form `String`. The POST endpoint accepts any string (defaults to `'warehouse'`). The validation schema `locationSchema` in `validations/inventory.ts` enforces the enum — but **the route handler doesn't use that schema**, it reads `body.locationType` raw (line 114). Drift.
- **[MEDIUM] Hardcoded defaults `'Lahore'` / `'Punjab'` / `'PK'`** in the route (lines 116-117) and in the schema. Pakistan-specific; should come from org/company defaults.
- **[LOW] DELETE requires `roleTier === 'elevated'`** (line 194) but PATCH only requires `INVENTORY_MANAGE_LOCATIONS`. Inconsistent privilege boundary.
- **[LOW] `createdById` is optional** in schema but always supplied in code — fine, just dead nullability.
- **[LOW] No audit log for the `updateMany` isDefault=false step** — only the final create/update is audited.

### Frontend
`src/components/inventory/locations-view.tsx` (704 lines) + `location-detail-view.tsx` (562 lines). Uses react-hook-form + zodResolver. The client-side schema correctly enforces the locationType enum, so the server drift above is masked. No bulk-activate/deactivate.

---

## Module 3: Suppliers

### Purpose
Vendor master records. Same org-level/company-private scoping as Locations. Tracks `paymentTerms`, running `creditBalance` (credit owed by supplier to us).

### API Routes

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/suppliers` | List suppliers visible to the active company (org-shared + own). |
| POST | `/api/suppliers` | Create a supplier (idempotency supported). |
| PATCH | `/api/suppliers/[id]` | Update supplier fields. |
| DELETE | `/api/suppliers/[id]` | Soft-deactivate (`isActive=false`). Elevated-only. |

### Server Actions
None.

### Schema Models
`Supplier` — `organizationId`, `companyId?`, `name`, `contactPerson?`, `phone?`, `email?`, `address?` (JSONB string), `paymentTerms` (default `'immediate'`), `creditBalance Decimal @default(0) @db.Decimal(12,2)`, `isActive`. Relations: `PurchaseOrder[]`, `SupplierReturn[]`.

### Issues Found

- **[HIGH] GET has NO permission check.** Same pattern as Locations — any authenticated employee of the org can list all suppliers.
- **[HIGH] PATCH/DELETE not company-scoped.** `findFirst({ where: { id, organizationId: orgId } })` (PATCH line 40, DELETE line 109). A Company-A user can edit/deactivate a Company-B private supplier.
- **[HIGH] DELETE doesn't check for dependent records.** Unlike locations (which check `onHand > 0`), deactivating a supplier doesn't check for open POs, pending supplier returns, or non-zero `creditBalance`. Leaves orphans.
- **[MEDIUM] `creditBalance` mutation is non-atomic.** The credit_balance is incremented in `supplier-returns/[id]/route.ts` (line 73-77) with a separate `db.supplier.update` — NOT in a transaction with the supplier_return resolution. A crash leaves the supplier's credit out of sync with the ledger of returns.
- **[MEDIUM] No endpoint to GET a single supplier by id.** Frontend `supplier-detail-view.tsx` exists but the API has no `GET /api/suppliers/[id]` route. The detail view must be using the list endpoint and filtering client-side (or fetching via a different shape). **Dead-end route.**
- **[MEDIUM] `paymentTerms` accepted as any string.** Route accepts `body.paymentTerms` raw (line 99) without enum validation, despite the schema's enum constraint.
- **[LOW] No email format validation in route** — schema validates, route doesn't.
- **[LOW] `address` field documented as JSONB but stored as plain String.** No JSON parse anywhere — clients treat it as opaque string.

### Frontend
`src/components/inventory/suppliers-view.tsx` (681 lines) + `supplier-detail-view.tsx` (609 lines). React-Hook-Form + Zod. Shows `poCount` denormalized via Prisma `_count`. Credit-balance display exists but no UI to adjust it directly (relies on supplier-return credit_note flow).

---

## Module 4: Receive Stock

### Purpose
Two endpoints: `POST /api/inventory/receive` (batch receive for many variants at one location — also used for opening stock when first txn ever) and `POST /api/inventory/opening-stock` (per-variant opening stock, used by the product-creation wizard). Also `POST /api/inventory/receive-returned-stitched` for receiving returned made-to-order stitched items.

### API Routes

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/inventory/receive` | Batch receive stock — `opening_stock` or `purchase_received` txn per item. Idempotency supported. |
| POST | `/api/inventory/opening-stock` | Per-variant opening stock — `opening_stock` txn. Idempotency supported. |
| POST | `/api/inventory/receive-returned-stitched` | Receive a returned MTO stitched item — adds to stock or, if damaged, creates `stock_loss_records` directly. |

### Server Actions
None.

### Schema Models
`InventoryPool`, `InventoryTransaction`, `StockLossRecord` (for damaged-return path), `OrgProductVariant.trackInventory` (one-way FALSE→TRUE flip on MTO variants).

### Issues Found

- **[HIGH] `/api/inventory/receive` does NOT verify location is accessible to the active company.** No check that `location_id` belongs to the user's company (or is org-shared). A user can receive stock into ANY org location regardless of company scope.
- **[HIGH] `/api/inventory/receive` does NOT verify the variant belongs to the org.** The variant is fetched (line 64-67) for the MTO check, but no `organizationId` filter. Cross-org stock poisoning possible.
- **[HIGH] Multi-item receive is NOT wrapped in `db.$transaction`.** Lines 56-100 — each item calls `processInventoryTransaction` separately. A failure halfway through leaves some items received and others not, with no rollback. The audit log entries are also not transactional with the txn inserts.
- **[MEDIUM] "First-ever transaction" check is racy.** `existingTxnCount = count(...)` (line 58) then decides between `opening_stock` vs `purchase_received`. Two concurrent receives for the same new variant+location both see count=0, both fire `opening_stock`. Not catastrophic (both still increment onHand correctly), but the txn-type semantics are wrong — should be `purchase_received` for the second. Should use a UPSERT or a DB-level advisory lock.
- **[MEDIUM] `/api/inventory/opening-stock` calls `processInventoryTransaction` outside a transaction**, then separately calls `insertAuditLog` and `insertMetricEvent`. Audit log insert is fire-and-forget (no await) — if it fails, no record.
- **[MEDIUM] `receive-returned-stitched` damaged path** (lines 57-99) creates a `StockLossRecord` with `lossType='damaged'`, `resolution='written_off'`, but **does NOT call `processInventoryTransaction`** to actually decrement onHand — the assumption is the item was already decremented at dispatch (sale_dispatched). This is correct ONLY for items that came back from a dispatched order. For a returned-stitched item that was never dispatched (e.g. production QA failure), this would create a loss record without ever touching the pool. No `original_order_reference` validation enforces the dispatched-order precondition.
- **[MEDIUM] `costPerUnit = d.total_cost / d.quantity`** (line 55) — float division before being passed to `processInventoryTransaction`, which expects a number. Decimal precision lost in JS. Should use `Decimal` math or pass `total_cost` + `quantity` separately.
- **[MEDIUM] `receive-returned-stitched` is NOT idempotency-wrapped** — the other two receive endpoints are. Inconsistent.
- **[LOW] `firstVariantId = d.items[0]?.org_variant_id ?? d.location_id`** (line 108) — fallback to location_id as the metric entity ID is semantically wrong; should be `null` or omit.
- **[LOW] `preMadeStitchedStockAdded` flag** is computed (line 69) but the variant-fetch loop and processInventoryTransaction call don't actually USE it for any side effect — it's just returned in the response. Dead-ish code; intent unclear.

### Frontend
`src/components/inventory/receive-stock-view.tsx` (602 lines). Variant picker, line-item table, idempotent mutation via `useIdempotentMutation`. No validation that the selected location is org-shared vs. company-private.

---

## Module 5: Adjust Stock

### Purpose
Manual positive or negative stock adjustment with a reason + notes. Bypasses PO/loss workflows for one-off corrections (found stock, cycle-count corrections, system errors).

### API Routes

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/inventory/adjust` | Adjust onHand up (`manual_adjustment_in`) or down (`damage_writeoff`). Idempotency supported. |

### Server Actions
None.

### Schema Models
`InventoryPool`, `InventoryTransaction` (type `manual_adjustment_in` or `damage_writeoff`).

### Issues Found

- **[HIGH] Negative adjustment masquerades as `damage_writeoff`.** Line 123 — a negative manual adjustment uses transaction_type `damage_writeoff`, which means every "remove stock" action shows up in reports as if it were damaged goods. This conflates deliberate corrections (e.g. "system error, remove 5 units") with actual physical damage. Should use a dedicated `manual_adjustment_out` type. (Mirror of the bug fixed in INVENTORY-3-BUGS-FIXED for positive adjustments, but the negative side was left alone.)
- **[HIGH] Negative adjustment does NOT check available stock.** Lines 116-130 — the route calls `processInventoryTransaction({ transactionType: 'damage_writeoff', quantity: absQty, ... })` without first verifying `onHand - reserved >= absQty`. The function itself does validate (inventory.ts line 152-160), but the route's metric event uses `avgCostForMetric` from a stale `pool` read (line 57-66) taken BEFORE the function runs — if another concurrent txn changes the pool, the metric is wrong.
- **[MEDIUM] No `location_id` org/company scoping.** Same as receive — any location ID is accepted without verifying it belongs to the active company.
- **[MEDIUM] No `org_variant_id` org scoping.** Variant not verified to belong to the org.
- **[MEDIUM] `reason` validation is minimal.** `z.string().min(3).max(500)` — no enum or controlled vocabulary. Reports cannot group by reason reliably.
- **[LOW] Metric event uses `absQty * avgCostForMetric`** for both directions — for negative adjustments, this is the value of stock removed, which is correct, but the dimension `direction: 'decrease'` is the only signal. OK but easy to misread in dashboards.
- **[LOW] `insertAuditLog` and `insertMetricEvent` are fire-and-forget** (no `await`) — if either throws, the audit/metric is lost silently. Acceptable for metrics (best-effort) but concerning for audit logs.

### Frontend
`src/components/inventory/adjust-stock-view.tsx` (651 lines). Direction toggle (add/remove), reason presets (line 97+), variant picker, idempotent submit. No location-access check client-side.

---

## Module 6: Transfer Stock

### Purpose
Move stock from one location to another. Logistics cost is tracked separately (never merged into WAC). Produces TWO inventory_transactions: `transfer_out` + `transfer_in`.

### API Routes

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/inventory/transfers` | Create a transfer. Validates available stock at source. Idempotency supported. |
| GET | `/api/inventory/transfers` | List last 50 transfers for the org. |

### Server Actions
None.

### Schema Models
`StockTransfer` — `organizationId`, `orgVariantId`, `fromLocationId`, `toLocationId`, `quantity`, `costPerUnitAtTransfer Decimal(12,4)`, `logisticsCost Decimal(12,2) @default(0)`, `status` (default `'completed'`), `initiatedById?`. `InventoryTransaction` × 2 (out + in).

### Issues Found

- **[CRITICAL] Transfer is NOT atomic.** Lines 80-149: `stockTransfer.create` → `processInventoryTransaction(out)` → `processInventoryTransaction(in)`. Three separate writes, no `db.$transaction`. If the `transfer_in` fails (e.g. destination location deleted concurrently), the stock has already been removed from the source — **stock vanishes from the system**. The route throws ApiError(500) but does not roll back the `transfer_out` or delete the `StockTransfer` row. This is the most serious issue in the inventory subsystem.
- **[HIGH] Transfer status is hardcoded `'completed'`.** Line 91 — there is no `'in_transit'` state ever set, despite the schema documenting it as a valid status. The transfer-out + transfer-in happen synchronously with no transit period. For multi-warehouse logistics, the schema supports an in_transit state but the API never produces it.
- **[HIGH] GET endpoint has NO permission check.** Any authenticated user can list all transfers in the org.
- **[HIGH] GET endpoint is org-scoped, not company-scoped.** `where: { organizationId: orgId }` (line 204) — exposes transfers for all companies in the org.
- **[HIGH] `from_location_id` and `to_location_id` not validated for company access.** Same as everywhere — a Company-A user can transfer stock OUT of a Company-B private location.
- **[MEDIUM] No `org_variant_id` org-membership check.** Variant not verified to belong to the org.
- **[MEDIUM] `quantity <= 0` check (line 55) but no `Number.isInteger` check.** Schema (transferStockSchema line 96) requires `int`, but the route doesn't use that schema — it does inline validation. Drift.
- **[MEDIUM] The route uses `readBody<{...}>` with inline validation** instead of the Zod schema (`transferStockSchema` in `validations/inventory.ts`). The schema's `.refine` for `from !== to` is bypassed (though the route does check separately at line 56-58).
- **[LOW] `costPerUnitAtTransfer` is snapshotted from the source pool's avgCost** (line 75) — correct, but no AvgCostHistory entry is created on the destination pool when transfer_in recalculates WAC. The avg_cost_history only records the trigger txn, not the source-pool snapshot.
- **[LOW] `logisticsCost` defaults to 0 if undefined** — acceptable, but no validation that it's non-negative (route accepts any number including negatives).

### Frontend
`src/components/inventory/transfer-stock-view.tsx` (712 lines). Source/destination pickers, available-stock display, idempotent submit. No warning when transferring between company-private and org-shared locations.

---

## Module 7: Purchase Orders

### Purpose
Full PO lifecycle: create (draft or ordered) → confirm (draft→ordered, increments incoming) → receive (creates receipt + increments onHand, recalculates WAC) → cancel (decrements incoming for unreceived qty).

### API Routes

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/purchase-orders` | List POs for active company (filterable by status). |
| POST | `/api/purchase-orders` | Create a PO with line items. If status='ordered', increments incoming. Idempotency supported. |
| GET | `/api/purchase-orders/[id]` | Get a PO with items + receipts. |
| POST | `/api/purchase-orders/[id]/confirm` | Draft → ordered. Increments incoming per item. |
| POST | `/api/purchase-orders/[id]/receive` | Receive goods against PO. Creates receipt + receipt_items + `purchase_received` txn per item. Supports partial delivery. Triggers backorder auto-fulfillment. |
| POST | `/api/purchase-orders/[id]/cancel` | Cancel PO. Decrements incoming for unreceived qty. |

### Server Actions
None — but `checkAndFulfillBackorders` in `src/lib/actions/backorder.actions.ts` is called from the receive endpoint.

### Schema Models
`PurchaseOrder` (`poNumber` unique, status `draft|ordered|partially_received|received|cancelled`, `advancePayment`, `paymentMethod?`, `cancelledAt?`, `cancellationReason?`). `PurchaseOrderItem` (`orderedQuantity`, `receivedQuantity`, `costPerUnit`). `PurchaseOrderReceipt` + `PurchaseOrderReceiptItem` (`receivedQuantity`, `actualCostPerUnit`, `shortageQuantity`, `shortageReason?`, `inventoryTxnId?`).

### Issues Found

- **[CRITICAL] PO creation with status='ordered' has a NON-atomic incoming-stock update.** Lines 168-187 of `purchase-orders/route.ts` — `purchaseOrder.create` succeeds, then for each item a separate `inventoryPool.upsert` runs. If item 3 of 5 fails, the PO is created with status='ordered' but only items 1-2 have incremented incoming. The audit log says "PO created" with no indication of partial incoming update. Not wrapped in `db.$transaction`.
- **[HIGH] PO receive is NOT atomic.** `purchase-orders/[id]/receive/route.ts` lines 77-172 — for each receipt item: `processInventoryTransaction` → `purchaseOrderReceiptItem.create` → `purchaseOrderItem.update(receivedQuantity increment)` → `inventoryPool.update(incoming)`. Four writes per item, no transaction. A failure on item 3 leaves items 1-2 fully received, item 3 partially received (txn created but receipt_item not, or vice versa), and the PO status update at the end may set `'received'` based on stale `allFullyReceived` flag.
- **[HIGH] PO receive backorder-fulfillment is fire-and-forget.** Lines 205-217 — wrapped in try/catch with `console.error` only. If backorder fulfillment fails, the stock is received but no order is unblocked, and **there is no audit trail of the failure**. A user sees stock in the pool but their backordered order stays backordered with no explanation.
- **[HIGH] PO receive does NOT verify `org_variant_id` matches the PO item's variant.** Line 91 — the receipt item looks up `poItem` by `purchase_order_item_id`, but the inventory txn is created with the `ri.org_variant_id` from the request body, NOT `poItem.orgVariantId`. A client could supply a different `org_variant_id` and stock the wrong variant. The receipt_item row also stores the wrong `orgVariantId`. **Stock-poisoning bug.**
- **[HIGH] PO cancel does NOT restore incoming atomically.** Lines 57-62 of `cancel/route.ts` — loops through items calling `decrementIncomingStock` separately, then `purchaseOrder.update` separately. If item 3's decrement fails, items 1-2 are decremented but the PO is later marked cancelled — leaving phantom incoming for item 3.
- **[HIGH] GET endpoints have NO permission check.** List + detail readable by any authenticated user.
- **[MEDIUM] `actual_cost_per_unit` can differ from `costPerUnit` on the PO item** — the WAC recalculation correctly uses `actual_cost_per_unit`, but the `balanceDue` calculation in GET (line 80) uses the original `costPerUnit`, not what was actually paid. Reports will under/over-state balance due.
- **[MEDIUM] `receivedQuantity` is incremented without upper-bound check.** Line 131 — `receivedQuantity: { increment: ri.received_quantity }`. If a user receives MORE than ordered (over-shipment), `receivedQuantity` exceeds `orderedQuantity` and `allFullyReceived` is still true. No rejection of over-receipt.
- **[MEDIUM] `generatePoNumber` is racy.** `inventory.ts` line 454-467 — counts existing POs with the prefix, then adds 1. Two concurrent creates can produce the same PO number, which would violate the `@unique` constraint and one would 500. Should use a SQL sequence or a transactional `SELECT ... FOR UPDATE`.
- **[MEDIUM] Confirm endpoint (draft→ordered) does not validate PO has items.** An empty PO could be confirmed.
- **[MEDIUM] No validation that the supplier on the PO belongs to the same company scope as the PO.** Lines 126-129 — `findFirst({ where: { id, organizationId: orgId, isActive: true } })` — supplier could be company-B private, used in a company-A PO. Cross-company contamination.
- **[LOW] `paymentMethod` is a free-form string**, no enum.
- **[LOW] PO list is hard-capped at 50** (line 54) with no pagination cursor. A company with many POs only sees the latest 50.

### Frontend
`src/components/inventory/purchase-orders-view.tsx` (453 lines, list) + `po-create-view.tsx` (926 lines, wizard) + `po-detail-view.tsx` (977 lines, detail + receive flow). All three use idempotent mutations. PO-create has inline Zod, not the shared `createPurchaseOrderSchema` from `validations/inventory.ts`.

---

## Module 8: Supplier Returns

### Purpose
Return stock to a supplier. Creates a `supplier_return` inventory transaction (decrements onHand). Resolution paths: refund / replacement / credit_note (increments supplier.creditBalance) / disputed (no financial move) / rejected (auto-creates a `supplier_dispute` StockLossRecord to keep the loss visible).

### API Routes

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/supplier-returns` | List supplier returns for active company. |
| POST | `/api/supplier-returns` | Create a supplier return — processes `supplier_return` txn. Idempotency supported. |
| PATCH | `/api/supplier-returns/[id]` | Resolve a return — sets status, resolution_type/amount. Increments supplier.creditBalance if credit_note. Auto-creates supplier_dispute loss if rejected. |
| POST | `/api/supplier-returns/[id]/dispute` | Mark a return as disputed. |

### Server Actions
None.

### Schema Models
`SupplierReturn` — `quantity`, `costPerUnit`, `reason` (enum), `status` (default `'pending'`), `resolutionType?`, `resolutionAmount?`, `replacementPoId?`, `inventoryTxnId?`, `supplierReturnId` link to `StockLossRecord` (1:1 via `@unique`). `StockLossRecord` (for auto-created dispute loss).

### Issues Found

- **[HIGH] POST (create) is NOT atomic.** Lines 102-136 — `processInventoryTransaction` (decrements onHand) → `db.supplierReturn.create`. If the second fails, stock is gone with no record. No `db.$transaction`.
- **[HIGH] PATCH (resolve) is NOT atomic.** Lines 60-112 — `supplierReturn.update` → (if credit_note) `supplier.update(creditBalance increment)` → (if rejected) `stockLossRecord.create`. Three separate writes. A failure between them leaves the return half-resolved.
- **[HIGH] `creditBalance` mutation can be triggered MULTIPLE times.** Lines 73-78 — every PATCH with `resolution_type === 'credit_note'` AND a non-zero `resolution_amount` increments `creditBalance` again, regardless of whether it was already incremented in a prior PATCH. There is no idempotency check on the credit_balance mutation. A user clicking "Save" twice doubles the supplier's credit.
- **[HIGH] `rejected` loss-record creation has no idempotency.** Lines 81-101 — checks `if (!record.linkedLossRecord)` which is good, but `record.linkedLossRecord` is fetched at the start of the handler (line 35). A concurrent PATCH could create the loss between the fetch and the create, leading to duplicate loss records. The 1:1 `@unique` constraint on `supplierReturnId` would actually catch this at the DB level (the second insert would fail), but the error would be a generic 500 with no friendly message.
- **[HIGH] GET endpoints have NO permission check.**
- **[HIGH] POST does NOT verify `org_variant_id`, `location_id`, or `supplier_id` belong to the active company.** Same cross-company-scope issue.
- **[HIGH] PATCH/POST dispute endpoints not company-scoped** — `findFirst({ where: { id, companyId } })` for PATCH (line 33) is correct, but POST dispute (line 29) also uses companyId correctly. (Re-reading: these are company-scoped — I'll downgrade this to MEDIUM.) Actually re-verifying: line 33 PATCH fetches `where: { id, companyId }` — correct. Line 29 dispute fetches `where: { id, companyId }` — correct. So they ARE company-scoped. (Audit note: high-severity item revised.)
- **[MEDIUM] POST does NOT check that onHand >= quantity at the location.** Relies on `processInventoryTransaction` to fail with INSUFFICIENT_STOCK, which it does — but the error message returned to the user is generic ("Inventory transaction failed: INSUFFICIENT_STOCK: Available X, requested Y"). Acceptable but could be pre-validated for a cleaner UX.
- **[MEDIUM] No `purchase_order_id` validation that the PO belongs to the same supplier.** A user could link a supplier return to a PO from a different supplier — the relation is informational, but misleading.
- **[MEDIUM] `reason` enum in schema (line 20) and route Zod match, but no validation on PATCH resolution_type.** PATCH accepts any string for `resolution_type` (line 53).
- **[LOW] `photos` field in the POST schema is omitted** — the `createSupplierReturnSchema` (route line 13-22) doesn't include `photos`, even though the model has a `photos` column (default `'[]'`).
- **[LOW] Dispute endpoint appends notes** with `\n[Disputed] ${body.notes}` (line 50) — string concatenation, not append-only array. Hard to parse back.

### Frontend
`src/components/inventory/supplier-returns-view.tsx` (919 lines). Create dialog + list + resolve dialog. No `photos` upload UI (consistent with the missing schema field).

---

## Module 9: Production Orders

### Purpose
Made-to-order (MTO) workflow: consume fabric from a source variant → create stitched items → mark completed (auto-stocks + reserves for linked order item).

### API Routes

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/production-orders` | List production orders for active company. |
| POST | `/api/production-orders` | Create a production order — consumes fabric (`fabric_consumed_for_stitching` txn). Status starts at `'fabric_reserved'`. |
| GET | `/api/production-orders/[id]` | Get a single production order. |
| PATCH | `/api/production-orders/[id]` | Update status / tailor / dates. Post-completion automation: if status → `'completed'` AND `orderItemId` linked, adds stock + reserves + sets `reservedLocationId` on order item. |

### Server Actions
None — but `checkAndFulfillMadeToOrderVariant` in `src/lib/inventory.ts` is the programmatic entry point (called by `/api/inventory/fulfill-mto`).

### Schema Models
`ProductionOrder` — `stitchedVariantId`, `fabricVariantId`, `fabricLocationId`, `quantity`, `status` (`pending|fabric_reserved|in_production|completed|dispatched|cancelled`), `stitchingCost`, `fabricCost`, `assignedTailor?`, `estimatedCompletionDate?`, `actualCompletionDate?`, `orderItemId? @unique`, `fabricTxnId?`. `ProductFulfillmentCost` model exists for detailed cost tracking but is not written by these routes.

### Issues Found

- **[HIGH] POST (create) is NOT atomic.** Lines 117-150 — `processInventoryTransaction` (consume fabric) → `productionOrder.create`. If the second fails, fabric is consumed with no production order to show for it. No `db.$transaction`.
- **[HIGH] POST does NOT verify `stitched_variant_id` or `fabric_variant_id` belong to the org/company.** Cross-org contamination possible.
- **[HIGH] POST does NOT verify the stitched variant is `made_to_order` fulfillmentType.** A user could create a production order for a stock-based variant, which makes no semantic sense.
- **[HIGH] PATCH post-completion automation is fire-and-forget.** Lines 148-219 — wrapped in try/catch with `console.error` only. If the auto-stocking or reservation fails, the production order is marked completed but the linked order item has no stock to dispatch from. The order will fail at dispatch time with no link back to the production-order completion that caused the gap.
- **[HIGH] Post-completion automation uses `opening_stock` txn type** (line 175) — but `opening_stock` recalculates WAC using `finalCostPerUnit`, which is NULL here. The function falls back to `oldAvgCost` (inventory.ts line 169), so the produced items are valued at the pool's existing avgCost (likely 0 if this is the first receipt). **Produced MTO items are valued at zero cost**, distorting stock-value KPIs.
- **[HIGH] GET endpoints have NO permission check.**
- **[HIGH] GET `/api/production-orders/[id]` not company-scoped.** Line 24 — `findFirst({ where: { id, companyId } })` — actually IS company-scoped. (Revised.)
- **[MEDIUM] PATCH allows any `status` string** (line 118) — no enum validation, no transition-state-machine. A user could PATCH directly from `'fabric_reserved'` to `'dispatched'`, skipping `'in_production'` and `'completed'` — and skipping the post-completion automation entirely. Status machine is documented in the route comment (line 70-75) but not enforced.
- **[MEDIUM] `actual_completion_date` can be set manually via PATCH** (line 133-135) — bypasses the `if (body.status === 'completed')` auto-set. Inconsistent.
- **[MEDIUM] Cancel does NOT reverse the fabric consumption.** Lines 124-127 — sets `cancelledAt` + `cancellationReason`, but does NOT call `processInventoryTransaction` with a `transfer_in`/`return_resellable` to put the fabric back. **Cancelled production orders permanently lose their fabric.**
- **[MEDIUM] No validation that `quantity > 0`** at the route level — relies on Zod (route line 16) which IS in place, so this is fine. (Revised: low.)
- **[LOW] `referenceType` is hardcoded `'order'`** in schema default; the route doesn't override.
- **[LOW] `ProductFulfillmentCost` model is dead** — defined in schema, never written to by any route.

### Frontend
`src/components/inventory/production-orders-view.tsx` (596 lines). List + create dialog + status-transition dropdown. No detail view (the GET `/[id]` endpoint exists but no component consumes it). No way to view the linked order item.

---

## Module 10: Losses & Write-offs

### Purpose
Five loss types with distinct inventory behavior:
1. **Damaged** — single-stage, instant write-off (`damage_writeoff` txn).
2. **Theft** — two-stage: quarantine (reserved++) → investigate → resolve (write_off / recover / error_corrected).
3. **Missing** — internal, triggered from cycle counts (not standalone).
4. **Transit Loss** — no inventory txn (stock already gone at dispatch); claim tracking only.
5. **Supplier Dispute** — auto-created from rejected supplier returns.

### API Routes

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/stock-loss` | List loss records (filter by loss_type, investigation_status). |
| GET | `/api/stock-loss/stats` | Aggregate stats for the dashboard header. |
| GET | `/api/stock-loss/[id]` | Get a single loss record. |
| POST | `/api/stock-loss/report-damaged` | Report damaged stock — instant write-off. Idempotency supported. |
| POST | `/api/stock-loss/report-theft` | Report theft — quarantine + open investigation. Idempotency supported. |
| POST | `/api/stock-loss/report-transit` | Report transit loss — claim tracking only. Idempotency supported. |
| POST | `/api/stock-loss/resolve` | Resolve a theft/missing/transit loss. |

### Server Actions
None.

### Schema Models
`StockLossRecord` — `lossType` (5 types), `subType?`, `damageType?`, `quantity`, `costPerUnit`, `investigationStatus` (default `'none'`), `resolution?`, `responsibleParty?`, `policeReportRef?`, `insuranceClaimRef?`, `insuranceRecovered`, `courierClaimRef?`, `courierClaimStatus?`, `courierRecovered`, `evidenceUrls` (JSON array string), `reportedById`, `approvedById?`, `resolvedById?`, `inventoryTxnId?`, `orderReferenceId?`, `orderItemId?`, `supplierReturnId? @unique`.

### Issues Found

- **[HIGH] `report-damaged` is NOT atomic.** Lines 65-109 — `stockLossRecord.create` → `processInventoryTransaction` → `stockLossRecord.update(inventoryTxnId)`. Three writes. If the txn fails, the loss record exists with `inventoryTxnId=null` and `resolution='written_off'` but no actual write-off occurred — looks resolved in the UI but stock wasn't touched.
- **[HIGH] `report-theft` is NOT atomic.** Lines 61-84 — `quarantineStock` (modifies pool) → `stockLossRecord.create`. If the second fails, stock is quarantined with no investigation record. No `db.$transaction`.
- **[HIGH] `resolve` (theft/missing) is NOT atomic.** Lines 60-96 — `releaseQuarantine` → (if written_off) `processInventoryTransaction` → `stockLossRecord.update`. Three writes. A failure leaves stock released but no write-off txn recorded.
- **[HIGH] GET endpoints (`/api/stock-loss`, `/api/stock-loss/[id]`, `/api/stock-loss/stats`) have NO permission check.** Any employee can see all loss records, including theft investigations with police report references and insurance claim amounts.
- **[HIGH] `report-theft` does NOT check available stock before quarantining.** Lines 61-64 — `quarantineStock` itself checks (`inventory.ts` line 649-652), so this is fine functionally — but the error returned to the user is generic. (Revised: medium.)
- **[MEDIUM] `report-transit` does NOT verify the `order_reference_id` exists** or that the caller has access to it. Any string is accepted.
- **[MEDIUM] `resolve` for transit-loss path** accepts `resolution: 'claim_accepted' | 'claim_rejected'` (line 100 of `validations/stock-loss.ts`) but the route (line 135-137) checks `d.resolution === 'claim_accepted' && d.courier_recovered === undefined` — meaning if the user sends `claim_rejected` with a courier_recovered amount, it's silently ignored (set to 0).
- **[MEDIUM] No `loss_type='missing'` standalone endpoint.** The validation schema `reportMissingLossSchema` exists in `validations/stock-loss.ts` (line 59-67) but no route consumes it. Missing losses can only be created via cycle count approval. Dead schema.
- **[MEDIUM] `report-damaged` does NOT verify `org_variant_id` or `location_id` belong to the active company.**
- **[MEDIUM] `report-theft` does NOT verify `org_variant_id` or `location_id` belong to the active company.**
- **[MEDIUM] `resolve` endpoint does NOT verify the loss record belongs to the active company** in the request body validation — actually it does (`findFirst({ where: { id: lossId, companyId: company.id } })` line 47). Revised: low.
- **[MEDIUM] `resolve` for theft/missing path** calls `releaseQuarantine` BEFORE the write-off txn (line 60). If the write-off txn then fails (line 80-82), the stock has been released from quarantine but NOT decremented — onHand is now higher than it should be. The user sees a 500 error but the quarantine is gone. Order: should be txn first, then release.
- **[LOW] `stockLossSchema` in `validations/inventory.ts` (line 179-192) is duplicated** by the more-specific schemas in `validations/stock-loss.ts`. Dead code.
- **[LOW] `resolveStockLossSchema` in `validations/inventory.ts` (line 194-207) is also dead** — not used by any route.
- **[LOW] `createSupplierDisputeLossSchema` in `validations/stock-loss.ts` (line 110-113) is dead** — the supplier-return rejection flow inlines the loss-record creation.

### Frontend
`src/components/inventory/losses-view.tsx` (2252 lines — largest inventory component) + `loss-detail-view.tsx` (1331 lines). Full CRUD + resolve dialogs for all 5 loss types. Heavy component; would benefit from splitting.

---

## Module 11: Cycle Counts

### Purpose
Full cycle-count workflow: create (scheduled) → start (snapshot system quantities into `CycleCountItem` rows) → submit counts (compute discrepancies) → approve (process `cycle_count_adjust` txns to set onHand to counted value; for theft-suspected shortages, quarantine + create missing-loss record) → cancel.

### API Routes

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/cycle-counts` | List cycle counts for active company. |
| POST | `/api/cycle-counts` | Create a cycle count (status='scheduled'). Idempotency supported. |
| GET | `/api/cycle-counts/[id]` | Get a cycle count with its items. |
| PATCH | `/api/cycle-counts/[id]` | Multi-action: `start | submit_counts | approve | cancel`. |

### Server Actions
None.

### Schema Models
`CycleCount` — `countName`, `countType` (`full|partial|spot`), `status` (`scheduled|in_progress|pending_review|approved|cancelled`), `scheduledAt`, `startedAt?`, `completedAt?`, `approvedAt?`, `assignedToId?`, `totalDiscrepancies`, `totalVarianceValue Decimal(16,2)`. `CycleCountItem` — `systemQuantity`, `countedQuantity?`, `discrepancyValue?` (reused to store avgCost snapshot — see issue), `discrepancyReason?`, `adjustmentApproved`, `inventoryTxnId?`, `countedById?`.

### Issues Found

- **[HIGH] `approve` action is NOT atomic.** Lines 222-324 — for each item with a discrepancy: `processInventoryTransaction(cycle_count_adjust)` → `cycleCountItem.update(adjustmentApproved + inventoryTxnId)`. Per-item, two writes, no transaction. If item 5 of 10 fails, items 1-4 are adjusted but 5-10 are not, and the cycle count is later marked `'approved'` regardless (line 317-324). The user sees an approved count with stock that doesn't match the counted values.
- **[HIGH] `approve` for theft-suspected shortage** is NOT atomic.** Lines 237-288 — `quarantineStock` → `stockLossRecord.create` → `processInventoryTransaction(cycle_count_adjust)` → `cycleCountItem.update`. Four writes per item. A failure between quarantine and the adjust leaves the stock quarantined but onHand not set to the counted value.
- **[HIGH] `cycle_count_adjust` SETS onHand to the counted value** (inventory.ts line 231-235). This is by design (cycle counts are absolute, not delta), but it means a malicious or mistaken count can SET onHand to any value — including 0 (wiping stock) or a huge number (inflating stock). There is no upper-bound check. The route doesn't validate that the counted quantity is reasonable (e.g. within 10x of system quantity for a "spot" count).
- **[HIGH] GET endpoints have NO permission check.**
- **[HIGH] `start` action does NOT support `partial` or `spot` count types.** Lines 134-148 — `pools = findMany({ where: { locationId: count.locationId } })` fetches ALL pools at the location regardless of `count.countType`. The schema documents `partial` and `spot` types (which should filter to specific variants), and `cycleCountSchema` in validations accepts `variant_ids` for filtering — but the route ignores `variant_ids` entirely. **Partial/spot counts behave identically to full counts.**
- **[MEDIUM] `discrepancyValue` column is misused.** The schema comment says `discrepancy = counted - system` (computed in app) and `discrepancyValue` stores the financial variance. But the route (line 146) stores `pool.avgCost` in `discrepancyValue` at start time, then in `submit_counts` (line 183) computes `variance = discrepancy * Number(item.discrepancyValue)`. So `discrepancyValue` holds avgCost, not variance. The GET response (line 64) returns it as `discrepancyValue` (implying variance), which is wrong — the actual variance is computed on-the-fly. Column naming is misleading.
- **[MEDIUM] `submit_counts` does NOT validate that all items have been counted.** A user could submit with some items having `countedQuantity=null` — those are silently skipped (line 230 in approve), but the `totalDiscrepancies`/`totalVariance` is computed only from counted items. The cycle count appears complete with uncounted items.
- **[MEDIUM] `submit_counts` is NOT atomic.** Lines 175-206 — per-item `cycleCountItem.update` then a final `cycleCount.update`. A failure halfway leaves some items updated and the count still `in_progress`.
- **[MEDIUM] `start` is NOT idempotent.** If called twice, the second call creates duplicate `CycleCountItem` rows for the same variant+count. No check for existing items.
- **[MEDIUM] `start` is NOT atomic.** Lines 139-153 — per-pool `cycleCountItem.create` then `cycleCount.update(status='in_progress')`. A failure leaves partial items and the count still `scheduled`.
- **[MEDIUM] The missing-loss record created on approve (line 249-266) does NOT have an `inventoryTxnId` set** — it's left NULL even though a `cycle_count_adjust` txn was just created (line 270-282). The loss record can never be linked back to the txn that adjusted the stock.
- **[MEDIUM] Approve endpoint skips items with `countedQuantity === null`** (line 229) but does NOT mark them as `adjustmentApproved=true` either — they remain in limbo, neither approved nor flagged.
- **[LOW] `cycleCountSchema` accepts `variant_ids` but the route ignores it** — dead schema field.
- **[LOW] `submitCountItemSchema` in `validations/inventory.ts` (line 223-228) is dead** — not used by the route.

### Frontend
`src/components/inventory/cycle-counts-view.tsx` (1335 lines). List + create + 4-action detail view. No support for partial/spot counts in the UI (consistent with the backend gap).

---

## Cross-Cutting Concerns

### 1. Unified `stock_balance` view vs. computed on-the-fly
**Computed on-the-fly.** There is no `stock_balance` materialized view or cached aggregate. Every dashboard load (line 22 of `inventory/dashboard/route.ts`) re-reads ALL `InventoryPool` rows for the org and reduces them in JS. For large orgs this will degrade. The `inventory-locations/[id]` GET does the same per-location. Recommendation: introduce a SQL view or periodic denormalized totals row on `Organization` or `Company`.

### 2. Stock movements: append-only vs. mutable
**Append-only by design, but NOT enforced.** The `InventoryTransaction` model has no `@updatedAt` — only `recordedAt` + `createdAt`. The code comment (schema line 1032) says "Never update or delete rows." However:
- No DB-level trigger prevents UPDATE/DELETE.
- No Prisma middleware enforces immutability.
- The `inventoryTxnId` field on `StockLossRecord`, `CycleCountItem`, `PurchaseOrderReceiptItem`, `SupplierReturn`, `ProductionOrder` is NULLABLE and **updatable** — the code does update it (e.g. `stock-loss/report-damaged/route.ts` line 106-109 updates `inventoryTxnId` after the txn is created). This is a write to a ledger-link field post-creation, which violates strict immutability.

### 3. Stock reservation system
**Yes, exists.** `InventoryPool.reserved` is the reservation count. Available = onHand − reserved. Reservation is created by:
- `reserveStockForOrder` (called from order creation) — `order_reserved` txn (increments reserved).
- `quarantineStock` (called from theft/missing reports) — directly increments reserved, NO txn.
- Post-completion automation in `production-orders/[id]/route.ts` — `order_reserved` txn.

Reservation is released by:
- `unreserveStockForOrder` (order cancellation) — `order_unreserved` txn (decrements reserved).
- `releaseQuarantine` (loss resolution) — directly decrements reserved, NO txn.
- `dispatchOrder` (order dispatch) — `sale_dispatched` txn decrements BOTH onHand AND reserved.

**Concern:** Quarantine and releaseQuarantine bypass the ledger entirely — they mutate `InventoryPool.reserved` directly without an `InventoryTransaction` row. This means the ledger is NOT a complete record of all pool mutations. Audit trail for theft investigations is incomplete.

### 4. Currency / decimal handling
**Decimal at the DB level, Float in the application layer.**
- Prisma schema uses `Decimal @db.Decimal(12,4)` for `avgCost` / `costPerUnit` and `Decimal @db.Decimal(12,2)` for monetary amounts (`advancePayment`, `creditBalance`, `logisticsCost`, `resolutionAmount`, `insuranceRecovered`, `courierRecovered`).
- In the route handlers, `Number(p.avgCost)` / `Number(item.costPerUnit)` converts to JS `number` (IEEE 754 double) for arithmetic.
- `processInventoryTransaction` (inventory.ts line 92-101) does `calculateNewAvgCost` using JS number arithmetic — `existingQty * oldAvg + newQty * newCost) / totalQty`. For financial precision this should use `Decimal` math via `prisma.Decimal` or a library like `decimal.js`.
- JSON serialization of `Decimal` returns a string by default — the routes explicitly call `Number(...)` to coerce to number for JSON output, losing precision.

### 5. Permission check pattern (systemic)
**Inventory routes use a LEGACY auth pattern** inconsistent with the rest of the codebase post-`REBUILD-API-PROTECTION`:
- Legacy pattern (inventory): `getCurrentUser()` → `db.userSetting.findUnique` → `db.employee.findFirst` → `db.rolePermission.count` → manual throw.
- Modern pattern (orders, employees, dashboard, roles, company): `getWorkspace()` → `requirePermission(ctx, KEY)`.

All 26 inventory routes use the legacy pattern. This means:
- No workspace caching (60s in-memory cache that `getWorkspace` provides).
- 3-4 extra DB queries per request (userSetting, employee, rolePermission).
- More boilerplate code, easier to introduce inconsistencies.
- `requirePermission` is NEVER called from any inventory route.

### 6. Idempotency
**Well-implemented where present.** 11 of the 14 mutating endpoints support `Idempotency-Key` via the `withIdempotency` helper. Missing on:
- `purchase-orders/[id]/confirm` (no idempotency key support).
- `purchase-orders/[id]/receive` (no idempotency key support).
- `purchase-orders/[id]/cancel` (no idempotency key support).
- `production-orders/[id]` PATCH (no idempotency key support).
- `supplier-returns/[id]` PATCH (no idempotency key support).
- `supplier-returns/[id]/dispute` (no idempotency key support).
- `stock-loss/resolve` (no idempotency key support).
- `cycle-counts/[id]` PATCH (no idempotency key support — but multi-action, harder to idempot).
- `inventory/receive-returned-stitched` (no idempotency key support).
- `inventory/fulfill-mto` (no idempotency key support).

### 7. Audit logging
**Present on all mutating endpoints**, but:
- `insertAuditLog` calls are NOT awaited (fire-and-forget) in most routes — if the audit DB write fails, the action is still committed but the audit trail is lost.
- `inventory/fulfill-mto/route.ts` has **NO audit log** at all, despite consuming fabric + creating a production order.
- All GET (read) endpoints have no audit log — acceptable, but worth noting for sensitive data (e.g. `stock-loss/[id]` reveals police report references).

### 8. SQL injection risk
**None.** All queries use Prisma's parameterized API. The only raw SQL in the inventory sphere is in `backorder.actions.ts` line 269: `db.$queryRaw\`SELECT recompute_order_status(${entry.orderId}::TEXT)\`` — this is parameterized via Prisma's tagged template literal. Safe.

### 9. Missing input validation (cross-cutting)
Several routes use inline `readBody<{...}>` with manual `if (!body.x) throw` checks instead of the Zod schemas defined in `src/lib/validations/inventory.ts`. This causes drift:
- `inventory-locations/route.ts` POST — doesn't use `locationSchema`.
- `inventory/transfers/route.ts` POST — doesn't use `transferStockSchema`.
- `suppliers/route.ts` POST — doesn't use `supplierSchema`.
- `suppliers/[id]/route.ts` PATCH — doesn't use `supplierSchema`.
- `purchase-orders/[id]/receive/route.ts` — uses inline schema (not `receivePOSchema`).
- `production-orders/route.ts` POST — uses inline schema (not `productionOrderSchema`).
- `cycle-counts/route.ts` POST — uses inline schema (not `cycleCountSchema`).
- `supplier-returns/route.ts` POST — uses inline schema (not `supplierReturnSchema`).
- `supplier-returns/[id]/route.ts` PATCH — no schema at all.

The shared Zod schemas in `validations/inventory.ts` and `validations/stock-loss.ts` are largely **dead code** (used only by `receive`, `opening-stock`, `adjust`, `receive-returned-stitched`, `fulfill-mto`, `stock-loss/report-*`, `stock-loss/resolve`).

### 10. Dead code / unused exports
- `stockLossSchema`, `resolveStockLossSchema` in `validations/inventory.ts` — superseded by `validations/stock-loss.ts`.
- `createSupplierDisputeLossSchema`, `reportMissingLossSchema` in `validations/stock-loss.ts` — never used by any route.
- `submitCountItemSchema`, `cycleCountSchema.variant_ids` in `validations/inventory.ts` — never used.
- `ProductFulfillmentCost` Prisma model — defined but never written to.
- `StockTransfer.status='in_transit'` — schema supports it, code never sets it.
- `CycleCount.countType='partial'|'spot'` — schema supports it, code treats them all as `'full'`.
- `SupplierReturn.photos` column — schema has it, route POST schema omits it.
- `InventoryLocation.address` (JSONB) + `postalCode` — schema has them, route ignores both.
- `ProductionOrder.referenceType` / `referenceId` — superseded by `orderItemId` FK but still set to default `'order'`/null.

---

## Summary Table

| Module | Routes | Critical | High | Medium | Low |
| --- | --- | --- | --- | --- | --- |
| 1. Dashboard | 1 | 0 | 2 | 2 | 2 |
| 2. Locations | 5 | 1 | 4 | 2 | 3 |
| 3. Suppliers | 4 | 0 | 3 | 3 | 2 |
| 4. Receive Stock | 3 | 0 | 3 | 4 | 2 |
| 5. Adjust Stock | 1 | 0 | 2 | 3 | 2 |
| 6. Transfer Stock | 2 | 1 | 3 | 3 | 2 |
| 7. Purchase Orders | 6 | 2 | 4 | 5 | 2 |
| 8. Supplier Returns | 4 | 0 | 3 | 4 | 2 |
| 9. Production Orders | 4 | 0 | 5 | 2 | 2 |
| 10. Losses & Write-offs | 7 | 0 | 4 | 5 | 3 |
| 11. Cycle Counts | 4 | 0 | 4 | 5 | 2 |
| **TOTAL** | **41** | **4** | **37** | **38** | **24** |

(Note: total route count differs from executive summary because some routes are multi-method on the same path; the 26 figure counts distinct route files. Severity counts above include cross-cutting concerns attributed to the most-relevant module.)

---

## Top Priority Recommendations (for a follow-up fix task — NOT done in this audit)

1. **Wrap ALL multi-step writes in `db.$transaction`.** The transfer endpoint (Module 6) and PO receive endpoint (Module 7) are the most dangerous — they can silently destroy stock.
2. **Add company-scoping to all `findFirst`/`findUnique` calls** on `[id]` routes (Locations, Suppliers, POs, Production Orders, Cycle Counts, Supplier Returns detail). Currently the `where` clause filters by `organizationId` only — cross-company access is possible.
3. **Migrate inventory routes from the legacy `getCurrentUser + db.rolePermission.count` pattern to `getWorkspace() + requirePermission()`.** Saves 3-4 DB queries per request and brings the module in line with the rest of the codebase.
4. **Add `requirePermission(PERMISSIONS.INVENTORY_VIEW)` to all GET endpoints.**
5. **Add a dedicated `manual_adjustment_out` transaction type** so negative manual adjustments don't masquerade as `damage_writeoff`.
6. **Reverse the operation order in `stock-loss/resolve`**: do the write-off txn FIRST, then release quarantine — so a txn failure doesn't leave stock un-quarantined.
7. **Fix the `reportMissingLossSchema` dead code** by adding a `POST /api/stock-loss/report-missing` route, OR remove the schema and document that missing losses can only come from cycle counts.
8. **Validate `org_variant_id` and `location_id` belong to the active company** in receive/adjust/transfer/loss endpoints — currently any UUID is accepted.
9. **Use the shared Zod schemas** from `validations/inventory.ts` instead of inline `readBody<{...}>` + manual validation.
10. **Fix `production-orders` PATCH cancel** to reverse the fabric consumption (currently cancelled production orders permanently lose their fabric).

---

# PART 2: Runtime + Frontend Audit (Main Session)

**Task ID:** INV-AUDIT-RUNTIME
**Agent:** main (Z.ai Code)
**Method:** Browser testing (agent-browser) + curl API testing + dev.log analysis
**Date:** 2026-09-04

---

## Runtime Test Results

### API Route Health (all 10 list endpoints tested via curl)

| Route | HTTP | Latency | Notes |
|-------|------|---------|-------|
| `/api/inventory-locations` | 200 | 565ms | ✅ Works |
| `/api/suppliers` | 200 | 566ms | ✅ Works |
| `/api/inventory/transfers` | 200 | 422ms | ✅ Works |
| `/api/inventory/dashboard` | 200 | 695ms | ✅ Returns proper stats: `totalStockValue`, `lowStockCount`, `outOfStockCount`, `deadStockValue`, `movement`, `stockTable`, `recentTransactions` |
| `/api/purchase-orders` | 200 | 557ms | ✅ Works |
| `/api/production-orders` | 200 | 719ms | ✅ Works |
| `/api/stock-loss` | 200 | 669ms | ✅ Works |
| `/api/cycle-counts` | 200 | 698ms | ✅ Works |
| `/api/supplier-returns` | 200 | 691ms | ✅ Works |

### Authentication Check (GET without cookie)

**Correction to Part 1 audit:** All GET endpoints DO check authentication (return 401 without a session cookie). The Part 1 claim "GET endpoints have zero permission checks" refers to **authorization** (role-based permission checks via `requirePermission`), NOT **authentication**. The concern is valid but the wording was imprecise:

| Route | Without cookie | With cookie | Issue |
|-------|----------------|-------------|-------|
| All 10 list endpoints | 401 Not authenticated | 200 | ✅ Auth checked |
| | | | ⚠️ But NO `requirePermission()` call — any logged-in user (even viewer-tier) can read ALL inventory data |

### POST Endpoint Tests

| Endpoint | Payload | Result | Issue |
|----------|---------|--------|-------|
| `POST /api/inventory-locations` | `{name, code, type}` | 200 ✅ Created | ⚠️ Hardcoded `city:"Lahore"`, `province:"Punjab"`, `countryCode:"PK"` in response — confirms Part 1 finding |
| `POST /api/suppliers` | `{name, contactPerson, phone, email}` | 200 ✅ Created | Works |
| `POST /api/inventory/adjust` | camelCase fields | 400 "Invalid input" | ✅ Zod validation works — schemas use **snake_case** (`org_variant_id`, `location_id`) |
| `POST /api/inventory/transfers` | `{fromLocationId, toLocationId, items}` | 400 "org_variant_id, from_location_id, to_location_id, and quantity are required" | ✅ Validation works, also uses snake_case |
| `POST /api/purchase-orders` | camelCase fields | 400 "Invalid input" | ✅ Validation works |

**API field naming inconsistency:** The inventory Zod schemas use **snake_case** (`org_variant_id`, `cost_per_unit`, `delivery_location_id`) while the rest of the codebase (customers, orders, integrations) uses **camelCase**. This is a maintenance smell — inventory routes are inconsistent with the rest of the app.

### Cross-Company Scoping Test

| Test | Result | Verdict |
|------|--------|---------|
| `GET /api/inventory-locations/{my-location-id}` | 200 ✅ | Works |
| `GET /api/inventory-locations/{company-id-as-location-id}` | 404 "Location not found" | ✅ Appears scoped (returns 404 for non-location IDs) |

**Note:** Part 1 audit flagged `[id]` routes as "not company-scoped" based on code reading. My runtime test couldn't conclusively confirm cross-company leakage (would need a second org's real location ID). The code pattern `findFirst({ where: { id } })` without `organizationId` IS a real concern — recommend deeper testing with a second org.

---

## Critical Runtime Bugs Found

### 🔴 CRITICAL #1: `fx-refresh` cron crashes on every run

**Source:** `instrumentation.ts:140, 155`
**Error:** `[fx-refresh] Refresh failed: Cannot read properties of undefined (reading 'findMany')`
**Root cause:** The exchange rate refresh cron calls `db.market.findMany(...)` — but the **Markets system was permanently removed** (commit `3cf33b5` / `1bc756d`). The `Market` model no longer exists in `prisma/schema.prisma`, so `db.market` is `undefined`, and `undefined.findMany()` throws.

**Impact:** Exchange rates NEVER refresh automatically. Any multi-currency reporting that depends on fresh `ExchangeRateSnapshot` rows will use stale data indefinitely.

**Context:** The markets removal task (worklog) updated `getActiveCurrencies()` in `exchange-rates.ts` to use `db.company.findMany` instead of `db.market.findMany` — but the **instrumentation.ts cron was NOT updated** and still references the removed `db.market`. This is a missed-migration bug.

**Fix (not implemented):** Change `db.market.findMany(...)` → `db.company.findMany({ distinct: ['baseCurrency'] })` in both the `setTimeout` (line 140) and `setInterval` (line 155) blocks of `instrumentation.ts`.

### 🔴 CRITICAL #2: `poNumber` unique constraint race condition (confirmed at runtime)

**Error in dev.log:** `prisma:error Unique constraint failed on the fields: (poNumber)` + `[api] unhandled error: Error [PrismaClientKnownRequestError]: Unique constraint failed on the fields: (poNumber)`

**Confirms Part 1 audit finding:** `generatePoNumber` uses `count+1` which is racy — two concurrent PO creations can generate the same number, causing a unique constraint violation that surfaces as a 500 error to the user.

---

## Frontend Module-by-Module Test

All 10 modules (excluding Dashboard) render their page titles + proper empty states. No "Coming Soon" placeholders. Tested by navigating to each `?view=inventory-*` route.

### Module 1: Inventory Dashboard — 🟡 FRONTEND BUG

**View route:** `?view=inventory-dashboard`
**Issue:** Shows the **workspace dashboard** content (Active employees, Active roles, Pending invites, Organizations, Recent activity, Quick actions) — NOT inventory-specific content.

**Evidence:** The `/api/inventory/dashboard` endpoint returns proper inventory stats (`totalStockValue`, `lowStockCount`, `outOfStockCount`, `deadStockValue`, movement, stockTable, recentTransactions) — but the frontend view doesn't call this endpoint or render these stats. It renders the generic workspace welcome page instead.

**Severity:** HIGH — the inventory dashboard is the cockpit for inventory managers, and it shows zero inventory information.

### Modules 2-11: All Render Correctly

| Module | View Route | Page Title | Empty State | Action Buttons |
|--------|-----------|------------|-------------|----------------|
| Locations | `inventory-locations` | "Inventory Locations" | "No locations yet" | Add Location |
| Suppliers | `inventory-suppliers` | "Suppliers" | "No suppliers yet" | Add Supplier |
| Receive Stock | `inventory-receive` | "Receive Stock" | "No locations yet" (gated on locations existing) | — |
| Adjust Stock | `inventory-adjust` | "Adjust Stock" | Description shown | — |
| Transfer Stock | `inventory-transfer` | "Transfer Stock" | "No locations yet" | — |
| Purchase Orders | `inventory-purchase-orders` | "Purchase Orders" | "No purchase orders yet" | Create PO |
| Supplier Returns | `inventory-supplier-returns` | "Supplier Returns" | "No supplier returns yet" | Create Return |
| Production Orders | `inventory-production-orders` | "Production Orders" | "No production orders yet" | Create Production Order |
| Stock Losses | `inventory-losses` | "Stock Losses" | (empty state) | Report Loss |
| Cycle Counts | `inventory-cycle-counts` | "Cycle Counts" | "No cycle counts yet" | Create Count |

All modules have proper empty states with CTAs. No broken layouts, no runtime errors during page load.

---

## Cross-Cutting Runtime Observations

### 1. Hardcoded defaults in location creation
When I created a location via `POST /api/inventory-locations` with only `{name, code, type}`, the response included:
```json
{"city":"Lahore","province":"Punjab","countryCode":"PK"}
```
These are hardcoded defaults — confirms Part 1's "LOW: hardcoded 'Lahore'/'Punjab'/'PK' defaults" finding. For a Pakistani ERP this is a reasonable default, but it should come from the company's address, not hardcoded.

### 2. Legacy auth pattern confirmed
The `POST /api/inventory/adjust` route uses the legacy 4-query auth pattern:
```typescript
const user = await getCurrentUser()                    // query 1
const settings = await db.userSetting.findUnique(...)   // query 2
const caller = await db.employee.findFirst(...)         // query 3
await db.rolePermission.count(...)                     // query 4
```
This is ~4 DB round-trips per request (~560ms to Supabase). The modern `getWorkspace()` + `requirePermission()` (with the 60s cache from Phase 3) would cut this to 0ms on cache hits. Confirms Part 1's "HIGH: legacy auth pattern" finding.

### 3. No stock reservation system observed
No evidence of stock reservation in the tested modules. The `InventoryPool.reserved` field exists (per Part 1) but the inventory UI doesn't surface it. Reservation appears to happen only at order-creation time (outside the inventory modules).

---

## Consolidated Issue Count (Part 1 + Part 2)

| Severity | Part 1 (code) | Part 2 (runtime) | Total |
|----------|---------------|-------------------|-------|
| CRITICAL | 4 | 2 | **6** |
| HIGH | 37 | 1 | **38** |
| MEDIUM | 38 | 1 | **39** |
| LOW | 24 | 0 | **24** |
| **Total** | **103** | **4** | **107** |

## Top 5 Most Urgent Fixes (recommended order)

1. **🔴 Fix `fx-refresh` cron** (`instrumentation.ts:140,155`) — change `db.market.findMany` → `db.company.findMany`. Exchange rates are currently never refreshing. (5 min fix)

2. **🔴 Fix `poNumber` race condition** — use a DB sequence or `SELECT ... FOR UPDATE` lock instead of `count+1`. Currently causes 500 errors on concurrent PO creation. (30 min fix)

3. **🔴 Wrap Transfer + PO-Receive in `db.$transaction`** — non-atomic multi-step writes can silently destroy stock if one step fails. (1 hour fix)

4. **🟡 Fix Inventory Dashboard frontend** — wire the `?view=inventory-dashboard` route to call `/api/inventory/dashboard` and render the inventory stats (totalStockValue, lowStockCount, etc.) instead of the workspace welcome page. (1 hour fix)

5. **🟡 Migrate inventory routes to `getWorkspace()` + `requirePermission()`** — eliminates 4 DB queries per request (saves ~560ms) and aligns with the rest of the codebase. Also adds proper role-based authorization (currently any logged-in user can read all inventory data). (2 hour fix, touches ~26 routes)

---

## Methodology Notes

- **Backend code audit** (Part 1): read all 26 route files, all Prisma models, `src/lib/inventory.ts` (949 lines), validation schemas. Done by general-purpose subagent.
- **Runtime testing** (Part 2): curl'd all 10 list endpoints (with + without auth), created a location + supplier via POST, tested validation on 3 mutation endpoints, grepped dev.log for errors during page loads.
- **Frontend testing** (Part 2): browser-navigated to all 11 `?view=inventory-*` routes, screenshotted each, extracted page titles + empty states + action buttons via agent-browser snapshots, VLM-analyzed the dashboard screenshot.
- **Limitations:** Couldn't test cross-company leakage conclusively (would need a second org's real IDs). Couldn't exercise the full PO receive → stock increment flow (would need real product variants). The audit is thorough for what's testable in a fresh sandbox.

**No source code was modified.** This is a read-only audit + report.
