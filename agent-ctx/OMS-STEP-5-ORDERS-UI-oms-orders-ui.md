# OMS-STEP-5-ORDERS-UI

Agent: oms-orders-ui
Task: Build OMS order list, create wizard, and detail page

## Plan

3 frontend views (orders list / create wizard / detail) + 11 API routes wrapping the existing order.actions.ts and order-return.actions.ts server actions.

## Work Log

Files created:

API routes (wrap server actions):
- src/app/api/orders/route.ts — GET (listOrders) + POST (createManualOrder)
- src/app/api/orders/[id]/route.ts — GET (full order detail incl. dispatchLocation + productionOrder + advance + return + timeline fields)
- src/app/api/orders/[id]/confirm/route.ts — POST (confirmOrder)
- src/app/api/orders/[id]/dispatch/route.ts — POST (dispatchOrderAction with tracking_number + courier_name)
- src/app/api/orders/[id]/cancel/route.ts — POST (cancelOrder with cancellation_reason)
- src/app/api/orders/[id]/delivered/route.ts — POST (markOrderDelivered)
- src/app/api/orders/[id]/rto/route.ts — POST (processOrderReturn with return_reason)
- src/app/api/orders/[id]/convert-payment/route.ts — POST (convertPaymentStatus)
- src/app/api/orders/[id]/cod-collected/route.ts — POST (markCodCollected)
- src/app/api/orders/[id]/processing/route.ts — POST (markOrderProcessing)
- src/app/api/orders/[id]/packed/route.ts — POST (markOrderPacked)
- src/app/api/customers/route.ts — GET (listCustomers — for phone/name/email search in wizard)

Frontend views (src/components/orders/):
- orders-view.tsx — list page with 4 stat cards (Total / Pending / Backordered / Today's Revenue), filter bar (status × 9, payment_type × 4, source × 5, search), color-coded status + payment + source badges, loading skeleton, empty state with CTA, error state with retry, ORDERS_VIEW permission gate, [+ Create Order] button gated on ORDERS_CREATE, row click → navigate({name:'order-detail', id}). TanStack Query ['orders', filters] with staleTime 15s.
- order-create-view.tsx — 5-step wizard (Customer → Items → Payment → Delivery → Review) with stepper UI. Step 1 phone-search via /api/customers (debounced via query key) OR add-new-customer form. Step 2 product/variant search reusing receive-stock-view pattern with stock status badge + editable unit_price + running subtotal. Step 3 RadioGroup full_cod / partial_advance / fully_prepaid with conditional advance fields. Step 4 delivery address (auto-prefilled from new customer) + dispatch location dropdown (fetched from /api/inventory-locations) + discount amount + reason. Step 5 full summary → POST /api/orders → toast + navigate({name:'order-detail', id}). All hooks called before permission-gate early return (rules-of-hooks compliant).
- order-detail-view.tsx — header (order # + external ref + status/payment/source badges), customer info section with flagged warning, items table (variant title + SKU + attribute values + quantity + unit price + line total + fulfillment_status badge + MTO/returned-stitched-used/production-order/needs-review indicators), payment breakdown (subtotal + discount + courier + total + advance details + remaining COD + COD collected), delivery info, status timeline (pending → confirmed → processing → packed → dispatched → delivered/rto/cancelled with timestamps), activity log (fetched from /api/audit-logs?entityType=order&entity_id=…), context-sensitive action buttons (Confirm/Process/Pack/Dispatch/Deliver/RTO/Cancel/Convert Payment/COD Collected) with 5 dialog forms (DispatchDialog/CancelDialog/RtoDialog/ConvertPaymentDialog/CodCollectedDialog). TanStack Query ['order', orderId] staleTime 10s + ['order', orderId, 'activity']. All 9 useMutation hooks declared BEFORE loading/error early returns (rules-of-hooks compliant).

Router wiring (src/app/page.tsx):
- Added imports + switch cases for 'orders' / 'order-create' / 'order-detail' (preserving the 'orders-pending-confirmation'/'orders-backordered'/etc cases that another agent had already added).

Audit log enhancement:
- src/app/api/audit-logs/route.ts — added optional entity_id / entityId query-param filter (purely additive, backward-compatible).

## Verification

- bun run lint: 0 errors, 15 pre-existing warnings (none in any new file).
- npx tsc --noEmit | grep orders: 0 errors in any orders file. (Pre-existing errors in unrelated purchase-orders/[id]/receive/route.ts remain.)

## Stage Summary

OMS order list / create / detail UI COMPLETE. All 3 views wire to the existing OMS Step 2-4 server actions via 11 new API routes that follow the project pattern (runtime='nodejs', dynamic='force-dynamic', getCurrentUser + ApiError + handleError + readBody, wrap ActionResult → JSON). Permission gating via useCan() hook. TanStack Query v5 for server state, Sonner for toasts, shadcn/ui for all components, status badges color-coded per the spec (pending=gray, confirmed=sky, partially_backordered=amber, processing=blue, dispatched=violet, delivered=emerald, rto=rose, cancelled=slate, refunded=purple). PKR + en-PK date formatting consistent with the rest of the app.
