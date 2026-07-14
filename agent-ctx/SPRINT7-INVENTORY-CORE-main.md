# SPRINT7-INVENTORY-CORE — Work Record

**Agent:** main
**Task:** Build 8 inventory SPA view components + wire routes into page.tsx
**Date:** 2026-07-14

## Files Created

All in `/home/z/my-project/src/components/inventory/`:

1. `inventory-dashboard-view.tsx` (~620 lines)
2. `locations-view.tsx` (~640 lines)
3. `location-detail-view.tsx` (~570 lines)
4. `suppliers-view.tsx` (~600 lines)
5. `supplier-detail-view.tsx` (~620 lines)
6. `receive-stock-view.tsx` (~480 lines)
7. `adjust-stock-view.tsx` (~490 lines)
8. `transfer-stock-view.tsx` (~520 lines)

## File Modified

- `/home/z/my-project/src/app/page.tsx` — added 8 imports + 8 cases in `renderRoute` switch.

## API Contracts Used (all already implemented in /api/)

- `GET /api/inventory/dashboard` → `{ stats, movement, stockTable[], recentTransactions[] }`
- `GET /api/inventory-locations` → `{ locations[] }`
- `POST /api/inventory-locations` (create)
- `GET/PATCH/DELETE /api/inventory-locations/{id}`
- `GET /api/suppliers` → `{ suppliers[] }`
- `POST /api/suppliers` (create)
- `PATCH/DELETE /api/suppliers/{id}` (NO GET /[id] — detail view filters list)
- `POST /api/inventory/receive` (multi-item)
- `POST /api/inventory/adjust` (signed quantity)
- `POST /api/inventory/transfers` (logistics cost NOT merged into WAC)
- `GET /api/products?pageSize=100` (variants nested under products — flattened for search)
- `GET /api/purchase-orders` (filtered by supplier name for supplier-detail PO list)

## TanStack Query Keys

- `['inventory-dashboard']` — dashboard stats + stockTable; also used by locations-view (per-location aggregation) and adjust-stock-view + transfer-stock-view (live on_hand preview).
- `['locations']` — location list (also fetched by receive-stock-view + adjust-stock-view + transfer-stock-view).
- `['location-detail', locationId]` — single location's pools + recent txns.
- `['suppliers']` — supplier list (also used by supplier-detail-view for profile fetch).
- `['purchase-orders']` — supplier-detail-view PO list.
- `['products', 'for-{receive|adjust|transfer}']` — variant search pools (keyed per-view to avoid crosstalk).

## Permission Gates (useCan)

- `INVENTORY_VIEW` — sidebar gate (already wired).
- `INVENTORY_RECEIVE` — receive-stock-view Submit + dashboard Quick-link.
- `INVENTORY_ADJUST` — adjust-stock-view Submit + dashboard Quick-link.
- `INVENTORY_TRANSFER` — transfer-stock-view Submit + dashboard Quick-link.
- `INVENTORY_MANAGE_LOCATIONS` — Add/Edit/Set Default/Deactivate buttons in locations-view.
- `INVENTORY_MANAGE_SUPPLIERS` — Add/Edit/Deactivate buttons in suppliers-view + Edit button in supplier-detail-view.
- `INVENTORY_MANAGE_PURCHASE_ORDERS` — dashboard Quick-link.

## Mutations + Cache Invalidation

- Receive: invalidates `['inventory-dashboard']` + `['locations']`.
- Adjust: invalidates `['inventory-dashboard']` + `['location-detail']` (prefix).
- Transfer: invalidates `['inventory-dashboard']` + `['location-detail']` + `['locations']`.
- Location create/edit/setDefault/deactivate: invalidates `['locations']` + `['inventory-dashboard']`.
- Supplier create/edit/deactivate: invalidates `['suppliers']`.
- Supplier edit (from detail): invalidates `['suppliers']`.

All mutations → Sonner toast.success on success, toast.error(getErrorMessage(err)) on error. getErrorMessage handles FetchError + generic Error.

## Patterns Used

- React Hook Form + Zod (zodResolver) for all 4 dialog forms (location create/edit, supplier create, supplier edit). Pattern matches existing catalog-settings-view.tsx.
- `useEffect` to call RHF `reset()` when dialog opens (initially used `useMemo` — flagged by React-Compiler lint rule `react-hooks/imcompatible-library` → infinite loop warning. Fixed by switching to `useEffect`).
- `useEffect` to auto-select default location on first load (receive/adjust/transfer views).
- `useMemo` for derived state (filtered lists, totals, variant search results).
- Custom `formatPKR` using `Intl.NumberFormat('en-PK')`.
- Tonally-coded Badge variants: emerald=healthy/inbound, amber=low/credit/intermediate, rose=out/loss/danger, sky=info, gray=dead stock/inactive.
- Mobile-first responsive grids (`sm:grid-cols-2 lg:grid-cols-3/4`).
- Scrollable long lists with `max-h-96 overflow-y-auto scrollbar-thin`.
- Empty-state CTAs that route to creation views.
- No-locations banners in receive/adjust/transfer with "Create a location" link.

## Verification

- `bun run lint`: **0 errors** in all 8 inventory files + page.tsx. 14 warnings total — all pre-existing React Hook Form `watch()` advisories (documented pattern used elsewhere) or pre-existing unused eslint-disable directives in unrelated files.
- `bunx tsc --noEmit`: **0 errors** in all 8 inventory files + page.tsx.
- Dev server (started manually for compile test): HTTP 200 on `/` in 13s initial compile (Turbopack), then 80ms subsequent. No compile errors.

## Issues Encountered & Fixed

1. **`Skuhl` icon** — initial import referenced a non-existent Lucide icon. Replaced with `Archive` for the "Dead stock value" stat card.
2. **Zod `.default()` on booleans** — caused TS resolver mismatch in locations-view (LocationFormValues input vs output types diverged). Removed `.default()` from `isDefault`/`isOrgLevel` — now required booleans with explicit `DEFAULT_FORM_VALUES`.
3. **`useMemo` with `setState`** — React-Compiler flagged this as an infinite-loop risk in receive-stock-view + adjust-stock-view (auto-select default location) and in 3 RHF form dialogs (`reset()` call). All converted to `useEffect`.
4. **`isDefault` not in local type** — adjust-stock-view's local `InventoryLocation` interface was missing `isDefault`; added it (the API does return it).
5. **Unused eslint-disable directives** — removed the 3 leftover `// eslint-disable-next-line react-hooks/exhaustive-deps` after switching to `useEffect`.

## Routes Already Declared (no app-store work needed)

All 8 SPA routes were already declared in `src/stores/app-store.ts` (AppRoute union) and wired into `src/components/layout/sidebar.tsx` + `mobile-nav.tsx`. Only `page.tsx` switch + imports needed.
