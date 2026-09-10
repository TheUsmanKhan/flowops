---
Task ID: INVENTORY-CORE-AUDIT
Agent: Explore (read-only audit subagent)
Mode: READ-ONLY — no source code, schema, or data was modified
Scope: FlowOps Inventory Core module — sidebar items (Inventory Dashboard, Locations, Suppliers, Receive Stock, Adjust Stock, Transfer Stock)
       + core logic in `src/lib/inventory.ts` + all routes under `/api/inventory/**`, `/api/inventory-locations/**`, `/api/suppliers/**` + frontend components under `src/components/inventory/*-view.tsx`
Database: PostgreSQL @ Supabase (postgres.gobwxqkzfulbwhzbbsdj) — 13 live SQL diagnostic queries executed
Reference: Cross-checks against `PRODUCTS_AUDIT_FINAL.md` (PROD-002) and `INVENTORY_AUDIT.md` (prior audits)

---

# INVENTORY-CORE-AUDIT — Final Investigation Report

## EXECUTIVE SUMMARY

| Metric | Count |
|---|---|
| API route files audited | 11 (`/api/inventory/**` 8 + `/api/inventory-locations/**` 2 + `/api/suppliers/**` 2) |
| Frontend components audited | 7 (inventory-dashboard, locations, location-detail, suppliers, supplier-detail, receive-stock, adjust-stock, transfer-stock) |
| Core lib audited | `src/lib/inventory.ts` (959 lines, 8 exported functions) |
| Prisma models touched | 6 (InventoryLocation, Supplier, InventoryPool, InventoryTransaction, AvgCostHistory, StockTransfer) |
| DB diagnostic SQL queries run | 13 (live against Supabase) |
| Critical bugs found | 2 |
| High-severity bugs found | 4 |
| Medium-severity issues | 5 |
| Low-severity / smell issues | 4 |

The Inventory Core module is **architecturally sound at the ledger level** — `processInventoryTransaction()` in `src/lib/inventory.ts` is a genuine single write-point for `InventoryPool`, with WAC recalculation, immutable `InventoryTransaction` rows, and 1:1 `AvgCostHistory` coverage (verified: 44 history rows for 44 avgCost-changing txns, 0 orphans). Spot-check of 5 real transactions confirms WAC math is correct.

**However**, the module has **two critical runtime bugs** that are currently producing real-world data inconsistencies in the live database:

1. **INV-001 (Critical)** — A real InventoryPool has `onHand=2, reserved=3` (reserved > onHand). Confirmed in DB.
2. **INV-002 (Critical)** — The `/api/inventory/receive-returned-stitched` route — claimed by PRODUCTS_AUDIT (PROD-002) as the "working equivalent" of the broken `/api/returned-stitched` route — does NOT actually create a `ReturnedStitchedInventory` row at all. It only creates the InventoryTransaction. The link contract is therefore unfulfilled.

There are also **4 high-severity traceability bugs** (referenceType set but referenceId NULL for `supplier_return` ×6 and `production_order` ×4 rows), one **direct write to InventoryPool outside inventory.ts** (in purchase-orders routes — only the `incoming` projection field, not on_hand), one **update to InventoryTransaction** (in `exchange-shipment.actions.ts` — violates the "append-only" contract), and several **multi-step writes not wrapped in `db.$transaction`** that can leave the system in an inconsistent state on partial failure (mitigated by compensating-transaction patterns where the code remembers to add them).

---

## CROSS-REFERENCE CHECK (IN-000) — Verifying PROD-002 claim

**Task:** Verify whether `POST /api/inventory/receive-returned-stitched` correctly creates BOTH a `ReturnedStitchedInventory` row AND an `InventoryTransaction` row with a valid `inventoryTxnId` link, for both `condition='damaged'` and `condition!='damaged'` paths.

**Files read:**
- `src/app/api/inventory/receive-returned-stitched/route.ts` (165 lines)
- `src/app/api/returned-stitched/route.ts` (185 lines — the "broken" old route)
- `prisma/schema.prisma` lines 846-893 (`ReturnedStitchedInventory` model — has `inventoryTxnId String?` field)

**Findings:**

