# Stock-Loss System Investigation + Unification Proposal

**Task ID:** STOCKLOSS-INVESTIGATE
**Agent:** general-purpose (read-only investigation subagent)
**Scope:** Every code path in FlowOps that DECREMENTS stock due to loss/damage/theft/transit-loss/missing — across the Orders, Inventory, Cycle Count, Adjust Stock, Returned Stock, Return-Order-Scan, Exchange, and Supplier Return modules.
**Mode:** READ-ONLY — no source code was modified.

---

## Executive Summary

- **Current state:** Stock loss is recorded by **6 disconnected code paths** in the codebase, only **1 of which is the dedicated Stock Losses module**. The other 5 are silent side-effects embedded in RTO, Cycle Count, Adjust Stock, Receive-Returned-Stitched, Exchange verification, and Supplier Return rejection. There is no shared helper that creates `StockLossRecord`, no `sourceModule` discriminator on the loss row, and no DB-level uniqueness constraint that prevents the same physical loss from being recorded twice.
- **Core problems (confirmed by code reading):**
  1. **RTO auto-restocks with an optimistic "perfect/resellable" assumption** — if the same item is *then* also fed through `/api/inventory/receive-returned-stitched` (the inventory-module endpoint), stock gets incremented AGAIN (double-increment). If the user instead fires `/api/returned-stitched` (the Returned Stock module endpoint), no pool change occurs but a parallel `ReturnedStitchedInventory` row exists with NO link to the originating order — and if the user marks *that* row as `damaged` or `written_off`, no `StockLossRecord` is created at all.
  2. **Cycle Count + Adjust Stock don't create `StockLossRecord`** for the most common shortage reasons. Only `theft_suspected` / `unknown` cycle-count shortages auto-create a `lossType='missing'` record. A shortage marked `damage_not_recorded`, `recording_error`, or `transfer_not_recorded` → onHand goes down, **NO loss record exists**. Negative Adjust Stock uses `damage_writeoff` (decrements onHand) and **never** creates a `StockLossRecord`. So the Stock Losses dashboard silently under-reports actual stock decreases.
  3. **The dedicated Stock Losses "Report Damaged" form has no order-linking field.** The user can select `responsible_party='courier'` but cannot attach the loss to the specific `Order` / `OrderItem`. The `reportDamagedLossSchema` (`src/lib/validations/stock-loss.ts:17-37`) omits `orderItemId` and `orderReferenceId` entirely. The transit-loss form has a free-text `order_reference_id` field that is **not validated as a real Order ID** — any string is accepted.
  4. **Transit loss has no real Order FK.** `StockLossRecord.orderReferenceId` is a `String?` (line 1320 in schema.prisma) with the comment "for transit_loss: references the dispatched order (future)". The proper `orderItemId` FK exists but is only set by `correctReturnItemCondition` (RTO review) — never by the transit-loss endpoint.
  5. **Return Order Scan does NOT inline RTO confirmation or damage recording.** The scan action for `receive_return` mode (`src/lib/actions/scan.actions.ts:218-222`) just returns the order items to the UI — it explicitly does NOT call `processOrderReturn`. The user must then navigate to Orders → Order Detail → RTO Dialog → enter return_reason → submit, and later go to Returns → Review Queue to mark an item damaged. Three modules, three round-trips.
- **Proposed solution (high-level):** Make `StockLossRecord` the SINGLE source of truth for every loss-type stock decrease. Add a `sourceModule` enum, a real `linkedOrderId` FK, a `linkedTransactionId` FK, and a unique constraint on `(orderItemId, lossType, sourceModule)` to prevent double-counting. Every module that currently decrements onHand due to loss must funnel through a single shared helper `recordStockLoss()` that creates the loss record AND the inventory transaction atomically in `db.$transaction`. Return-Order-Scan's `receive_return` mode should be extended to optionally inline: (a) confirm RTO, (b) record damage, (c) record transit loss — all from the scan station UI.

---

## Part 1: Current State (Per Module)

### A. Stock Losses Module (dedicated)

This is the only module whose *primary purpose* is to record stock loss. Located in `src/app/api/stock-loss/`.

#### A.1 API routes

| Method | Path | File | Loss types handled | Inventory txn type created |
|---|---|---|---|---|
| GET | `/api/stock-loss` | `route.ts` (72 lines) | List + filter by `lossType`, `investigationStatus` | — (read-only) |
| GET | `/api/stock-loss/[id]` | `[id]/route.ts` (100 lines) | Get single loss record | — (read-only) |
| GET | `/api/stock-loss/stats` | `stats/route.ts` (59 lines) | Aggregated counts per lossType for dashboard header | — (read-only) |
| POST | `/api/stock-loss/report-damaged` | `report-damaged/route.ts` (158 lines) | `damaged` (instant write-off) | `damage_writeoff` (decrements onHand) |
| POST | `/api/stock-loss/report-theft` | `report-theft/route.ts` (134 lines) | `theft` (quarantine, two-stage) | NONE — only `quarantineStock` (increments `reserved`, no ledger entry) |
| POST | `/api/stock-loss/report-transit` | `report-transit/route.ts` (126 lines) | `transit_loss` (claim tracking only) | NONE — stock was already decremented at `sale_dispatched` |
| POST | `/api/stock-loss/resolve` | `resolve/route.ts` (183 lines) | Theft/Missing → `written_off` / `recovered` / `error_corrected`; Transit → `claim_accepted` / `claim_rejected` | Theft/Missing write-off → `theft_writeoff` or `missing_writeoff` (decrements onHand); Transit → none |

**No `report-missing` endpoint exists** despite `reportMissingLossSchema` being defined in `src/lib/validations/stock-loss.ts:59-67` — confirmed dead code. Missing losses can ONLY be created by the Cycle Count approve flow (see §C below).

#### A.2 `StockLossRecord` schema (full)

From `prisma/schema.prisma:1279-1341`:

```prisma
model StockLossRecord {
  id              String   @id @default(cuid())
  organizationId  String
  companyId       String
  orgVariantId    String
  locationId      String
  lossType        String   // damaged | theft | missing | transit_loss | supplier_dispute
  subType         String?  // confirmed | suspected | admin_error | manufacturing
  damageType      String?  // water_moisture | physical_impact | manufacturing_defect | transit_damage | storage_damage | other
  quantity        Int
  costPerUnit     Decimal  @db.Decimal(12, 4)
  investigationStatus String @default("none")  // none | open | closed
  resolution      String?  // written_off | recovered | error_corrected | claim_accepted | claim_rejected
  responsibleParty String? // warehouse | courier | customer | employee | unknown | supplier
  policeReportRef String?
  insuranceClaimRef String?
  insuranceRecovered Decimal @default(0) @db.Decimal(12, 2)
  courierClaimRef String?
  courierClaimStatus String?  // not_filed | filed | accepted | rejected
  courierRecovered Decimal @default(0) @db.Decimal(12, 2)
  evidenceUrls    String   @default("[]")  // JSON array string
  notes           String?
  reportedById    String
  approvedById    String?
  resolvedById    String?
  inventoryTxnId  String?   // FK to InventoryTransaction (nullable; updatable post-create)
  orderReferenceId String?  // FREE-TEXT, not an FK. Comment: "for transit_loss: references the dispatched order (future)"
  orderItemId     String?   // proper FK to OrderItem (added later, used only by RTO correction)
  supplierReturnId String? @unique  // ONLY set for supplier_dispute
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  resolvedAt      DateTime?

  @@index([companyId, lossType, investigationStatus])
  @@index([companyId, createdAt])
  @@index([orgVariantId])
}
```

**Critical observations on the schema:**

1. **No `sourceModule` field.** Once a `StockLossRecord` row exists, you cannot tell which module created it (RTO review? Cycle count? Adjust stock? Receive-returned-stitched? Exchange? Manual report? Supplier-return rejection?) — you can only guess from `lossType` + `notes` text.
2. **No `cycleCountId` FK.** Cycle-count-created missing losses mention the cycle count name in `notes` text only — no programmatic back-link.
3. **`orderReferenceId` is a free-text String, not a FK.** Only the transit-loss endpoint sets it; no validation that it points to a real Order.
4. **`orderItemId` is a proper FK but only set by ONE caller** (`correctReturnItemCondition` in `order-return.actions.ts:319`). No other create path sets it.
5. **`supplierReturnId` is `@unique`** — supplier-dispute losses ARE idempotent at the DB level.
6. **NO unique constraint on `orderItemId`** — the same `OrderItem` could have multiple `StockLossRecord` rows (one from RTO correction, one from a manual damaged report). No dedup protection.
7. **`inventoryTxnId` is nullable AND updatable.** Multiple create paths insert the loss record first with `inventoryTxnId=null`, then call `processInventoryTransaction`, then UPDATE the row to set `inventoryTxnId`. This violates the "append-only ledger" principle documented in `schema.prisma:1032`. If the second step (the txn) fails, the loss record exists with `inventoryTxnId=null` and `resolution='written_off'` but no actual write-off occurred — the UI shows the loss as resolved while stock is untouched.
8. **`evidenceUrls` stored as a JSON-stringified `String`** — not a proper JSONB column. Same for `photos` on `ReturnedStitchedInventory`.

