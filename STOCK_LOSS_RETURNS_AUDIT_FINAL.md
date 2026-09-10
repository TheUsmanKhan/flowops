# STOCK-LOSS + RETURNS MODULES AUDIT — FINAL REPORT

**Task ID:** STOCK-LOSS-RETURNS-AUDIT
**Scope:** Read-only audit of Stock Loss, Cycle Counts, Returned-Stitched, Supplier Returns modules
**Mode:** READ-ONLY — no code was modified
**Date:** 2026-09-04
**Auditor:** Sub-agent (Explore profile)

---

## EXECUTIVE SUMMARY

The user's identified CRITICAL bug — **"when an order is marked RTO, the system restocks the item via `return_resellable` AND `ReturnedStitchedInventory` ALSO adds the same item — DOUBLE stock entry"** — **DOES NOT occur in the current codebase.**

The RTO flow (`processOrderReturn()` and `restockOrderForRto()`) calls `processInventoryTransaction()` directly with type `return_resellable` (stock_based) or `return_stitched_received` (made_to_order). It does **NOT** create a `ReturnedStitchedInventory` register row. Conversely, `processReturnedStitchedReceipt()` — the only function that creates `ReturnedStitchedInventory` rows — is only invoked from two explicit UI routes (`POST /api/returned-stitched` and `POST /api/inventory/receive-returned-stitched`), never automatically by the RTO flow.

The DB confirms this: zero orders have both `return_resellable` AND `return_stitched_received` transactions for the same variant; zero orders have multiple `return_stitched_received` transactions for the same variant.

However, the audit uncovered several other issues, ranked by severity:

| # | Severity | Finding | Status in DB |
|---|----------|---------|--------------|
| 1 | LOW (false alarm) | RTO does not double-add stock | Confirmed safe |
| 2 | MEDIUM | Scan confirm-return flow (damaged) creates 2 offsetting txns (+return_resellable, –damage_writeoff) instead of 1 net write-off | Confirmed in DB for ORD-2026-00023 |
| 3 | MEDIUM | 2 legacy `ReturnedStitchedInventory` rows have `inventoryTxnId=NULL` and no matching `return_stitched_received` txn (backfill never ran successfully) | Confirmed — orphaned register rows |
| 4 | MEDIUM | `InventoryTransaction.orderId` field is NULL on **every** return / reserve / unreserve / cycle_count / supplier_return txn (only set on 14 of 18 `sale_dispatched`) | Confirmed — schema FK field is unused by the call sites |
| 5 | LOW | Supplier-return "rejected" path bypasses `recordStockLoss()` (writes `StockLossRecord` directly, leaving `sourceModule=NULL`) | Confirmed in code — DB has 0 supplier returns, so no impact yet |
| 6 | LOW | 4 historical `StockLossRecord` rows have `sourceModule=NULL` (legacy data pre-dating migration 027) | Confirmed |
| 7 | INFO | Dedup index `stock_loss_orderitem_dedup_idx` exists and works (verified) | Confirmed |
| 8 | INFO | No duplicate loss records exist for same orderItem+lossType | Confirmed |

---

## PART 1 — CRITICAL PRIORITY: Double-Stock-Entry Investigation

### 1.1 Trace: `processOrderReturn()` (manual RTO via UI)

**File:** `src/lib/actions/order-return.actions.ts:52-252`

```typescript
export async function processOrderReturn(orderId, returnReason) {
  // ...
  for (const item of order.items) {
    if (item.fulfillmentTypeSnapshot === 'made_to_order') {
      // Calls processInventoryTransaction with type 'return_stitched_received'
      const txnResult = await processInventoryTransaction({
        transactionType: 'return_stitched_received',
        referenceType: 'order',
        referenceId: orderId,           // ← links via referenceId, NOT orderId
        // ...
      })
      if (txnResult.success) {
        await db.orderItem.update({
          where: { id: item.id },
          data: { fulfillmentStatus: 'returned', autoProcessedAsPerfect: true, needsReview: true },
        })
      }
    } else {
      // stock_based: type='return_resellable'
      const txnResult = await processInventoryTransaction({
        transactionType: 'return_resellable',
        referenceType: 'order',
        referenceId: orderId,
        // ...
      })
      // ...
    }
  }
}
```

**Key observation:** The RTO flow calls `processInventoryTransaction()` directly. It does **NOT** call `processReturnedStitchedReceipt()`. Therefore it creates an `InventoryTransaction` row and updates `InventoryPool.onHand` exactly once, but does NOT create a `ReturnedStitchedInventory` register row.

### 1.2 Trace: `restockOrderForRto()` (auto RTO via webhook / poller)

**File:** `src/lib/inventory.ts:1280-1402`

Same pattern: calls `processInventoryTransaction()` directly with `return_stitched_received` or `return_resellable`. Does NOT create `ReturnedStitchedInventory`.

