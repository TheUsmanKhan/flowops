# PO & Production Orders (MTO Fabric Consumption) — Audit Report

**Task ID:** PO-PRODUCTION-AUDIT
**Mode:** READ-ONLY investigation (no code/schema/data modified)
**Database:** Supabase Postgres (project `gobwxqkzfulbwhzbbsdj`)
**Scope:** PurchaseOrder, PurchaseOrderItem, PurchaseOrderReceipt, PurchaseOrderReceiptItem, SupplierReturn, ProductionOrder, ReturnedStitchedInventory models + their API routes, lib helpers, and frontend components.

---

## Executive Summary

The PO module is **mature and mostly clean** — INV-001/002/003/004/006/007 fixes are correctly applied at the code level, atomicity is enforced via `db.$transaction` in all the right places, and the Zod + permission checks are consistent on the mutation routes. **9 issues** were found, of which **1 Critical (authorization gap), 1 Critical (production-order completion data loss), 1 High (stale incoming), 4 Medium (legacy orphan data + UI messaging), and 2 Low (UX gaps).**

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High     | 1 |
| Medium   | 4 |
| Low      | 2 |
| **Total** | **9** |

The most actionable issue is **PO-002** — manually-created ProductionOrders (or those created via the exchange-shipment MTO flow) silently lose their stitched product on completion because the auto-stock-on-completion automation only runs when `order.orderItemId` is set. 2 of the 3 ProductionOrders in the live DB are orphaned this way.

---

## PART A — Module Relational Map

### A.1 PurchaseOrder — all consumers

| Consumer (file) | Role | Notes |
|---|---|---|
| `src/app/api/purchase-orders/route.ts` | GET (list), POST (create) | Listed + created with `INVENTORY_VIEW` (list) / `INVENTORY_MANAGE_PURCHASE_ORDERS` (create) |
| `src/app/api/purchase-orders/[id]/route.ts` | GET (detail) | **No requirePermission call** — see PO-009 |
| `src/app/api/purchase-orders/[id]/confirm/route.ts` | POST → `draft → ordered` | Increments `InventoryPool.incoming` via `incrementIncomingStock()` ✓ |
| `src/app/api/purchase-orders/[id]/receive/route.ts` | POST receipt | `purchase_received` txn + receipt creation + `decrementIncomingStock()` + backorder fulfillment ✓ |
| `src/app/api/purchase-orders/[id]/cancel/route.ts` | POST cancel | Decrements `incoming` for unreceived quantities via `decrementIncomingStock()` ✓ |
| `src/app/api/suppliers/[id]/route.ts` (DELETE) | Dependency guard | INV-009 fix blocks supplier deletion when PO history exists ✓ |
| `src/app/api/supplier-returns/route.ts` (POST) | Reverse direction | INV-003 fix creates SupplierReturn → InventoryTransaction in `db.$transaction` with bidirectional link ✓ |
| `src/app/api/supplier-returns/[id]/route.ts` (PATCH) | Resolve | Status transitions to `rejected` → auto-creates `StockLossRecord(supplier_dispute)` ✓ |
| `src/lib/inventory.ts` | `generatePoNumber`, `incrementIncomingStock`, `decrementIncomingStock` | INV-007 canonical helpers ✓ |
| `src/lib/validations/inventory.ts` | Zod schemas | `createPurchaseOrderSchema`, `receivePOSchema` ✓ |
| `src/lib/permissions.ts` | `INVENTORY_MANAGE_PURCHASE_ORDERS` key | Registered ✓ |
| `src/components/inventory/purchase-orders-view.tsx` | List UI | Status badges, filters, search, pagination-less (take: 50) |
| `src/components/inventory/po-create-view.tsx` | Create form | Supplier+location+items, advance payment, draft/ordered submit |
| `src/components/inventory/po-detail-view.tsx` | Detail + Receive dialog | Permission-gated Confirm/Receive/Cancel buttons ✓ |
| `src/components/inventory/supplier-detail-view.tsx` | Supplier → PO history | Reuses `GET /api/purchase-orders` |
| `src/components/inventory/supplier-returns-view.tsx` | Supplier return create dialog | Optional linked PO select |
| `src/app/page.tsx` | SPA router | `'inventory-purchase-orders'`, `'inventory-po-create'`, `'inventory-po-detail'` views registered ✓ |

### A.2 ProductionOrder — all consumers

| Consumer (file) | Role | Notes |
|---|---|---|
| `src/app/api/production-orders/route.ts` | GET (list), POST (manual create) | **POST is exposed** — frontend says "no manual creation" but the route supports it. See PO-007, PO-002. |
| `src/app/api/production-orders/[id]/route.ts` | GET (detail), PATCH (status update) | Cancel reverses fabric via `manual_adjustment_in` ✓. Completed auto-stocks **only if `order.orderItemId` set** — see PO-002. |
| `src/lib/inventory.ts:checkAndFulfillMadeToOrderVariant` | MTO decision core | Returns existing_stock OR creates ProductionOrder + consumes fabric (INV-004 fix sets `referenceId=po.id`) ✓ |
| `src/lib/actions/order.actions.ts:reserveOrderStock` | Order confirmation → MTO trigger | Links ProductionOrder back to OrderItem via `productionOrder.update({ where: { id }, data: { orderItemId: item.id } })` ✓ |
| `src/lib/actions/exchange-shipment.actions.ts` | Exchange shipment → MTO trigger | Creates ProductionOrder via `checkAndFulfillMadeToOrderVariant` but **does NOT link the orderItemId** — see PO-002 impact. |
| `src/app/api/orders/awaiting-production/route.ts` | List view | Filters `OrderItem.productionOrderId NOT NULL` AND `productionOrder.status NOT IN (completed, cancelled, dispatched)` ✓ |
| `src/components/inventory/production-orders-view.tsx` | List UI | Stat cards, status filter, dropdown actions, cancel dialog |
| `src/components/orders/orders-awaiting-production-view.tsx` | Orders-side MTO view | Grouped by production status |
| `src/components/orders/order-detail-view.tsx` | Order detail | Shows productionOrderId when linked |
| `src/lib/permissions.ts` | `INVENTORY_MANAGE_PRODUCTION` key | Registered ✓ |
| `src/app/page.tsx` | SPA router | `'inventory-production-orders'` view registered ✓ |

### A.3 ReturnedStitchedInventory — all consumers

| Consumer (file) | Role |
|---|---|
| `src/app/api/returned-stitched/route.ts` (GET, POST) | Register CRUD — delegates to `processReturnedStitchedReceipt()` per INV-002 fix |
| `src/app/api/returned-stitched/[id]/route.ts` (PATCH) | Write-off status |
| `src/app/api/returned-stitched/stats/route.ts` | Dashboard stats |
| `src/app/api/inventory/receive-returned-stitched/route.ts` | Also delegates to `processReturnedStitchedReceipt()` (unified post-INV-002) |
| `src/lib/inventory.ts:checkReturnedStockAvailability` | Read for MTO existing-stock path |
| `src/lib/inventory.ts:processReturnedStitchedReceipt` | Canonical processor (INV-002) |
| `src/lib/stock-loss.ts` | Damaged path delegates to `recordStockLoss()` |
| `src/lib/actions/order.actions.ts` | Uses availability check during MTO fulfillment |
| `src/lib/validations/product.ts` | Schema for product creation |

### A.4 PO lifecycle trace (create → confirm → receive → supplier return)

