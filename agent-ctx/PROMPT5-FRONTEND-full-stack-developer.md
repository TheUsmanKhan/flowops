# PROMPT5-FRONTEND

Agent: full-stack-developer
Task: Build 3 frontend components for Prompt 5 of the PostEx integration (BookingWorkbenchView, SendExchangeShipmentModal, ShipmentTrackingCard)

## Plan

3 new React components in `src/components/orders/` only — no `/lib` modifications, no edits to existing exchange-detail-view.tsx or exchanges-view.tsx (parent agent handles those integrations).

## Work Log

### Context review
- Read `/home/z/my-project/worklog.md` — especially the POSTEX-REAL-ADAPTER and EXCHANGE-SHIPMENTS-SYSTEM entries which establish the data shapes and lifecycle.
- Confirmed the ExchangeShipment shape returned by `getExchangeDetail()` (in `exchange.actions.ts` line ~1116): `{ id, exchangeShipmentNumber, status, quantity, invoiceAmount, trackingNumber, dispatchedAt, deliveredAt, createdAt }` — matches the `ShipmentTrackingCard` prop type exactly.
- Inspected existing patterns: `_shared.ts` (formatPKR, formatDate, formatDateTime, getErrorMessage), `verify-old-item-dialog.tsx` (Dialog + useMutation pattern), `exchange-detail-view.tsx` (SettleDialog / NotReturnedDialog patterns), `customer-detail-view.tsx` (addCustomerAddress/Phone patterns), `orders-view.tsx` (Table + Checkbox list pattern).
- Confirmed API contracts:
  - `GET /api/orders?statuses=confirmed,processing&limit=100` returns `{ orders: OrderRow[], total }` with `courierCompanyIntegrationId` included on each row (line 1506 of order.actions.ts) — enables client-side filter for unbooked orders.
  - `GET /api/integrations?category=courier` returns `{ providers, integrations }` where each integration has `id` (companyIntegrationId) + `provider.providerKey` (used as `CityAutocomplete` providerKey).
  - `POST /api/booking-workbench/book` (already exists) accepts `{ orderId, companyIntegrationId, customerName?, customerPhone?, deliveryAddress?, deliveryCity?, codAmount?, orderType? }` and returns `{ success, trackingNumber, orderType, providerStatus }` on success or `{ error }` on failure.
  - `POST /api/exchanges/[id]/dispatch-new-item` and `POST /api/exchanges/[id]/dispatch-replacement` exist but currently don't read body — parent agent will enhance to consume the form fields sent by SendExchangeShipmentModal.
  - `GET /api/customers/[id]` returns full customer record including `phones[]` and `addresses[]`.
  - `POST /api/customers/[id]/addresses` accepts `{ label?, address, city, is_default }` → returns `{ addressId }`.
  - `POST /api/customers/[id]/phones` accepts `{ phone, label?, is_primary }` → returns `{ phoneId }`.
- Confirmed `CityAutocomplete` (`src/components/couriers/city-autocomplete.tsx`) is already wired up and exports a controlled component with `providerKey`, `value`, `onChange`, `disabled`, `placeholder` props.

### Files created

1. **`src/components/orders/shipment-tracking-card.tsx`** (~190 lines)
   - Compact card showing an ExchangeShipment row.
   - 6-state status badge map (pending/confirmed/backordered/dispatched/delivered/cancelled) with color-coded Tailwind classes (gray/sky/amber/violet/emerald/slate — no indigo/blue).
   - EXCH-##### shipment number in mono font.
   - Tracking number with copy-to-clipboard affordance (uses `navigator.clipboard.writeText` + Sonner toast).
   - Dispatched / Delivered / Created timestamps formatted via `_shared.formatDateTime`.
   - Invoice amount formatted via `_shared.formatPKR`.
   - Amber "Queued — will be fulfilled when stock arrives" callout when `status === 'backordered'`.
   - Cancelled state dims the card with `opacity-70`.
   - Read-only — no mutations.

2. **`src/components/orders/send-exchange-shipment-modal.tsx`** (~480 lines)
   - Reusable Dialog component.
   - 6 sequential form fields:
     1. Courier integration dropdown (from `GET /api/integrations?category=courier`) — must be selected first; changing it resets delivery city.
     2. Delivery city via `<CityAutocomplete providerKey={selectedCourierProviderKey}>` — disabled until courier is picked.
     3. Shipping address Select dropdown of customer's existing addresses + "Add New" sentinel option. Add New expands an inline sub-form (label, address, city, is_default) that POSTs to `/api/customers/{id}/addresses`, refetches customer, and auto-selects the new addressId.
     4. Shipping phone Select with same pattern + inline Add New (phone, label, is_primary) → POSTs to `/api/customers/{id}/phones`.
     5. Invoice/COD amount Input (number, defaults to `defaultInvoiceAmount`).
     6. Quantity Input (number, defaults to `defaultQuantity`).
   - On submit: POSTs to `dispatch-new-item` (when `isExchangeReplacement === true`) or `dispatch-replacement` (when false) with body `{ companyIntegrationId, deliveryCity, shippingAddressId, shippingPhoneId, invoiceAmount, quantity, variantId }`.
   - On success: toast.success + invalidate `['exchanges']`, `['exchange', exchangeId]`, `['inventory-pools']` + call `onSuccess()` + close dialog.
   - On failure: toast.error with `getErrorMessage(err)` — keeps dialog open so the user can fix inputs.
   - Reset effect on modal close clears all state.
   - Method badge in header shows courier_replacement vs customer_self_return label.