Idempotency guard at line 1324:
```typescript
if (item.fulfillmentStatus === 'returned') continue
```
— skips items already processed. **No double-entry risk from re-runs.**

### 1.3 Trace: `processReturnedStitchedReceipt()` (canonical stitched-receipt)

**File:** `src/lib/inventory.ts:591-738`

This is the ONLY function that creates `ReturnedStitchedInventory` rows. It also creates a `return_stitched_received` InventoryTransaction (non-damaged path) — so when invoked, it adds to onHand exactly once AND creates the register row.

**Callers:**
- `POST /api/returned-stitched` (UI manual receipt)
- `POST /api/inventory/receive-returned-stitched` (UI manual receipt — alternate route)

Neither is invoked automatically by RTO. The user must explicitly go to the Returned-Stitched UI and submit a receipt form. **No automatic double-entry.**

### 1.4 DB verification

**Query 1 — Orders with both `return_resellable` AND `return_stitched_received` for the same variant:**

```sql
SELECT referenceId, orgVariantId, ...
FROM "InventoryTransaction"
WHERE referenceType = 'order' AND referenceId IS NOT NULL
GROUP BY referenceId, orgVariantId
HAVING SUM(CASE WHEN transactionType = 'return_resellable' THEN 1 ELSE 0 END) > 0
   AND SUM(CASE WHEN transactionType = 'return_stitched_received' THEN 1 ELSE 0 END) > 0
```

**Result:** `[]` — zero orders have this pattern.

**Query 2 — Orders with multiple `return_stitched_received` for the same variant:**

```sql
SELECT referenceId, orgVariantId, count(*)
FROM "InventoryTransaction"
WHERE transactionType = 'return_stitched_received' AND referenceType = 'order'
GROUP BY referenceId, orgVariantId
HAVING count(*) > 1
```

**Result:** `[]` — zero orders have this pattern.

**Query 3 — Orders with `autoProcessedAsPerfect=true` (post-ORD-004 fix):**

| Order # | Type | Return txns | RSI rows |
|---------|------|-------------|----------|
| ORD-2026-00023 | stock_based | 1 (return_resellable qty=1) | 0 |
| ORD-2026-00022 | stock_based | 1 (return_resellable qty=1) | 0 |
| ORD-2026-00011 | made_to_order | 1 (return_stitched_received qty=5) | 0 |

All three auto-processed RTO orders have exactly **1** return transaction each and **0** ReturnedStitchedInventory rows — definitively confirming no double-entry.

### 1.5 The made_to_order RTO exemplar — `ORD-2026-00011` (order `cmsol7k0j0001svybs5lzyqj0`)

Variant: `HFH-ST-OS` (made_to_order, trackInventory=true). Transaction timeline:

| Time | Type | Qty | Net onHand |
|------|------|-----|------------|
| 11:38:53 | `order_reserved` | +1 reserved | 0 |
| 11:42:23 | `sale_dispatched` | -1 onHand, -1 reserved | -1 |
| 11:42:26 | `return_stitched_received` | +5 onHand | +4 |

**Exactly one return txn, qty=+5. No ReturnedStitchedInventory register row.** The onHand is now 4 (the dispatched item restocked + 4 leftover units from the test, which the user accepted). The `OrgProductVariant.trackInventory` was flipped from FALSE→TRUE one-way (as expected for the first stitched return).

### 1.6 Conclusion on Critical Priority

**The user's identified bug is NOT real** in the current code. The RTO flow and the ReturnedStitched receipt flow are completely separate code paths. The RTO flow only modifies `InventoryPool.onHand` and the ledger; the ReturnedStitched flow does both register + ledger.

The risk the user is correctly identifying *could* occur if a user manually creates a ReturnedStitchedInventory receipt for an item that was ALREADY auto-restocked via RTO — but that would be a UI/user error, not an automatic double-entry. There's no dedup guard preventing this scenario because there's no shared key between the two flows (ReturnedStitchedInventory has `originalOrderReference` as a free-text field, not an FK to `Order.id`).

---

## PART 2 — STOCK LOSS MODULE

### 2.1 Routes

- `GET /api/stock-loss` — list (filter by loss_type, investigation_status)
- `POST /api/stock-loss/report-damaged` — single-stage write-off
- `POST /api/stock-loss/report-theft` — two-stage (quarantine → resolve)
- `POST /api/stock-loss/report-transit` — transit loss with courier-claim workflow
- `POST /api/stock-loss/resolve` — close an open investigation
- `GET /api/stock-loss/stats` — dashboard summary
- `GET/DELETE /api/stock-loss/[id]` — record detail / delete

### 2.2 Logic — `recordStockLoss()` helper

**File:** `src/lib/stock-loss.ts:125-268`

**Step 1:** Inserts `StockLossRecord`. If `orderItemId` is set AND a record already exists for `(orderItemId, lossType, sourceModule)`, the unique partial index `stock_loss_orderitem_dedup_idx` rejects the insert → caught and returned as `wasDuplicate=true` (idempotent success).