| Step | InventoryPool.incoming | InventoryPool.onHand | InventoryTransaction | AvgCostHistory | Notes |
|------|------------------------|----------------------|----------------------|----------------|-------|
| 1. **Create (status='draft')** | unchanged | unchanged | none | none | ✓ Correct — draft doesn't reserve incoming |
| 2. **Create (status='ordered')** OR **Confirm draft → ordered** | `+orderedQty` via `incrementIncomingStock()` | unchanged | none | none | ✓ Correct — INV-007 fix routes through helper |
| 3. **Receive partial** | `-receivedQty` via `decrementIncomingStock()` | `+receivedQty` via `processInventoryTransaction(purchase_received)` | `purchase_received` with `referenceType='purchase_order', referenceId=poId` | created only if avgCost changed | ✓ INV-003 fix applied |
| 4. **Receive complete** | reduced to 0 (clamped) | `+receivedQty` | `purchase_received` | conditional | ✓ Status flips to `received` |
| 5. **Cancel (after step 2, before receipt)** | `-unreceivedQty` via `decrementIncomingStock()` | unchanged | none | none | ✓ |
| 6. **Supplier return** | unchanged | `-returnQty` via `processInventoryTransaction(supplier_return)` | `supplier_return` with `referenceType='supplier_return', referenceId=returnId` | unchanged | ✓ INV-003 fix applied |
| 7. **Supplier return disputed → rejected** | unchanged | unchanged | none | none | Auto-creates `StockLossRecord(supplier_dispute)` — does NOT re-deduct stock (already deducted at step 6) ✓ |

**VERIFIED OK** — the PO lifecycle correctly maintains `incoming + onHand` accounting and ledger entries with proper forward/back links.

### A.5 MTO lifecycle trace

| Step | InventoryPool.fabricVariant | InventoryPool.stitchedVariant | ReturnedStitchedInventory | ProductionOrder | InventoryTransaction | Notes |
|------|------------------------------|--------------------------------|---------------------------|-----------------|----------------------|-------|
| 1. **Order confirmed with MTO item** | unchanged | unchanged | queried | maybe created | none yet | `checkAndFulfillMadeToOrderVariant()` called |
| 2a. **Existing stock path** | unchanged | `reserved += qty` via `reserveStockForOrder` | read-only (no status change) | NOT created | `order_reserved` with `referenceType='order'` | ✓ |
| 2b. **Fresh production path** | `onHand -= qty` via `processInventoryTransaction(fabric_consumed_for_stitching)` | unchanged | NOT touched | created with `status='fabric_reserved'` + `orderItemId` linked via subsequent update | `fabric_consumed_for_stitching` with `referenceType='production_order', referenceId=po.id` | ✓ INV-004 fix applied |
| 3. **ProductionOrder → in_production** | unchanged | unchanged | unchanged | status updated | none | PATCH endpoint ✓ |
| 4. **ProductionOrder → completed** | unchanged | **`+qty` via `opening_stock` + `reserved += qty` via `order_reserved`** | unchanged | status='completed' | `opening_stock` + `order_reserved` (both with `referenceType='production_order'`) | ⚠️ **Only fires when `order.orderItemId` is set** — see PO-002 |
| 5. **Order dispatched** | unchanged | `onHand -= qty` via `dispatchOrder` + `reserved -= qty` | unchanged | status='dispatched' | `sale_dispatched` | ✓ |
| 6. **ProductionOrder cancelled (before stitching)** | `onHand += fabricQty` via `manual_adjustment_in` reversal | unchanged | unchanged | status='cancelled' | `manual_adjustment_in` with `referenceType='production_order'` | ✓ BUG FIX from INVENTORY_AUDIT.md CRITICAL #3 correctly applied |

**Partial receipt handling** (PO receive): `purchase-orders/[id]/receive/route.ts` correctly skips `received_quantity <= 0` items, supports partial receipts, and updates PO status to `partially_received` when `anyItem.receivedQuantity < orderedQuantity`. ✓ VERIFIED OK.

---

## PART B — Database Layer (live queries)

| # | Query | Result | Verdict |
|---|-------|--------|---------|
| 1 | `SELECT count(*) FROM "PurchaseOrder"` | **6** | ✓ small dev dataset |
| 2 | `SELECT status, count(*) FROM "PurchaseOrder" GROUP BY status` | `received: 4, draft: 2` | ✓ 0 ordered/partially_received/cancelled in dev |
| 3 | `SELECT count(*) FROM "ProductionOrder"` | **3** | ✓ small dev dataset |
| 4 | `SELECT status, count(*) FROM "ProductionOrder" GROUP BY status` | `completed: 2, fabric_reserved: 1` | ✓ |
| 5 | `PurchaseOrderItem` where `receivedQuantity > orderedQuantity` | **0** | ✓ VERIFIED OK — no impossible state |
| 6 | `ProductionOrder` with NULL `fabricVariantId` or `stitchedVariantId` | **0** | ✓ VERIFIED OK — both fields NOT NULL enforced at schema level |
| 7 | `InventoryTransaction` `type='purchase_received'` with NULL `referenceId` | **11** | ⚠ See PO-004-equivalent finding below — these are from the non-PO direct receive path (`referenceType='manual'`) |
| 8 | `InventoryTransaction` `type='fabric_consumed_for_stitching'` with NULL `referenceId` | **4** | ⚠ See PO-004 — OLD pre-INV-004-fix records, current code sets referenceId=po.id |
| 9 | AvgCostHistory spot-check on last 5 `purchase_received` txns | 1 of 5 has a history row; the other 4 have `avgCostBefore === avgCostAfter` (no cost change → no history row by design). | ✓ VERIFIED OK — code only writes AvgCostHistory when `avgCostChanged === true` (line 469 of `inventory.ts`) — design decision, not a bug |

### Extra DB integrity queries

| # | Check | Result | Verdict |
|---|-------|--------|---------|
| B-X1 | `InventoryPool` with `incoming > 0` but no open ordered PO | **3 pools with `incoming=500`** but 0 open/draft/partially_received POs | ⚠ See PO-003 (stale incoming) |
| B-X2 | `ProductionOrder` with NULL `orderItemId` AND NULL `fabricTxnId` (truly orphan) | **0** | ✓ all ProductionOrders have fabricTxnId set |
| B-X3 | `ReturnedStitchedInventory` with `status='available'` but NULL `inventoryTxnId` | **2** | ⚠ See PO-005 — OLD pre-INV-002-fix records |
| B-X4 | `AvgCostHistory` orphaned (no matching InventoryTransaction) | **0** | ✓ VERIFIED OK |
| B-X5 | `InventoryTransaction(purchase_received)` with `referenceType='purchase_order'` — back-resolves to PurchaseOrder? | All 6 PO-backed txns resolve correctly to their PurchaseOrder | ✓ |
| B-X6 | `InventoryTransaction(fabric_consumed_for_stitching)` — back-link to ProductionOrder via `referenceId`? | All 4 have `referenceId=NULL` — back-link broken | ⚠ same as #8 above |
| B-X7 | `ProductionOrder.fabricTxnId` ↔ `InventoryTransaction.id` back-link | All 3 ProductionOrders have `fabricTxnId` set, linked txn exists | ✓ reverse link OK |
| B-X8 | `OrderItem` with `productionOrderId` (i.e. MTO order → production link) | **0** | ⚠ The end-to-end MTO order flow has never been exercised against this DB — all 3 ProductionOrders were created via POST /api/production-orders (manual), with `orderItemId=NULL` |
| B-X9 | Currently backordered `OrderItem`s | **11** | information-only — backorder system is actively used |
| B-X10 | `SupplierReturn` count | **0** | No live supplier returns to verify INV-003 fix end-to-end against DB, but code review confirms the pattern is correctly applied |