#### A.3 Transaction types created by Stock Losses module

From `src/lib/inventory.ts:22-41` (the `TransactionType` union) + the OUT_TYPES array (lines 42-51):

- **Damaged (single-stage):** `damage_writeoff` (in OUT_TYPES → decrements onHand).
- **Theft (two-stage):** NONE at report time (only `quarantineStock` increments `reserved`). At resolve: `theft_writeoff` if `written_off`; none if `recovered` or `error_corrected`.
- **Missing:** only created via cycle count → `missing_writeoff` at resolve time.
- **Transit loss:** NONE (no inventory txn — stock was already decremented at `sale_dispatched`).
- **Supplier dispute:** NONE from the loss-record endpoint itself (the `supplier_return` txn was done at supplier-return CREATE time per the inventory audit).

#### A.4 Order linking

- `orderReferenceId` (free-text String) is set ONLY by the **transit-loss** endpoint (`report-transit/route.ts:72`).
- `orderItemId` (proper FK) is set ONLY by the **RTO review correction** flow (`correctReturnItemCondition` at `order-return.actions.ts:319`).
- The dedicated `report-damaged` endpoint does NOT accept any order link in its Zod schema (`reportDamagedLossSchema` in `src/lib/validations/stock-loss.ts:17-37`). The `DamagedForm` UI component (`src/components/inventory/losses-view.tsx:1170-1225`) does not have an order-picker or order-reference input.

#### A.5 Responsible-party options

From `reportDamagedLossSchema` (`validations/stock-loss.ts:29-34`):

```ts
responsible_party: z.enum(['warehouse', 'courier', 'customer', 'employee'])
```

Note: `'supplier'` and `'unknown'` are MISSING from this enum despite being valid values per the schema column comment (line 1300: `warehouse | courier | customer | employee | unknown | supplier`). The transit-loss endpoint hard-codes `responsibleParty: 'courier'` (line 69 of report-transit/route.ts). Theft defaults `responsibleParty: 'unknown'` (line 78 of report-theft/route.ts). Supplier-dispute hard-codes `responsibleParty: 'supplier'`.

---

### B. RTO Flow (Orders module)

RTO (Return To Origin) is triggered via 3 entry points that all converge on the same logic:

#### B.1 Entry points

1. **Manual via Order Detail UI** — `POST /api/orders/[id]/rto` (file `src/app/api/orders/[id]/rto/route.ts`, 27 lines) → calls `processOrderReturn(orderId, returnReason)` from `src/lib/actions/order-return.actions.ts`.
2. **Courier webhook (Leopard)** — `src/lib/actions/leopard-webhook.actions.ts:202-237` calls `restockOrderForRto()` (defined in `src/lib/inventory.ts:846-958`), then sets `order.status = 'rto'`.
3. **Courier polling (PostEx)** — `src/lib/actions/postex-status-poll.actions.ts:265-286` calls `restockOrderForRto()`, then sets `order.status = 'rto'`.
4. **Generic webhook** — `src/app/api/webhooks/[provider_key]/[webhook_endpoint_id]/route.ts:127` calls `processOrderReturn(order.id, 'Courier returned (RTO)')`.

#### B.2 What RTO does to stock

Two code paths with DIFFERENT behavior:

**Path A — `processOrderReturn()` (manual + generic webhook)** (`order-return.actions.ts:52-219`):

For each `dispatched` order item:
- Looks up the original `sale_dispatched` txn to recover `costPerUnit`.
- If `fulfillmentTypeSnapshot === 'made_to_order'`: calls `processInventoryTransaction` with type `'return_stitched_received'` → **increments onHand** AND recalculates WAC AND one-way flips `trackInventory` to TRUE on the variant.
- Else (`stock_based`): calls `processInventoryTransaction` with type `'return_resellable'` → **increments onHand** AND recalculates WAC.
- Sets `OrderItem.autoProcessedAsPerfect = true` AND `OrderItem.needsReview = true` → the item surfaces in the exception review queue for physical spot-checking.
- Sets `Order.status = 'rto'`, `Order.returnedAt = now`.
- Updates customer stats (increments `totalRtoCount`); auto-flags customer if RTO count ≥ 3.
- Fires-and-forgets employee stats recompute (RTO changes `rtoCount`, `rtoRate`, `inTransitCount`).

For `confirmed`/`processing` (not-yet-dispatched) items: NOT covered in `processOrderReturn` (its `where: { fulfillmentStatus: 'dispatched' }` filter at line 69 excludes them).

**Path B — `restockOrderForRto()` (Leopard + PostEx auto-RTO)** (`inventory.ts:846-958`):

For each order item:
- If `fulfillmentStatus === 'returned'`: **SKIP** (idempotency — already processed by a prior call).
- If `fulfillmentStatus === 'dispatched'`: same as Path A — looks up `sale_dispatched` txn, calls `processInventoryTransaction` with type `'return_stitched_received'` (MTO) or `'return_resellable'` (stock-based). Sets `OrderItem.fulfillmentStatus = 'returned'`, `autoProcessedAsPerfect = true`, `needsReview = true`.
- If `fulfillmentStatus === 'reserved'`: calls `unreserveStockForOrder` → `processInventoryTransaction` with type `'order_unreserved'` (decrements `reserved`, no onHand change). Sets `OrderItem.fulfillmentStatus = 'returned'`.

**KEY POINT:** RTO does NOT decrement stock. It INCREMENTS stock back (assumes resellable/perfect). The original stock decrement happened earlier at `dispatchOrder` time via `sale_dispatched`.

#### B.3 Does RTO create a `StockLossRecord`?

**NO — not at RTO trigger time.** Verified in:
- `processOrderReturn` (`order-return.actions.ts:52-219`): the only DB writes are `order.update`, `processInventoryTransaction`, `orderItem.update`, `insertAuditLog`, `insertMetricEvent`, `updateCustomerStats`, `flagCustomer`, `updateEmployeeStats`. NO `db.stockLossRecord.create` call.
- `restockOrderForRto` (`inventory.ts:846-958`): only calls `processInventoryTransaction` + `orderItem.update`. NO loss record creation.

**However**, the RTO review-correction path DOES create one — only when a human later inspects the returned item and decides it was actually damaged. That flow is `correctReturnItemCondition` (next subsection B.4).

#### B.4 RTO exception-review correction flow

`POST /api/orders/[id]/returns/review/correct?item_id=X` → `correctReturnItemCondition(orderItemId, 'damaged')` (`order-return.actions.ts:225-359`).

What it does:
1. Verifies the item was `autoProcessedAsPerfect=true` and `needsReview=true`.
2. Finds the auto-processed return txn (`return_resellable` or `return_stitched_received`) to recover cost basis.
3. **Reverses the auto-processed increment** by calling `processInventoryTransaction` with type `'damage_writeoff'` and the same quantity — this decrements onHand back to where it was before RTO. (Code line 280-292.)
4. **Creates a `StockLossRecord`** with:
   - `lossType: 'damaged'`, `subType: 'confirmed'`, `damageType: 'other'`, `quantity`, `costPerUnit`
   - `investigationStatus: 'none'`, `resolution: 'written_off'` (instant write-off — no investigation opened despite the damage being physical)
   - `responsibleParty: 'courier'` (hard-coded — even though the user has no way to override; e.g. warehouse damage during unpack would still be attributed to courier)
   - `damageType: 'other'` (hard-coded — no way to specify `water_moisture`, `physical_impact`, etc.)
   - `orderItemId: item.id` (the ONLY code path that sets this FK)
   - `inventoryTxnId: reverseResult.transactionId` (linked to the reversal txn)
   - `reportedById / approvedById / resolvedById` = the correcting employee
5. Sets `OrderItem.needsReview = false`.

There is also a `POST /api/orders/[id]/returns/review/dismiss?item_id=X` → `dismissReturnReview(orderItemId)` (`order-return.actions.ts:365-403`) which simply sets `needsReview = false` with no inventory change — confirms the auto-assumed condition was correct.

#### B.5 Double-decrement risk (Problem 1 detailed)

The user's wording "RTO decrements stock" is technically imprecise — RTO actually INCREMENTS stock back (auto-assumes resellable). But the underlying bug the user describes is real, and there are THREE distinct double-counting scenarios:

**Scenario 1 — Double INCREMENT (most likely what the user observed):**
1. Order dispatched → `sale_dispatched` decrements onHand (say 10 → 9).
2. Order marked RTO → `processOrderReturn` calls `return_resellable` (or `return_stitched_received` for MTO) → onHand goes 9 → 10. Item flagged `needsReview=true`.
3. User does NOT spot the auto-increment, and ALSO goes to the inventory module and calls `POST /api/inventory/receive-returned-stitched` with the same variant+location+quantity → that endpoint (`src/app/api/inventory/receive-returned-stitched/route.ts:101-118`) calls `processInventoryTransaction` with `return_stitched_received` → onHand goes 10 → 11. **Double-increment.** The system now shows 11 units when only 10 physically exist. The next sale will succeed against phantom stock → customer gets short-shipped, OR a later cycle count reveals a shortage with no explanation.