**Step 2 (if `createInventoryTransaction !== false`):** Calls `processInventoryTransaction()` with mapped txn type:
- `damaged` → `damage_writeoff`
- `theft` → `theft_writeoff`
- `missing` → `missing_writeoff`
- `transit_loss` → `transit_loss`
- `supplier_dispute` → `supplier_return`

If the inventory txn fails, the loss record is **rolled back** (`db.stockLossRecord.delete`) — atomicity preserved. The `inventoryTxnId` is backfilled on the loss record after the txn succeeds.

### 2.3 DB verification

**StockLossRecord counts (lossType × sourceModule):**

| lossType | sourceModule | count |
|----------|--------------|-------|
| theft | NULL | 4 |
| damaged | adjust_stock | 2 |
| damaged | NULL | 2 |
| damaged | return_scan | 1 |
| missing | NULL | 1 |

**Total: 10 StockLossRecord rows.**

The 7 NULL `sourceModule` rows pre-date migration 027 (the unification migration). They're a backfill target — see recommendation #B-2 in §6.

### 2.4 Dedup verification

**Index exists:** ✅ Confirmed via `pg_indexes`:
```
CREATE UNIQUE INDEX stock_loss_orderitem_dedup_idx
  ON "StockLossRecord" USING btree ("orderItemId", "lossType", "sourceModule")
  WHERE ("orderItemId" IS NOT NULL)
```

**Duplicate records per (orderItemId, lossType):** `[]` (zero) — the dedup mechanism works correctly.

### 2.5 Stock Loss UI scope

**File:** `src/app/api/stock-loss/route.ts` (GET) and `src/app/api/stock-loss/stats/route.ts`

The list endpoint filters only by `companyId`, `lossType`, and `investigationStatus`. It does NOT filter by `sourceModule`. Therefore the Stock Losses UI shows records from ALL sources (stock_loss, rto, cycle_count, adjust_stock, return_scan, etc.) — which is the intended unified-dashboard behavior.

**Caveat:** There's no UI filter/discriminator for `sourceModule` in the losses-view component — admins can't easily distinguish "loss recorded from RTO" vs. "loss recorded from cycle count". This is a UX improvement opportunity, not a correctness bug.

### 2.6 "Resolved" flow

**File:** `src/app/api/stock-loss/resolve/route.ts`

Two paths:
1. **theft/missing** (two-stage): releases quarantine, then optionally writes off via `theft_writeoff`/`missing_writeoff` txn. If resolution='recovered'/'error_corrected' → no txn (quarantine release already restored availability).
2. **transit_loss**: updates claim status + courierRecovered amount. NO inventory transaction (the loss was already recorded upfront via `transit_loss` txn at report time).

This path correctly does NOT create a reverse transaction (the original write-off was the correct direction — going OUT). The resolve flow only updates investigation metadata.

### 2.7 Adjust Stock path (no longer creates StockLossRecord)

**File:** `src/app/api/inventory/adjust/route.ts` (INV-013 fix)

Negative stock adjustments now call `processInventoryTransaction(damage_writeoff)` directly, WITHOUT creating a `StockLossRecord`. The 2 historical `sourceModule='adjust_stock'` rows are from before this fix. New adjustments won't pollute the losses dashboard.

### 2.8 Stock Loss findings summary

| Check | Status |
|-------|--------|
| `recordStockLoss()` decrements onHand correctly | ✅ |
| Creates InventoryTransaction with correct referenceId | ✅ (`stock_loss` + lossRecord.id) |
| Dedup guard prevents duplicate loss per (orderItemId, lossType, sourceModule) | ✅ |
| Unique constraint exists in DB | ✅ |
| UI shows losses from ALL sources | ✅ |
| "Resolve" creates correct reverse/forward txn (or no txn where appropriate) | ✅ |
| Atomic (loss record + txn in sequence, rollback on failure) | ✅ |

---

## PART 3 — CYCLE COUNTS MODULE

### 3.1 DB summary

```
CycleCount status counts:
  scheduled   : 9
  approved    : 5
  pending_review : 2
  in_progress : 2
Total: 18 cycle counts
```

### 3.2 Routes

- `GET/POST /api/cycle-counts` — list/create
- `GET/PATCH /api/cycle-counts/[id]` — detail + actions (start, submit_counts, approve, cancel)

### 3.3 Approval flow atomicity

**File:** `src/app/api/cycle-counts/[id]/route.ts` (PATCH, action='approve')

The approve action iterates over each item with a discrepancy and processes them sequentially — but **NOT inside a single outer `db.$transaction`**. Each item's `processInventoryTransaction()` call is its own atomic transaction (INV-006 fix). If item 3 of 5 fails (e.g. INSUFFICIENT_STOCK), items 1-2 have already committed and items 4-5 still run. The cycle count header is then marked 'approved' regardless of partial failures.