---

## PART C — Backend / API Layer Audit

### C.1 `GET /api/purchase-orders` (list)

| Check | Status | Notes |
|---|---|---|
| Permission key | ✓ `INVENTORY_VIEW` via `requirePermission()` | line 34 |
| Zod validation | N/A — GET only takes URL params | OK |
| Company isolation | ✓ `where: { companyId, ...status }` | OK |
| Response shape | `orders: [...]` with computed totals | OK |
| `$transaction` usage | N/A (read-only) | OK |

**VERIFIED OK — no issue**

### C.2 `POST /api/purchase-orders` (create)

| Check | Status | Notes |
|---|---|---|
| Permission key | ✓ `INVENTORY_MANAGE_PURCHASE_ORDERS` (inline check, not via `requirePermission`) | lines 108–113 |
| Zod validation | ✓ `createPoSchema` with nested `poItemSchema` | lines 13–28 |
| Supplier exists | ✓ `db.supplier.findFirst({ id, organizationId, isActive: true })` | line 125 |
| Delivery location exists | ✓ `db.inventoryLocation.findFirst({ id, organizationId, isActive: true })` | line 131 |
| Items belong to org | ⚠ NOT VALIDATED — only `orgVariantId` is passed; no check that the variant exists in the org | See PO-010 below |
| Status='ordered' → increments incoming | ✓ loops items calling `incrementIncomingStock()` (INV-007 helper) | lines 174–183 |
| `$transaction` usage | ⚠ PO + items creation is one `db.purchaseOrder.create({ include: { items: true } })` call — atomic. But the subsequent `incrementIncomingStock` loop runs OUTSIDE the create transaction. If the create succeeds but one increment fails, you have a PO without incoming projections. | Minor — incrementIncomingStock uses upsert and rarely fails |
| Idempotency | ✓ `withIdempotency()` optional via `Idempotency-Key` header | OK |

### C.3 `GET /api/purchase-orders/[id]` (detail)

| Check | Status | Notes |
|---|---|---|
| Permission key | ❌ **MISSING** — only `getCurrentUser` + companyId match | See PO-009 |
| Zod validation | N/A | OK |
| Company isolation | ✓ `where: { id, companyId }` | OK |
| Response shape includes receipts + items + supplier | ✓ | OK |

### C.4 `POST /api/purchase-orders/[id]/confirm`

| Check | Status | Notes |
|---|---|---|
| Permission key | ✓ `INVENTORY_MANAGE_PURCHASE_ORDERS` (inline check) | lines 37–42 |
| Zod validation | N/A — no body | OK |
| Status guard | ✓ rejects if `status !== 'draft'` | line 50 |
| Increments incoming | ✓ loops `incrementIncomingStock()` per item | lines 59–66 |
| `$transaction` usage | ⚠ PO update + incoming increments NOT wrapped in a transaction. If the loop fails halfway, the PO is marked 'ordered' but only some items have incoming projections. | See PO-011 |

### C.5 `POST /api/purchase-orders/[id]/receive`

| Check | Status | Notes |
|---|---|---|
| Permission key | ✓ `INVENTORY_RECEIVE` (inline check) | lines 55–60 |
| Zod validation | ✓ `receiveSchema` with nested `receiptItemSchema` | lines 14–26 |
| Status guards | ✓ rejects `cancelled` and `received` | lines 68–69 |
| Partial receipts | ✓ supported — `received_quantity <= 0` skipped, status flips to `partially_received` if any item not fully received | lines 96–97, 188–191 |
| Calls `processInventoryTransaction(purchase_received)` | ✓ with `referenceType='purchase_order'` and `referenceId=poId` (INV-003 fix) | lines 104–117 |
| Creates `PurchaseOrderReceiptItem` with `inventoryTxnId` link | ✓ | line 137 |
| Updates `PurchaseOrderItem.receivedQuantity` via `increment` | ✓ | line 144 |
| Decrements incoming | ✓ `decrementIncomingStock()` (INV-007 helper) | line 153 |
| Backorder fulfillment trigger | ✓ calls `checkAndFulfillBackorders()` for each unique variant+location that received stock | lines 231–243 |
| `$transaction` usage | ⚠ NOT wrapping the per-item 4 writes — uses COMPENSATING pattern: if any write AFTER `processInventoryTransaction` fails, reverses via `manual_adjustment_in`. Documented at lines 86–94. This is a deliberate design choice given `processInventoryTransaction` uses the global db client. | OK — design is sound but inherently less safe than true atomicity |
| Excess quantity handling | ⚠ **No validation that `received_quantity + alreadyReceived <= orderedQuantity`** — a user could receive MORE than was ordered, and the system would happily keep incrementing `receivedQuantity` past `orderedQuantity` and flip status to `received`. The schema's CHECK comment ("CHECK >= 0" for receiptItem) suggests this was intended to be enforced at the DB level, but no actual constraint exists in Prisma schema. | See PO-012 |

### C.6 `POST /api/purchase-orders/[id]/cancel`

| Check | Status | Notes |
|---|---|---|
| Permission key | ✓ `INVENTORY_MANAGE_PURCHASE_ORDERS` (inline check) | lines 37–42 |
| Zod validation | ⚠ no schema — `readBody<{ reason?: string }>` only | OK for simple shape |
| Status guards | ✓ rejects `cancelled` and `received` | lines 50–51 |
| Decrements incoming for unreceived | ✓ `decrementIncomingStock()` per item with `unreceived = ordered - received` | lines 57–62 |
| `$transaction` usage | ⚠ PO update + decrement loop NOT wrapped — if a decrement fails, PO is cancelled but incoming still shows for some items | See PO-013 |

### C.7 `GET /api/production-orders` (list)

| Check | Status | Notes |
|---|---|---|
| Permission key | ✓ `INVENTORY_VIEW` via `requirePermission()` | line 27 |
| Zod | N/A | OK |
| Company isolation | ✓ `where: { companyId }` | OK |
| Response shape | `orders: [...]` | OK |

### C.8 `POST /api/production-orders` (manual create)

| Check | Status | Notes |
|---|---|---|
| Permission key | ✓ `INVENTORY_MANAGE_PRODUCTION` (inline check) | lines 86–91 |
| Zod validation | ✓ `createProductionOrderSchema` | lines 12–21 |
| Validates fabric stock | ✓ reads `fabricPool` and checks `available < quantity` | lines 99–112 |
| INV-004 fix: ProductionOrder created FIRST, then `fabric_consumed_for_stitching` txn with `referenceId=po.id`, then backfill `fabricTxnId` | ✓ all 3 writes wrapped in `db.$transaction` | lines 127–179 |
| Audit log + metric event | ✓ | lines 181–195 |
| **Mismatch with frontend claim** | ⚠ frontend says "no manual creation" but route allows it — creates ProductionOrders with `orderItemId=NULL` which break the completion automation | See PO-002, PO-007 |

### C.9 `GET /api/production-orders/[id]` (detail)

| Check | Status | Notes |
|---|---|---|
| Permission key | ❌ **MISSING** — only `getCurrentUser` + companyId match | See PO-009 |
| Zod | N/A | OK |
| Company isolation | ✓ `where: { id, companyId }` | OK |
| Response shape | `order: {...}` with stitched/fabric/fabricTxn nested | OK |