### Damaged path (`condition='damaged'`)
The route (lines 57-109) calls `recordStockLoss({ createInventoryTransaction: false })` — which creates ONLY a `StockLossRecord`. No `InventoryTransaction` is created (by design — damaged items aren't added to stock). **No `ReturnedStitchedInventory` row is created either.**

### Non-damaged path (`condition='perfect' | 'good' | 'open_box'`)
The route (lines 111-160) calls `processInventoryTransaction({ transactionType: 'return_stitched_received' })` — which creates an `InventoryTransaction` row AND updates `InventoryPool` (increments onHand, recalculates WAC, flips trackInventory for MTO variants). **But no `ReturnedStitchedInventory` row is created.** The `txnResult.transactionId` is returned to the client but never persisted as `ReturnedStitchedInventory.inventoryTxnId` (because no such row exists).

### Verdict — PROD-002 claim is HALF-TRUE

| Claim | Reality |
|---|---|
| "Creates an InventoryTransaction" | ✅ TRUE (for non-damaged path only) |
| "Creates a ReturnedStitchedInventory row" | ❌ FALSE — neither path creates one |
| "Establishes a valid inventoryTxnId link" | ❌ FALSE — there's no register row to link FROM |
| "Equivalent to POST /api/returned-stitched" | ❌ FALSE — the old route creates the register but not the txn; the new route creates the txn but not the register. They are complementary, not equivalent. |

### DB Confirmation
```
ReturnedStitchedInventory: 2 rows total, 0 with inventoryTxnId link
```
Both existing rows were created via the OLD `/api/returned-stitched` route (PROD-002 — never fixed). No rows have been created via the new route (because nothing calls it, AND even if it were called, it wouldn't create a register row).

### Bug logged as INV-002 (Critical) below.

---

## PART A — MODULE RELATION MAP

### A.1 — Direct writes to InventoryPool outside `src/lib/inventory.ts`

**Method:** `Grep` for `db.inventoryPool.(update|create|upsert|delete|updateMany)` across `src/`.

**Results:**

| File | Line | Operation | Field touched | Goes through processInventoryTransaction? |
|---|---|---|---|---|
| `src/lib/inventory.ts` | 138 | `create` | (initial pool creation) | ✅ Yes (inside processInventoryTransaction) |
| `src/lib/inventory.ts` | 280 | `update` | onHand, reserved, incoming, avgCost | ✅ Yes (inside processInventoryTransaction) |
| `src/lib/inventory.ts` | 491 | `upsert` | `incoming` only | ⚠️ Helper `incrementIncomingStock()` — legitimate exception, documented |
| `src/lib/inventory.ts` | 518 | `update` | `incoming` only | ⚠️ Helper `decrementIncomingStock()` — legitimate exception |
| `src/lib/inventory.ts` | 663 | `update` | `reserved` only | ⚠️ Helper `quarantineStock()` — legitimate exception, documented |
| `src/lib/inventory.ts` | 686 | `update` | `reserved` only | ⚠️ Helper `releaseQuarantine()` — legitimate exception |
| `src/app/api/purchase-orders/route.ts` | 170 | `upsert` | `incoming` only (create+increment) | ❌ **NO** — direct write outside inventory.ts |
| `src/app/api/purchase-orders/[id]/receive/route.ts` | 159 | `update` | `incoming` only (decrement) | ❌ **NO** — direct write outside inventory.ts |

**Flagged:** 2 direct writes outside `inventory.ts`. Both touch ONLY the `incoming` projection field (not `onHand`, `reserved`, or `avgCost`). The `inventory.ts` header comment (lines 17-19) claims "inventory_pools is NEVER written to directly from any other code path" — this contract is **violated**, but the violation is contained to the `incoming` field, which is a live projection of undelivered PO quantities (not a ledgered movement). The proper fix is to call the existing `incrementIncomingStock()` / `decrementIncomingStock()` helpers in `inventory.ts` (lines 485-522) which do exactly the same thing but through the sanctioned helper interface.

Logged as **INV-007 (Low)**.

---

### A.2 — Modules that READ InventoryPool for decision-making

**Method:** `Grep` for `db.inventoryPool.findUnique` / `findMany` / `findFirst` across `src/`.

**Modules reading InventoryPool for decision-making (not just display):**

| Module | File:Line | Reads via | Decision made |
|---|---|---|---|
| Order confirm | `src/lib/actions/order.actions.ts:207` | Raw `db.inventoryPool.findUnique` | Reserve vs backorder vs fail |
| Exchange verify/dispatch | `src/lib/actions/exchange.actions.ts:183` | Raw `db.inventoryPool.findUnique` | Reserve exchange stock |
| Exchange-shipment dispatch | `src/lib/actions/exchange-shipment.actions.ts:294` | Raw `db.inventoryPool.findUnique` | Verify available for dispatch |
| Backorder fulfillment | `src/lib/actions/backorder.actions.ts:191` | Raw `db.inventoryPool.findUnique` | Check if backorder can be fulfilled |
| Cycle count start | `src/app/api/cycle-counts/[id]/route.ts:133` | Raw `db.inventoryPool.findMany` | Snapshot system quantities |
| Cycle count approve | `src/app/api/cycle-counts/[id]/route.ts:284` | Raw `db.inventoryPool.findUnique` | Fetch avgCost for loss record |
| Stock loss report (3 routes) | `src/app/api/stock-loss/report-{transit,theft,damaged}/route.ts:53/54/54` | Raw `db.inventoryPool.findUnique` | Fetch avgCost for loss valuation |
| Adjust stock | `src/app/api/inventory/adjust/route.ts:57` | Raw `db.inventoryPool.findUnique` | Fetch avgCost for metric event |
| Transfer stock | `src/app/api/inventory/transfers/route.ts:61` | Raw `db.inventoryPool.findUnique` | Verify source has enough available |
| Receive stock (PO) | `src/app/api/purchase-orders/[id]/receive/route.ts:148` | Raw `db.inventoryPool.findUnique` | Fetch `incoming` for decrement |
| Returned-stitched mark_sold/write_off | `src/app/api/returned-stitched/[id]/route.ts:75,139` | Raw `db.inventoryPool.findFirst` | Resolve locationId (PROD-001 fix) |
| Production order create | `src/app/api/production-orders/route.ts:99` | Raw `db.inventoryPool.findUnique` | Verify fabric availability |
| Inventory summary | `src/lib/inventory.ts:414` (inside `getProductInventorySummary`) | `db.inventoryPool.findMany` | Display per-location breakdown |
| Inventory dashboard | `src/app/api/inventory/dashboard/route.ts:36` | `db.inventoryPool.findMany` | KPI computation |

**Verdict:** **NONE of the 14 readers use `getProductInventorySummary()` or another helper.** All use raw ad-hoc queries. The `getProductInventorySummary()` helper (inventory.ts:388-448) is used only by `GET /api/inventory/summary`. This is a **smell** (the contract was "use helpers, not ad-hoc queries"), but not a critical bug — each reader is reading a single specific pool row for a specific decision, and the helper would be overkill. The real concern is that the "available = onHand - reserved" calculation is duplicated in ~10 places (with the same logic), so any future change to the formula would require touching all 10 sites.

Logged as **INV-012 (Low)** — smell, not a bug.

---

### A.3 — InventoryLocation and Supplier "org-level shared" behavior

**Method:** Read the GET query in each route file.

| Endpoint | Filter | Org-level shared (companyId=null) visible? | Company-scoped (companyId != current) hidden? |
|---|---|---|---|
| `GET /api/inventory-locations` | `where: { organizationId, isActive, OR: [{ companyId: null }, { companyId }] }` | ✅ Yes | ✅ Yes |
| `GET /api/suppliers` | `where: { organizationId, isActive, OR: [{ companyId: null }, { companyId }] }` | ✅ Yes | ✅ Yes |
| `GET /api/inventory/dashboard` | `where: { organizationId, location: { OR: [{ companyId: null }, { companyId }] } }` (filter via location relation) | ✅ Yes | ✅ Yes |
| `GET /api/inventory-locations/[id]` | `where: { id, organizationId }` — NO company filter | ⚠️ N/A (any location in org visible) | ❌ **NO** — cross-company leak |
| `GET /api/suppliers/[id]` | No GET route (only PATCH/DELETE) | N/A | N/A |
| `PATCH /api/suppliers/[id]` | `where: { id, organizationId }` — NO company filter | ⚠️ N/A | ❌ **NO** — cross-company write possible |
| `DELETE /api/suppliers/[id]` | `where: { id, organizationId }` — NO company filter | ⚠️ N/A | ❌ **NO** — cross-company delete possible |
| `PATCH /api/inventory-locations/[id]` | `where: { id, organizationId }` — NO company filter | ⚠️ N/A | ❌ **NO** — cross-company write possible |
| `DELETE /api/inventory-locations/[id]` | `where: { id, organizationId }` — NO company filter | ⚠️ N/A | ❌ **NO** — cross-company delete possible |
| `GET /api/inventory/transfers` | `where: { organizationId }` — NO company filter | ⚠️ N/A | ❌ **NO** — cross-company leak |

**Flagged:** The list endpoints correctly scope by company. The `[id]` detail/update/delete endpoints do NOT — they only filter by `organizationId`. A user from Company A in Org X can fetch/update/delete a location or supplier owned by Company B in the same org (as long as they know the ID).

Logged as **INV-008 (High)** — cross-company access on `[id]` routes.

---

### A.4 — InventoryTransaction.referenceType values

**Method:** `Grep` for `referenceType:\s*['"]` across `src/`. Then verify each maps to a real entity table.

**Values found in code:**

| referenceType | Count in DB | referenceId NULL count | Maps to entity table? |
|---|---|---|---|
| `'order'` | 90 | 0 | ✅ `Order` |
| `'manual'` | 31 | 30 | N/A — descriptive label (no entity) |
| `'transfer'` | 14 | 0 | ✅ `StockTransfer` |
| `'stock_loss'` | 8 | 1 | ✅ `StockLossRecord` (1 NULL is a pre-unification legacy row) |
| `'purchase_order'` | 6 | 0 | ✅ `PurchaseOrder` |
| `'supplier_return'` | 6 | **6 (all)** | ✅ `SupplierReturn` exists — but **link is broken** |
| `'opening'` | 12 | 12 | N/A — descriptive label (no entity) |
| `'production_order'` | 4 | **4 (all)** | ✅ `ProductionOrder` exists — but **link is broken** |
| `'cycle_count'` | 3 | 0 | ✅ `CycleCount` |
| `'exchange_shipment'` | 2 | 0 | ✅ `ExchangeShipment` |

**Flagged:** Two referenceTypes have 100% NULL referenceId — `supplier_return` (6 of 6) and `production_order` (4 of 4). These are real bugs — the link should be set but isn't, because the InventoryTransaction is created BEFORE the linked entity (SupplierReturn / ProductionOrder) is persisted. The reverse link (entity → InventoryTransaction via `inventoryTxnId` field) IS set, so the data is recoverable, but the forward link (InventoryTransaction → entity) is broken.

Logged as **INV-003 (High)** and **INV-004 (High)** below.

---

## PART B — DATABASE LAYER

### B.1 — Negative onHand/reserved or reserved>onHand violations

**Query:** `SELECT * FROM "InventoryPool" WHERE "onHand" < 0 OR "reserved" < 0 OR "reserved" > "onHand";`

**Result:** **1 violation found.**

```
id: cmrsfkgmw003btdochj7jvi6b
orgVariantId: cmrsfj86n002ptdoc36yyt3di
locationId: cmrsfhp0t002ftdoc5x5fcbxf
onHand: 2
reserved: 3   ← VIOLATION (reserved > onHand)
avgCost: 0.0000
```

**Investigation of the violation** (queried all transactions for this pool, ordered by recordedAt):

| recordedAt | transactionType | quantity | referenceType | referenceId |
|---|---|---|---|---|
| 2026-07-19 23:32 | cycle_count_adjust | 7 (SET onHand=7) | manual | null |
| 2026-07-24 21:47 | cycle_count_adjust | 5 (SET onHand=5) | cycle_count | cmrzh11xf... |
| 2026-07-24 22:04 | cycle_count_adjust | 2 (SET onHand=2) | cycle_count | cmrzhn0it... |

A `StockLossRecord` was created ~190ms before the final cycle_count_adjust:
```
StockLossRecord cmrzhn46s000nmmjz8a10x808
  sourceModule: NULL, lossType: missing, subType: suspected
  quantity: 3, inventoryTxnId: NULL
  createdAt: 2026-07-24T22:04:41.332Z
```

**Root cause analysis:** The cycle-count approval flow (for shortage + theft_suspected/unknown) does this sequence:
1. Calls `quarantineStock()` → increments `reserved += 3` (reserved now = 3)
2. Calls `recordStockLoss({ createInventoryTransaction: false })` → creates StockLossRecord but does NOT touch InventoryPool
3. Calls `processInventoryTransaction({ transactionType: 'cycle_count_adjust', quantity: 2 })` → SETS onHand to 2 (the counted value)

After step 3: `onHand = 2`, `reserved = 3` (untouched by cycle_count_adjust). This is the violation.

Logged as **INV-001 (Critical)**.

### B.2 — Duplicate InventoryPool rows per (orgVariantId, locationId)

**Query:** `SELECT "orgVariantId", "locationId", count(*) FROM "InventoryPool" GROUP BY "orgVariantId", "locationId" HAVING count(*) > 1;`

**Result:** 0 duplicates. ✅ The `@@unique([orgVariantId, locationId])` constraint in the Prisma schema is enforced at the DB level.

### B.3 — UPDATE or DELETE targeting InventoryTransaction in src/

**Method:** `Grep` for `db.inventoryTransaction.(update|delete|updateMany|deleteMany|upsert)`.

**Result:** **1 violation found.**

| File:Line | Operation | Field modified | Severity |
|---|---|---|---|
| `src/lib/actions/exchange-shipment.actions.ts:545` | `updateMany` | `metadata` field only | High (contract violation) |

The schema comment at `prisma/schema.prisma:1045` explicitly states: *"Append-only ledger. Never update or delete rows."*

The violation updates the `metadata` JSON field of recently-created `sale_dispatched` transactions (within the last 60 seconds) to attach an `exchangeShipmentId` tag for future idempotency checks. It does NOT touch financial fields (quantity, costPerUnit, avgCostBefore, avgCostAfter) — but it IS still a mutation of an append-only table.

Logged as **INV-005 (High)** below.

### B.4 — WAC math spot-check (5 real transactions)

**Query:** Latest 5 `opening_stock` or `purchase_received` transactions, joined with their current `InventoryPool`. Manually recomputed `new_avg = (preQty × oldAvg + newQty × newCost) / (preQty + newQty)` where `preQty = current_on_hand - qty` (since IN transactions increment).

**Result:**

| Txn ID (prefix) | Type | qty | cpu | avgCostBefore | avgCostAfter | Expected | Match? |
|---|---|---|---|---|---|---|---|
| cmthsbo4 | opening_stock | 10 | 1000 | 0 | 1000 | 1000.0000 | ✅ |
| cmtgfg25 | opening_stock | 10 | 3000 | 0 | 3000 | 3000.0000 | ✅ |
| cmtge12b | opening_stock | 10 | 3000 | 0 | 3000 | 3000.0000 | ✅ |
| cmstjtpq | opening_stock | 10 | 4000 | 0 | 4000 | 4000.0000 | ✅ |
| cmsol3vz | opening_stock | 100 | 5000 | 0 | 5000 | 5000.0000 | ✅ |

**Note:** All 5 sampled transactions had `avgCostBefore = 0` (i.e. the pool was empty before the txn) — so the formula simplifies to `new_avg = new_cost`. This is correct but doesn't exercise the full WAC path (where existing qty > 0). A more rigorous audit would sample transactions where `avgCostBefore > 0`. The code path for that is in `inventory.ts:194` (`calculateNewAvgCost`) and is correct by inspection.

**VERIFIED OK** — WAC math is correct for all 5 sampled transactions.

### B.5 — StockTransfer.quantity > 0 validation

**Method:** `Grep` for quantity validation in `src/app/api/inventory/transfers/route.ts`.

**Result:** Lines 55-58:
```typescript
if (body.quantity <= 0) throw new ApiError(400, 'Quantity must be positive.')
if (body.from_location_id === body.to_location_id) {
  throw new ApiError(400, 'From and to locations must be different.')
}
```

Also enforced client-side via Zod schema (`transferStockSchema` at `validations/inventory.ts:96`: `z.number().int().positive('Quantity must be positive')`).

**VERIFIED OK** — Quantity > 0 validation is present at both API and Zod layers.

### B.6 — StockTransfer net-zero verification (3 real transfers)

**Query:** Latest 3 StockTransfers, with their associated InventoryTransaction rows.

**Result:**

| Transfer ID (prefix) | qty | cpuAtTransfer | logisticsCost | txns | txn qty match? | logistics folded into cpu? |
|---|---|---|---|---|---|---|
| cmtmtjqi | 5 | 0 | 0 | 2 (out=-5, in=+5) | ✅ | N/A (logistics=0) |
| cmtm51fu | 5 | 0 | 0 | 2 (out=-5, in=+5) | ✅ | N/A (logistics=0) |
| cms0es18 | 30 | 2500 | 500 | 2 (out=-30, in=+30) | ✅ | ✅ NOT folded (both txns have cpu=2500, not 2500+500/30) |

**Bonus:** Queried ALL 7 StockTransfers — every single one has exactly 2 InventoryTransaction rows (transfer_out + transfer_in) with matching quantities.

**VERIFIED OK** — All transfers are net-zero (transfer_out + transfer_in with matching qty). Logistics cost is NOT folded into costPerUnit on either txn. The `costPerUnitAtTransfer` field on StockTransfer records the sending location's avgCost, and both txns use this value (verified by query: `t.cpu = st.costPerUnitAtTransfer` for all rows).

### B.7 — AvgCostHistory coverage check

**Query:** All InventoryTransactions where `avgCostBefore != avgCostAfter` (i.e. avgCost changed), checked for a corresponding `AvgCostHistory` row via `triggeredByTxnId`.

**Result:** Latest 5 avgCost-changing txns all have a matching AvgCostHistory row. ✅

**Aggregate check:**
```
AvgCostHistory total rows:        44
InventoryTransactions with avgCost change: 44
Match ratio: 1:1 (perfect)
Orphan AvgCostHistory rows (no matching txn): 0
```

**VERIFIED OK** — AvgCostHistory has 1:1 coverage with avgCost-changing transactions. No orphans.

### Bonus DB findings

```
InventoryPool: 40 rows, total_on_hand=5875, total_reserved=26, total_value≈Rs. 15.1M
InventoryTransaction: 176 rows across 14 distinct transactionTypes
  (top: order_reserved=37, order_unreserved=28, opening_stock=20, sale_dispatched=18, purchase_received=17)
AvgCostHistory: 44 rows (perfect 1:1 match with changed txns)
StockLossRecord: 10 rows (8 with inventoryTxnId, 2 NULL — pre-unification legacy)
ReturnedStitchedInventory: 2 rows (0 with inventoryTxnId — confirms PROD-002 still unfixed)
ProductionOrder: 3 rows (0 with orderItemId link — bug)
```

---

## PART C — BACKEND / API LAYER

### C.1 — GET /api/inventory/dashboard — company filter

**File:** `src/app/api/inventory/dashboard/route.ts` (lines 28-52)

**Code:**
```typescript
const companyFilter = { OR: [{ companyId: null }, { companyId }] }
const pools = await db.inventoryPool.findMany({
  where: { organizationId: orgId, location: companyFilter },
  ...
})
```

**Verdict:** The dashboard correctly filters via the `location` relation — only pools at org-level shared locations (companyId=null) OR this company's locations (companyId=current) are returned. The "org-wide leak" from prior audits is **truly fixed** for this endpoint.

The same `companyFilter` is also applied to the `InventoryTransaction` queries for movement stats and recent transactions — but applied DIRECTLY on the transaction's `companyId` field (not via location relation). This means transactions are filtered by their `companyId` column (which is set explicitly when the txn is created, even for org-level shared locations). So a transaction done on an org-level location by Company A would have `companyId = Company A` and would NOT be visible to Company B. This is the intended confidentiality behavior.

**VERIFIED OK** — no issue.

### C.2 — POST /api/inventory/receive — first-ever detection logic

**File:** `src/app/api/inventory/receive/route.ts` (lines 56-83)

**Code:**
```typescript
for (const item of d.items) {
  const existingTxnCount = await db.inventoryTransaction.count({
    where: { orgVariantId: item.org_variant_id, locationId: d.location_id },
  })
  const txnType = existingTxnCount === 0 ? 'opening_stock' : 'purchase_received'
  ...
}
```

**Edge case — receiving at a NEW location for an EXISTING variant:**

Suppose variant V has stock at Location A (5 prior transactions). User receives V at Location B (no prior transactions for V+B).

- `existingTxnCount` query filters by `orgVariantId + locationId` → returns 0 for V+B (correct, since locationId is in the filter)
- `txnType` becomes `'opening_stock'` (correct — this IS the opening stock at Location B)
- `processInventoryTransaction` creates a new pool for V+B (since none exists), sets onHand=qty, calculates avgCost=costPerUnit
- The `trackInventory` flip for MTO variants also fires (one-way FALSE→TRUE) on opening_stock — this is correct behavior for "first bulk stock entered for an MTO variant at a new location"

**VERIFIED OK** — the first-ever detection logic correctly handles the new-location-for-existing-variant edge case. The `opening_stock` type is chosen when the count is 0 for variant+location, regardless of whether the variant has stock at other locations.

### C.3 — POST /api/inventory/adjust — negative adjustment rejection

**File:** `src/app/api/inventory/adjust/route.ts` (lines 115-196)

**Code path for negative adjustment:**
```typescript
const lossResult = await recordStockLoss({
  ...
  lossType: d.reason.toLowerCase().includes('theft') ? 'theft' : 'damaged',
  sourceModule: 'adjust_stock',
  quantity: absQty,
  costPerUnit: avgCostForMetric,
  createInventoryTransaction: true, // default — recordStockLoss creates the txn
})
```

The `recordStockLoss` helper (in `src/lib/stock-loss.ts:217-242`) calls `processInventoryTransaction` with `transactionType: 'damage_writeoff'` (or `theft_writeoff`).

`damage_writeoff` IS in `OUT_TYPES` (inventory.ts:42-51), so the validation at inventory.ts:152-160 fires:
```typescript
if (OUT_TYPES.includes(transactionType)) {
  const available = pool.onHand - pool.reserved
  if (available < absQty) {
    return { success: false, error: `INSUFFICIENT_STOCK: Available ${available}, requested ${absQty}` }
  }
}
```

**So:** A negative adjustment that would bring `onHand - qty < reserved` (i.e. would consume reserved stock) IS rejected — but with HTTP **500**, not HTTP **400**. The route catches the failure and re-throws as `ApiError(500, ...)`.

**Flagged:** Status code mismatch — should be 400 (client-supplied invalid input) but is 500 (server error). Minor issue.

Logged as **INV-010 (Medium)** below.

### C.4 — POST /api/inventory/transfers — transferring more than available

**File:** `src/app/api/inventory/transfers/route.ts` (lines 60-73)

**Code:**
```typescript
const sourcePool = await db.inventoryPool.findUnique({ ... })
if (!sourcePool) throw new ApiError(404, 'No inventory at the source location.')
const available = sourcePool.onHand - sourcePool.reserved
if (available < body.quantity) {
  throw new ApiError(400, `Insufficient stock. Available: ${available}, requested: ${body.quantity}.`)
}
```

**Verdict:** Correctly rejects transferring more than `(onHand - reserved)` with HTTP 400. ✅

**VERIFIED OK** — no issue.

### C.5 — POST /api/inventory/fulfill-mto + checkAndFulfillMadeToOrderVariant

**Files:**
- `src/app/api/inventory/fulfill-mto/route.ts` (42 lines — thin wrapper)
- `src/lib/inventory.ts:532-640` (`checkAndFulfillMadeToOrderVariant`)

**Two paths traced:**

#### Path 1: returned stock available (`source: 'existing_stock'`)
```typescript
const availability = await checkReturnedStockAvailability(orgVariantId)
const totalAvailable = availability.reduce((sum, a) => sum + a.available, 0)
if (totalAvailable >= quantity) {
  const best = availability.filter((a) => a.available > 0).sort((a, b) => b.available - a.available)[0]
  return { source: 'existing_stock', locationId: best.locationId, available: best.available }
}
```

- Correctly aggregates available stock across all locations for this variant
- Returns the location with the most available stock
- **No InventoryTransaction is created at this point** — the caller (order.actions.ts) is responsible for calling `reserveStockForOrder()` with this locationId
- ✅ Logic is sound

#### Path 2: returned stock NOT available (`source: 'fresh_production'`)
```typescript
const variant = await db.orgProductVariant.findUnique({
  where: { id: orgVariantId },
  select: { fabricSourceVariantId, stitchingCharges, productionDays, organizationId },
})
if (!variant.fabricSourceVariantId) return { error: 'No fabric source variant linked' }

const fabricPools = await db.inventoryPool.findMany({
  where: { orgVariantId: variant.fabricSourceVariantId, onHand: { gt: 0 } },
})
const fabricLocation = preferredLocationId
  ? fabricPools.find((p) => p.locationId === preferredLocationId)
  : fabricPools[0]

if (!fabricLocation || fabricLocation.onHand - fabricLocation.reserved < quantity) {
  return { error: `Insufficient fabric stock. Available: ${fabricLocation?.onHand ?? 0}, required: ${quantity}` }
}

// Consume fabric
const txnResult = await processInventoryTransaction({
  orgVariantId: variant.fabricSourceVariantId,
  locationId: fabricLocation.locationId,
  ...
  transactionType: 'fabric_consumed_for_stitching',
  referenceType: 'production_order',
  // ⚠️ NO referenceId passed — production order doesn't exist yet
})

// Create production order
const productionOrder = await db.productionOrder.create({
  data: {
    ...
    fabricTxnId: txnResult.transactionId ?? null,
  },
})
```

**Bug:** The fabric consumption transaction is created BEFORE the ProductionOrder. The `referenceType: 'production_order'` is set, but `referenceId` is left NULL because the production order ID doesn't exist yet. The reverse link (`ProductionOrder.fabricTxnId → InventoryTransaction.id`) IS set, so the data is recoverable, but the forward link (`InventoryTransaction.referenceId → ProductionOrder.id`) is broken.

DB confirms: 4 of 4 `production_order`-typed transactions have NULL `referenceId`. ✗

Logged as **INV-004 (High)** below.

### C.6 — GET/POST /api/inventory-locations, /api/suppliers — permission + DELETE behavior

#### POST permission enforcement

| Route | Permission required | Enforced? |
|---|---|---|
| `POST /api/inventory-locations` | `INVENTORY_MANAGE_LOCATIONS` | ✅ Yes (lines 70-75) |
| `POST /api/suppliers` | `INVENTORY_MANAGE_SUPPLIERS` | ✅ Yes (lines 67-72) |
| `PATCH /api/inventory-locations/[id]` | `INVENTORY_MANAGE_LOCATIONS` | ✅ Yes |
| `PATCH /api/suppliers/[id]` | `INVENTORY_MANAGE_SUPPLIERS` | ✅ Yes |

**VERIFIED OK** — POST permission enforcement is correct.

#### DELETE behavior with dependent rows

**`DELETE /api/inventory-locations/[id]`:**
- Soft-delete only (sets `isActive=false`, `isDefault=false`) — never hard-deletes
- Restricts to elevated-tier employees only
- Pre-check: queries `InventoryPool` where `locationId=id AND onHand > 0`
- If any pool has `onHand > 0`, throws `ApiError(409, ...)` with details
- ⚠️ **Gap:** Does NOT check `reserved > 0`. A location with `onHand=0` but `reserved=5` (an unusual but possible state) would pass the check and be deactivated, leaving 5 units of phantom reservation pointing at a deactivated location.

**`DELETE /api/suppliers/[id]`:**
- Soft-delete only (sets `isActive=false`)
- Restricts to elevated-tier employees only
- ⚠️ **Gap:** Does NOT check for dependent rows at all — no check for existing PurchaseOrders, SupplierReturns, or any other relation. A supplier with active POs or pending returns can be silently deactivated. This may break foreign-key integrity for queries that filter by `isActive=true` (the supplier disappears from dropdowns even though open POs reference it).

Logged as **INV-009 (Medium)** below.

### C.7 — GET /api/inventory/summary — totalOnHand correctness

**File:** `src/app/api/inventory/summary/route.ts` (30 lines — thin wrapper around `getProductInventorySummary`)

**Code in `src/lib/inventory.ts:421-423`:**
```typescript
const totalOnHand = pools.reduce((sum, p) => sum + p.onHand, 0)
const totalReserved = pools.reduce((sum, p) => sum + p.reserved, 0)
const totalAvailable = totalOnHand - totalReserved
```

**Verdict:** `totalOnHand` is computed as the SUM of `onHand` across all `InventoryPool` rows for that variant (across all locations). This is the correct formula.

**VERIFIED OK** — no issue.

**Note:** The endpoint requires `product_id` query parameter and returns per-variant summaries. There is no aggregate "total across all variants" endpoint — the dashboard endpoint (`/api/inventory/dashboard`) provides that via its `totalStockValue` field.

---

## PART D — FRONTEND LAYER

### D.1 — inventory-dashboard-view.tsx — KPI values from API

**File:** `src/components/inventory/inventory-dashboard-view.tsx` (712 lines)

**Code:**
```typescript
const { data, isLoading, isError, refetch, isFetching } = useQuery<InventoryDashboardData>({
  queryKey: ['inventory-dashboard'],
  queryFn: () => api.get<InventoryDashboardData>('/api/inventory/dashboard'),
  staleTime: 15_000,
})

const stats = data?.stats
// ... passed to <StatCard value={stats ? formatPKR(stats.totalStockValue) : undefined} ... />
```

**Verdict:** KPI values are fetched from `/api/inventory/dashboard` via `useQuery`, not hardcoded. The `StatCard` components show `Skeleton` while loading and the actual value when loaded. ✅

**VERIFIED OK** — no issue. (Note: this fixes the prior `INVENTORY_AUDIT.md` finding that the dashboard was rendering the workspace welcome page instead of inventory stats — that bug appears to have been resolved.)

### D.2 — Client-side validation for negative/zero quantities

| Component | Quantity validation | Cost validation | Available-stock check |
|---|---|---|---|
| `adjust-stock-view.tsx` | `parseQty()` ensures non-negative integer; `if (quantity <= 0)` reject | `if (i.costPerUnit < 0)` reject | `if (direction === 'remove' && Math.abs(quantity) > currentPool.onHand)` reject — checks **onHand** not **available** ⚠️ |
| `transfer-stock-view.tsx` | `parseQty()` ensures non-negative integer; `if (quantity <= 0)` reject | `parseCost()` ensures non-negative | `if (sourcePool && quantity > sourcePool.available)` reject — checks **available** ✅ |
| `receive-stock-view.tsx` | `if (i.quantity <= 0)` reject (per-item) | `if (i.costPerUnit < 0)` reject | N/A (receiving adds stock) |

**Flagged:** `adjust-stock-view.tsx` checks `Math.abs(quantity) > currentPool.onHand` instead of `> currentPool.available`. If `onHand=5, reserved=3` and user enters `quantity=4` for removal, the frontend allows submission (4 < 5 is false), but the backend rejects with HTTP 500 (because `damage_writeoff` is an OUT_TYPE and checks `available`). The user sees a confusing "Adjustment failed: INSUFFICIENT_STOCK" error after submission, instead of being blocked at the form level. The transfer-stock view does this correctly (uses `available`).

Logged as **INV-011 (Low)** — minor UX inconsistency.

### D.3 — Org-level vs company-level visual distinction

| Component | Distinction |
|---|---|
| `locations-view.tsx` | ✅ Badge with `<Building2 /> Org-level` icon vs `<Store /> Company` icon (lines 326-336) |
| `suppliers-view.tsx` | ✅ Badge with `<Building2 /> Org` vs `Company` text (lines 346-354) |
| `location-detail-view.tsx` | ✅ Reads `isOrgLevel` field (line 61) |
| `supplier-detail-view.tsx` | ✅ Reads `isOrgLevel` field (line 72) |
| `inventory-dashboard-view.tsx` | ⚠️ Shows location NAME but not the org/company badge in the stock table |

**VERIFIED OK** for locations and suppliers. Dashboard could surface the distinction but it's not critical.

### D.4 — Responsive patterns

| Pattern | Used in |
|---|---|
| `grid gap-4 sm:grid-cols-2 lg:grid-cols-4` | Dashboard stat cards |
| `grid gap-3 sm:grid-cols-5` | Movement blocks |
| `flex flex-col sm:flex-row` | Dashboard filter bar |
| `grid gap-6 lg:grid-cols-3` | Adjust/Transfer layout (form + preview) |
| `lg:col-span-2` | Form column |
| `lg:sticky lg:top-20` | Live-preview card on adjust/transfer |
| `overflow-x-auto` | All tables |
| `max-h-96 overflow-y-auto scrollbar-thin` | Recent transactions table |
| `grid grid-cols-2 gap-3` | Mobile-friendly stat sub-blocks |

**VERIFIED OK** — responsive patterns are well-implemented. Mobile layouts collapse to single column, desktop uses 3-4 column grids. Tables horizontally scroll on narrow screens.

### D.5 — Hydration issues

**Method:** Inspected each component for:
- `useEffect` dependencies
- Direct `window`/`document` references
- `useState` initial values that could differ between server and client
- Time/date formatting that could mismatch

**Findings:**

| Component | Issue? |
|---|---|
| `inventory-dashboard-view.tsx` | ✅ No hydration issues. `useMemo` deps are correct. `formatDate()` uses `try/catch` around `new Date(iso).toLocaleString()` — safe. |
| `adjust-stock-view.tsx` | ✅ `useEffect` deps `[locationId, locationsQuery.data]` correct. No window refs. |
| `transfer-stock-view.tsx` | ✅ No `useEffect`, no window refs. Pure `useMemo` for derived state. |
| `receive-stock-view.tsx` | ✅ Standard pattern. |
| `locations-view.tsx` | ✅ Uses `useEffect` to auto-select default location; deps correct. |
| `location-detail-view.tsx` | ✅ No hydration issues. |
| `suppliers-view.tsx` | ✅ Same pattern as locations. |
| `supplier-detail-view.tsx` | ✅ Same pattern. |

**VERIFIED OK** — no hydration issues found. All components use `'use client'` directive and follow React Query patterns correctly. Date formatting is wrapped in try/catch. No direct window references.

---

## PART E — CROSS-MODULE TRIGGER VERIFICATION

### E.1 — Receive stock route: InventoryPool update + AvgCostHistory atomicity

**File:** `src/app/api/inventory/receive/route.ts` (calls `processInventoryTransaction` per item)

**Tracing into `src/lib/inventory.ts:107-361`:**

The `processInventoryTransaction` function performs these writes **sequentially** (NOT in `db.$transaction`):

| Step | Line | Operation | Failure consequence |
|---|---|---|---|
| 1 | 130-148 | `db.inventoryPool.findUnique` (read — no write) | — |
| 1b | 138-148 | `db.inventoryPool.create` (only if pool doesn't exist) | If fails: pool doesn't exist, function returns error |
| 2 | 280-283 | `db.inventoryPool.update` (update onHand, reserved, avgCost, etc.) | If fails: pool NOT updated, function returns error — pool state is unchanged |
| 3 | 309-327 | `db.inventoryTransaction.create` (insert ledger row) | ⚠️ If fails: **pool IS updated but ledger is missing** — ledger and pool disagree |
| 4 | 331-341 | `db.avgCostHistory.create` (only if avgCost changed) | ⚠️ If fails: **pool + ledger updated, but history missing** — audit trail incomplete |

**Verdict:** The 3 writes (pool update, txn create, history create) are NOT atomic. If step 3 fails after step 2 succeeds, the pool reflects the stock movement but the ledger has no record — violating the "ledger and pool always agree" guarantee claimed in the header comment (inventory.ts:17-19).

The same non-atomicity applies to:
- POST `/api/inventory/opening-stock` (calls the same `processInventoryTransaction`)
- POST `/api/inventory/adjust` (via `recordStockLoss` → `processInventoryTransaction`)
- POST `/api/inventory/transfers` (calls `processInventoryTransaction` twice — once for out, once for in — and uses a compensating-transaction pattern documented at lines 80-90)
- POST `/api/inventory/receive-returned-stitched` (calls `processInventoryTransaction`)
- POST `/api/purchase-orders/[id]/receive` (calls `processInventoryTransaction` per item)

**Mitigation:** The transfer route implements a COMPENSATING-TRANSACTION pattern (lines 91-175) — if `transfer_in` fails after `transfer_out` succeeds, it reverses the `transfer_out` via `manual_adjustment_in`. This handles the cross-pool consistency. But there is no compensating pattern for the intra-function non-atomicity (steps 2-3-4 within `processInventoryTransaction`).

Logged as **INV-006 (High)** below.

### E.2 — Adjust stock route: StockLossRecord creation

**File:** `src/app/api/inventory/adjust/route.ts` (lines 115-196)

**Audit task expectation:** "confirm it does NOT create a StockLossRecord (that should only come from the dedicated Stock Loss module)"

**Actual behavior:**

For **negative adjustments** (lines 115-196), the route calls:
```typescript
const lossResult = await recordStockLoss({
  ...
  lossType: d.reason.toLowerCase().includes('theft') ? 'theft' : 'damaged',
  sourceModule: 'adjust_stock',
  quantity: absQty,
  createInventoryTransaction: true, // default
})
```

This **DOES create a StockLossRecord** (with `sourceModule='adjust_stock'`).

**Code rationale** (from the extensive comment at lines 116-130):
> *"BUG FIX: Previously this branch only created the inventory transaction (decremented onHand) but NO StockLossRecord — leaving the Stock Losses module completely unaware that stock was lost/damaged. The user could then record the same loss AGAIN in the Stock Losses module → double-decrement. Now we create a StockLossRecord via the unified recordStockLoss helper, which: (1) Creates the loss record (linked to the inventory txn), (2) Is dedup-safe (if the user re-records in Stock Losses, the unique index prevents duplicate), (3) Uses sourceModule='adjust_stock' so it's traceable."*

**Verdict:** This is a deliberate design decision that **conflicts with the audit task's expectation**. The code creates a StockLossRecord from the adjust-stock route. The rationale (prevent double-decrement, dedup-safe, traceable) is reasonable, but it does mean stock loss records come from TWO sources: the dedicated Stock Loss module AND the adjust-stock route. This may cause confusion about where loss records originate.

DB confirms: 2 of 10 StockLossRecord rows have `sourceModule='adjust_stock'`.

Logged as **INV-013 (Medium)** — design decision conflict with audit expectation. Not a bug per se, but the audit task explicitly expected "no StockLossRecord from adjust route".

### E.3 — Transfer route: net-zero verification

**File:** `src/app/api/inventory/transfers/route.ts`

**Code trace:**
- Step 1 (line 93-106): Create `StockTransfer` record with status='in_transit'
- Step 2 (line 108-132): `processInventoryTransaction({ transactionType: 'transfer_out' })` — decrements source onHand
- Step 3 (line 134-175): `processInventoryTransaction({ transactionType: 'transfer_in' })` — increments destination onHand
  - If step 3 fails: COMPENSATING ACTION — calls `processInventoryTransaction({ transactionType: 'manual_adjustment_in' })` to reverse step 2 (increment source onHand back), then deletes the orphan StockTransfer record
- Step 4 (line 178-181): Mark StockTransfer as 'completed'

**Net-zero math:**
- Source: -qty (transfer_out)
- Destination: +qty (transfer_in)
- Net change across locations: 0 ✅

**Failure recovery:**
- If step 2 fails: StockTransfer record deleted (line 130), no stock moved ✅
- If step 3 fails: Step 2 reversed via `manual_adjustment_in` (line 160-172), StockTransfer deleted (line 173) ✅

**DB verification:** All 7 StockTransfers in DB have exactly 2 InventoryTransaction rows (transfer_out + transfer_in) with matching quantities. ✅

**VERIFIED OK** — net-zero is maintained. Compensating-transaction pattern correctly handles partial failures.

### E.4 — checkAndFulfillMadeToOrderVariant: fabric consumption + ProductionOrder linkage

**File:** `src/lib/inventory.ts:532-640`

**Code trace for `fresh_production` path:**

1. **Fabric variant's InventoryPool.onHand decreases:**
```typescript
const txnResult = await processInventoryTransaction({
  orgVariantId: variant.fabricSourceVariantId,  // fabric variant
  locationId: fabricLocation.locationId,
  transactionType: 'fabric_consumed_for_stitching',
  quantity,  // ← correct amount
  costPerUnit: Number(fabricLocation.avgCost),
  ...
})
```
`fabric_consumed_for_stitching` is in `OUT_TYPES` (inventory.ts:50), so:
- Validation: `available = onHand - reserved >= quantity` — rejects if insufficient ✅
- Pool update: `newOnHand -= absQty` (inventory.ts:251) ✅
- Txn created with `quantity: -absQty` (negative = out) ✅

**VERIFIED:** Fabric variant's `InventoryPool.onHand` decreases by exactly `quantity`. ✅

2. **ProductionOrder links back to orderItemId:**

```typescript
const productionOrder = await db.productionOrder.create({
  data: {
    ...
    stitchedVariantId: orgVariantId,
    fabricVariantId: variant.fabricSourceVariantId,
    fabricLocationId: fabricLocation.locationId,
    quantity,
    status: 'fabric_reserved',
    fabricTxnId: txnResult.transactionId ?? null,  // ← links PO → txn
    // ⚠️ orderItemId NOT set here
  },
})
```

The `orderItemId` is set **later** in `src/lib/actions/order.actions.ts:319-322`:
```typescript
await db.productionOrder.update({
  where: { id: mtoResult.productionOrderId },
  data: { orderItemId: item.id },
})
```

**VERIFIED:** When the order-confirmation flow triggers MTO fulfillment, the ProductionOrder is updated to set `orderItemId`. ✅

**HOWEVER:** If a production order is created directly via `POST /api/production-orders` (not through the order flow), `orderItemId` remains NULL. DB confirms: 3 of 3 existing production orders have `orderItemId = NULL`. This means:
- All 3 production orders were created via direct API (not through order confirmation), OR
- The order.actions.ts update failed for all 3

This is likely the former — manual production orders created by an admin for testing. Not a bug per se, but worth flagging.

**VERIFIED OK** — the linkage mechanism is correct. The NULL orderItemId values are a data artifact, not a code bug.

---

## BUG REPORTS

### INV-001 — Cycle count adjustment creates `reserved > onHand` state

```
BUG-ID: INV-001
Layer: DB | API | Cross-Module
Severity: Critical
Location: src/app/api/cycle-counts/[id]/route.ts (lines 291-340, action='approve' branch for theft_suspected/unknown shortage) + src/lib/inventory.ts:231-235 (cycle_count_adjust case)
Description: When a cycle count reveals a shortage with reason 'theft_suspected' or 'unknown', the approval flow does:
  1. quarantineStock() → increments reserved += shortageQty
  2. recordStockLoss({ createInventoryTransaction: false }) → creates StockLossRecord, no pool change
  3. processInventoryTransaction({ transactionType: 'cycle_count_adjust', quantity: countedQuantity }) → SETS onHand to countedValue (which is lower than before)
  Step 3 SETS onHand to the counted value but does NOT release the quarantine reservation from step 1. The result: reserved > onHand.

Expected: After cycle count approval, reserved should be <= onHand. Either:
  (a) cycle_count_adjust should release the corresponding reserved quantity (since the "missing" stock is now accounted for via the count), OR
  (b) the quarantine reservation should be explicitly released before/after the cycle_count_adjust, OR
  (c) cycle_count_adjust should validate that the new onHand >= reserved and reject otherwise.

Actual: A real pool (id cmrsfkgmw003btdochj7jvi6b) has onHand=2, reserved=3 — a state that should be impossible. Any future stock operation on this pool will compute available = 2-3 = -1, breaking downstream logic.

Repro Steps:
  1. Have a pool with onHand=7, reserved=0 (variant V at location L).
  2. Reserve 3 units (e.g. via order_reserved) — reserved=3, onHand=7.
  3. Initiate a cycle count for location L.
  4. Count V at 2 units (shortage of 5).
  5. Approve the cycle count with discrepancy_reason='theft_suspected'.
  6. Observe: pool now has onHand=2 (SET by cycle_count_adjust), reserved=3 (untouched).
  7. The pool is now in an invalid state — reserved > onHand.

Suspected Root Cause: The cycle-count approval flow was designed assuming quarantine happens on a pool with sufficient onHand, but cycle_count_adjust SETTING onHand directly (rather than decrementing) bypasses the OUT_TYPES validation that would normally catch this. The two operations (quarantine + cycle_count_adjust) need to be coordinated — currently they are not.
```

### INV-002 — `/api/inventory/receive-returned-stitched` does NOT create a ReturnedStitchedInventory row

```
BUG-ID: INV-002
Layer: API | Cross-Module
Severity: Critical
Location: src/app/api/inventory/receive-returned-stitched/route.ts (entire route, both branches)
Description: The PRODUCTS_AUDIT (PROD-002) claimed this route is the "working equivalent" of the broken POST /api/returned-stitched route. This is HALF-TRUE:
  - It correctly creates an InventoryTransaction (via processInventoryTransaction) for non-damaged items — fixing the inventory ledger side.
  - It does NOT create a ReturnedStitchedInventory row at all — for EITHER damaged or non-damaged path.
  - Therefore the inventoryTxnId link (ReturnedStitchedInventory.inventoryTxnId → InventoryTransaction.id) is NEVER established, because there's no register row to link FROM.
  - The ReturnedStitchedInventory register is bypassed entirely.

Expected: A returned-stitched receive should:
  1. Create ReturnedStitchedInventory row (with condition, total_cost, status='available' or 'written_off', photos, etc.)
  2. For non-damaged: create InventoryTransaction (type='return_stitched_received') via processInventoryTransaction
  3. Set ReturnedStitchedInventory.inventoryTxnId = txn.id (the link)
  4. For damaged: create StockLossRecord (no InventoryTransaction — by design)
  5. Set ReturnedStitchedInventory.linkedLossRecordId = lossRecord.id (the link)

Actual: Only step 2 (or step 4) happens. Steps 1, 3, 5 do NOT. The ReturnedStitchedInventory register never gets a row from this route. The frontend `returned-stitched-view.tsx` (which displays the register) shows no items created via this route.

Repro Steps:
  1. POST /api/inventory/receive-returned-stitched with { org_variant_id, location_id, quantity, condition:'perfect', total_cost, return_reason }
  2. Observe response: { success: true, transaction_id: '...', condition:'perfect', status:'available' }
  3. GET /api/returned-stitched (the register list endpoint)
  4. Observe: the newly-received item is NOT in the list (no ReturnedStitchedInventory row was created)
  5. The InventoryTransaction EXISTS (visible in /api/inventory/dashboard recent_transactions), the InventoryPool was incremented, but the register is empty.

Suspected Root Cause: Code drift. The route was written as an inventory-only endpoint (just the ledger side), intended to be called AFTER a ReturnedStitchedInventory row was created via the old route. But the old route is broken (PROD-002 — doesn't create the txn), so the two routes were supposed to work together. Instead, neither is complete. The fix is either: (a) make /api/inventory/receive-returned-stitched create the register row too, OR (b) fix the old /api/returned-stitched route to call processInventoryTransaction.
```

### INV-003 — supplier_return InventoryTransactions have NULL referenceId

```
BUG-ID: INV-003
Layer: API
Severity: High
Location: src/app/api/supplier-returns/route.ts (lines 103-135)
Description: The route creates the InventoryTransaction FIRST (line 103-114) with referenceType='supplier_return' but NO referenceId, then creates the SupplierReturn record (line 119-135) with inventoryTxnId=txnResult.transactionId. The link is one-directional: SupplierReturn → InventoryTransaction exists, but InventoryTransaction → SupplierReturn does NOT.

Expected: InventoryTransaction.referenceId should be set to the SupplierReturn.id for bi-directional traceability.

Actual: DB confirms 6 of 6 supplier_return-typed transactions have NULL referenceId. The forward link is broken — querying "which supplier return does this transaction belong to?" requires joining via SupplierReturn.inventoryTxnId (reverse lookup), which is less efficient and breaks the convention used by all other referenceTypes.

Repro Steps:
  1. POST /api/supplier-returns with { supplier_id, org_variant_id, location_id, quantity, cost_per_unit, reason }
  2. Query: SELECT id, "referenceType", "referenceId" FROM "InventoryTransaction" WHERE "transactionType"='supplier_return' ORDER BY "recordedAt" DESC LIMIT 1;
  3. Observe: referenceType='supplier_return', referenceId=NULL.

Suspected Root Cause: The transaction is created before the SupplierReturn record exists (chicken-and-egg). The fix is to either: (a) create SupplierReturn first, then the transaction (with referenceId set), then update SupplierReturn.inventoryTxnId; OR (b) update the InventoryTransaction.referenceId after creating SupplierReturn.
```

### INV-004 — production_order InventoryTransactions have NULL referenceId

```
BUG-ID: INV-004
Layer: API
Severity: High
Location: src/lib/inventory.ts:602-612 (checkAndFulfillMadeToOrderVariant, fabric_consumed_for_stitching call) + src/app/api/production-orders/route.ts:117-128 (POST create, same pattern)
Description: In both code paths, the fabric consumption transaction is created BEFORE the ProductionOrder record. referenceType='production_order' is set, but referenceId is left NULL because the production order ID doesn't exist yet. The reverse link (ProductionOrder.fabricTxnId → InventoryTransaction.id) IS set, but the forward link is broken.

Expected: InventoryTransaction.referenceId should be set to the ProductionOrder.id for bi-directional traceability.

Actual: DB confirms 4 of 4 production_order-typed transactions have NULL referenceId. All 4 are fabric_consumed_for_stitching txns.

Repro Steps:
  1. Confirm an order containing a made_to_order variant (triggers checkAndFulfillMadeToOrderVariant)
  2. OR: POST /api/production-orders directly with { stitched_variant_id, fabric_variant_id, fabric_location_id, quantity, stitching_cost }
  3. Query: SELECT id, "referenceType", "referenceId" FROM "InventoryTransaction" WHERE "transactionType"='fabric_consumed_for_stitching';
  4. Observe: all rows have referenceType='production_order', referenceId=NULL.

Suspected Root Cause: Same chicken-and-egg as INV-003. The fabric is consumed before the production order is created. Fix: either reorder (create PO first, then consume fabric with referenceId=PO.id) OR update the txn after PO creation.
```

### INV-005 — InventoryTransaction is mutated (violates append-only contract)

```
BUG-ID: INV-005
Layer: API
Severity: High
Location: src/lib/actions/exchange-shipment.actions.ts:545-560
Description: The schema comment at prisma/schema.prisma:1045 explicitly states: "Append-only ledger. Never update or delete rows." However, the exchange-shipment dispatch flow uses db.inventoryTransaction.updateMany() to mutate the metadata field of recently-created sale_dispatched transactions (within the last 60 seconds) to attach an exchangeShipmentId tag.

Expected: InventoryTransaction should be write-once. Any additional metadata should be stored in a separate join table or in the related entity (ExchangeShipment) — not retroactively patched onto the transaction.

Actual: After dispatching an exchange shipment, the code runs:
  await db.inventoryTransaction.updateMany({
    where: { transactionType: 'sale_dispatched', orgVariantId, locationId, recordedAt: { gte: new Date(Date.now() - 60_000) }, metadata: '{}' },
    data: { metadata: JSON.stringify({ exchangeShipmentId, dispatch_source: source }) },
  })
  This matches the most-recent sale_dispatched txn (within 60s) and overwrites its metadata.

Repro Steps:
  1. Create an exchange shipment (POST /api/exchanges or via UI)
  2. Dispatch it (POST /api/exchange-shipments/[id]/dispatch)
  3. Query the resulting sale_dispatched InventoryTransaction — its metadata field will be a JSON string containing exchangeShipmentId, not the default '{}'.

Suspected Root Cause: The idempotency check needs to find "the txn I just created" to tag it. A cleaner approach would be to have processInventoryTransaction accept and persist the metadata upfront (the function already accepts a metadata parameter at inventory.ts:73), OR to add a dedicated exchangeShipmentId column on InventoryTransaction.
```

### INV-006 — processInventoryTransaction is non-atomic (pool update + ledger + history not in db.$transaction)

```
BUG-ID: INV-006
Layer: API
Severity: High
Location: src/lib/inventory.ts:280-342 (processInventoryTransaction)
Description: The function performs 3 sequential writes (pool.update → txn.create → avgCostHistory.create) without wrapping them in db.$transaction. If write 2 fails after write 1 succeeds, the pool is updated but the ledger is missing — violating the "ledger and pool always agree" guarantee claimed in the header comment (lines 17-19).

Expected: All 3 writes should be atomic — either all succeed or all roll back.

Actual: The function uses sequential awaits with no transaction wrapper. The header comment (lines 17-19) claims "inventory_pools is NEVER written to directly from any other code path — only through this function. This guarantees the ledger and pool always agree." The first claim is mostly true (see INV-007 for the exception). The second claim is FALSE — the function itself doesn't guarantee agreement under partial failure.

Repro Steps:
  1. Difficult to reproduce without injecting a failure — would require simulating a DB outage between writes 2 and 3.
  2. Code inspection confirms the issue: no db.$transaction wrapper around the 3 writes.

Suspected Root Cause: The function uses the global db client (not a tx client). Refactoring to accept a tx client would require touching all 9 callers. The transfer route (src/app/api/inventory/transfers/route.ts) works around this by using a COMPENSATING-TRANSACTION pattern (reverse the transfer_out if transfer_in fails) — but that only handles cross-pool consistency, not intra-function consistency.
```

### INV-007 — Direct InventoryPool writes in purchase-orders routes (outside inventory.ts)

```
BUG-ID: INV-007
Layer: API
Severity: Low
Location: src/app/api/purchase-orders/route.ts:170 (upsert) + src/app/api/purchase-orders/[id]/receive/route.ts:159 (update)
Description: Both routes write directly to InventoryPool.incoming (bypassing inventory.ts helpers). The inventory.ts header comment (lines 17-19) claims "inventory_pools is NEVER written to directly from any other code path" — this contract is violated.

Expected: All InventoryPool writes should go through inventory.ts helpers (incrementIncomingStock / decrementIncomingStock which exist at lines 485-522).

Actual: The purchase-orders routes duplicate the increment/decrement logic inline. The writes are contained to the `incoming` projection field (not onHand, reserved, or avgCost), so the ledger integrity is not affected — but the contract is broken, and any future change to the increment/decrement logic would need to be applied in 3 places (inventory.ts + 2 purchase-orders routes).

Repro Steps:
  1. Code inspection only — no runtime repro needed.
  2. Grep confirms: db.inventoryPool.(update|create|upsert) appears in 2 files outside inventory.ts.

Suspected Root Cause: Code drift — the purchase-orders routes were written before the incrementIncomingStock/decrementIncomingStock helpers were extracted. The helpers exist but weren't adopted.
```

### INV-008 — [id] routes for inventory-locations and suppliers lack company-scoping

```
BUG-ID: INV-008
Layer: API
Severity: High
Location: src/app/api/inventory-locations/[id]/route.ts (GET line 24, PATCH line 126, DELETE line 199) + src/app/api/suppliers/[id]/route.ts (PATCH line 40, DELETE line 109) + src/app/api/inventory/transfers/route.ts (GET line 252)
Description: All [id] routes filter by { id, organizationId } only — NO companyId filter. A user from Company A in Org X can fetch/update/delete a location or supplier owned by Company B in the same org, as long as they know the ID.

Expected: The where clause should include OR: [{ companyId: null }, { companyId: ctx.company.id }] to ensure only org-level shared entities OR the caller's own company's entities are accessible. (For writes: only allow edits to own company's entities OR org-level if caller is elevated-tier.)

Actual: A user with INVENTORY_VIEW permission in Company A can call GET /api/inventory-locations/{company-B-location-id} and receive the full location detail (pools, recent transactions). A user with INVENTORY_MANAGE_LOCATIONS in Company A can PATCH/DELETE Company B's location. Same for suppliers.

Repro Steps:
  1. Log in as a user in Company A (org X).
  2. Obtain the ID of a location owned by Company B (same org X) — e.g. via DB inspection or a leaked URL.
  3. GET /api/inventory-locations/{company-B-location-id}
  4. Observe: 200 OK with full location details, pools, and transactions for Company B's location.

Suspected Root Cause: The list endpoints (GET /api/inventory-locations, GET /api/suppliers) correctly scope by company. The [id] endpoints were overlooked — they use the same pattern as the rest of the codebase (filter by org only), which is insufficient for multi-company orgs with company-scoped entities. This was flagged in the prior INVENTORY_AUDIT.md (Recommendation #2) but appears unfixed.
```

### INV-009 — Supplier DELETE does not check for dependent rows

```
BUG-ID: INV-009
Layer: API
Severity: Medium
Location: src/app/api/suppliers/[id]/route.ts (DELETE, lines 84-129)
Description: The DELETE route soft-deletes a supplier (sets isActive=false) without checking for dependent rows. A supplier with active PurchaseOrders (status != 'cancelled'), pending SupplierReturns (status != 'resolved'), or open credit balances can be silently deactivated.

Expected: The route should check for dependent rows and block deactivation with HTTP 409 if any active dependencies exist (mirroring the pattern in DELETE /api/inventory-locations/[id] which checks for pools with onHand > 0).

Actual: No dependency check. The supplier simply disappears from dropdowns (since list endpoints filter isActive=true), but the foreign-key rows (PurchaseOrders, SupplierReturns) still reference it. Users creating new POs won't see the supplier, but existing POs/returns still link to it.

Repro Steps:
  1. Create a supplier S.
  2. Create a PurchaseOrder with supplierId=S, status='ordered'.
  3. DELETE /api/suppliers/{S-id} (as elevated-tier user).
  4. Observe: 200 OK, supplier S now has isActive=false.
  5. GET /api/suppliers — S is not in the list.
  6. GET /api/purchase-orders — the PO still references S, but the supplier name won't resolve in dropdowns for new POs.

Suspected Root Cause: The location DELETE route has the dependency check (added later); the supplier DELETE route was not updated to match.
```

### INV-010 — Adjust-stock negative adjustment returns HTTP 500 instead of 400

```
BUG-ID: INV-010
Layer: API
Severity: Medium
Location: src/app/api/inventory/adjust/route.ts (lines 115-196, negative-adjustment branch)
Description: When a negative adjustment would bring onHand below reserved, the backend correctly rejects it (via processInventoryTransaction's INSUFFICIENT_STOCK check on damage_writeoff — an OUT_TYPE). However, the route catches the failure and re-throws as ApiError(500, ...). Per HTTP semantics, this should be 400 (Bad Request — client supplied invalid input).

Expected: HTTP 400 with a clear message like "Cannot remove {qty} units — only {available} available (onHand={onHand}, reserved={reserved})."

Actual: HTTP 500 with message "Adjustment failed: INSUFFICIENT_STOCK: Available {available}, requested {absQty}". The 500 status code implies a server error, misleading clients into retrying.

Repro Steps:
  1. Have a pool with onHand=5, reserved=3 (available=2).
  2. POST /api/inventory/adjust with { org_variant_id, location_id, quantity: -4, reason: 'Cycle count correction' }
  3. Observe: HTTP 500 with "Adjustment failed: INSUFFICIENT_STOCK: Available 2, requested 4".

Suspected Root Cause: The route uses a generic catch-all that wraps all failures in ApiError(500). Should distinguish between "server error" (500) and "client input rejected" (400).
```

### INV-011 — Adjust-stock frontend checks onHand instead of available

```
BUG-ID: INV-011
Layer: Frontend
Severity: Low
Location: src/components/inventory/adjust-stock-view.tsx (lines 252-257)
Description: The client-side validation for removal checks Math.abs(quantity) > currentPool.onHand, but the backend rejects based on available = onHand - reserved. This means the frontend can allow a submission that the backend will reject, resulting in a confusing error after submission.

Expected: Frontend should check Math.abs(quantity) > (currentPool.onHand - currentPool.reserved) — i.e. use available, matching the backend logic. (The transfer-stock-view does this correctly.)

Actual: If onHand=5, reserved=3 (available=2), and user enters quantity=4 for removal, the frontend check (4 > 5) is false → submission proceeds. Backend then rejects with HTTP 500 (INV-010).

Repro Steps:
  1. Have a pool with onHand=5, reserved=3.
  2. Open Adjust Stock, select the variant+location, direction='remove', quantity=4.
  3. The "Apply adjustment" button is enabled (no frontend block).
  4. Click it — observe HTTP 500 error from backend.

Suspected Root Cause: The adjust-stock-view was written before the reserved-stock concept was fully fleshed out. The transfer-stock-view (written later) correctly uses available.
```

### INV-012 — InventoryPool readers use raw ad-hoc queries instead of helpers

```
BUG-ID: INV-012
Layer: API
Severity: Low
Location: 14 sites across src/ (see Part A.2 table for full list)
Description: The contract was "read InventoryPool via getProductInventorySummary or equivalent helper". In practice, 14 modules read InventoryPool directly via raw db.inventoryPool.findUnique/findMany calls. The "available = onHand - reserved" formula is duplicated in ~10 places.

Expected: A single helper function (e.g. getPoolAvailability(orgVariantId, locationId)) that returns { onHand, reserved, available, avgCost } — used by all decision-making modules.

Actual: Each module reads the pool and computes available inline. This is functionally correct but creates maintenance risk: any change to the formula (e.g. adding a "quarantined" field that subtracts from available) would require touching all 10 sites.

Repro Steps: Code inspection only.

Suspected Root Cause: The helpers were never extracted. getProductInventorySummary is too product-centric (returns all variants for a product) — there's no single-pool helper.
```

### INV-013 — Adjust-stock route creates a StockLossRecord (conflicts with audit expectation)

```
BUG-ID: INV-013
Layer: API | Cross-Module
Severity: Medium
Location: src/app/api/inventory/adjust/route.ts (lines 115-196, negative-adjustment branch)
Description: The audit task expected: "confirm adjust stock route does NOT create a StockLossRecord (that should only come from the dedicated Stock Loss module)". The route DOES create one — via recordStockLoss({ sourceModule: 'adjust_stock' }) for negative adjustments.

Expected (per audit task): StockLossRecords should only come from the dedicated Stock Loss module (/api/stock-loss/* routes).

Actual: DB confirms 2 of 10 StockLossRecord rows have sourceModule='adjust_stock'. The route's rationale (prevent double-decrement if user re-records in Stock Losses module) is reasonable, but it means stock loss records come from TWO sources, creating ambiguity about the canonical entry point.

Repro Steps:
  1. POST /api/inventory/adjust with { org_variant_id, location_id, quantity: -3, reason: 'Damaged in storage' }
  2. GET /api/stock-loss
  3. Observe: a StockLossRecord with sourceModule='adjust_stock', lossType='damaged', quantity=3 appears in the list.

Suspected Root Cause: This is a deliberate design decision (documented in the extensive code comment at lines 116-130), not an accident. The audit task's expectation may need to be revisited — OR the route should be changed to NOT create the loss record (and accept the double-decrement risk).
```

---

## VERIFIED OK — Summary of Passing Checks

| Check | Result |
|---|---|
| IN-000 cross-reference: receive-returned-stitched creates InventoryTransaction (non-damaged path) | ✅ VERIFIED (txn IS created) |
| IN-000 cross-reference: receive-returned-stitched creates ReturnedStitchedInventory row | ❌ NOT VERIFIED — see INV-002 |
| A.1: All InventoryPool writes go through processInventoryTransaction | ⚠️ PARTIAL — see INV-007 (2 exceptions, both on `incoming` field only) |
| A.3: InventoryLocation + Supplier org-level shared behavior on list endpoints | ✅ VERIFIED OK — no issue |
| A.3: [id] endpoints company-scoping | ❌ NOT VERIFIED — see INV-008 |
| A.4: All referenceType values map to real entity tables | ✅ VERIFIED OK — no issue (10/10 valid types) |
| A.4: referenceId set when referenceType is set | ❌ NOT VERIFIED — see INV-003 (supplier_return) and INV-004 (production_order) |
| B.1: No negative onHand/reserved or reserved>onHand | ❌ NOT VERIFIED — see INV-001 (1 violation) |
| B.2: No duplicate InventoryPool rows per (orgVariantId, locationId) | ✅ VERIFIED OK — no issue (0 duplicates, unique constraint enforced) |
| B.3: No UPDATE or DELETE on InventoryTransaction | ❌ NOT VERIFIED — see INV-005 (1 updateMany found) |
| B.4: WAC math correct on 5 real transactions | ✅ VERIFIED OK — no issue (5/5 match) |
| B.5: StockTransfer quantity > 0 validation | ✅ VERIFIED OK — no issue (validated at API + Zod layers) |
| B.6: StockTransfers have exactly 2 txns (out + in) with matching qty, logistics NOT folded into cpu | ✅ VERIFIED OK — no issue (7/7 transfers correct) |
| B.7: AvgCostHistory has row for every avgCost-changing txn | ✅ VERIFIED OK — no issue (44/44 perfect 1:1 match, 0 orphans) |
| C.1: Dashboard filters by companyId (org-wide leak fixed) | ✅ VERIFIED OK — no issue |
| C.2: Receive stock first-ever detection handles new-location-for-existing-variant | ✅ VERIFIED OK — no issue |
| C.3: Negative adjustment that would bring onHand below reserved is rejected | ⚠️ PARTIAL — rejected, but with HTTP 500 not 400 (see INV-010) |
| C.4: Transferring more than available is rejected | ✅ VERIFIED OK — no issue (HTTP 400) |
| C.5: fulfill-mto + checkAndFulfillMadeToOrderVariant both paths traced | ✅ VERIFIED OK (existing_stock path) + ⚠️ fresh_production path has INV-004 |
| C.6: POST /api/inventory-locations + /api/suppliers require INVENTORY_MANAGE_* permission | ✅ VERIFIED OK — no issue |
| C.6: DELETE behavior for locations with dependent rows | ⚠️ PARTIAL — location checks onHand>0 but not reserved>0; supplier checks nothing (see INV-009) |
| C.7: GET /api/inventory/summary totalOnHand = SUM of onHand across all pools | ✅ VERIFIED OK — no issue |
| D.1: KPI values fetched from API (not hardcoded) | ✅ VERIFIED OK — no issue |
| D.2: Client-side validation for negative/zero quantities | ⚠️ PARTIAL — adjust-stock checks onHand not available (see INV-011); transfer-stock and receive-stock correct |
| D.3: Org-level vs company-level visually distinguished | ✅ VERIFIED OK — no issue (locations + suppliers show badges) |
| D.4: Responsive patterns (CSS breakpoints, flex/grid) | ✅ VERIFIED OK — no issue |
| D.5: No hydration issues | ✅ VERIFIED OK — no issue |
| E.1: Receive stock InventoryPool + AvgCostHistory same logical operation | ❌ NOT VERIFIED — see INV-006 (sequential, not transactional) |
| E.2: Adjust stock route does NOT create StockLossRecord | ❌ NOT VERIFIED — see INV-013 (route DOES create one) |
| E.3: Transfer route net-zero (out decreases source, in increases destination, total unchanged) | ✅ VERIFIED OK — no issue (code + DB confirmed) |
| E.4: checkAndFulfillMadeToOrderVariant fabric pool decreases + ProductionOrder links to orderItemId | ✅ VERIFIED OK — fabric pool decreases correctly; orderItemId linkage mechanism works (when called via order flow) |

---

## TOP PRIORITY RECOMMENDATIONS (for a follow-up fix task — NOT done in this audit)

1. **🔴 INV-001 (Critical)** — Fix cycle_count_adjust to release the corresponding quarantine reservation OR validate that new onHand >= reserved. Real data corruption is occurring (1 pool in DB with reserved > onHand).
2. **🔴 INV-002 (Critical)** — Either: (a) make `/api/inventory/receive-returned-stitched` create the ReturnedStitchedInventory row too, OR (b) fix the old `/api/returned-stitched` route to call processInventoryTransaction. The register-ledger split is the root cause of PROD-002.
3. **🟠 INV-003 + INV-004 (High)** — Fix the chicken-and-egg pattern in supplier-returns and production-orders routes: create the entity first, then the inventory transaction (with referenceId set), then update the entity's inventoryTxnId. OR: update the txn's referenceId after entity creation.
4. **🟠 INV-005 (High)** — Stop mutating InventoryTransaction.metadata. Add a dedicated column (e.g. `exchangeShipmentId`) OR use a join table for the exchange-shipment ↔ txn link.
5. **🟠 INV-006 (High)** — Wrap the 3 writes in `processInventoryTransaction` in `db.$transaction`. Refactor the function to accept an optional tx client.
6. **🟠 INV-008 (High)** — Add company-scoping to all `[id]` routes (inventory-locations, suppliers, transfers GET). Include `OR: [{ companyId: null }, { companyId }]` in the where clause.
7. **🟡 INV-009 (Medium)** — Add dependency check to supplier DELETE (mirror the location DELETE pattern).
8. **🟡 INV-010 (Medium)** — Change adjust-stock negative-adjustment rejection from HTTP 500 to HTTP 400.
9. **🟡 INV-013 (Medium)** — Decide: should adjust-stock create StockLossRecords or not? If yes, document it. If no, remove the recordStockLoss call (and accept double-decrement risk).
10. **🟢 INV-007 (Low)** — Replace direct InventoryPool writes in purchase-orders routes with calls to `incrementIncomingStock` / `decrementIncomingStock` helpers.
11. **🟢 INV-011 (Low)** — Fix adjust-stock-view frontend to check `available` (onHand - reserved) instead of `onHand`.
12. **🟢 INV-012 (Low)** — Extract a `getPoolAvailability(orgVariantId, locationId)` helper and adopt it across the 14 reader sites.

---

## METHODOLOGY NOTES

- **Backend code audit:** Read all 11 route files, full `src/lib/inventory.ts` (959 lines), validation schemas in `src/lib/validations/inventory.ts`, `src/lib/stock-loss.ts` (relevant sections), `src/app/api/returned-stitched/[id]/route.ts` (for PROD-001 fix verification), `src/app/api/production-orders/route.ts` + `[id]/route.ts`, `src/app/api/supplier-returns/route.ts`, `src/app/api/cycle-counts/[id]/route.ts`, `src/app/api/purchase-orders/route.ts` + `[id]/receive/route.ts`.
- **Prisma schema audit:** Read InventoryLocation, Supplier, InventoryPool, InventoryTransaction, AvgCostHistory, StockTransfer, ReturnedStitchedInventory, ProductionOrder, SupplierReturn models.
- **Frontend audit:** Read all 7 view components (inventory-dashboard, locations, location-detail, suppliers, supplier-detail, receive-stock, adjust-stock, transfer-stock). Focused on validation, responsive patterns, and hydration safety.
- **DB diagnostics:** 13 live SQL queries against Supabase (postgres.gobwxqkzfulbwhzbbsdj). Queries covered: B.1-B.7 + bonus checks on ReturnedStitchedInventory, StockLossRecord, InventoryTransaction types, AvgCostHistory coverage, StockTransfer txn pairs, ProductionOrder linkages.
- **Cross-reference:** Verified PROD-002 claim from PRODUCTS_AUDIT_FINAL.md against actual route code + live DB state.
- **Limitations:** Could not exercise the full order-confirm → MTO-fulfillment → production-complete → dispatch flow end-to-end (would need a complete test order with MTO variant + fabric stock). Relied on code inspection + DB state verification for E.4.

**No source code was modified. No data was modified. This is a read-only audit + report.**