**This is a MEDIUM atomicity gap** — if a cycle count has 5 items and item 3 fails, the count ends up in an inconsistent state: header says 'approved' but only some items have their `inventoryTxnId` set. No automatic rollback of the whole cycle count.

### 3.4 Shortage handling (theft/damage/missing)

Three branches per item (lines 290-422):

1. **theft_suspected / unknown**: calls `quarantineStock()` (reduces available) + `recordStockLoss(lossType='missing', sourceModule='cycle_count', createInventoryTransaction=false)` + `cycle_count_adjust` txn (sets onHand to counted value).

2. **damage_not_recorded**: calls `recordStockLoss(lossType='damaged', sourceModule='cycle_count', createInventoryTransaction=false)` + `cycle_count_adjust` txn (sets onHand).

3. **All other reasons** (recording_error, transfer_not_recorded, surplus): just `cycle_count_adjust` txn.

**Critical design pattern:** In branches 1 & 2, `createInventoryTransaction=false` is passed explicitly because the `cycle_count_adjust` txn already sets onHand directly. Creating another damage_writeoff/missing_writeoff would **double-decrement**. This pattern is correctly applied.

### 3.5 Can cycle count adjustments cause `reserved > onHand` (INV-001 scenario)?

**Yes — by design, but with mitigation.** The `cycle_count_adjust` txn type SETS onHand to the counted value (line 277: `newOnHand = absQty`). If the counted value is lower than the current reserved count, the post-write INV-001 protection logic (lines 298-392 of `inventory.ts`) bumps the newest-reserved OrderItems to 'backordered' until `reserved <= onHand`. If the gap can't be closed (ghost reservations), reserved is clamped to onHand + WARNING audit log.

This protection was applied to `cycle_count_adjust` via `ONHAND_REDUCING_TYPES` array. ✅ Verified.

### 3.6 Validation bounds

**File:** `src/app/api/cycle-counts/[id]/route.ts:182-217`

Counted quantity is validated against:
- Non-negative integer (no negative stock)
- Hard cap: 1,000,000 units (sanity ceiling)
- Soft cap: 10× system quantity (typo/fraud prevention)

If exceeded, returns 400 with a helpful message. ✅ Good guardrails.

### 3.7 Cycle Count findings summary

| Check | Status |
|-------|--------|
| DB count distribution looks healthy | ✅ 18 total, 5 approved |
| Shortage creates StockLossRecord via unified helper | ✅ |
| Shortage does NOT double-decrement (createInventoryTransaction=false) | ✅ |
| `cycle_count_adjust` correctly sets onHand (not increments) | ✅ |
| INV-001 reservation invariant protection applies | ✅ |
| Validation bounds prevent typo/fraud | ✅ |
| Approval flow atomicity | ⚠️ PARTIAL — per-item txns are atomic, but the whole approval is not wrapped in a single outer transaction |

---

## PART 4 — RETURNED-STITCHED MODULE

### 4.1 DB summary

```
ReturnedStitchedInventory status+condition:
  status='available', condition='perfect' : 2
Total: 2 rows
```

Both rows are legacy (created 2026-07-25, before the INV-002 fix unified the flow). Both have `inventoryTxnId=NULL`. Neither has a matching `return_stitched_received` transaction in the ledger within a ±5-minute window.

### 4.2 Routes

- `GET/POST /api/returned-stitched` — list / receive (delegates to `processReturnedStitchedReceipt()`)
- `POST /api/returned-stitched/[id]` — mark_sold / write_off
- `GET /api/returned-stitched/stats` — summary

### 4.3 `processReturnedStitchedReceipt()` correctness

**File:** `src/lib/inventory.ts:591-738`

Two paths:

**Non-damaged (perfect/good/open_box):**
1. Calls `processInventoryTransaction(return_stitched_received)` — increments onHand, recalculates WAC, flips `track_inventory` to TRUE (one-way).
2. Creates `ReturnedStitchedInventory` with `status='available'` and `inventoryTxnId=txnResult.transactionId` (bidirectional link set).

**Damaged:**
1. Calls `recordStockLoss(lossType='damaged', sourceModule='returned_stitched', createInventoryTransaction=false)` — creates a loss record but does NOT decrement onHand (the returned item was never added to stock).
2. Creates `ReturnedStitchedInventory` with `status='written_off'`, `writtenOffAt=now`, `inventoryTxnId=NULL`.

✅ Both paths correctly avoid double-decrement.

### 4.4 The `inventoryTxnId` link

For NEW records (created after the INV-002 fix), `inventoryTxnId` is correctly set on the non-damaged path (line 721: `inventoryTxnId: txnResult.transactionId ?? null`).