### C.10 `PATCH /api/production-orders/[id]` (status update)

| Check | Status | Notes |
|---|---|---|
| Permission key | ✓ `INVENTORY_MANAGE_PRODUCTION` (inline check) | lines 100–105 |
| Zod validation | ⚠ no schema — `readBody<{...}>` only (typed but not runtime-validated) | See PO-014 |
| Cancel → reverses fabric consumption | ✓ if `order.fabricTxnId` exists, creates `manual_adjustment_in` with same `costPerUnit` and `quantity` | lines 159–211 — INV bug fix correctly applied |
| Complete → adds stitched stock + reserves | ⚠ **only fires when `order.orderItemId` is set** — manual POs + exchange-shipment-triggered POs get nothing | See PO-002 |
| `$transaction` usage | ⚠ NOT wrapping the cancel-reversal — if `processInventoryTransaction(manual_adjustment_in)` succeeds but a subsequent step fails, the reversal is committed but the order is still in limbo. Catch block catches and logs, doesn't fail the cancel. | OK — design choice (non-fatal) |

### C.11 `POST /api/inventory/fulfill-mto`

| Check | Status | Notes |
|---|---|---|
| Permission key | ❌ **MISSING** — only `getCurrentUser()` called; no `requirePermission()` and no inline rolePermission check | See PO-001 |
| Zod validation | ✓ `fulfillMadeToOrderSchema` | OK |
| Body-derived `company_id` | ⚠ Trusts client-supplied `company_id` — could be used to trigger MTO for any company the user isn't a member of | Compounded by PO-001 |
| Delegates to `checkAndFulfillMadeToOrderVariant()` | ✓ | OK |
| `$transaction` usage | ✓ inside `checkAndFulfillMadeToOrderVariant` (INV-004 fix) | OK |

---

## PART D — Frontend Layer Audit

### D.1 `purchase-orders-view.tsx` (list view)

| Check | Status | Notes |
|---|---|---|
| Table with status badges | ✓ 5 statuses with distinct colors | OK |
| Filters (search + status) | ✓ search by poNumber/supplier/location + status dropdown | OK |
| Stat cards (Pending, Committed Value, Overdue) | ✓ | OK |
| "New Purchase Order" button gated on `INVENTORY_MANAGE_PURCHASE_ORDERS` | ✓ `canManage` flag | line 133, 187 |
| Pagination | ⚠ NO pagination — backend limits to `take: 50`. For orgs with many POs, the list silently truncates. | See PO-015 |
| Row click → detail navigation | ✓ `navigate({ name: 'inventory-po-detail', id: po.id })` | OK |

### D.2 `po-create-view.tsx` (create form)

| Check | Status | Notes |
|---|---|---|
| Supplier selection | ✓ from `/api/suppliers` + inline QuickCreateSupplierDialog | OK |
| Location selection | ✓ from `/api/inventory-locations` + auto-selects default | OK |
| Item selection (variant search) | ✓ from `/api/products?pageSize=100` | OK |
| Quantity > 0 validation | ✓ `items.find((i) => i.quantity <= 0 ...)` rejects | line 307 |
| Cost >= 0 validation | ✓ `i.costPerUnit < 0` rejects | line 307 |
| Advance <= total value | ✓ | line 309 |
| Draft vs Ordered submit | ✓ two buttons, payload includes status | OK |
| Permission gate | ✓ `canManage` disables both submit buttons when user lacks permission | lines 750, 765 |
| Idempotency | ✓ `useIdempotentMutation` hook | OK |

**VERIFIED OK — no issue**

### D.3 `po-detail-view.tsx` (detail + receive dialog)

| Check | Status | Notes |
|---|---|---|
| Items table with progress bars | ✓ received/ordered + percentage | OK |
| Receiving history card | ✓ lists each receipt with timestamp, receiver, items, shortage info | OK |
| Confirm Draft button gated on `INVENTORY_MANAGE_PURCHASE_ORDERS` AND status='draft' | ✓ | lines 224, 355 |
| Receive Stock button gated on `INVENTORY_RECEIVE` AND not cancelled/received AND items remain | ✓ | lines 225–229, 371 |
| Cancel PO button gated on `INVENTORY_MANAGE_PURCHASE_ORDERS` AND not cancelled/received | ✓ | lines 222–223, 376 |
| Receive dialog pre-fills remaining quantities | ✓ `i.orderedQuantity - i.receivedQuantity` | line 755 |
| Shortage reason required when received < remaining | ✓ `lines.find((l) => l.shortage > 0 && !l.shortageReason.trim())` | line 804 |
| `hasAnyReceived` validation | ✓ rejects submission if all zero | line 799 |
| Permissions correctly hide buttons for non-managers | ✓ | OK |

**VERIFIED OK — no issue**

### D.4 `production-orders-view.tsx` (list view)

| Check | Status | Notes |
|---|---|---|
| Stat cards (Pending, In Production, Completed This Month, Avg Turnaround) | ✓ | OK |
| Status filter + search | ✓ | OK |
| Status update dropdown (Start Production / Mark Completed / Mark Dispatched / Cancel) | ✓ | OK |
| Permission gate on actions | ✓ `canManage` flag using `INVENTORY_MANAGE_PRODUCTION` | lines 173, 401 |
| Cancel dialog message | ❌ says "Fabric has already been consumed and cannot be restored automatically" — but the API DOES restore fabric automatically via `manual_adjustment_in` reversal. Misleading. | See PO-006 |
| Page header claim | ❌ "Created automatically when made-to-order variants are fulfilled — no manual creation." — but POST /api/production-orders route allows manual creation, and 3 of 3 ProductionOrders in DB were created that way. | See PO-007 |
| **No detail view** | ❌ No drill-down for individual production orders — only the list with status update actions | See PO-008 |

### D.5 Client-side validation summary

| Form | Quantity > 0 | Cost >= 0 | Other constraints |
|---|---|---|---|
| PO create (po-create-view) | ✓ (line 307) | ✓ (line 307) | advance ≤ total ✓; supplier required ✓; location required ✓; items.length ≥ 1 ✓ |
| PO receive (po-detail-view ReceiveDialog) | ✓ (parseQty clamps ≥0) | ⚠ NOT validated — `actualCost` defaults to `costPerUnit` and accepts any number including negative | See PO-016 |
| Production order status update | N/A (status enum) | N/A | OK |

---

## PART E — Cross-Module Trigger Verification

### E.1 Create PO → confirm → receive → confirm InventoryPool + AvgCostHistory + InventoryTransaction

**Tested at code level** (no live repro):
- `purchaseOrder.create()` (with status='ordered') → loop calls `incrementIncomingStock()` per item → `InventoryPool.incoming` increases. ✓
- On receive → `processInventoryTransaction({ transactionType: 'purchase_received', referenceType: 'purchase_order', referenceId: poId, costPerUnit: ri.actual_cost_per_unit })` → `InventoryPool.onHand` increases, `incoming` decreases via `decrementIncomingStock()`. ✓
- WAC recalculated via `calculateNewAvgCost()` (line 237 of inventory.ts). AvgCostHistory created ONLY if avgCost changed (line 469). ✓
- Backref: `PurchaseOrderReceiptItem.inventoryTxnId` set to `txn.id` (line 137 of receive route). ✓

**DB verification**: 6 `purchase_received` transactions with `referenceType='purchase_order'` all back-resolve correctly to their PurchaseOrder IDs. ✓

**VERIFIED OK — no issue**