**Scenario 2 — Two loss records for one damaged item:**
1. Order dispatched → onHand 10 → 9.
2. Order marked RTO → onHand 9 → 10 (auto-assumes perfect). Item flagged `needsReview=true`.
3. User opens Returns & RTO → Review Queue → clicks "Correct to Damaged" → `correctReturnItemCondition` reverses the increment (10 → 9) AND creates `StockLossRecord #1` with `orderItemId=X`, `lossType='damaged'`, `responsibleParty='courier'`.
4. User separately opens the dedicated Stock Losses module → clicks "Report Damaged" → fills the form with the same variant+location+quantity → `report-damaged/route.ts` creates `StockLossRecord #2` AND decrements onHand AGAIN (9 → 8). **Two loss records exist for the same physical damage; onHand is now 8 when it should be 9.**

Because `orderItemId` is NOT unique on `StockLossRecord` (verified — no `@unique` constraint on `orderItemId` in the schema), the DB does NOT prevent Scenario 2. The report-damaged endpoint doesn't even check for an existing loss on the same `orderItemId`.

**Scenario 3 — Returned Stock module parallel record-keeping:**
1. Order marked RTO → `processOrderReturn` increments onHand back AND auto-assumes perfect.
2. User opens Returned Stock module → `POST /api/returned-stitched` (file `src/app/api/returned-stitched/route.ts:79-186`) creates a `ReturnedStitchedInventory` row with `status='available'` (or `'written_off'` if `condition='damaged'`).
3. **This endpoint does NOT call `processInventoryTransaction`** — so no double-increment. BUT:
   - It does NOT create a `StockLossRecord` either, even when `condition='damaged'` (it just sets `status='written_off'` on the ReturnedStitchedInventory row itself).
   - It does NOT validate that the variant hasn't ALREADY been restocked via RTO (`originalOrderReference` is a free-text string, not an FK).
   - The user now has TWO records of the same physical item: the `OrderItem` with `fulfillmentStatus='returned'` (from RTO) AND a `ReturnedStitchedInventory` row with `originalOrderReference` pointing to the order number — neither references the other.
   - If the user later marks the `ReturnedStitchedInventory` row as `'written_off'` via `POST /api/returned-stitched/[id]` with `action='write_off'` → that endpoint (`returned-stitched/[id]/route.ts:99-107`) just updates the row's status fields. No `StockLossRecord`. No `processInventoryTransaction`. The pool still shows the auto-incremented stock from RTO — which may now be wrong if the item was actually damaged.

The net effect: the Stock Losses dashboard can show **0 losses for a variant whose onHand has decreased**, OR show **2 losses for the same physical damage**, depending on which combination of paths the user takes. This is the dis-unification the user is asking to fix.

---

### C. Cycle Count

File: `src/app/api/cycle-counts/[id]/route.ts` (424 lines, PATCH action = `start | submit_counts | approve | cancel`).

#### C.1 What happens when a shortage is found

The approve action (lines 271-398) iterates every cycle-count item with a non-zero discrepancy. Branch logic at line 286:

```ts
if (discrepancy < 0 && (item.discrepancyReason === 'theft_suspected' || item.discrepancyReason === 'unknown')) {
  // Path X — quarantine + create StockLossRecord(missing) + cycle_count_adjust
} else {
  // Path Y — just cycle_count_adjust, NO StockLossRecord
}
```

**Path X — shortage with `theft_suspected` or `unknown` reason** (lines 286-337):
1. Calls `quarantineStock(variant, location, absDiscrepancy)` → increments `reserved` (no ledger txn).
2. Fetches `pool.avgCost` for cost basis.
3. **Creates a `StockLossRecord`** with:
   - `lossType: 'missing'`, `subType: 'suspected'`, `quantity: absDiscrepancy`, `costPerUnit: avgCost`
   - `investigationStatus: 'open'`, `resolution: null` (will be resolved later via `/api/stock-loss/resolve`)
   - `responsibleParty: 'unknown'`
   - `notes: "Auto-created from cycle count ${count.countName}. Discrepancy reason: ${item.discrepancyReason}"`
   - `inventoryTxnId: null` ← **NOT linked** even though a txn IS created in step 4 below
   - **NO `orderItemId`** (missing losses are not order-linked)
   - **NO `cycleCountId`** field exists on `StockLossRecord` — only a text mention in `notes`
4. Calls `processInventoryTransaction` with type `'cycle_count_adjust'` and `quantity: item.countedQuantity` → **SETS onHand directly to the counted value** (per `inventory.ts:231-235`: `case 'cycle_count_adjust': newOnHand = absQty`). So onHand goes from system_quantity to counted_quantity, e.g. 10 → 8.
5. Updates `CycleCountItem.adjustmentApproved = true` and `CycleCountItem.inventoryTxnId = txnResult.transactionId`.

**Path Y — shortage with `recording_error`, `transfer_not_recorded`, or `damage_not_recorded` reason, OR any surplus** (lines 338-363):
- Just calls `processInventoryTransaction` with `'cycle_count_adjust'` and `quantity: item.countedQuantity` → SETS onHand to counted value.
- **NO `StockLossRecord` is created**, regardless of the reason. So a shortage of 2 suits marked `damage_not_recorded` adjusts onHand from 10 → 8 but the Stock Losses module shows 0 losses for that variant.

#### C.2 Does it create `StockLossRecord`?

**YES — but ONLY for `theft_suspected` / `unknown` shortages.** Confirmed by code at lines 297-315 of `cycle-counts/[id]/route.ts`.

**NO for `damage_not_recorded`, `recording_error`, `transfer_not_recorded`, or `surplus` discrepancies.** Confirmed by lines 338-363 (no `db.stockLossRecord.create` call in the `else` branch).

#### C.3 Does it create a `missing_writeoff` transaction?

**NO.** At approve time it creates a `cycle_count_adjust` txn (which SETS onHand). It does NOT call `missing_writeoff` — that only happens later, when the resulting `StockLossRecord` (lossType='missing') is resolved via `/api/stock-loss/resolve` with `resolution='written_off'`.

The 5 discrepancy reasons are documented in the UI at `src/components/inventory/cycle-counts-view.tsx:220-224`:

```ts
{ value: 'recording_error', label: 'Recording error', ... },
{ value: 'transfer_not_recorded', label: 'Transfer not recorded', ... },
{ value: 'damage_not_recorded', label: 'Damage not recorded', hint: 'Units were damaged but no stock-loss report was filed.' },
{ value: 'theft_suspected', label: 'Theft suspected', hint: '... will quarantine + open a missing-stock investigation on approval.' },
{ value: 'unknown', label: 'Unknown', hint: '... will quarantine + open a missing-stock investigation on approval.' },
```

So the UI explicitly promises that `damage_not_recorded` is for units that were damaged without a prior loss report — yet the approve flow does NOT create a loss record. The hint is misleading.

#### C.4 Double-decrement risk (Problem 2 — detailed)

**Cycle Count vs Stock Losses module:**
1. Cycle count finds 2 suits short → user selects reason `damage_not_recorded` → approve → onHand goes 10 → 8, NO `StockLossRecord` created.
2. The user (or an auditor noticing the gap) opens the Stock Losses module and reports 2 damaged units → `report-damaged/route.ts` creates `StockLossRecord` AND calls `processInventoryTransaction('damage_writeoff')` → onHand goes 8 → 6. **Double-decrement: 2 units decremented twice.**

Because cycle-count-created adjustments have `referenceType='cycle_count'` and Stock-Loss-created write-offs have `referenceType='stock_loss'`, you can detect this in the ledger after the fact — but nothing prevents it at write time.

**Cycle Count vs Adjust Stock:**
Same scenario — a shortage can be corrected via Adjust Stock with `damage_writeoff` instead of via Cycle Count. Both decrement onHand; neither knows about the other.

**Cycle Count's own internal missing-loss path is sound** (creates the loss record + quarantine + adjusts onHand to counted value), but the loss record is missing `inventoryTxnId` (mentioned in `INVENTORY_AUDIT.md` line 443 as `[MEDIUM] The missing-loss record created on approve does NOT have an inventoryTxnId set`). The loss investigator later clicks "Resolve" → `releaseQuarantine` → `missing_writeoff` decrements onHand AGAIN — but since the cycle_count_adjust already set onHand to the counted value, the additional `missing_writeoff` decrement causes onHand to go BELOW the physically-counted value. This is a separate bug (the cycle count should NOT adjust onHand to the counted value when quarantining for theft — it should leave onHand alone and only adjust after the investigation resolves).

---

### D. Adjust Stock

File: `src/app/api/inventory/adjust/route.ts` (179 lines).

#### D.1 What happens on a negative adjustment

The route branches at line 53: `const isPositive = d.quantity > 0`.

**Positive adjustment** (lines 72-114): calls `processInventoryTransaction` with type `'manual_adjustment_in'` → onHand increments by `absQty`. No `StockLossRecord`. (Audit-fixed in INVENTORY-3-BUGS-FIXED — previously used `damage_writeoff` for both directions.)