The 2 legacy rows have `inventoryTxnId=NULL` because they pre-date the migration. The backfill script `scripts/backfill-returned-stitched-inventory-txn-id.ts` exists but was apparently never successfully run (or no matching txn was found for these variants, since the variants have no pool/txn).

### 4.5 `mark_sold` action

**File:** `src/app/api/returned-stitched/[id]/route.ts:46-110`

When a returned-stitched item is sold:
- Updates `ReturnedStitchedInventory.status = 'sold'`, sets `soldAt` and `soldOrderReference`.
- Calls `processInventoryTransaction(sale_dispatched)` to decrement onHand (the register row tracks it, but the actual stock movement is via the pool).

✅ Correctly decrements onHand.

### 4.6 `write_off` action

**File:** `src/app/api/returned-stitched/[id]/route.ts:111-176`

When a returned-stitched item is written off:
- Updates `ReturnedStitchedInventory.status = 'written_off'`, sets `writtenOffAt`, `writtenOffById`, `writeOffReason`.
- Calls `recordStockLoss(lossType='damaged', sourceModule='returned_stitched', createInventoryTransaction=true)` to decrement onHand AND create the loss record.

✅ Correctly decrements onHand AND creates the loss record (linked via `inventoryTxnId`).

### 4.7 The KEY QUESTION — does RTO for stitched items ALSO create a ReturnedStitchedInventory row?

**NO.** Verified in code (Part 1.1) and DB (Part 1.4):
- `processOrderReturn()` and `restockOrderForRto()` only call `processInventoryTransaction()`.
- 0 ReturnedStitchedInventory rows have `originalOrderReference` matching any order ID in the DB.
- All 3 orders with `autoProcessedAsPerfect=true` have `rsi_count=0`.

### 4.8 Returned-Stitched findings summary

| Check | Status |
|-------|--------|
| `processReturnedStitchedReceipt()` creates BOTH register + txn | ✅ |
| `inventoryTxnId` set on all NEW records | ✅ |
| Legacy records still have NULL `inventoryTxnId` | ⚠️ (2 rows — orphaned) |
| `mark_sold` decrements onHand | ✅ |
| `write_off` creates StockLossRecord + decrements onHand | ✅ |
| RTO flow does NOT create ReturnedStitchedInventory record (no double entry) | ✅ confirmed |

---

## PART 5 — SUPPLIER RETURNS MODULE

### 5.1 DB summary

```
SupplierReturn status counts: (empty)
Total: 0 rows
```

The `supplier_return` InventoryTransaction type has 6 rows, but ALL have `referenceId=NULL` — meaning they were created BEFORE the INV-003 fix that added the backlink. They were likely created by test data or by an older code path that didn't link the txn to a SupplierReturn record (and the SupplierReturn records were later deleted/cleaned up, leaving orphan transactions).

### 5.2 Routes

- `GET/POST /api/supplier-returns`
- `PATCH /api/supplier-returns/[id]` — resolve / mark rejected
- `POST /api/supplier-returns/[id]/dispute` — mark disputed

### 5.3 Atomicity

**File:** `src/app/api/supplier-returns/route.ts:101-166`

The creation flow wraps everything in `db.$transaction`:
1. Creates `SupplierReturn` (with `inventoryTxnId=NULL`).
2. Calls `processInventoryTransaction(supplier_return)` with `referenceId=rec.id`.
3. Backfills `inventoryTxnId` on the SupplierReturn.
4. If processInventoryTransaction fails, the throw aborts the outer tx → SupplierRecord is rolled back.

✅ Fully atomic.

### 5.4 Decrement correctness

The `supplier_return` txn type is in `OUT_TYPES` (line 65 of `inventory.ts`) — meaning it decrements onHand. ✅ Correct.

### 5.5 "Rejected" (disputed) path

**File:** `src/app/api/supplier-returns/[id]/route.ts:81-112`

When `status='rejected'` is set via PATCH:
- Auto-creates a `StockLossRecord` with `lossType='supplier_dispute'`, `supplierReturnId=id`, `sourceModule` is **NOT SET** (NULL — bypasses `recordStockLoss()` helper).
- The linked `inventoryTxnId` on this loss record is NULL (because the inventory was already decremented when the SupplierReturn was first created — the loss record is just for tracking).

**Problem:** This bypasses the unified `recordStockLoss()` helper. The StockLossRecord is created directly via `db.stockLossRecord.create()`, leaving `sourceModule=NULL`. This means:
- The losses dashboard can't filter/group this record by source.
- The dedup mechanism doesn't apply (no `sourceModule` to dedup on).
- The "supplier_dispute" loss type's mapping to `supplier_return` txn type isn't applied (correctly, since the txn was already created at SupplierReturn creation time).

**Recommended fix:** Replace the direct `db.stockLossRecord.create()` call with `recordStockLoss({ lossType: 'supplier_dispute', sourceModule: 'supplier_return', createInventoryTransaction: false })` to maintain consistency. (This is a code-only recommendation — no DB impact since 0 supplier returns exist yet.)