3. **`src/components/orders/booking-workbench-view.tsx`** (~570 lines)
   - Bulk booking workbench for unbooked external-platform orders.
   - Fetches `GET /api/orders?statuses=confirmed,processing&limit=100` via TanStack Query (`['orders', 'booking-workbench']`, staleTime 15s).
   - Client-side filters to orders where `courierCompanyIntegrationId === null` (the API doesn't yet expose this as a query param — adding it would require a `/lib` change, out of scope).
   - Optional client-side search filter (order # / customer / phone / external ref).
   - Per-row editable state in a `Record<string, RowState>` keyed by orderId, lazily seeded from the order's data on first access (customerName, customerPhone, deliveryCity pre-filled; deliveryAddress blank since the list endpoint doesn't return it; codAmount defaults to `remainingCodAmount ?? totalOrderValue`; orderType defaults to 'Normal').
   - Each row: checkbox + order # / source badge / item count / date + editable Inputs for customer name / phone / address / COD amount + `<CityAutocomplete providerKey={selectedProviderKey || 'postex'}>` + Select for order type (Normal / Overland / Replacement with descriptions) + per-row status/result cell.
   - Batch toolbar: courier integration dropdown (drives per-row CityAutocomplete providerKey) + search Input + "Upload Booking (N)" button showing the current selected count.
   - "Select All" / "Select None" via header checkbox.
   - On Upload Booking: sequentially (not parallel — to play nice with the external courier API) calls `POST /api/booking-workbench/book` for each checked row, with the row's editable overrides as the body. Per-row try/catch — one failure does NOT block others.
   - Per-row result state: `null` (pending) | `{ ok: true, trackingNumber, orderType }` (✅ green row + tracking# + type badge) | `{ ok: false, error }` (❌ red row + error text).
   - Successfully booked rows: checkbox auto-unchecks + inputs disabled (so user can't re-book) + row tinted emerald.
   - Failed rows: row tinted rose + error message shown (truncated to 3 lines, full text on hover via `title`).
   - Final toast: success/warning/error summarising counts.
   - Invalidates `['orders', 'booking-workbench']` and `['orders']` after any successful booking so booked rows disappear on next render.
   - Helper text shown when no courier integrations are connected (links to Settings → Integrations conceptually).
   - Empty state when all orders are booked ("All caught up!") vs when search returns no matches.

### Verification
- `bun run lint`: ✅ 0 errors, 10 pre-existing warnings (all React Hook Form `watch()` notes in unrelated files — `catalog-settings-view.tsx`, `product-create-view.tsx`, `returned-stitched-view.tsx`). Zero warnings in any new file.
- `bunx tsc --noEmit`: ✅ 0 errors in `src/`. Only 4 pre-existing errors in `examples/websocket/*` (missing socket.io-client types) and `skills/*` (unrelated z-ai-web-dev-sdk typing issues).
- Dev server: ✅ still running cleanly (GET / 200 in 28s — Turbopack compile time only).

### Constraints respected
- ✅ Only created files in `src/components/orders/` — no `/lib` modifications.
- ✅ Did NOT modify `exchange-detail-view.tsx` or `exchanges-view.tsx` (parent agent handles integration).
- ✅ `'use client'` directive at the top of each file.
- ✅ Used existing shadcn/ui components from `@/components/ui/` (Card, Badge, Button, Input, Label, Checkbox, Select, Table, Dialog).
- ✅ Used `import { api, FetchError } from '@/lib/api-client'` for API calls.
- ✅ Used `import { toast } from 'sonner'` for notifications.
- ✅ Used `import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'`.
- ✅ All timestamps formatted via `_shared.formatDateTime` / `formatDate`.
- ✅ Imported `CityAutocomplete` from `@/components/couriers/city-autocomplete`.
- ✅ Status badges use `Badge` with color classes (no indigo/blue).
- ✅ Mobile-first responsive (table scrolls horizontally on small screens, modal uses `max-h-[90vh] overflow-y-auto`).
- ✅ Used `getErrorMessage` from `_shared` for error extraction.

### Notes for parent agent
- The dispatch endpoints (`dispatch-new-item` / `dispatch-replacement`) currently don't read the request body. The SendExchangeShipmentModal sends `{ companyIntegrationId, deliveryCity, shippingAddressId, shippingPhoneId, invoiceAmount, quantity, variantId }` — these will need to be read + passed to `dispatchExchangeNewItem()` / `dispatchReplacementForSelfReturnExchange()` (or a new server action) to actually create the ExchangeShipment with the chosen courier. The parent agent's job is to enhance those endpoints to consume this body.
- The BookingWorkbenchView wires into the existing `case 'booking-workbench'` route in `src/app/page.tsx` (already present). The sidebar nav entry may need to be added by the parent agent.
- The ShipmentTrackingCard is designed to be embedded inside ExchangeDetailView — for each shipment in `exchange.exchangeShipments[]`, render `<ShipmentTrackingCard shipment={shipment} />`. The parent agent will add this rendering loop.

## Stage Summary

3 production-ready React components delivered for Prompt 5 of the PostEx integration:
- ShipmentTrackingCard: read-only compact card for exchange shipment tracking (6-state badge, tracking # with copy, timestamps, backorder callout).
- SendExchangeShipmentModal: 6-field sequential dispatch dialog with inline Add New address/phone sub-forms and per-mode endpoint routing.
- BookingWorkbenchView: bulk booking workbench with editable per-row overrides, CityAutocomplete tied to the selected courier's providerKey, batch select-all, and independent per-row booking with ✅/❌ result tracking.

All 3 files: 0 lint errors, 0 type errors, fully typed, mobile-responsive, accessible, using existing shadcn/ui components only.
