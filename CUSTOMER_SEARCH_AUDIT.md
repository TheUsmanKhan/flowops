# Customer Search Latency Audit

**Date**: 2026-09-04
**Component**: Customer live-search in Order Create form
**Symptom**: Each search takes 2.7s–7.9s (target: <500ms)

## Executive Summary

The customer search is slow due to **three compounding factors**:
1. **Supabase network latency** (cold: ~1.1s, warm: ~140ms per query)
2. **`normalizePhone()` makes a SQL round-trip** to call a Postgres function (`normalize_phone`) — adds 150ms–1100ms per search
3. **N+1 query pattern**: the `detailed=1` API path fires up to **3 sequential DB queries** + the `listCustomers` path fires **2 sequential** + **2 parallel** queries

No single query is "slow" — the delay is the **sum of multiple sequential round-trips** to a remote Supabase database (aws-ap-south-1, ~140ms RTT per query).

---

## Measured Latencies (hard numbers)

### DB Round-Trip Latency (Supabase pooler, aws-ap-south-1)
| Query | Time |
|-------|------|
| Cold `SELECT 1` (new connection) | **1181ms** |
| Warm `SELECT 1` (pooled) | **141ms** |
| `normalize_phone()` SQL function (cold) | **1137ms** |
| `normalize_phone()` SQL function (warm) | **137ms** |

### Prisma Query Latencies (warm connection)
| Query | Time | Index Used? |
|-------|------|-------------|
| `customerPhone.findFirst` (exact `phoneNormalized` match) | 290ms | ✅ `@@index([organizationId, phoneNormalized])` |
| `customerPhone.findMany` (LIKE `%0300%`) | 283ms | ⚠️ `contains` = sequential scan (no index on `LIKE`) |
| `customer.findFirst` + include phones+addresses | 857ms | ✅ but heavy `include` |
| `listCustomers` parallel (count + findMany) | 1110ms | ✅ parallel but each ~1s |

### Full HTTP API Latency (end-to-end via curl, warm)
| Search Input | Path Taken | Latency |
|--------------|-----------|---------|
| `03001234567` (phone) | `searchCustomerByPhone` | 4.68s, 2.75s, 3.60s |
| `test` (name) | `listCustomers` + full fetch | 3.78s, 3.05s, 2.74s |

---

## The Full Call Chain (where time goes)

### Path A: Phone search (`search=03001234567`)

```
Frontend (CustomerSearchAutocomplete.tsx)
  └─ 300ms debounce
  └─ GET /api/customers?detailed=1&search=03001234567
       └─ getWorkspace()                          ~140ms (session lookup × 2-3 queries)
       └─ searchCustomerByPhone(phone)
            └─ normalizePhone(phone)              ~150ms–1100ms  ← SQL: SELECT normalize_phone(...)
            └─ db.customerPhone.findFirst(...)      ~290ms  ← indexed (OK)
            └─ db.customer.findFirst(...)           ~857ms  ← heavy include (phones + addresses)
       └─ Response.json()
  Total: ~1.4s–2.4s (server-side) + 140ms network = 2.7s–4.7s
```

### Path B: Name search (`search=test`)

```
Frontend (CustomerSearchAutocomplete.tsx)
  └─ 300ms debounce
  └─ GET /api/customers?detailed=1&search=test
       └─ getWorkspace()                           ~140ms
       └─ searchCustomerByPhone(search)            ← FIRES FIRST, FAILS (not a phone)
            └─ normalizePhone("test")              ~150ms  ← wasted SQL call (returns null)
            └─ returns { found: false }             ~140ms  ← +1 query wasted
       └─ listCustomers({ search: "test", limit: 1 })
            └─ normalizePhone("test") AGAIN         ~150ms  ← DUPLICATE SQL call (already tried above)
            └─ db.customerPhone.findMany(contains)  ~283ms  ← LIKE scan (no index)
            └─ Promise.all([
                 db.customer.findMany(...)         ~560ms  ← with include phones+addresses
                 db.customer.count(...)            ~280ms
               ])
       └─ db.customer.findFirst(full record)        ~857ms  ← SECOND full fetch (redundant!)
       └─ Response.json()
  Total: ~2.5s–3.8s (server-side) + 140ms network = 2.7s–4.0s
```

---

## Root Causes (Ranked by Impact)

### 🔴 #1: `normalizePhone()` SQL round-trip (highest impact)