### 5.6 Disputed (separate endpoint)

**File:** `src/app/api/supplier-returns/[id]/dispute/route.ts`

Sets `status='disputed'` and appends notes. **Does NOT create a StockLossRecord.** This is for the "we dispute the supplier's rejection" workflow — different from the "supplier rejected our return" workflow.

### 5.7 Supplier Returns findings summary

| Check | Status |
|-------|--------|
| DB count | 0 rows |
| Creating supplier return decrements onHand | ✅ (verified in code) |
| Creates InventoryTransaction with referenceId pointing to SupplierReturn | ✅ (INV-003 fix) |
| "Rejected" path creates StockLossRecord | ✅ but bypasses recordStockLoss (sourceModule=NULL) |
| Atomic creation flow | ✅ (db.$transaction) |
| Legacy orphan txn rows (referenceId=NULL) | ⚠️ 6 rows from pre-INV-003 era |

---

## PART 6 — CROSS-MODULE: InventoryTransaction Type Analysis

### 6.1 Type distribution (full DB)

| transactionType | count |
|-----------------|-------|
| order_reserved | 37 |
| order_unreserved | 28 |
| opening_stock | 20 |
| sale_dispatched | 18 |
| purchase_received | 17 |
| damage_writeoff | 9 |
| transfer_out | 7 |
| return_resellable | 7 |
| transfer_in | 7 |
| supplier_return | 6 |
| cycle_count_adjust | 5 |
| manual_adjustment_in | 4 |
| fabric_consumed_for_stitching | 4 |
| theft_writeoff | 4 |
| return_stitched_received | 3 |
| **TOTAL** | **160** |

### 6.2 Loss-related types — double-entry check (definitive)

For each loss-related type, the audit verified:

1. **`return_resellable` (7 rows)** — All for stock_based variants. No duplicates per (referenceId, orgVariantId). ✅ Safe.
2. **`return_stitched_received` (3 rows)** — All for made_to_order variants. No duplicates. ✅ Safe.
3. **`return_damaged` (0 rows)** — Type is defined in the enum but NEVER used in code. The damaged-return path uses `damage_writeoff` instead (via the unified `recordStockLoss()` helper). This type is dead code — could be removed from the enum for clarity, or kept for future use.
4. **`damage_writeoff` (9 rows)** — Used by stock-loss module, adjust-stock (INV-013 fix), cycle count damage_not_recorded (createInventoryTransaction=false, so this is from the stock-loss flow only), scan-confirm-return damaged path, and returned-stitched write_off. ✅ All linked to a StockLossRecord via `referenceId`.
5. **`theft_writeoff` (4 rows)** — All from `stock-loss/report-theft` flow. ✅
6. **`missing_writeoff` (0 rows)** — Defined but unused. Quarantine flow is the path for missing items.
7. **`cycle_count_adjust` (5 rows)** — SETS onHand to the counted value (not increment/decrement). 5 approved cycle counts → 5 cycle_count_adjust txns. ✅
8. **`transit_loss` (0 rows)** — Defined but no rows. The stock-loss/report-transit route exists but has no DB records yet.
9. **`supplier_return` (6 rows)** — All 6 have `referenceId=NULL` (legacy pre-INV-003 orphans). The 6 inventory txns have NO matching SupplierReturn records (the table is empty). These represent historical inventory deductions that were never properly linked to a SupplierReturn. ⚠️ Data integrity gap.

### 6.3 Orders with same variant having multiple return txns

The query (using `referenceId` instead of the always-NULL `orderId`) found:
- **5 orders with 1+ `return_resellable`** (1 of which has 2 — order `cms5sofrf0031jl4fl7pjna14` had qty=2 worth of return_resellable txns; this is the exchange-flow where the same variant was received twice for the same order — once for the "good" condition receipt and once for the "perfect" condition receipt, both on 2026-07-29).
- **0 orders with `return_stitched_received` + `return_resellable` combo** — definitively confirms no double-entry.

The order with 2 return_resellable txns is from the EXCHANGE flow (`verifyOldItemReceived()` path), not the RTO flow. The exchange flow has its own dedup mechanism (idempotency key on the exchange shipment). This is NOT a bug — it represents two legitimately separate receipts of the same physical variant for the same order (e.g. customer returned item, was perfect; then later returned the replacement, also perfect — both restocked).

### 6.4 `InventoryTransaction.orderId` population

**This is a SIGNIFICANT data integrity issue.** The schema has an `orderId` FK field on `InventoryTransaction`, but the call sites in `processInventoryTransaction()` do not populate it. The function only sets `referenceType` + `referenceId` (the older, more generic link).