**Negative adjustment** (lines 115-158): calls `processInventoryTransaction` with type `'damage_writeoff'` → onHand decrements by `absQty`. **NO `StockLossRecord` is created.**

The Zod schema (`adjustStockSchema` in `src/lib/validations/inventory.ts:78-84`):

```ts
export const adjustStockSchema = z.object({
  org_variant_id: z.string().min(1),
  location_id: z.string().min(1),
  quantity: z.number().int().refine((v) => v !== 0, 'Quantity must be non-zero (positive to add, negative to remove)'),
  reason: z.string().min(3, 'Reason is required').max(500),
  notes: z.string().max(1000).optional().or(z.literal('')),
})
```

`reason` is a free-text string with no enum constraint. The audit report (line 191) flagged: "Reports cannot group by reason reliably."

The frontend (`src/components/inventory/adjust-stock-view.tsx`) offers reason presets (line 97+ per the audit), but they're sent to the API as plain strings and not enforced by the schema.

#### D.2 Does it create `StockLossRecord`?

**NO.** Verified by reading the entire route (179 lines) — there is no `db.stockLossRecord.create` call anywhere. Confirmed also by `INVENTORY_AUDIT.md` Module 5 audit which makes no mention of a loss record being created on the negative-adjustment path.

#### D.3 Double-decrement risk

1. User wants to record 5 damaged units. Two valid paths:
   - **Path A:** Stock Losses → Report Damaged → 5 units. Creates loss record + `damage_writeoff` txn. onHand: 10 → 5.
   - **Path B:** Adjust Stock → -5 → reason "5 units damaged in warehouse flood". Calls `damage_writeoff` txn. onHand: 10 → 5. **NO loss record created.**
2. **Combination:** User clicks Path A first (creates loss record + decrements to 5), then realises they need to add a note about the flood → opens Adjust Stock → enters -5 again with reason "5 units damaged in warehouse flood" → onHand: 5 → 0. **Stock destroyed; no second loss record but a SECOND `damage_writeoff` txn exists for the same physical damage.**

Even worse: a user might use Adjust Stock with a positive quantity to "fix" a prior loss by adding the units back. Since neither endpoint references the other, there's no audit trail linking the two events.

---

### E. Returned Stock Module

Located in `src/app/api/returned-stitched/` (3 routes) + `src/components/products/returned-stitched-view.tsx` (1351 lines).

The "Returned Stock" sidebar entry (`src/components/layout/sidebar.tsx:67`) routes to `?view=returned-stitched` which renders `ReturnedStitchedView`. It is a PRODUCTS-section module, not an inventory-section module — despite its primary purpose being reverse-logistics inventory handling.

#### E.1 Lifecycle of a `ReturnedStitchedInventory` row

The `ReturnedStitchedInventory` model (`prisma/schema.prisma:842-880`):

```prisma
model ReturnedStitchedInventory {
  id              String   @id @default(cuid())
  organizationId  String
  companyId       String
  orgVariantId    String
  quantity        Int      @default(1)
  condition       String   // perfect | good | open_box | damaged
  totalCost       Decimal  @db.Decimal(12, 2)
  suggestedResalePrice Decimal?
  originalOrderReference String?   // FREE-TEXT, not an FK
  returnReason    String?
  status          String   @default("available")  // available | sold | written_off
  photos          String   @default("[]")  // JSON array
  notes           String?
  receivedById    String?
  receivedAt      DateTime @default(now())
  soldAt          DateTime?
  soldOrderReference String?  // FREE-TEXT, not an FK
  writtenOffAt    DateTime?
  writtenOffById  String?
  writeOffReason  String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@index([organizationId, orgVariantId, status])
  @@index([companyId, status])
}
```

**Critical observations:**
- `originalOrderReference` is `String?` — not an FK. No referential integrity.
- `soldOrderReference` is `String?` — same.
- No relation to `OrderItem`, `OrderExchange`, or `StockLossRecord`.
- No `inventoryTxnId` field — the row never references the ledger.
- The model has NO relation to `InventoryPool` — it's a parallel inventory record that doesn't share the source of truth.

#### E.2 Receive endpoint — `POST /api/returned-stitched`

File: `src/app/api/returned-stitched/route.ts` (186 lines).

**What it does to stock:** NOTHING. It only creates the `ReturnedStitchedInventory` row. **It does NOT call `processInventoryTransaction`.** It does NOT create a `StockLossRecord` even when `condition='damaged'`.

When `condition === 'damaged'`:
- Sets `status = 'written_off'`
- Sets `writtenOffAt = now`
- Sets `writtenOffById = caller.id`
- Sets `writeOffReason = 'Damaged on return'` (hard-coded)
- Audit log action: `returned_stitched.received`
- No pool change. No loss record.

#### E.3 Mark-as-sold / mark-as-written-off — `POST /api/returned-stitched/[id]`

File: `src/app/api/returned-stitched/[id]/route.ts` (127 lines).

Action `sold` (lines 46-82):
- Verifies `record.status === 'available'`.
- Updates row: `status='sold'`, `soldAt`, `soldOrderReference` (from `markSoldSchema`).
- Audit log: `returned_stitched.sold`.
- **NO `processInventoryTransaction` call.** No loss record. No pool change. The `soldOrderReference` is free-text — no validation that it references a real Order.

Action `write_off` (lines 83-120):
- Verifies `record.status === 'available'`.
- Updates row: `status='written_off'`, `writtenOffAt`, `writtenOffById`, `writeOffReason`.
- Audit log: `returned_stitched.written_off`.
- **NO `processInventoryTransaction` call.** No loss record. No pool change.

#### E.4 Does it create `StockLossRecord`?

**NO.** Verified by reading both routes — zero `db.stockLossRecord.create` calls.

The ONLY endpoint that creates a loss record for a "returned stitched" item is the **OTHER** endpoint: `POST /api/inventory/receive-returned-stitched` (note: different file, different URL, different schema). That endpoint (`src/app/api/inventory/receive-returned-stitched/route.ts`):
- When `condition === 'damaged'`: creates a `StockLossRecord` with `lossType='damaged'`, `responsibleParty='courier'`, `damageType='other'`. Does NOT call `processInventoryTransaction` (assumes stock was already decremented at dispatch — audit flagged this assumption as unsafe in `INVENTORY_AUDIT.md` line 157).
- When `condition` is `perfect`/`good`/`open_box`: calls `processInventoryTransaction` with `return_stitched_received` (increments onHand + recalculates WAC).

So there are TWO completely separate "receive returned stitched" endpoints, both doing partly-overlapping things:
- `/api/returned-stitched` (Returned Stock module) — neither decrements nor increments pool; never creates loss record.
- `/api/inventory/receive-returned-stitched` (Inventory Receive Stock module) — increments pool OR creates loss record.

Neither references the other.

#### E.5 Double-decrement risk

See §B.5 Scenario 3 above. The Returned Stock module is a parallel record-keeping system that doesn't touch the inventory pool, so it doesn't directly double-decrement — but it creates a false sense of completeness: a user looking at the Returned Stock module sees a "written_off" row and assumes the loss is recorded, while the Stock Losses module shows nothing. The actual onHand pool may still contain the auto-incremented RTO stock (Scenario 3 in §B.5).

---

### F. Return Order Scan

Files:
- `src/components/orders/order-scan-view.tsx` (543 lines)
- `src/lib/actions/scan.actions.ts` (356 lines)
- `src/app/api/scan/route.ts` (42 lines — thin wrapper around `processScan`)

#### F.1 Current scan flow

Six scan modes (defined at `order-scan-view.tsx:58-65`):

| Mode | Action taken on scan | Backend call |
|---|---|---|
| `mark_processing` | Calls `markOrderProcessing(orderId)` | dynamic import in `scan.actions.ts:173` |
| `mark_packed` | Calls `markOrderPacked(orderId)` | dynamic import in `scan.actions.ts:193` |
| `warehouse_handover` | Sets `warehouseHandoverScannedAt = now` on the order/shipment | direct DB update at `scan.actions.ts:209-211` |
| `receive_return` | **NO action taken** — only logs scan event + returns entity details to UI | `scan.actions.ts:217-222` |
| `locate_cancelled` | Only validates status is `cancelled`; logs scan event | `scan.actions.ts:225-233` |
| `cancel_via_scan` | Returns entity for confirmation; staff must click "Confirm Cancel" → calls `confirmCancelAfterScan` → `cancelCourierBooking` | `scan.actions.ts:236-245`, `308-329` |

#### F.2 Can it trigger RTO?

**NO.** The `receive_return` mode explicitly does NOT call `processOrderReturn`. The code comment at `scan.actions.ts:219` says: *"Return entity details to UI — staff selects condition BEFORE calling processOrderReturn"*. But the UI (`order-scan-view.tsx`) has no follow-up action — it just displays the order items in the result panel (lines 285-300) and asks the staff to "select return condition to proceed" (toast message at line 221). The user must then navigate to Orders → Order Detail → click "RTO" → enter reason → submit.

There is also NO `confirm_rto` action in the scan API (only `confirm_unpack` and `confirm_cancel` are handled — `scan/route.ts:20-30`).

#### F.3 Can it record damage?