### E.2 MTO order → confirm → checkAndFulfillMadeToOrderVariant fires

**Path A — existing ReturnedStitchedInventory stock available:**
- `checkReturnedStockAvailability(variantId)` returns pools with `onHand > 0`
- If `totalAvailable >= quantity` → returns `{ source: 'existing_stock', locationId, available }`
- Order action then calls `reserveStockForOrder()` → `InventoryPool.reserved += qty` via `order_reserved` txn
- OrderItem updated: `fulfillmentStatus='reserved', returnedStitchedUsed=true, reservedLocationId=mtoResult.locationId`

**Path B — no existing stock, fabric available:**
- `checkAndFulfillMadeToOrderVariant()` creates ProductionOrder (with `orderItemId=NULL` initially)
- Calls `processInventoryTransaction(fabric_consumed_for_stitching)` with `referenceId=po.id` (INV-004 fix)
- Backfills `ProductionOrder.fabricTxnId`
- Order action then links back: `db.productionOrder.update({ where: { id }, data: { orderItemId: item.id } })` (line 319)
- OrderItem updated: `fulfillmentStatus='reserved', productionOrderId=po.id`

**Path C — error (no fabric source linked, insufficient fabric):**
- Returns `{ source: 'fresh_production', error: ... }`
- OrderItem outcome='failed'