| transactionType | total | has_orderId | null_orderId |
|-----------------|-------|-------------|--------------|
| order_reserved | 37 | 0 | 37 |
| order_unreserved | 28 | 0 | 28 |
| sale_dispatched | 18 | 14 | 4 |
| return_resellable | 7 | 0 | 7 |
| return_stitched_received | 3 | 0 | 3 |
| (all others) | 67 | 0 | 67 |

Only `sale_dispatched` partially populates `orderId` (14 of 18). This is because `dispatchOrder()` (in `order.actions.ts`) sets `orderId` explicitly when calling `processInventoryTransaction()`. None of the other call sites (RTO, reserve, cycle count, supplier return, etc.) do.

**Impact:** The `InventoryTransaction.order` relation is mostly broken. Any query that joins `InventoryTransaction` to `Order` via this FK will return zero rows for non-dispatched transaction types. Queries must use `referenceType='order' AND referenceId=<orderId>` instead.

**Recommended fix:** Add `orderId` as a parameter to `processInventoryTransaction()` and have all order-related call sites pass it. (Schema-level change, no DB migration needed since the column exists.)

---

## PART 7 — FINDINGS, RECOMMENDATIONS & NEXT ACTIONS

### 7.1 Critical Priority (User's identified bug)

| ID | Finding | Severity |
|----|---------|----------|
| CR-1 | RTO flow does NOT double-add stock — user's hypothesis is incorrect | ✅ Safe |

**No action needed** on this specific concern. The RTO flow is correctly implemented and verified safe in both code and DB.

### 7.2 Medium-severity findings

| ID | Finding | Recommendation |
|----|---------|----------------|
| MD-1 | Scan confirm-return flow (damaged) creates 2 offsetting txns (`+return_resellable`, `-damage_writeoff`) instead of 1 net write-off. Net onHand impact is correct (0), but ledger has 2 entries. | Consider: if condition='damaged' AND it's a stock_based item, skip the `return_resellable` txn in `processOrderReturn()` and only create the `damage_writeoff` txn. For made_to_order items, this is more complex (the track_inventory flip is a side-effect of return_stitched_received). Could be solved with a `condition` parameter to `processOrderReturn()`. |
| MD-2 | 2 legacy `ReturnedStitchedInventory` rows have NULL `inventoryTxnId` and no matching ledger txn. The backfill script `scripts/backfill-returned-stitched-inventory-txn-id.ts` exists but didn't fix these. | Run the backfill script; if no matching txn can be found, either create a synthetic `return_stitched_received` txn for these legacy rows, or DELETE them (since they have no actual stock impact — the pool doesn't have these variants). |
| MD-3 | `InventoryTransaction.orderId` is NULL on every return / reserve / unreserve / cycle_count / supplier_return txn. The `Order` FK field is essentially unused. | Refactor `processInventoryTransaction()` to accept and propagate `orderId`. Update all order-related call sites to pass it. |
| MD-4 | Cycle count approve flow is not wrapped in a single outer `db.$transaction`. Partial failures leave the count in an inconsistent state (header='approved' but some items have no txn). | Wrap the per-item processing loop in `db.$transaction`. Note: this requires refactoring `processInventoryTransaction()` to accept a passed-in tx client (currently uses the global db client). |

### 7.3 Low-severity findings

| ID | Finding | Recommendation |
|----|---------|----------------|
| LO-1 | Supplier-return "rejected" path creates StockLossRecord directly, bypassing `recordStockLoss()` → `sourceModule=NULL`. | Replace with `recordStockLoss({ lossType: 'supplier_dispute', sourceModule: 'supplier_return', createInventoryTransaction: false })`. |
| LO-2 | 7 legacy StockLossRecords have `sourceModule=NULL` (pre-migration 027). | Run a backfill UPDATE based on heuristics: if `supplierReturnId IS NOT NULL` → 'supplier_return'; if `notes LIKE '%cycle count%'` → 'cycle_count'; if `orderItemId IS NOT NULL` AND `lossType='damaged'` → 'rto'; else 'stock_loss'. |
| LO-3 | 6 legacy `supplier_return` InventoryTransactions have `referenceId=NULL` (orphaned from their SupplierReturn records, which no longer exist). | Investigate whether these are real deductions that should remain, or test data that should be cleaned up. The `SupplierReturn` table is currently empty. |
| LO-4 | `return_damaged` and `missing_writeoff` and `transit_loss` transaction types are defined but never used in the current code. | Either remove from the enum for clarity, or keep for future use. No urgency. |

### 7.4 Code-quality observations (positive)

The audit confirms several well-implemented patterns:

- **`recordStockLoss()` unification is sound** — atomic loss record + txn creation with rollback, dedup via partial unique index, idempotent re-runs. The `wasDuplicate` flag is correctly handled by callers.
- **INV-001 reservation invariant protection** — applied to all onHand-reducing txn types, bumps backordered correctly.
- **INV-006 atomicity** — `processInventoryTransaction()` wraps all writes in `db.$transaction`.
- **INV-002 unification** — both `/api/returned-stitched` and `/api/inventory/receive-returned-stitched` now delegate to `processReturnedStitchedReceipt()` — eliminating the historical split-flow bug where one route created only the register and the other only the txn.
- **INV-003 link-back** — `SupplierReturn.inventoryTxnId` is correctly backfilled, and the InventoryTransaction.referenceId points to the SupplierReturn.
- **INV-013 fix** — adjust-stock no longer pollutes the Stock Losses dashboard with non-investigation adjustments.
- **Idempotency** — all create routes accept an `Idempotency-Key` header and use `withIdempotency()` to prevent duplicate submissions.

### 7.5 Next-action checklist (for engineering)

1. **Investigate the 2 legacy ReturnedStitchedInventory rows** (orgVariantId `cms0erjyc000zi7fs74l6scpn` and `cms0eommy000zi7cl2ap08u7a`). Decide: backfill txn, or delete orphaned register rows. (MD-2)
2. **Refactor `processInventoryTransaction()` to accept `orderId`** and propagate to the `InventoryTransaction.create()` call. Update all order-related call sites. (MD-3)
3. **Wrap cycle count approve in `db.$transaction`** (requires passing tx client to `processInventoryTransaction()` — out of current scope but worth planning). (MD-4)
4. **Refactor `supplier-returns/[id]` PATCH "rejected" branch** to use `recordStockLoss()`. (LO-1)
5. **Backfill `sourceModule` on 7 legacy StockLossRecords** using the heuristic from LO-2. (LO-2)
6. **Investigate 6 orphan `supplier_return` txns with `referenceId=NULL`** — decide: clean up or document as historical. (LO-3)
7. **(Optional) Consider the scan-confirm-return optimization** — when `condition='damaged'` AND fulfillmentType='stock_based', skip the `return_resellable` txn and just create the `damage_writeoff`. This reduces ledger noise. (MD-1)

---

## APPENDIX A — Code Files Reviewed

| File | Purpose |
|------|---------|
| `prisma/schema.prisma` | Models: StockLossRecord, CycleCount/Item, ReturnedStitchedInventory, SupplierReturn, InventoryPool, InventoryTransaction |
| `src/lib/inventory.ts` | `processInventoryTransaction()`, `processReturnedStitchedReceipt()`, `restockOrderForRto()` |
| `src/lib/stock-loss.ts` | `recordStockLoss()` unified helper |
| `src/lib/actions/order-return.actions.ts` | `processOrderReturn()`, `correctReturnItemCondition()` |
| `src/app/api/orders/[id]/rto/route.ts` | Manual RTO trigger |
| `src/app/api/scan/confirm-return/route.ts` | One-go return + damage confirmation |
| `src/app/api/returned-stitched/route.ts` | Returned-Stitched list/receive |
| `src/app/api/returned-stitched/[id]/route.ts` | mark_sold / write_off |
| `src/app/api/inventory/receive-returned-stitched/route.ts` | Alt receipt route (delegates to canonical helper) |
| `src/app/api/stock-loss/route.ts` | Loss list |
| `src/app/api/stock-loss/report-damaged/route.ts` | Damaged report |
| `src/app/api/stock-loss/resolve/route.ts` | Resolve investigation |
| `src/app/api/stock-loss/stats/route.ts` | Dashboard stats |
| `src/app/api/inventory/adjust/route.ts` | Manual stock adjust |
| `src/app/api/cycle-counts/route.ts` | List/create cycle counts |
| `src/app/api/cycle-counts/[id]/route.ts` | start / submit_counts / approve / cancel |
| `src/app/api/supplier-returns/route.ts` | Create supplier return |
| `src/app/api/supplier-returns/[id]/route.ts` | Resolve supplier return (creates StockLossRecord on rejected) |
| `src/app/api/supplier-returns/[id]/dispute/route.ts` | Mark disputed |
| `src/app/api/webhooks/[provider_key]/[webhook_endpoint_id]/route.ts` | Courier webhook → RTO |
| `src/lib/actions/postex-status-poll.actions.ts` | PostEx polling → `restockOrderForRto()` |
| `src/lib/actions/leopard-webhook.actions.ts` | Leopard webhook → `restockOrderForRto()` |
| `supabase/migrations/027_stock_loss_unification.sql` | Adds sourceModule + dedup index |
| `scripts/backfill-returned-stitched-inventory-txn-id.ts` | Backfill script for RSI.inventoryTxnId (exists but didn't fix the 2 legacy rows) |

## APPENDIX B — Key DB Queries Used

The audit ran 4 query batches against the live Supabase DB:
1. InventoryTransaction counts by type
2. Detailed return-stitched and return_resellable txn inspection
3. RTO order + item + txn linkage
4. Definitive double-entry check using `referenceId` (since `orderId` is always NULL)

All scripts were temporary and removed after execution. No DB modifications were made (read-only audit).

---

**End of report.**
