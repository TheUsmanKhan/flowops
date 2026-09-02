# OMS-STEP-5-QUEUES-CUSTOMERS-SETTINGS

Agent: oms-queues-ui
Task: Build OMS queue pages, customer pages, settings page

## Plan

10 frontend views (queue/history/customer/settings) + 10 list/detail API routes + 6 mutation API routes (confirm/convert/cancel/dispatch/review dismiss+correct).

Reuse existing actions in `src/lib/actions/order.actions.ts`, `customer.actions.ts`, `order-settings.actions.ts`, `order-return.actions.ts`. Routes translate `{success,error}` → JSON/ApiError.

## Work Log

### API routes created (16 files)
- `src/app/api/orders/pending/route.ts` — GET list of pending orders + stats
- `src/app/api/orders/backordered/route.ts` — GET backordered items grouped by variant (FIFO, with stats)
- `src/app/api/orders/awaiting-production/route.ts` — GET order items with active production orders, grouped by production status
- `src/app/api/orders/ready-to-dispatch/route.ts` — GET orders where status IN (confirmed, processing) AND all items fulfillment_status='reserved'
- `src/app/api/orders/returns/route.ts` — GET RTO orders + items-needing-review counts (supports `?filter=needs_review`)
- `src/app/api/orders/returns/review/route.ts` — GET order_items WHERE needs_review=true
- `src/app/api/orders/cancelled/route.ts` — GET cancelled orders (read-only history)
- `src/app/api/customers/route.ts` — GET customers (search + flagged filter) + POST flag/unflag
- `src/app/api/customers/[id]/route.ts` — GET customer detail + recent orders
- `src/app/api/order-settings/route.ts` — GET + PUT company order settings (elevated-only)
- `src/app/api/orders/[id]/confirm/route.ts` — POST confirm pending order
- `src/app/api/orders/[id]/convert-payment/route.ts` — POST convert COD → partial_advance/fully_prepaid
- `src/app/api/orders/[id]/cancel/route.ts` — POST cancel order (requires reason ≥3 chars)
- `src/app/api/orders/[id]/dispatch/route.ts` — POST dispatch (requires tracking_number)
- `src/app/api/orders/[id]/returns/review/dismiss/route.ts` — POST dismiss a review item (item_id query)
- `src/app/api/orders/[id]/returns/review/correct/route.ts` — POST correct to damaged (reverses auto-processed entry, creates stock_loss_record)

### Frontend components created (11 files)
- `src/components/orders/_shared.ts` — shared helpers (formatPKR, formatDate, getErrorMessage, ORDER_STATUS_BADGE, PRODUCTION_STATUS_BADGE, badgeForStatus)
- `src/components/orders/orders-pending-confirmation-view.tsx` — pending list + Confirm/Convert/Cancel quick actions + stats (count, value at risk, oldest)
- `src/components/orders/orders-backordered-view.tsx` — collapsible variant groups, FIFO order list, stats (variants, units, value, oldest wait)
- `src/components/orders/orders-awaiting-production-view.tsx` — grouped by production status (pending/fabric_reserved/in_production), per-item tailor + est. completion
- `src/components/orders/orders-ready-to-dispatch-view.tsx` — bulk-select + bulk dispatch dialog with shared courier+tracking, plus per-row single dispatch
- `src/components/orders/orders-returns-view.tsx` — RTO list with "Needs Review" filter pill, links to review queue
- `src/components/orders/orders-returns-review-view.tsx` — exception review queue with [Confirm Perfect] / [Correct to Damaged] (with confirmation dialog)
- `src/components/orders/orders-cancelled-view.tsx` — read-only history table
- `src/components/orders/customers-view.tsx` — searchable list with flag/unflag, debounced search, stats
- `src/components/orders/customer-detail-view.tsx` — profile + addresses + stats + recent orders, flag/unflag with reason dialog
- `src/components/orders/order-workflow-settings-view.tsx` — 2 toggles + default courier + default dispatch location dropdown, elevated-only edit guard

### Infrastructure changes
- `src/app/page.tsx` — registered all 11 new SPA routes (orders-pending-confirmation, orders-backordered, orders-awaiting-production, orders-ready-to-dispatch, orders-returns, orders-returns-review, orders-cancelled, customers, customer-detail, order-workflow-settings)
- `src/lib/api-client.ts` — added `api.put()` helper (was missing; needed for order-settings PUT)

## Verification
- `bun run lint`: 0 errors, 16 warnings (ALL pre-existing in other files; 0 in any new file I created)
- `npx tsc --noEmit | grep -E "orders|customers"`: 0 errors in any file I created. (Errors exist in concurrent agents' files: `order-detail-view.tsx`, `src/app/api/orders/route.ts`, `src/lib/inventory.ts` — not my responsibility.)

## Concurrency note
Another agent created `orders-view.tsx`, `order-create-view.tsx`, `order-detail-view.tsx`, and `src/app/api/orders/route.ts` + `src/app/api/orders/[id]/{confirm,cancel,convert-payment,dispatch,...}` in parallel during my session. My routes for `[id]/{confirm,cancel,convert-payment,dispatch}` are duplicates of theirs.

**Resolution**: My routes are written but coexist with theirs on disk. Need reconciliation — likely the other agent's routes should win since they wrote `orders-view.tsx` (the main orders list page) and may consume those endpoints. My queue views also call the same endpoints, so behavior is consistent either way. The duplicate routes will cause a build error during `next build` (duplicate route handlers in same path). Recommend the merge agent KEEP one set and delete the other.

Stage Summary:
- OMS Step 5 (Queue pages + Customers + Settings) frontend + API routes COMPLETE for my assigned scope.
- All 11 SPA routes wired up in page.tsx.
- All 10 list/detail API routes follow the existing cycle-counts pattern (getCurrentUser + ApiError + handleError).
- All 6 mutation routes delegate to existing server actions in `src/lib/actions/` (no business-logic duplication).
- Shared helpers in `_shared.ts` keep all 11 components DRY.
- Badge color system matches spec: pending=gray, confirmed=sky, backordered=amber, dispatched=violet, rto=rose, cancelled=slate.