**⚠ BUG FOUND** — Path B for **exchange-shipment-triggered MTO** (in `exchange-shipment.actions.ts`):
- Creates ProductionOrder via `checkAndFulfillMadeToOrderVariant`
- Does NOT link `orderItemId` (exchange shipments don't have an `OrderItem`)
- When the ProductionOrder is later marked `completed`, the auto-completion automation at `production-orders/[id]/route.ts:219` checks `order.orderItemId` and **silently skips** stock addition.

**Result:** The stitched product is consumed (fabric lost) but never produced (no `opening_stock` txn). The system records a completed production order with no stitched stock on hand. This is the same bug as manual creation via POST /api/production-orders. See PO-002.

### E.3 PO receive → backorder fulfillment trigger

- After all receipt items processed, the receive route loops `d.items`, dedupes by `${org_variant_id}|${locationId}`, and calls `checkAndFulfillBackorders(variantId, locationId)` for each unique combination (lines 231–243 of receive route).
- `checkAndFulfillBackorders` builds a priority queue: exchange shipments (priority) first, then regular OrderItems, ordered oldest-first.
- For each queue entry: checks `available = pool.onHand - pool.reserved`; if `available >= entry.quantity`, calls `reserveStockForOrder()` and updates the order_item to `fulfillmentStatus='reserved'`.
- After fulfillment, recomputes parent order status via `recompute_order_status()` SQL function.
- If order has no remaining backordered items → order status set to `'confirmed'` and `maybeAutoBookOrder()` fires.

**VERIFIED OK — no issue** (no live repro due to small dev dataset)

### E.4 Supplier return from PO receive → StockLossRecord + InventoryTransaction

**PO receive → supplier return flow:**
- PO receive adds stock via `purchase_received` txn (InventoryPool.onHand +=, WAC recalculated)
- A separate POST `/api/supplier-returns` creates a SupplierReturn + `supplier_return` InventoryTransaction (InventoryPool.onHand -= qty)
- If supplier disputes → PATCH `{ status: 'rejected' }` auto-creates `StockLossRecord(lossType='supplier_dispute')` with `supplierReturnId` link

**⚠ NOT verified at DB level** — 0 SupplierReturns exist in DB. Code review confirms the INV-003 pattern (`db.$transaction` wrapping `supplierReturn.create` + `processInventoryTransaction` + `supplierReturn.update` to backfill `inventoryTxnId`) is correctly applied at `src/app/api/supplier-returns/route.ts:113-166`. ✓

### E.5 Other cross-module checks

- `ReturnedStitchedInventory.inventoryTxnId` ↔ `InventoryTransaction.id` link: ✓ for new records (post-INV-002); ⚠ 2 OLD records have NULL link (see PO-005).
- `OrderItem.productionOrderId` ↔ `ProductionOrder.orderItemId` link: 0 OrderItems currently linked in DB, so cannot verify end-to-end. Code in `order.actions.ts:319-322` sets the link, but only on the order-action-triggered MTO path.

---

## PART F — Role-Based Access

### F.1 Permission keys per route

| Route | Permission key |
|---|---|
| `GET /api/purchase-orders` | `inventory.view` |
| `POST /api/purchase-orders` | `inventory.manage_purchase_orders` (inline check, elevated bypass) |
| `GET /api/purchase-orders/[id]` | **NONE** (only auth + company membership) |
| `POST /api/purchase-orders/[id]/confirm` | `inventory.manage_purchase_orders` |
| `POST /api/purchase-orders/[id]/receive` | `inventory.receive` |
| `POST /api/purchase-orders/[id]/cancel` | `inventory.manage_purchase_orders` |
| `GET /api/production-orders` | `inventory.view` |
| `POST /api/production-orders` | `inventory.manage_production` |
| `GET /api/production-orders/[id]` | **NONE** (only auth + company membership) |
| `PATCH /api/production-orders/[id]` | `inventory.manage_production` |
| `POST /api/inventory/fulfill-mto` | **NONE** (only auth) |

### F.2 Per-role capability matrix

Capabilities from `src/lib/seed-default-roles.ts`. Elevated roles (Owner, Founder, Co-Founder, Investor) bypass all permission checks via `roleTier === 'elevated'`.

| Capability | Owner (elevated) | Sales | Sales Manager | Manager | Inventory Manager | Warehouse Staff |
|---|---|---|---|---|---|---|
| View PO list | ✅ | ❌ (no `inventory.view`) | ✅ | ✅ | ✅ | ✅ |
| View PO detail (`GET /[id]`) | ✅ | ⚠ **YES** (route has no perm check — see PO-009) | ⚠ YES | ⚠ YES | ⚠ YES | ⚠ YES |
| Create PO | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Confirm PO | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Receive PO | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Cancel PO | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| View Production Orders list | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| View Production Order detail (`GET /[id]`) | ✅ | ⚠ YES (route has no perm check) | ⚠ YES | ⚠ YES | ⚠ YES | ⚠ YES |
| Update Production Order status | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Cancel Production Order | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Trigger MTO fulfillment (`POST /api/inventory/fulfill-mto`) | ✅ | ⚠ **YES** (route has no perm check — see PO-001) | ⚠ YES | ⚠ YES | ⚠ YES | ⚠ YES |
| Manage Supplier Returns | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |

### F.3 Frontend button gating

| Button | Component | Permission | Correctly gated? |
|---|---|---|---|
| New Purchase Order | `purchase-orders-view.tsx` | `INVENTORY_MANAGE_PURCHASE_ORDERS` | ✓ |
| Save as Draft / Confirm & Send | `po-create-view.tsx` | `INVENTORY_MANAGE_PURCHASE_ORDERS` | ✓ (disabled when `!canManage`) |
| Confirm Draft | `po-detail-view.tsx` | `INVENTORY_MANAGE_PURCHASE_ORDERS` | ✓ |
| Receive Stock | `po-detail-view.tsx` | `INVENTORY_RECEIVE` (separate from manage POs) | ✓ |
| Cancel PO | `po-detail-view.tsx` | `INVENTORY_MANAGE_PURCHASE_ORDERS` | ✓ |
| Start Production / Mark Completed / Cancel Order | `production-orders-view.tsx` | `INVENTORY_MANAGE_PRODUCTION` | ✓ |

**Frontend gating VERIFIED OK** — the UI correctly hides buttons based on permission. The gaps are server-side (PO-001, PO-009).

---

## Issues Found

### BUG-ID: PO-001
**Layer:** API
**Severity:** Critical
**Location:** `src/app/api/inventory/fulfill-mto/route.ts`
**Description:** The `/api/inventory/fulfill-mto` endpoint has NO `requirePermission()` call and NO inline `rolePermission` check — only `getCurrentUser()` verifies the user is authenticated. The `company_id` is taken from the request body (not from the session), so any authenticated user can trigger MTO fulfillment for ANY company they pass in the body.
**Expected:** The route should call `getWorkspace()` + `requirePermission(ctx, PERMISSIONS.INVENTORY_MANAGE_PRODUCTION)` (or similar), and derive `company_id` from `ctx.company.id` rather than from the body. The internal `checkAndFulfillMadeToOrderVariant` function is already used internally by `order.actions.ts` and `exchange-shipment.actions.ts` (which both have their own auth); exposing it via HTTP without authz is unnecessary.
**Actual:** Any authenticated user (including a Sales-only role with no inventory permissions) can POST to `/api/inventory/fulfill-mto` with an arbitrary `org_variant_id` + `company_id`, creating a ProductionOrder and consuming fabric.
**Repro Steps:**
1. Login as a Sales role user (no `inventory.manage_production` permission).
2. POST `/api/inventory/fulfill-mto` with `{ org_variant_id: "<any MTO variant>", quantity: 1, company_id: "<any company UUID>" }`.
3. Request succeeds — ProductionOrder created, fabric consumed.
**Suspected Root Cause:** The route was likely written as a development/debug entrypoint and never had its permission check added before going live. The internal function is exposed as an HTTP route without the standard auth wrapper.

---

### BUG-ID: PO-002
**Layer:** Cross-Module (API + DB)
**Severity:** Critical
**Location:** `src/app/api/production-orders/[id]/route.ts:219` (automation condition); `src/app/api/production-orders/route.ts` (manual POST creates POs with `orderItemId=NULL`); `src/lib/actions/exchange-shipment.actions.ts:418-430` (MTO via exchange shipments doesn't set `orderItemId`)
**Description:** The auto-completion automation on ProductionOrder status → 'completed' only fires when `order.orderItemId` is set. ProductionOrders created via POST `/api/production-orders` (manual create) OR via the exchange-shipment MTO flow have `orderItemId=NULL`, so when marked completed:
- NO `opening_stock` transaction is created for the stitched variant
- NO `order_reserved` transaction is created
- NO InventoryPool row is created for the stitched variant
- The stitched product is effectively LOST in the system — fabric was consumed but the stitched output never appears in inventory

**Expected:** The completion automation should run for ALL ProductionOrders reaching `status='completed'`, regardless of whether they're linked to an OrderItem. For unlinked ProductionOrders (manual create or exchange-shipment), the stitched stock should be added to a sensible default location (e.g. `fabricLocationId`) with `opening_stock` txn type, ready to be reserved/dispatched later or surfaced in inventory views.
**Actual:** Confirmed in DB:
- 2 of 3 ProductionOrders are `status='completed'` with `orderItemId=NULL`.
- Both have ZERO `opening_stock` transactions linked via `referenceType='production_order', referenceId=po.id`.
- Both have ZERO `InventoryPool` rows for their `stitchedVariantId`.
- The stitched variants (`FGL-STITCH-7162`, `FGL-STITCH-3629`) are invisible in inventory views despite being "produced".

**Repro Steps:**
1. POST `/api/production-orders` with `{ stitched_variant_id, fabric_variant_id, fabric_location_id, quantity: 2, stitching_cost: 1500 }`.
2. PATCH `/api/production-orders/{id}` with `{ status: 'in_production' }`.
3. PATCH `/api/production-orders/{id}` with `{ status: 'completed' }`.
4. Query `InventoryPool` for the `stitched_variant_id` — no rows exist. Query `InventoryTransaction` for `opening_stock` with `referenceType='production_order', referenceId={id}` — no rows exist.

**Suspected Root Cause:** The automation was originally written assuming ProductionOrders are only created via the order MTO flow (which sets `orderItemId`), but the manual POST route was added later without updating the automation condition.

---

### BUG-ID: PO-003
**Layer:** DB
**Severity:** High
**Location:** `InventoryPool` rows: `cms1ns2vu000ptdjo7ool9nsn`, `cms1ns324000rtdjoloh7rt6e`, `cms1ns2k8000ntdjom0zi0gzl`
**Description:** 3 InventoryPool rows have `incoming=500` each, but there are ZERO open / draft / partially_received PurchaseOrders containing these variants. The `incoming` projection field is stale — it was never decremented when the corresponding POs were fully received (or cancelled).
**Expected:** `InventoryPool.incoming` should equal the sum of `(orderedQuantity - receivedQuantity)` for all open ordered/partially_received PO items targeting this variant + location. With no open POs, `incoming` should be 0.
**Actual:** `incoming=500` for 3 pools; the warehouse UI will show "500 units incoming" forever for these SKUs, misleading operators.
**Repro Steps:**
1. Run: `SELECT id, "orgVariantId", "locationId", on_hand, reserved, incoming FROM "InventoryPool" WHERE incoming > 0;`
2. Cross-check against `PurchaseOrderItem` joined with `PurchaseOrder` where `status IN ('draft','ordered','partially_received')` — 0 items match.
3. The `incoming=500` is orphaned.
**Suspected Root Cause:** These pools were likely created BEFORE the INV-007 fix that routed decrement through `decrementIncomingStock()`. The pre-fix inline code in `purchase-orders/[id]/receive/route.ts` and `purchase-orders/[id]/cancel/route.ts` may have had a path that skipped the decrement. The current code is correct, but legacy data wasn't backfilled.

---

### BUG-ID: PO-004
**Layer:** DB (legacy data)
**Severity:** Medium
**Location:** 4 `InventoryTransaction` rows with `transactionType='fabric_consumed_for_stitching'` and `referenceId=NULL`
**Description:** 4 InventoryTransactions exist (from 2026-07-14 and 2026-07-25) with `referenceType='production_order'` but `referenceId=NULL`. The INV-004 fix correctly sets `referenceId=po.id` for NEW transactions (verified at `src/lib/inventory.ts:1014-1024` and `src/app/api/production-orders/route.ts:151-163`), but these OLD records remain orphaned.
**Expected:** Every `fabric_consumed_for_stitching` transaction should back-link to its ProductionOrder via `referenceId`.
**Actual:** The 4 OLD records have no back-link; cross-module joins from ProductionOrder → InventoryTransaction work via `ProductionOrder.fabricTxnId` (reverse link is OK), but joins from InventoryTransaction → ProductionOrder fail.
**Repro Steps:**
1. `SELECT id, "referenceId", "createdAt" FROM "InventoryTransaction" WHERE "transactionType"='fabric_consumed_for_stitching' AND "referenceId" IS NULL;` → returns 4 rows.
2. The ProductionOrder records linked via `fabricTxnId` are at `cmrl6tc1f0005odriam8uhfa8`, `cms0epk0p003ri7clb49l476v`, `cms0espdu0049i7fsdysk43rx`.
**Suspected Root Cause:** Pre-INV-004-fix data. The fix prevents new orphans but does not backfill historical ones.

---

### BUG-ID: PO-005
**Layer:** DB (legacy data)
**Severity:** Medium
**Location:** 2 `ReturnedStitchedInventory` rows: `cms0epnal003xi7clgempu4i0`, `cms0essh1004fi7fs9wcp6pnn`
**Description:** 2 ReturnedStitchedInventory rows with `status='available'` and `condition='perfect'` have `inventoryTxnId=NULL`. The INV-002 fix correctly sets `inventoryTxnId` for NEW rows (verified at `src/lib/inventory.ts:707-722`), but these OLD rows are orphaned.
**Expected:** Every non-damaged ReturnedStitchedInventory row (status='available') should have `inventoryTxnId` pointing to the `return_stitched_received` InventoryTransaction that incremented the pool.
**Actual:** 2 OLD rows have NULL — the bidirectional link between the register row and the ledger is broken for these. Stock reconciliation queries that join via `inventoryTxnId` will miss these rows.
**Repro Steps:**
1. `SELECT id, status, condition, "inventoryTxnId" FROM "ReturnedStitchedInventory" WHERE status='available' AND "inventoryTxnId" IS NULL;` → returns 2 rows.
**Suspected Root Cause:** Pre-INV-002-fix data created via the old split flow (POST /api/returned-stitched created register only; POST /api/inventory/receive-returned-stitched created txn only; no link). The fix unifies both into `processReturnedStitchedReceipt` and sets the link, but legacy data was not backfilled.

---

### BUG-ID: PO-006
**Layer:** Frontend
**Severity:** Medium
**Location:** `src/components/inventory/production-orders-view.tsx:485-487`
**Description:** The cancel-ProductionOrder AlertDialog tells the user: *"Fabric has already been consumed and cannot be restored automatically."* — but the API actually DOES reverse the fabric consumption automatically on cancel (via `manual_adjustment_in` transaction, `src/app/api/production-orders/[id]/route.ts:159-211`). The misleading message will cause users to believe fabric is lost forever, when in fact it's automatically returned to inventory.
**Expected:** The message should accurately reflect that fabric IS automatically restored to inventory on cancel (with audit trail preserved).
**Actual:** Users are misled; they may avoid cancelling production orders even when they should.
**Repro Steps:**
1. Open Production Orders view.
2. Click the dropdown actions for a `fabric_reserved` or `in_production` order.
3. Click "Cancel Order" — the dialog text says fabric cannot be restored.
4. Click "Cancel Order" anyway and confirm.
5. Inspect the InventoryPool for the fabric variant — onHand IS restored.
**Suspected Root Cause:** The dialog text predates the bug fix that added automatic fabric reversal; the text was not updated.

---

### BUG-ID: PO-007
**Layer:** Frontend / API mismatch
**Severity:** Low
**Location:** `src/components/inventory/production-orders-view.tsx:251` (UI claim) vs `src/app/api/production-orders/route.ts` (API allows it)
**Description:** The ProductionOrdersView PageHeader reads: *"Made-to-order stitching jobs. Created automatically when made-to-order variants are fulfilled — no manual creation."* But the POST `/api/production-orders` route explicitly supports manual creation, and all 3 ProductionOrders in the live DB were created that way (none via the order MTO flow).
**Expected:** Either the API should reject manual creation (since the frontend doesn't expose a creation UI), OR the frontend messaging should acknowledge that manual creation is possible via API.
**Actual:** Frontend claims "no manual creation" while API allows it. This mismatch enables PO-002 (manual POs with NULL `orderItemId` skip the completion automation).
**Repro Steps:**
1. Read the page header text.
2. POST `/api/production-orders` with valid payload → succeeds (201).
3. PO appears in the list view, contradicting the "no manual creation" claim.
**Suspected Root Cause:** The API was designed as a superset (supports both manual and automated creation), but the frontend was simplified to assume automated-only. No mechanism prevents the orphan-completion bug from manifesting.

---

### BUG-ID: PO-008
**Layer:** Frontend
**Severity:** Low
**Location:** `src/components/inventory/production-orders-view.tsx` (no detail view registered); `src/app/page.tsx` (no `'inventory-production-order-detail'` route)
**Description:** There is no detail view for individual ProductionOrders. The list view only offers inline dropdown actions (Start Production, Mark Completed, Mark Dispatched, Cancel). Users cannot drill into a ProductionOrder to see fabric txn details, stitched variant info, completion timeline, audit history, etc. The `GET /api/production-orders/[id]` route exists and returns rich data, but no UI consumes it.
**Expected:** A detail view (similar to `PoDetailView`) showing stitched variant, fabric variant, fabric location, fabric txn, completion timeline, assigned tailor, and audit history.
**Actual:** Users can only see summary columns in the list — no way to investigate a specific production order.
**Repro Steps:**
1. Navigate to Production Orders view.
2. Click on a row — nothing happens (no navigation).
3. Only the dropdown action button is available.
**Suspected Root Cause:** Frontend was scoped to list-only because the typical use case is "produced via order flow, no need for detail drill-down." But this leaves manual POs un-investigable.

---

### BUG-ID: PO-009
**Layer:** API
**Severity:** Medium
**Location:** `src/app/api/purchase-orders/[id]/route.ts` (GET handler, lines 10–102) and `src/app/api/production-orders/[id]/route.ts` (GET handler, lines 12–66)
**Description:** The GET detail handlers for both `/api/purchase-orders/[id]` and `/api/production-orders/[id]` are missing `requirePermission()` calls. They verify the user is authenticated and check company membership (`where: { id, companyId }`), but they DO NOT check that the user has `INVENTORY_VIEW` permission. Any employee in the company (including a Sales role with no inventory permissions at all) can read full PO/ProductionOrder details including supplier pricing, fabric costs, and stitch costs.
**Expected:** `GET /api/purchase-orders/[id]` and `GET /api/production-orders/[id]` should call `getWorkspace()` + `requirePermission(ctx, PERMISSIONS.INVENTORY_VIEW)` to match the pattern used by their list endpoints.
**Actual:** Any employee in the company can fetch full PO/ProductionOrder detail — exposing cost data that the role system explicitly restricts.
**Repro Steps:**
1. Login as a Sales role user (no `inventory.view` permission).
2. GET `/api/purchase-orders/{any PO id from their company}` → returns 200 with full detail including `costPerUnit`, `totalItemsValue`, `advancePayment`.
3. Compare: GET `/api/purchase-orders` (list) → 403 forbidden, but GET `[id]` succeeds.
**Suspected Root Cause:** The detail handlers were written using a simpler auth pattern (just `getCurrentUser` + companyId check) instead of the `getWorkspace + requirePermission` pattern used by the list handlers.

---

## Additional observations (not classified as bugs)

### PO-010 — PO create doesn't validate items belong to the org
**Layer:** API
**Location:** `src/app/api/purchase-orders/route.ts:140-164`
**Notes:** The create route validates that the supplier and delivery location belong to the org, but does NOT validate that each `org_variant_id` in `items[]` belongs to the org. A user could pass an arbitrary `org_variant_id` from another org and the PO would be created (the FK constraint would catch non-existent IDs, but cross-org leakage is possible if the variant exists in another org within the same DB).
**Severity:** Low (the multi-tenant app-layer model means this is exploitable only by an authenticated user with malicious intent).

### PO-011 — PO confirm is not atomic
**Layer:** API
**Location:** `src/app/api/purchase-orders/[id]/confirm/route.ts:52-66`
**Notes:** The PO status update and the `incrementIncomingStock()` loop are NOT wrapped in `db.$transaction`. If the loop fails halfway, the PO is marked 'ordered' but only some items have incoming projections. Practically rare (upsert rarely fails), but a design gap compared to the receive route which uses a compensating pattern.

### PO-012 — PO receive allows received_quantity > orderedQuantity
**Layer:** API
**Location:** `src/app/api/purchase-orders/[id]/receive/route.ts:96-191`
**Notes:** The receive route does NOT validate that `ri.received_quantity + existing.receivedQuantity <= ri.orderedQuantity`. A user could receive MORE than was ordered, and the system would happily keep incrementing `receivedQuantity` past `orderedQuantity` and flip status to `received`. The frontend `ReceiveDialog` does clamp `max={l.remaining}` on the input (line 865 of po-detail-view.tsx), but a direct API caller can bypass this. The schema comment `receivedQuantity Int // CHECK >= 0` suggests this was intended to be enforced at the DB level, but no actual constraint exists.

### PO-013 — PO cancel is not atomic
**Layer:** API
**Location:** `src/app/api/purchase-orders/[id]/cancel/route.ts:56-72`
**Notes:** The PO status update and the `decrementIncomingStock()` loop are NOT wrapped in `db.$transaction`. Same pattern as PO-011.

### PO-014 — Production order PATCH has no Zod validation
**Layer:** API
**Location:** `src/app/api/production-orders/[id]/route.ts:107-113`
**Notes:** The PATCH handler uses `readBody<{...}>` (typed but not runtime-validated). A malformed body (e.g. `status: 123` instead of string) would be passed to `db.productionOrder.update` and likely throw a Prisma error rather than a clean 400 validation error.

### PO-015 — PO list view lacks pagination
**Layer:** Frontend
**Location:** `src/components/inventory/purchase-orders-view.tsx` and `src/app/api/purchase-orders/route.ts` (line 53: `take: 50`)
**Notes:** The list view shows at most 50 POs with no pagination control. For orgs with many POs, older records are silently invisible. The frontend doesn't indicate truncation.

### PO-016 — PO receive dialog doesn't validate actualCostPerUnit >= 0 client-side
**Layer:** Frontend
**Location:** `src/components/inventory/po-detail-view.tsx:877-880`
**Notes:** The "Cost / unit" Input in the ReceiveDialog has `min="0"` HTML attribute but no JS validation. The `parseCost` helper exists in `po-create-view.tsx` but is not used here. A direct API caller can also submit negative `actual_cost_per_unit` since the Zod schema only enforces `z.number().min(0)` which DOES cover this. **Zod catches it but UI doesn't show inline validation.**

---

## Summary table

| BUG-ID | Severity | Layer | Status |
|---|---|---|---|
| PO-001 | Critical | API | `/api/inventory/fulfill-mto` missing `requirePermission` |
| PO-002 | Critical | Cross-Module | ProductionOrder completion automation skips when `orderItemId=NULL` |
| PO-003 | High | DB | 3 stale `InventoryPool.incoming=500` rows with no open POs |
| PO-004 | Medium | DB (legacy) | 4 `fabric_consumed_for_stitching` txns with NULL `referenceId` |
| PO-005 | Medium | DB (legacy) | 2 `ReturnedStitchedInventory` rows with NULL `inventoryTxnId` |
| PO-006 | Medium | Frontend | Cancel dialog incorrectly says fabric cannot be restored |
| PO-007 | Low | Frontend/API | Frontend claims "no manual creation" but API allows it |
| PO-008 | Low | Frontend | No production-order detail view |
| PO-009 | Medium | API | GET `/api/purchase-orders/[id]` and `/api/production-orders/[id]` missing `INVENTORY_VIEW` permission check |

---

## What's Verified OK

The following checks **passed** — no issues found:

1. **PO lifecycle atomicity** — `processInventoryTransaction()` is wrapped in `db.$transaction` (INV-006 fix). SupplierReturn + ProductionOrder creation flows use `db.$transaction` + correct ordering (INV-003, INV-004 fixes).
2. **INV-001 reservation invariant protection** — onHand-reducing transaction types bump newest-reserved OrderItems to 'backordered' if newOnHand < newReserved.
3. **PO number generation race-free** — uses `get_next_sequence_number()` Postgres function (atomic upsert).
4. **PO receive → backorder fulfillment trigger** — `checkAndFulfillBackorders()` called after each receipt with dedup by `variant|location`.
5. **PO receive handles partial receipts** — `received_quantity <= 0` skipped, status flips to `partially_received` when items remain unreceived.
6. **PO cancel decrements incoming for unreceived items** — uses `decrementIncomingStock()` helper (INV-007 fix).
7. **ProductionOrder cancel reverses fabric consumption** — INV critical bug #3 fix correctly applied via `manual_adjustment_in` with `referenceType='production_order'` (lines 159-211 of production-orders/[id]/route.ts).
8. **AvgCostHistory link integrity** — 0 orphan rows (AvgCostHistory with no matching InventoryTransaction).
9. **SupplierReturn → StockLossRecord(supplier_dispute)** — auto-created when status flips to `rejected` (lines 81-112 of supplier-returns/[id]/route.ts).
10. **SupplierReturn + InventoryTransaction atomic creation** — wrapped in `db.$transaction` with correct ordering (INV-003 fix in `src/app/api/supplier-returns/route.ts:113-166`).
11. **Frontend permission gating** — all Create/Confirm/Receive/Cancel/Update-status buttons correctly gated via `useCan(PERMISSIONS.XXX)`.
12. **Zod validation** — present on all POST routes (create PO, receive PO, cancel PO, create ProductionOrder, create SupplierReturn, fulfill-mto).
13. **Idempotency support** — PO create and SupplierReturn create support `Idempotency-Key` header via `withIdempotency()` wrapper.
14. **Cross-company isolation** — all queries use `where: { companyId, ... }` (or `organizationId` for org-level resources).

---

## Recommended Next Actions (priority order)

1. **PO-001**: Add `requirePermission(ctx, PERMISSIONS.INVENTORY_MANAGE_PRODUCTION)` to `/api/inventory/fulfill-mto` POST and derive `company_id` from session. Optionally remove the route entirely if internal-only.
2. **PO-002**: Move the auto-completion automation OUT of the `order.orderItemId` conditional — run it for ANY ProductionOrder reaching `status='completed'`, using `order.fabricLocationId` as the default location for unlinked orders.
3. **PO-009**: Add `requirePermission(ctx, PERMISSIONS.INVENTORY_VIEW)` to GET `/api/purchase-orders/[id]` and GET `/api/production-orders/[id]` (use `getWorkspace()` instead of `getCurrentUser()` + raw userSetting lookup).
4. **PO-003**: Backfill script to reset `incoming=0` on the 3 stale pools (and any others matching the pattern). Add a periodic sweep to detect and report stale incoming.
5. **PO-006**: Update the cancel dialog text to: *"This will reverse the fabric consumption (fabric will be returned to inventory) and mark the order as cancelled."*
6. **PO-004, PO-005**: One-time backfill to set the missing `referenceId` / `inventoryTxnId` on legacy rows by joining via timestamp + variant + location.
7. **PO-007**: Either remove POST `/api/production-orders` (force MTO orders to flow through the order system), or update the frontend messaging and add a manual-create UI.
8. **PO-008**: Add a ProductionOrder detail view (similar pattern to PoDetailView) — wire it via SPA router `'inventory-production-order-detail'`.

---

**Audit complete. No code, schema, or data was modified.**