**File**: `src/lib/actions/customer.actions.ts:150-155`
```typescript
async function normalizePhone(raw: string): Promise<string | null> {
  const rows = await db.$queryRaw<{ normalized: string | null }[]>`
    SELECT normalize_phone(${raw}::TEXT) AS normalized
  `
  return rows[0]?.normalized ?? null
}
```

**Problem**: Every search calls a Postgres function over the network. This adds **150ms (warm) to 1100ms (cold)** per call.

**Worse**: In the **name search path**, `normalizePhone()` is called **TWICE**:
1. Once in `searchCustomerByPhone()` (line 250) — returns `null` (not a phone)
2. Again in `listCustomers()` (line 1537) — returns `null` again (same input, same result)

**Impact**: ~300ms wasted on duplicate SQL calls that always return null for name searches.

---

### 🔴 #2: Redundant full customer fetch in name path

**File**: `src/app/api/customers/route.ts:57-73`

When `listCustomers` finds a match, the route does a **second** `db.customer.findFirst` with full includes — even though `listCustomers` already fetched the customer with phones+addresses (limited to `isPrimary`/`isDefault` only).

```typescript
const listResult = await listCustomers({ search, limit: 1 })  // ← fetches customer (partial include)
if (listResult.success && listResult.data?.customers.length > 0) {
  const match = listResult.data.customers[0]
  const full = await db.customer.findFirst({                    // ← RE-FETCHES same customer (full include)
    where: { id: match.id },
    include: { phones: ..., addresses: ... },
  })
}
```

**Impact**: ~857ms wasted (the second fetch is unnecessary if `listCustomers` included all phones/addresses).

---

### 🟡 #3: `contains` (LIKE) search is unindexed

**File**: `src/lib/actions/customer.actions.ts:1541`

```typescript
{ phoneRaw: { contains: q, mode: 'insensitive' } }
```

Postgres `LIKE '%query%'` cannot use a B-tree index — it scans every row in `customer_phones` for the org. With 10k+ phones, this becomes slow.

**Current impact**: ~283ms (small dataset now, but will degrade as customers grow).

---

### 🟡 #4: `getWorkspace()` overhead

Every API call resolves the session → user → active company → employee + role. This is typically 2–3 DB queries (~140ms total). Not individually slow, but adds to the total.

---

### 🟢 #5: Frontend debounce (300ms) — NOT a problem

The 300ms debounce is standard and appropriate. The delay is server-side, not client-side.

---

## Cost Breakdown (worst case: name search)

| Step | Time | Wasteful? |
|------|------|-----------|
| 300ms debounce | 300ms | No (standard) |
| `getWorkspace()` | ~140ms | No (required) |
| `normalizePhone("test")` in `searchCustomerByPhone` | ~150ms | **Yes** (returns null, input isn't a phone) |
| `searchCustomerByPhone` returns early | ~0ms | — |
| `normalizePhone("test")` in `listCustomers` | ~150ms | **Yes** (duplicate of above) |
| `customerPhone.findMany` (LIKE scan) | ~283ms | No (required for search) |
| `customer.findMany` (parallel) | ~560ms | No |
| `customer.count` (parallel) | ~280ms | No |
| `customer.findFirst` (redundant full fetch) | ~857ms | **Yes** (already have the data) |
| Network round-trip | ~140ms | No |
| **Total** | **~2.8s** | **~1.15s wasted** (~40%) |

---

## Recommended Fixes (NOT implemented — for discussion)

1. **Replace `normalizePhone()` SQL call with a pure-JS implementation** using `libphonenumber-js` (already a dependency). Eliminates ~150–1100ms per search.

2. **Deduplicate `normalizePhone` calls**: call once, pass the result. Or skip entirely when input isn't phone-like (regex check first).

3. **Merge the redundant full fetch**: have `listCustomers` return the full record (all phones + addresses) when `limit=1`, eliminating the second `findFirst`.

4. **Add a trigram index** (`pg_trgm` + GIN index) on `customer_phones.phoneRaw` and `customer.name` for fast `LIKE` searches. Or switch to full-text search (`tsvector`).

5. **Consider a materialized view** or cache for frequently-searched customers (returning customers).

---

## Verification Method

All measurements taken with:
- `bun -e` scripts timing `db.$queryRaw` and Prisma operations directly
- `curl -b cookies.txt` timing full HTTP round-trips (includes session + network)
- Supabase pooler (aws-ap-south-1, ~140ms RTT from sandbox)

The dev.log confirms: `GET /api/customers?detailed=1&search=... 200 in 2.1s–7.9s (render: 2.1s–6.6s)` — all server-side time, not compile time.