**NO.** There is no inline damage-recording option in the scan UI. No `report-damaged` call. No `correctReturnItemCondition` call. The scan station is purely a barcode-lookup + simple-lifecycle-trigger tool.

#### F.4 What's missing for the user's Problem 5

The user wants the scan flow to:
1. **Confirm RTO in one go** — instead of scan → navigate to order detail → click RTO → enter reason → submit, the scan should immediately process the RTO (with a default reason like "Courier returned (RTO)") or pop a small inline prompt for the reason.
2. **Offer the damage/transit-loss option inline** — so when scanning a return, the staff can select "this came back damaged" or "transit loss" right there, and the system creates the appropriate `StockLossRecord` (+ reverse the auto-increment for damage, + claim tracking for transit loss) without needing to visit 3 separate modules.

Currently neither is possible. The scan flow's `receive_return` mode is essentially a no-op that just identifies the order.

---

## Part 2: The 5 Problems (Detailed Analysis)

### Problem 1: RTO + Returned Stock double-decrement

**Detailed trace of the exact code path that causes double-counting:**

1. **Dispatch time:** `dispatchOrder` in `src/lib/inventory.ts:791-817` calls `processInventoryTransaction` with `transactionType: 'sale_dispatched'`. At `inventory.ts:201-204`:
   ```ts
   case 'sale_dispatched':
     newOnHand -= absQty                    // 10 → 9
     newReserved = Math.max(0, newReserved - absQty)
   ```
   Result: onHand 10 → 9, reserved 1 → 0. An `InventoryTransaction` row is inserted with `quantity: -1`, `referenceType: 'order'`, `referenceId: orderId`.

2. **RTO trigger (manual via order detail):** User clicks "RTO" button → opens `RtoDialog` (`order-detail-view.tsx:1371-1376`) → enters reason → `rtoMutation.mutate({ return_reason })` → `POST /api/orders/[id]/rto` → `processOrderReturn(orderId, reason)` (`order-return.actions.ts:52`).

3. **Inside `processOrderReturn`** (lines 65-167): fetches order with items where `fulfillmentStatus: 'dispatched'`. For each dispatched item, looks up the original `sale_dispatched` txn (lines 99-109) to recover `costPerUnit`. Then at lines 114-167:
   - If MTO: `processInventoryTransaction({ transactionType: 'return_stitched_received', quantity, costPerUnit, referenceType: 'order', referenceId: orderId })`. At `inventory.ts:215-218`:
     ```ts
     case 'return_stitched_received':
       newOnHand += absQty                    // 9 → 10 (auto-assumed perfect)
       newAvgCost = calculateNewAvgCost(...)   // WAC recalculated
     ```
   - Else (stock-based): `processInventoryTransaction({ transactionType: 'return_resellable', ... })`. At `inventory.ts:211-214`: same effect — `newOnHand += absQty` + WAC recalc.
   - Sets `orderItem.autoProcessedAsPerfect = true`, `orderItem.needsReview = true`.
4. **Order status updated:** `order.status = 'rto'`, `order.returnedAt = now`.

5. **User opens Returned Stock module:** `POST /api/returned-stitched` with `{ org_variant_id, condition: 'perfect', total_cost, original_order_reference: 'ORD-XXXX', return_reason: '...' }`. The endpoint creates a `ReturnedStitchedInventory` row with `status='available'`. **It does NOT call `processInventoryTransaction`** — so onHand stays at 10. No double-increment here. **BUT** the user now has TWO records of the same physical return: the auto-incremented pool (from RTO) AND the ReturnedStitchedInventory row. Neither references the other.

6. **User opens Inventory → Receive Stock → Receive Returned Stitched:** `POST /api/inventory/receive-returned-stitched` with `{ org_variant_id, location_id, condition: 'perfect', total_cost, ... }`. The endpoint (`receive-returned-stitched/route.ts:101-118`) calls `processInventoryTransaction` with `return_stitched_received` → onHand 10 → 11. **Double-increment.** The system now believes 11 units exist; only 10 do.

**For the "damage" sub-scenario:**
7. User opens Returns & RTO → Review Queue → sees the item with `needsReview=true` → clicks "Correct to Damaged" → `POST /api/orders/[id]/returns/review/correct?item_id=X` → `correctReturnItemCondition(X, 'damaged')`.
8. Inside `correctReturnItemCondition` (lines 280-322): calls `processInventoryTransaction` with `transactionType: 'damage_writeoff'` → onHand 11 → 10 (reverses ONE of the two prior increments; the other phantom increment from step 6 remains). Then creates `StockLossRecord` with `orderItemId=X`, `lossType='damaged'`, `responsibleParty='courier'`, `damageType='other'`.
9. **Net result:** onHand=10 (should be 9, since the item is actually damaged and was never physically returned to sellable stock), one `StockLossRecord` exists, one phantom `return_stitched_received` increment remains in the ledger with no offsetting write-off.

**Why no DB-level protection exists:** `StockLossRecord.orderItemId` is NOT `@unique` (verified at `schema.prisma:1324`). Multiple loss records can exist for the same `orderItemId`. The `report-damaged` endpoint does NOT check for an existing loss record with the same `orderItemId` before creating a new one. The `receive-returned-stitched` endpoint does NOT check for an existing `return_stitched_received` txn for the same variant+location+order before creating another one.

---

### Problem 2: Cycle Count + Adjust Stock don't create `StockLossRecord`s

**Detailed trace + evidence:**

**Cycle Count, `damage_not_recorded` path** (`cycle-counts/[id]/route.ts:338-363`):

```ts
} else {
  // Normal cycle_count_adjust for recording_error, transfer_not_recorded,
  // damage_not_recorded, or surplus
  const txnResult = await processInventoryTransaction({
    orgVariantId: item.orgVariantId,
    locationId: count.locationId,
    organizationId: orgId,
    companyId: company.id,
    employeeId: caller.id,
    transactionType: 'cycle_count_adjust',
    quantity: item.countedQuantity,   // SETS onHand to counted value
    costPerUnit: null,
    referenceType: 'cycle_count',
    referenceId: id,
    notes: `Cycle count adjustment: ${item.systemQuantity} → ${item.countedQuantity}`,
  })
  if (txnResult.success && txnResult.transactionId) {
    await db.cycleCountItem.update({
      where: { id: item.id },
      data: {
        adjustmentApproved: true,
        inventoryTxnId: txnResult.transactionId,
      },
    })
  }
}
```

No `db.stockLossRecord.create` call anywhere in this branch. The `cycle_count_adjust` txn type SETS onHand directly (per `inventory.ts:231-235`), so the discrepancy is silently absorbed into the pool. The Stock Losses module shows nothing.

**Adjust Stock, negative adjustment** (`inventory/adjust/route.ts:115-158`):

```ts
} else {
  // Removing stock — use damage_writeoff as a generic removal type
  const txnResult = await processInventoryTransaction({
    orgVariantId: d.org_variant_id,
    locationId: d.location_id,
    organizationId: orgId,
    companyId: company.id,
    employeeId: caller.id,
    transactionType: 'damage_writeoff',     // ← masquerades as damage
    quantity: absQty,
    referenceType: 'manual',
    notes: `Manual adjustment: ${d.reason}. ${d.notes || ''}`,
  })
  // ... audit log + metric event ...
  return { success: true, transaction_id: txnResult.transactionId }
}
```

No `db.stockLossRecord.create` call. The `damage_writeoff` txn decrements onHand but no loss record is created. The audit report (`INVENTORY_AUDIT.md` line 187) flagged this as `[HIGH] Negative adjustment masquerades as damage_writeoff`.

**Evidence the Stock Losses dashboard will under-report:**
- `/api/stock-loss/stats` (`stats/route.ts:8-58`) only counts `db.stockLossRecord.findMany` rows. Since cycle-count `damage_not_recorded` and adjust-stock negative adjustments don't create loss rows, they don't appear in the stats. The dashboard's "Losses this month" KPI silently excludes them.
- `/api/inventory/dashboard` (`dashboard/route.ts`) DOES count `damage_writeoff` txn types in its movement summary (audit Module 1, line 49: "losses" bucket groups `supplier_return` under losses too). So the Inventory Dashboard may show a "loss" of 5 units while the Stock Losses module shows 0 losses — visually contradictory.

**Double-decrement risk:**
1. Cycle count finds 2 missing → reason `damage_not_recorded` → onHand 10 → 8, NO loss record.
2. User opens Stock Losses → reports 2 damaged → onHand 8 → 6, loss record created.
3. Two separate `damage_writeoff`-family txns in the ledger for the same physical damage; onHand 4 units lower than it should be.

Or for Adjust Stock:
1. User adjusts -5 with reason "5 damaged" → onHand 10 → 5, NO loss record.
2. Auditor sees no loss record → opens Stock Losses → reports 5 damaged → onHand 5 → 0.

---

### Problem 3: Courier responsibility + order linking in Stock Loss

**Current state:**

The `DamagedForm` UI (`src/components/inventory/losses-view.tsx:1170-1225`) collects: `variantId`, `locationId`, `quantity`, `damageType`, `responsibleParty` (enum: warehouse/courier/customer/employee), `notes`. **No order reference field, no order search, no orderItemId link.**

The `reportDamagedLossSchema` (`validations/stock-loss.ts:17-37`):

```ts
export const reportDamagedLossSchema = z.object({
  org_variant_id: z.string().min(1, 'Variant is required'),
  location_id: z.string().min(1, 'Location is required'),
  quantity: z.number().int().positive('Quantity must be positive'),
  damage_type: z.enum(['water_moisture', 'physical_impact', 'manufacturing_defect', 'transit_damage', 'storage_damage', 'other']),
  responsible_party: z.enum(['warehouse', 'courier', 'customer', 'employee']),
  evidence_urls: z.array(z.string().url()).default([]),
  notes: z.string().max(1000).optional().or(z.literal('')),
})
```

**No `order_item_id`, no `order_reference_id`, no `linked_order_id`.** Even though the `StockLossRecord` schema HAS an `orderItemId` FK field (line 1324 of schema.prisma), the dedicated damaged-report endpoint never populates it.

**What's missing:**
1. **Order picker / search component** in the DamagedForm. The Transit form already has a free-text `order_reference_id` input (`losses-view.tsx:1643, 1696-1699`) but it's plain text — no validation against real Orders, noautocomplete, no order-item selection.
2. **Conditional required field:** When `responsible_party='courier'`, the form should REQUIRE an order link (the courier can only be responsible in the context of a specific shipment). Currently you can select `courier` with no order context, making the loss record useless for filing a courier claim.
3. **Deduplication:** If a loss already exists for `(orderItemId, lossType='damaged')`, the form should warn or block the duplicate. Currently nothing prevents it (the `orderItemId` column is NOT `@unique`).
4. **`'supplier'` and `'unknown'` are missing from the `responsible_party` enum** in the Damaged form schema, even though the schema column allows them. A user can't manually record a supplier-caused damage via this form.

---

### Problem 4: Transit loss + RTO + Stock Losses

**Current state:**

`StockLossRecord.orderReferenceId` is a `String?` (line 1320 of schema.prisma) with the comment "for transit_loss: references the dispatched order (future)". The "future" tag indicates the original designer intended to upgrade this to a real FK but never did.

The `reportTransitLossSchema` (`validations/stock-loss.ts:73-80`):

```ts
export const reportTransitLossSchema = z.object({
  org_variant_id: z.string().min(1, 'Variant is required'),
  location_id: z.string().min(1, 'Dispatch location is required'),
  quantity: z.number().int().positive('Quantity must be positive'),
  order_reference_id: z.string().min(1, 'Order reference is required'),
  courier_claim_ref: z.string().max(100).optional().or(z.literal('')),
  notes: z.string().max(1000).optional().or(z.literal('')),
})
```

`order_reference_id` is just `z.string().min(1)` — any non-empty string passes. The route (`report-transit/route.ts:72`) assigns it directly to `orderReferenceId: d.order_reference_id`. No DB lookup. No FK enforcement.

The Transit form UI (`losses-view.tsx:1640-1680`) uses a plain `<Input>` for `orderRef`:

```tsx
<Input
  id="tr-order"
  placeholder="e.g. ORD-2024-00982 / dispatch #DSP-5532"
  value={orderRef}
  onChange={(e) => setOrderRef(e.target.value)}
/>
```

The placeholder literally suggests typing either an order number OR a dispatch number — neither is validated.

**What's missing:**
1. **A real `orderId` FK** on `StockLossRecord` (or at minimum, the existing `orderReferenceId` should be upgraded to FK).
2. **An order picker** in the Transit form (and ideally Damaged form too) — same as Problem 3.
3. **Auto-linking when an order is in RTO state:** if a courier reports a transit loss for an order that's already RTO'd, the system should warn about potential double-recording (the RTO already auto-restocked; a transit-loss record without reversing that increment would be incorrect).
4. **No `inventoryTxnId` is set** for transit losses — by design (the stock was already decremented at `sale_dispatched` time). This is correct, BUT the `sale_dispatched` txn has `referenceType='order'` and `referenceId=orderId`, so the linkage is recoverable. The transit-loss record should at minimum surface the dispatch txn for the user.

---

### Problem 5: Return Order Scan integration

**Current scan flow (verified in §F above):**

The `receive_return` mode in `processScan` (`scan.actions.ts:218-222`) is essentially a no-op:

```ts
case 'receive_return': {
  // Return entity details to UI — staff selects condition BEFORE calling processOrderReturn
  await logScanEvent(ctx, scanMode, lookup.entityType, lookup.entityId, trimmedTracking, 'success', undefined, scanStationLabel)
  return { success: true, data: { scanResult: 'success' as const, entity: lookup, message: `Order identified — select return condition to proceed` } }
}
```

The comment explicitly admits the staff must "select return condition BEFORE calling processOrderReturn" — but the scan API has no follow-up endpoint to actually invoke `processOrderReturn` with a selected condition. The scan UI (`order-scan-view.tsx:217-222`) just displays the result and the staff is expected to manually navigate to the order detail page and trigger RTO.

There is no `confirm_rto` action in the scan API (only `confirm_unpack` and `confirm_cancel` exist — `scan/route.ts:20-30`).

**What's missing:**
1. **Inline RTO confirmation:** when scanning in `receive_return` mode, the UI should immediately show a small dialog with:
   - The order summary (already returned by the scan).
   - A "Confirm RTO" button that calls a new `confirm_rto` action in the scan API, which invokes `processOrderReturn(orderId, defaultReason)` with a default reason like "Courier returned (RTO)".
   - Optionally a reason input.
2. **Inline damage recording:** the dialog should also offer:
   - "Mark as Damaged" → calls a new `confirm_damage` action that triggers `correctReturnItemCondition(orderItemId, 'damaged')` for each item OR (better) opens a multi-item damage form.
   - "Mark as Transit Loss" → calls `POST /api/stock-loss/report-transit` with the order pre-filled.
3. **Combined flow:** ideally the scan should produce in one go: order identified → RTO processed → damage recorded (if applicable) → audit logs written. Currently this requires 3 separate modules (Scan → Order Detail → Returns Review Queue) and 3+ round-trips.

---

## Part 3: Proposed Unified Design

### Principle: Single Source of Truth

**`StockLossRecord` should be the ONLY place where loss-type stock decreases are recorded.** Every module that currently decrements onHand (or quarantines stock) due to loss/damage/theft/transit-loss/missing must:

1. **Funnel through a single shared helper** — `recordStockLoss()` defined in a new `src/lib/stock-loss.ts`. This helper:
   - Accepts a typed input including `sourceModule`, `orderItemId?`, `orderId?`, `lossType`, `quantity`, `costPerUnit`, `responsibleParty`, `damageType?`, `investigationStatus`, `resolution`, `notes`, `evidence_urls`, `employeeId`.
   - **Checks for an existing loss record** matching `(orderItemId, lossType, sourceModule)` and refuses/merges if one exists (DB-level unique constraint — see Proposed Schema Changes).
   - **Calls `processInventoryTransaction` with the appropriate txn type** (`damage_writeoff` / `theft_writeoff` / `missing_writeoff` / `transit_loss` / `supplier_return` — note: NOT `cycle_count_adjust`; see below).
   - **Creates the `StockLossRecord` row with `inventoryTxnId` populated from the txn result** (no second-step update — eliminates the "loss exists with null txn" bug class).
   - **Wraps both writes in `db.$transaction`** for atomicity (eliminates the "txn fails, loss record orphaned" bug class).
   - Inserts audit log + metric event inside the same transaction.

2. **For Cycle Count shortages, do NOT use `cycle_count_adjust` to absorb the discrepancy.** Instead:
   - For `damage_not_recorded` shortages: call `recordStockLoss(lossType='damaged', sourceModule='cycle_count', resolution='written_off', inventoryTxnType='damage_writeoff')` → creates loss record + decrements onHand by the shortage quantity. The onHand ends up at the counted value as a side-effect.
   - For `theft_suspected` / `unknown` shortages: call `recordStockLoss(lossType='missing', sourceModule='cycle_count', investigationStatus='open', quarantineOnly=true)` → quarantines + creates loss record WITHOUT adjusting onHand (the current implementation incorrectly sets onHand to counted value AND quarantines, which double-counts the shortage when the loss is later resolved as `written_off`).
   - For `recording_error` / `transfer_not_recorded` shortages: use `cycle_count_adjust` (no loss record) — these are data-entry corrections, not physical losses.
   - For surplus: use `cycle_count_adjust` (positive — but ideally switch to `manual_adjustment_in` per audit recommendation).

3. **For Adjust Stock negative adjustments, branch by `reason` enum:**
   - If `reason` is `damage` / `theft` / `missing` → call `recordStockLoss(sourceModule='adjust_stock', lossType=reason)`.
   - If `reason` is `system_error` / `correction` / `transfer_not_recorded` → use `manual_adjustment_out` (a NEW txn type to be added — see audit recommendation #5; currently the negative side abuses `damage_writeoff`).
   - Add a proper `reason` enum to `adjustStockSchema`.

4. **For RTO,** the current "auto-assume perfect, correct later" pattern is correct in spirit — physical inspection does take time. The fix is to:
   - Keep the auto-increment (`return_resellable` / `return_stitched_received`) at RTO time.
   - Keep the `needsReview=true` flag.
   - When `correctReturnItemCondition` runs, the existing reversal (`damage_writeoff`) + loss-record creation is correct — BUT extend it to:
     - Accept `damage_type`, `responsible_party`, `evidence_urls`, `notes` as input (currently hard-coded).
     - Set `sourceModule='rto'` on the loss record.
   - Add a `POST /api/scan` `confirm_rto` action that calls `processOrderReturn` inline (Problem 5 fix).
   - Add an `orderItemId @unique` constraint where `sourceModule IN ('rto', 'exchange')` — only one loss per orderItem per sourceModule (prevents Scenario 2 in §B.5).

5. **For Returned Stock module,** either:
   - **Option A (preferred):** Delete the `/api/returned-stitched` module entirely and consolidate into `/api/inventory/receive-returned-stitched`. The two endpoints do overlapping things; only one should exist. The "Returned Stock" sidebar entry would then point to a read-only view of `StockLossRecord` rows with `sourceModule IN ('rto', 'receive_returned_stitched')` + `InventoryTransaction` rows with type `return_stitched_received`.
   - **Option B (lower-risk):** Keep `/api/returned-stitched` as a parallel record-keeping tool but require it to ALSO call `recordStockLoss` when `condition='damaged'` (with `sourceModule='returned_stitched'`) and to ALSO call `processInventoryTransaction('return_stitched_received')` when `condition` is `perfect`/`good`/`open_box`. Add a check: if a `StockLossRecord` already exists with `orderItemId=X` AND `sourceModule='rto'`, refuse the duplicate (or convert it to a no-op).

6. **For Stock Losses dedicated module,** extend the Damaged form to accept `orderItemId` (proper FK) and `orderId` (FK) — with an order picker that searches by `flowopsOrderNumber` or `trackingNumber`. When `responsible_party='courier'`, make `orderId` required. Before creating the loss record, check: "Does a loss already exist for `(orderItemId, lossType='damaged')`?" If yes, refuse and surface the existing record.

7. **For Supplier Returns,** the existing `supplierReturnId @unique` constraint already prevents duplicates. No change needed — but the supplier-return rejection should also wrap the `stockLossRecord.create` + the `supplier_return` txn in `db.$transaction`.

8. **For Exchange old-item verification,** the existing `OrderExchange.oldItemStockLossId` back-link already provides dedup. Extend it: the `verifyExchangeOldItem` action should set `sourceModule='exchange'` and `orderItemId=exchange.originalOrderItemId` on the loss record, so it's properly linked.

### Proposed Schema Changes

```prisma
model StockLossRecord {
  // ... existing fields ...

  // NEW: discriminator for which module created this loss
  sourceModule    String   @default("stock_loss")
  // stock_loss | rto | cycle_count | adjust_stock | returned_stitched |
  // receive_returned_stitched | exchange | supplier_return | return_scan

  // UPGRADE: orderReferenceId → proper FK
  // (keep orderReferenceId as a deprecated free-text field for backward compat;
  // new code uses orderId)
  orderId         String?
  order           Order?   @relation("OrderStockLosses", fields: [orderId], references: [id])

  // EXISTING: orderItemId (already an FK)
  orderItemId     String?
  orderItem       OrderItem? @relation(fields: [orderItemId], references: [id])

  // NEW: FK to the originating cycle count item (replaces notes text)
  cycleCountItemId String?
  cycleCountItem  CycleCountItem? @relation(fields: [cycleCountItemId], references: [id])

  // NEW: FK to the originating exchange (replaces OrderExchange.oldItemStockLossId)
  orderExchangeId String?
  orderExchange   OrderExchange? @relation("ExchangeOriginatedLoss", fields: [orderExchangeId], references: [id])

  // EXISTING: supplierReturnId (already @unique)

  // EXISTING: inventoryTxnId (already an FK; STOP updating post-create — populate at create time inside a transaction)

  // NEW: unique constraint to prevent duplicate loss records for the same orderItem + lossType + sourceModule
  // Only enforced when orderItemId IS NOT NULL (partial unique index via raw SQL)
  // Example migration:
  //   CREATE UNIQUE INDEX stock_loss_orderitem_dedup
  //   ON stock_loss_records (order_item_id, loss_type, source_module)
  //   WHERE order_item_id IS NOT NULL;

  @@index([companyId, lossType, investigationStatus])
  @@index([companyId, createdAt])
  @@index([orgVariantId])
  @@index([orderId])
  @@index([sourceModule])
}
```

**Additional schema changes:**

- `InventoryTransaction.transactionType` — add `'manual_adjustment_out'` so negative adjustments no longer abuse `damage_writeoff`. (Audit recommendation #5.)
- `InventoryTransaction.referenceType` — formalize the enum to include `'cycle_count_item'`, `'stock_loss'`, `'rto'`, `'exchange'`, `'return_scan'` (currently free-text String).
- `AdjustStockSchema.reason` — change from free-text to an enum: `'damage' | 'theft' | 'missing' | 'system_error' | 'transfer_not_recorded' | 'recording_error' | 'found_stock'`. Each enum value maps to a known downstream behavior.
- `CycleCountItem.discrepancyReason` — change from free-text String to an enum constraint (it's already documented as one but not enforced at the DB level).
- `ReturnedStitchedInventory.originalOrderReference` and `.soldOrderReference` — upgrade to `orderId` FK (or deprecate the model entirely per Option A above).
- `StockLossRecord.responsibleParty` — formalize the enum constraint at the DB level (currently free-text String).

### Proposed Flow Changes (per module)

1. **RTO** (`processOrderReturn` + `restockOrderForRto`): no change to the auto-increment logic. When `correctReturnItemCondition` is later called, it creates a `StockLossRecord` via `recordStockLoss({ sourceModule: 'rto', orderItemId: item.id, lossType: 'damaged', damageType: <user-provided>, responsibleParty: <user-provided>, ... })`. The unique constraint on `(orderItemId, lossType, sourceModule)` prevents a second correction from creating a duplicate loss record.

2. **Cycle Count approve** (`cycle-counts/[id]/route.ts` PATCH action='approve'):
   - For `damage_not_recorded` shortage → call `recordStockLoss({ sourceModule: 'cycle_count', cycleCountItemId: item.id, lossType: 'damaged', resolution: 'written_off', inventoryTxnType: 'damage_writeoff' })` — the helper decrements onHand AND creates the loss record atomically.
   - For `theft_suspected` / `unknown` shortage → call `recordStockLoss({ sourceModule: 'cycle_count', cycleCountItemId: item.id, lossType: 'missing', investigationStatus: 'open', quarantineOnly: true })` — quarantines only, no onHand change (the onHand stays at system value; the investigation resolution will decide the final onHand).
   - For `recording_error` / `transfer_not_recorded` / surplus → use `cycle_count_adjust` as today (no loss record).

3. **Adjust Stock** (`inventory/adjust/route.ts`):
   - If `quantity < 0 AND reason IN ('damage', 'theft', 'missing')` → call `recordStockLoss({ sourceModule: 'adjust_stock', lossType: reason, resolution: 'written_off', inventoryTxnType: '<reason>_writeoff' })`.
   - If `quantity < 0 AND reason IN ('system_error', 'transfer_not_recorded', 'recording_error')` → use the NEW `manual_adjustment_out` txn type (no loss record).
   - If `quantity > 0` → use `manual_adjustment_in` (no loss record).

4. **Returned Stock** (`/api/returned-stitched`):
   - Option A: deprecate the module; consolidate into `/api/inventory/receive-returned-stitched` which already calls `recordStockLoss` for `condition='damaged'`. Extend that endpoint to set `sourceModule='receive_returned_stitched'` and accept `orderItemId`.
   - Option B: keep the module but require it to ALSO call `recordStockLoss` for `condition='damaged'` with `sourceModule='returned_stitched'` AND call `processInventoryTransaction('return_stitched_received')` for `condition='perfect'/'good'/'open_box'`. Add a dedup check against `(orderItemId, lossType, sourceModule)`.

5. **Return Scan** (`scan.actions.ts` `receive_return` mode):
   - Replace the no-op with: return entity details + 3 action buttons in the UI: "Confirm RTO (Perfect)", "Confirm RTO + Damaged", "Record Transit Loss".
   - Add `confirm_rto` action → calls `processOrderReturn(orderId, 'Courier returned (RTO) — confirmed via scan')`.
   - Add `confirm_rto_damaged` action → calls `processOrderReturn(orderId, ...)` then for each item calls `recordStockLoss({ sourceModule: 'return_scan', orderItemId, lossType: 'damaged', damageType: 'transit_damage', responsibleParty: 'courier', resolution: 'written_off' })`.
   - Add `record_transit_loss` action → calls `recordStockLoss({ sourceModule: 'return_scan', orderId, lossType: 'transit_loss', responsibleParty: 'courier', courierClaimStatus: 'filed' })` (no inventory txn — stock already decremented at dispatch).

6. **Stock Losses dedicated module:** remains the unified UI for viewing/managing ALL losses regardless of `sourceModule`. Add a `sourceModule` filter to the list endpoint and the UI. Extend the Damaged form with an `orderItemId` picker (with dedup check). Extend the Transit form with an `orderId` picker (replacing the free-text `order_reference_id`).

### Prevention of Double-Decrement

The single most important safeguard is the **partial unique index** on `StockLossRecord`:

```sql
CREATE UNIQUE INDEX stock_loss_orderitem_dedup
ON stock_loss_records (order_item_id, loss_type, source_module)
WHERE order_item_id IS NOT NULL;
```

This guarantees: for any given `OrderItem`, at most ONE loss record can exist per `(lossType, sourceModule)` combination. So:
- An orderItem can have ONE `damaged` loss from `sourceModule='rto'` AND ONE `damaged` loss from `sourceModule='return_scan'` (if the user re-scans and re-reports) — but NOT two `damaged` losses from `sourceModule='rto'`.
- An orderItem can have ONE `transit_loss` loss from `sourceModule='stock_loss'` AND ONE from `sourceModule='return_scan'` — but the user must explicitly choose which.

The `recordStockLoss()` helper should:
1. Check `SELECT 1 FROM stock_loss_records WHERE order_item_id = $1 AND loss_type = $2 AND source_module = $3` BEFORE creating.
2. If exists: either throw an error with a link to the existing record, OR (configurable) update the existing record's quantity/notes and skip the new inventory txn.
3. Wrap the check + create + txn in `db.$transaction([...], { isolationLevel: 'Serializable' })` to close the race window between concurrent calls.

For non-orderItem-linked losses (e.g. a warehouse-wide flood damage not tied to a specific order), no dedup is possible at the DB level — but the helper can still log a warning if a loss with the same `(orgVariantId, locationId, lossType, sourceModule, createdAt_within_1_hour)` already exists.

---

## Part 4: Implementation Priority

1. **[Highest — eliminates the most common double-decrement]** Add the `recordStockLoss()` helper in `src/lib/stock-loss.ts`. Refactor `report-damaged`, `correctReturnItemCondition`, `cycle-counts/[id] approve` (Path X only), `receive-returned-stitched`, `exchange.actions.ts verifyExchangeOldItem`, and `supplier-returns/[id] PATCH (rejected)` to funnel through it. This eliminates the "loss exists with null inventoryTxnId" bug class and the "two loss records for the same orderItem" bug class in one stroke. *Effort: ~1 day.*

2. **[Highest — schema migration]** Add the partial unique index `stock_loss_orderitem_dedup` on `(order_item_id, loss_type, source_module) WHERE order_item_id IS NOT NULL`. Add the `source_module` column (default `'stock_loss'`), `order_id` FK column, `cycle_count_item_id` FK column, `order_exchange_id` FK column. Backfill `source_module` for existing rows based on heuristics (if `supplierReturnId IS NOT NULL` → `'supplier_return'`; if `orderItemId IS NOT NULL` → `'rto'`; if `notes LIKE '%cycle count%'` → `'cycle_count'`; else `'stock_loss'`). *Effort: ~2 hours for migration + backfill.*

3. **[High — fixes Problem 2]** Extend the Cycle Count approve flow to call `recordStockLoss` for `damage_not_recorded` shortages (currently silent). Extend Adjust Stock to call `recordStockLoss` for negative adjustments with `reason IN ('damage', 'theft', 'missing')` and add a new `manual_adjustment_out` txn type for non-loss negative adjustments. Add `reason` enum to `adjustStockSchema`. *Effort: ~4 hours.*

4. **[High — fixes Problem 3]** Add an `OrderPicker` shared component (search by `flowopsOrderNumber` or `trackingNumber`). Use it in the Damaged form (with conditional required when `responsible_party='courier'`) and the Transit form (replacing the free-text `order_reference_id`). Wire the picker to set `orderItemId` (Damaged) and `orderId` (Transit) on the loss record. *Effort: ~6 hours.*

5. **[Medium — fixes Problem 5]** Add `confirm_rto`, `confirm_rto_damaged`, `record_transit_loss` actions to `scan.actions.ts`. Extend the scan UI to show 3 action buttons when `receive_return` mode succeeds. Wire the buttons to the new actions. *Effort: ~4 hours.*

6. **[Medium — fixes Problem 1 + Problem 4]** Decide on Option A vs Option B for the Returned Stock module:
   - **Option A (preferred, lower long-term maintenance):** deprecate `/api/returned-stitched` and the ReturnedStock module entirely; consolidate into `/api/inventory/receive-returned-stitched`. Add a redirect + a read-only "Returned Stock" view that queries `StockLossRecord` + `InventoryTransaction` filtered by `sourceModule IN ('rto', 'receive_returned_stitched')`. *Effort: ~1 day.*
   - **Option B (lower-risk, keeps existing UI):** keep `/api/returned-stitched` but require it to call `recordStockLoss` + `processInventoryTransaction` consistently. Add a dedup check. *Effort: ~4 hours.*

7. **[Medium — observability]** Add a `source_module` filter to `GET /api/stock-loss` and to the Stock Losses list UI. Add a `source_module` breakdown to `GET /api/stock-loss/stats`. This makes it visible to the user that losses are now unified. *Effort: ~3 hours.*

8. **[Low — cleanup]** Remove dead schemas `reportMissingLossSchema`, `createSupplierDisputeLossSchema`, `stockLossSchema`, `resolveStockLossSchema`. Migrate inventory routes from the legacy 4-query auth pattern (`getCurrentUser + userSetting + employee + rolePermission.count`) to `getWorkspace + requirePermission` (audit recommendation #3, ~26 routes). Add `requirePermission(PERMISSIONS.INVENTORY_VIEW)` to all GET endpoints (audit recommendation #4). *Effort: ~1 day.*

9. **[Low — correctness]** Fix the cycle-count-theft-suspected path to NOT call `cycle_count_adjust` (which SETS onHand to counted value) when quarantining — leave onHand alone and let the loss resolution handle the final write-off. Currently the double-adjustment (cycle_count_adjust now + missing_writeoff later) causes onHand to go below the physically-counted value. *Effort: ~1 hour.*

10. **[Low — completeness]** Add a `report-missing` endpoint (`POST /api/stock-loss/report-missing`) that consumes the existing `reportMissingLossSchema`. This makes the missing-loss type standalone (currently only cycle counts can create it). Required if warehouse staff discover theft outside of a cycle count. *Effort: ~2 hours.*

---

## Appendix: All 6 Code Paths That Create `StockLossRecord` Today

| # | Module | File | Function/Route | lossType | Sets orderItemId? | Sets inventoryTxnId? | Sets sourceModule? | Atomic? |
|---|---|---|---|---|---|---|---|---|
| 1 | Stock Losses | `stock-loss/report-damaged/route.ts` | POST handler | `damaged` | NO | YES (via 2-step update) | NO (defaults to "stock_loss") | NO (3 separate writes) |
| 2 | Stock Losses | `stock-loss/report-theft/route.ts` | POST handler | `theft` | NO | NO (created at resolve time) | NO | NO (2 separate writes) |
| 3 | Stock Losses | `stock-loss/report-transit/route.ts` | POST handler | `transit_loss` | NO (sets `orderReferenceId` free-text) | NO (by design) | NO | YES (single write) |
| 4 | Cycle Count | `cycle-counts/[id]/route.ts` PATCH action='approve' | approve handler | `missing` (theft/unknown shortage) | NO | NO (txn exists but ID not linked) | NO | NO (4 separate writes per item) |
| 5 | RTO Review | `order-return.actions.ts` `correctReturnItemCondition` | POST `/api/orders/[id]/returns/review/correct` | `damaged` | **YES** | YES (linked to the reversal txn) | NO | NO (3 separate writes) |
| 6 | Receive Returned Stitched | `inventory/receive-returned-stitched/route.ts` | POST handler (damaged branch) | `damaged` | NO | NO (no txn created — assumes already decremented at dispatch) | NO | YES (single write) |
| 7 | Exchange Verification | `exchange.actions.ts` `verifyExchangeOldItem` | called from `/api/orders/[id]/exchanges/[exchangeId]/verify-old-item` | `damaged` | NO (sets `OrderExchange.oldItemStockLossId` back-link instead) | NO (no txn created for the damaged old item — assumes already decremented at dispatch) | NO | NO (3+ writes) |
| 8 | Supplier Return Rejection | `supplier-returns/[id]/route.ts` PATCH | PATCH handler (rejected branch) | `supplier_dispute` | NO | NO (the `supplier_return` txn was created at supplier-return CREATE time) | NO | YES (single write, but the supplier return txn was non-atomic with it) |

**8 distinct create paths.** None share a helper. None set `sourceModule`. Only #5 (RTO review correction) sets `orderItemId`. Only #5 links `inventoryTxnId` at create time (the others either skip it or update it post-create, violating the append-only ledger principle). Only #8 has a DB-level uniqueness constraint (`supplierReturnId @unique`).

This is the dis-unification the user is asking to fix.
