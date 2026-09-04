# FlowOps — Frontend Guide

> **Comprehensive reference for the FlowOps frontend architecture.**
>
> **Audience**: developers onboarding to FlowOps, AI assistants generating frontend code, and engineers debugging UI behavior.
>
> **Companion documents**:
> - `INTERNAL_API_GUIDE.md` — every API route
> - `DATABASE_GUIDE.md` — full Prisma schema + migration history
> - `FLOWOPS_BRIEFING.md` — high-level architecture
>
> **Last updated**: September 2026 (DOCS-API-DB-FRONTEND task)

---

## 1. Technology stack

| Layer | Technology | Version |
|---|---|---|
| Framework | Next.js (App Router) | ^16.1.1 |
| UI library | React | ^19.0.0 |
| State management | Zustand | ^5.0.6 |
| Server-state / data fetching | TanStack Query (React Query) | ^5.82.0 |
| Forms | React Hook Form | ^7 |
| Form schemas | Zod | ^4 |
| RHF resolver | @hookform/resolvers | ^5 |
| UI components | shadcn/ui (52 components) | (latest) |
| Styling | Tailwind CSS v4 (oklch palette) | ^4 |
| Theming | next-themes | (latest) |
| Icons | lucide-react | (latest) |
| Toasts | sonner | (latest) |
| Phone parsing | libphonenumber-js | ^1.13.11 |
| Language | TypeScript | ^5 |

## 2. Routing system — query-string navigation

FlowOps uses a **single-page shell** architecture. The entire authenticated app lives on the `/` route. Navigation between "pages" is handled entirely client-side via Zustand state — no Next.js App Router segments, no `next/navigation` programmatic routing.

### The `AppRoute` discriminated union

Defined in `src/stores/app-store.ts`:

```ts
export type AppRoute =
  | { name: 'login' }
  | { name: 'register' }
  | { name: 'forgot' }
  | { name: 'reset'; token?: string }
  | { name: 'onboarding' }
  | { name: 'accept-invite'; token?: string }
  | { name: 'dashboard' }
  | { name: 'employees' }
  | { name: 'employees-invite' }
  | { name: 'employee-detail'; id: string }
  | { name: 'roles' }
  | { name: 'role-edit'; id: string }
  | { name: 'organization' }
  | { name: 'company-settings' }
  | { name: 'settings' }
  | { name: 'integrations' }
  | { name: 'integration-logs' }
  | { name: 'audit' }
  | { name: 'payroll' }
  | { name: 'payroll-run-detail'; id: string }
  | { name: 'create-organization' }
  | { name: 'create-company'; orgId?: string }
  | { name: 'products' }
  | { name: 'product-create'; draftId?: string }
  | { name: 'product-drafts' }
  | { name: 'product-detail'; id: string }
  | { name: 'product-settings' }
  | { name: 'returned-stitched' }
  | { name: 'org-catalog' }
  | { name: 'inventory' }
  | { name: 'inventory-locations' }
  | { name: 'inventory-location-detail'; id: string }
  | { name: 'inventory-suppliers' }
  | { name: 'inventory-supplier-detail'; id: string }
  | { name: 'inventory-receive' }
  | { name: 'inventory-adjust' }
  | { name: 'inventory-transfer' }
  | { name: 'inventory-purchase-orders' }
  | { name: 'inventory-po-create' }
  | { name: 'inventory-po-detail'; id: string }
  | { name: 'inventory-supplier-returns' }
  | { name: 'inventory-losses' }
  | { name: 'inventory-loss-detail'; id: string }
  | { name: 'inventory-production-orders' }
  | { name: 'inventory-cycle-counts' }
  | { name: 'orders' }
  | { name: 'order-create'; draftId?: string }
  | { name: 'order-drafts' }
  | { name: 'order-detail'; id: string }
  | { name: 'orders-pending-confirmation' }
  | { name: 'orders-backordered' }
  | { name: 'orders-awaiting-production' }
  | { name: 'orders-ready-to-dispatch' }
  | { name: 'orders-returns' }
  | { name: 'orders-returns-review' }
  | { name: 'orders-cancelled' }
  | { name: 'exchanges' }
  | { name: 'exchange-detail'; id: string }
  | { name: 'customers' }
  | { name: 'customer-detail'; id: string }
  | { name: 'order-workflow-settings' }
  | { name: 'booking-workbench' }
  | { name: 'order-scan' }
```

### URL format

The Zustand route state is serialized into a URL query string via `src/lib/routing/url-sync.ts`:

```
/?view=<route_name>&id=<optional_id>&token=<optional_token>&orgId=<optional_orgId>&draftId=<optional_draftId>
```

Examples:
- `/?view=dashboard` → `{ name: 'dashboard' }`
- `/?view=orders` → `{ name: 'orders' }`
- `/?view=order-detail&id=abc123` → `{ name: 'order-detail', id: 'abc123' }`
- `/?view=reset&token=xyz` → `{ name: 'reset', token: 'xyz' }`
- `/?view=create-company&orgId=org123` → `{ name: 'create-company', orgId: 'org123' }`
- `/` (no query) → `{ name: 'login' }` (default when no query string)

This strategy (called **Strategy B: Query-String Navigation** in the codebase) means:
- The browser's back/forward buttons work natively (popstate listener in `src/app/page.tsx`).
- Bookmarks restore the correct view on hard refresh.
- No Next.js dynamic route segments (`[id]/page.tsx`) are needed — everything is one route.

### The case statement in `src/app/page.tsx`

`renderRoute(route, employee)` is a switch that maps each `AppRoute.name` to the corresponding lazy-loaded component:

```tsx
function renderRoute(route, employee) {
  switch (route.name) {
    case 'dashboard': return <DashboardHome />
    case 'employees': return <EmployeesView />
    case 'employees-invite': return <InviteEmployeeView />
    case 'employee-detail': return <EmployeeDetailView employeeId={route.id} />
    case 'roles': return <RolesView />
    case 'role-edit': return <RoleEditView roleId={route.id} />
    case 'organization': return <OrganizationView />
    case 'company-settings': return <CompanySettingsView />
    case 'settings': return <SettingsView />
    case 'audit': return <AuditLogView />
    case 'payroll': return <PayrollView />
    case 'payroll-run-detail': return <PayrollRunDetailView runId={route.id} />
    case 'create-organization': return <CreateOrganizationViewWithBack />
    case 'create-company': return <CreateCompanyViewWithBack orgId={route.orgId} />
    case 'products': return <ProductsView />
    case 'product-create': return <ProductCreateViewWithBack draftId={route.draftId} />
    case 'product-drafts': return <DraftsView />
    case 'product-detail': return <ProductDetailView productId={route.id} />
    case 'product-settings': return <CatalogSettingsView />
    case 'returned-stitched': return <ReturnedStitchedView />
    case 'org-catalog': return <OrgCatalogView />
    case 'inventory': return <InventoryDashboardView />
    case 'inventory-locations': return <LocationsView />
    case 'inventory-location-detail': return <LocationDetailView locationId={route.id} />
    case 'inventory-suppliers': return <SuppliersView />
    case 'inventory-supplier-detail': return <SupplierDetailView supplierId={route.id} />
    case 'inventory-receive': return <ReceiveStockView />
    case 'inventory-adjust': return <AdjustStockView />
    case 'inventory-transfer': return <TransferStockView />
    case 'inventory-purchase-orders': return <PurchaseOrdersView />
    case 'inventory-po-create': return <PoCreateView />
    case 'inventory-po-detail': return <PoDetailView poId={route.id} />
    case 'inventory-supplier-returns': return <SupplierReturnsView />
    case 'inventory-production-orders': return <ProductionOrdersView />
    case 'inventory-losses': return <LossesView />
    case 'inventory-loss-detail': return <LossDetailView lossId={route.id} />
    case 'inventory-cycle-counts': return <CycleCountsView />
    case 'orders': return <OrdersView />
    case 'order-create': return <OrderCreateViewWithBack draftId={route.draftId} />
    case 'order-drafts': return <DraftsView />
    case 'order-detail': return <OrderDetailView orderId={route.id} />
    case 'orders-pending-confirmation': return <OrdersPendingConfirmationView />
    case 'orders-backordered': return <OrdersBackorderedView />
    case 'orders-awaiting-production': return <OrdersAwaitingProductionView />
    case 'orders-ready-to-dispatch': return <OrdersReadyToDispatchView />
    case 'orders-returns': return <OrdersReturnsView />
    case 'orders-returns-review': return <OrdersReturnsReviewView />
    case 'orders-cancelled': return <OrdersCancelledView />
    case 'exchanges': return <ExchangesView />
    case 'exchange-detail': return <ExchangeDetailView exchangeId={route.id} />
    case 'customers': return <CustomersView />
    case 'customer-detail': return <CustomerDetailView customerId={route.id} />
    case 'order-workflow-settings': return <OrderWorkflowSettingsView />
    case 'booking-workbench': return <BookingWorkbenchView />
    case 'order-scan': return <OrderScanView />
    case 'integrations': return <IntegrationsView />
    case 'integration-logs': return <IntegrationLogsView />
    default: return <DashboardHome />
  }
}
```

### Navigation actions

Navigation is performed via the `navigate()` action on the Zustand store. It:
1. Sets the new `route` in the store.
2. Scrolls to the top of the page (instant, not smooth).
3. Pushes the new URL state to the browser history via `pushRouteToURL(route)`.

For navigation that doesn't push a new history entry (e.g., restoring from a popstate event), the code uses `useAppStore.setState({ route })` directly to avoid double-pushing.

### Browser back/forward handling

`src/app/page.tsx` registers a `popstate` listener:

```tsx
useEffect(() => {
  function handlePopState() {
    if (window.__formGuardIntercepting) return  // form guard handles it
    const urlRoute = queryToRoute()
    if (urlRoute) {
      useAppStore.setState({ route: urlRoute })  // setState, NOT navigate
    }
  }
  window.addEventListener('popstate', handlePopState)
  return () => window.removeEventListener('popstate', handlePopState)
}, [])
```

When the user clicks back/forward, the browser fires `popstate`, the handler reads the URL via `queryToRoute()`, and updates the store WITHOUT pushing a new history entry (which would cause infinite loops).

### Form guard (Unsaved Changes Guard)

When a form is dirty (e.g. `OrderCreateView`, `ProductCreateView`), the `useFormGuard()` hook (`src/hooks/form-guard/use-form-guard.tsx`) intercepts all three exit points:
1. `beforeunload` — browser-level (reload, tab close)
2. In-app navigation — sidebar link clicks (wraps `navigate()` calls via `attemptNavigation()`)
3. Browser back/forward — `popstate` listener (sets `window.__formGuardIntercepting` flag to signal the page.tsx handler to skip)

The user sees an `UnsavedChangesModal` (`src/components/shared/unsaved-changes-modal.tsx`) with three options:
- **Discard & leave** — proceeds with navigation, drops unsaved changes.
- **Save as draft** — calls `onSaveDraft` (which POSTs to `/api/orders/drafts` or `/api/products/drafts`), then navigates.
- **Cancel** — closes the modal, stays on the page.

## 3. State management — Zustand

The single Zustand store lives in `src/stores/app-store.ts` (~171 lines). It contains:

```ts
interface AppState {
  // Session
  user: UserPublic | null
  activeCompany: CompanyPublic | null
  companies: CompanyPublic[]
  employee: {
    id: string
    roleTier: string
    roleName: string
    systemRoleKey: string | null
    permissions: string[]
    isElevated: boolean
    ordersDataScope: 'own' | 'all'
  } | null
  hydrated: boolean   // false until first session fetch completes
  loading: boolean

  // Routing
  route: AppRoute

  // Actions
  setSession: (s) => void
  setHydrated: (v: boolean) => void
  setLoading: (v: boolean) => void
  navigate: (route: AppRoute) => void
  reset: () => void
}
```

### Why Zustand (not Redux)

- Tiny (~1KB) — fits FlowOps's lean stack.
- No boilerplate (no actions/reducers/dispatch).
- Direct mutation via `set()` — no immutability ceremony.
- Works perfectly with React 19's concurrent rendering.

### Permission hook

`useCan()` is a tiny selector hook exported from `app-store.ts`:

```ts
export function useCan(): (key: string) => boolean {
  const employee = useAppStore((s) => s.employee)
  return (key: string) => {
    if (!employee) return false
    if (employee.isElevated) return true
    return employee.permissions.includes(key)
  }
}
```

Used everywhere in the UI to gate visibility:

```tsx
const can = useCan()
{can(PERMISSIONS.ORDERS_CREATE) && <Button>Create Order</Button>}
```

### Session hydration

The store starts with `hydrated: false`. `src/app/page.tsx` fires a TanStack Query against `/api/auth/me` on mount. When the query resolves:
- **First fetch** (cold start): calls `setSession({...})` which sets `hydrated: true`. The user sees a loading spinner (`<Loader2 className="animate-spin" />`) until then.
- **Background refetch** (tab refocus, reconnect, invalidation): silently updates the store ONLY if the session data actually changed (compares user.id, activeCompany.id, and permissions array). This prevents UI flicker on background refetches.

The session query intentionally overrides the global `refetchOnWindowFocus: false` default — session validity (active employee status, permissions, platform-level access) is the one place where catching a change quickly after the user returns to a background tab actually matters.

## 4. TanStack Query patterns

### Global defaults (`src/components/providers.tsx`)

```ts
const [client] = useState(() => new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,           // 30s default
      refetchOnWindowFocus: false, // global default — overridden ONLY for session
      retry: 1,
    },
  },
}))
```

### Query key conventions

Query keys are arrays starting with the resource name:

```ts
['session', 'me']                              // session
['orders', '?statuses=pending&limit=50']       // orders list with full query string
['order', orderId]                              // single order detail
['product', productId]                          // single product detail
['products', '?search=...&page=1']              // products list
['draft-count', 'product'|'order']              // sidebar draft badges
['booking-workbench-bookable']                  // booking workbench
['booking-workbench-activity', dateFrom, dateTo]
['couriers', providerKey, 'cities', q]          // city autocomplete (debounced)
['couriers', 'sync-cities']                     // city sync status
['integrations', category]                      // integration list
['integration-logs', '?...']                    // integration logs
['payroll']                                      // payroll runs list
['payroll', runId]                               // single payroll run
['employees']                                     // employees list
['employee', employeeId, 'salary']               // employee salary
```

### Mutation + invalidation pattern

```tsx
const queryClient = useQueryClient()

const mutation = useMutation({
  mutationFn: (data) => api.post('/api/orders', data, {
    'Idempotency-Key': idempotencyKey,
  }),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['orders'] })
    queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    toast.success('Order created')
  },
  onError: (err) => {
    toast.error(getErrorMessage(err))
  },
})
```

### Idempotent mutation hook

For creation flows, `src/hooks/use-idempotent-mutation.ts` wraps `useMutation` with automatic idempotency-key generation:

```tsx
const mutation = useIdempotentMutation({
  url: '/api/orders',
  onSuccess: (data) => { ... },
})

mutation.mutate(orderData)
// Button: <Button disabled={mutation.isPending}>Create Order</Button>

// For "Create & Add Another":
mutation.regenerateKey()
mutation.reset()
```

The key persists across re-renders (via `useRef`) but is fresh per mount. When the component unmounts and remounts (e.g., opening a fresh create form), a new key is generated automatically.

## 5. Component architecture

### Directory structure

```
src/
  app/
    layout.tsx           # Root layout: Geist fonts, Providers, suppressHydrationWarning
    page.tsx             # Single-page shell — switch on route.name
    globals.css          # Tailwind v4 + oklch theme variables
    api/                 # Next.js Route Handlers (server-side)
  components/
    ui/                  # 52 shadcn/ui primitives (see §7)
    auth/                # LoginForm, RegisterForm, ForgotPasswordForm, ResetPasswordForm, AuthShell
    onboarding/          # OnboardingView, CreateOrganizationView, CreateCompanyView, CreateCompanyWizard, AcceptInviteCard
    dashboard/           # DashboardHome
    layout/              # DashboardShell, Sidebar, Navbar (WorkspaceSwitcher + UserMenu), MobileNav, Brand
    workspace/           # WorkspaceSwitcher, useInvalidateWorkspaces
    employees/           # EmployeesView, EmployeeDetailView, InviteEmployeeView, EmployeeStatusBadge, MyPayslipsTab, PerformanceTab, SalaryTab
    roles/               # RolesView, RoleEditView, PermissionKeySelector
    payroll/             # PayrollView, PayrollRunDetailView, AdvancesView
    products/            # ProductsView, ProductCreateView, ProductDetailView, CatalogSettingsView, ReturnedStitchedView, OrgCatalogView, + sub-components (AttributeSelector, ParentChildVariantTable, FulfillmentTypeBadge, etc.)
    inventory/           # 16 view files — InventoryDashboardView, LocationsView, SuppliersView, ReceiveStockView, AdjustStockView, TransferStockView, PurchaseOrdersView, PoCreateView, PoDetailView, SupplierReturnsView, ProductionOrdersView, LossesView, LossDetailView, CycleCountsView, LocationDetailView, SupplierDetailView
    orders/              # 24 view files + sub-components (see §10)
    customers/           # CustomerSearchAutocomplete, CreateCustomerForm, AddressSelector, types.ts
    couriers/             # CityAutocomplete, CityMismatchResolver, PickupAddressesSection, CourierBadge
    settings/            # OrganizationView, CompanySettingsView, SettingsView, AuditLogView, IntegrationsView, IntegrationLogsView, LeopardPreferencesSection
    shared/              # DraftsView, UnsavedChangesModal
    providers.tsx        # QueryClientProvider + ThemeProvider + Toaster
  stores/
    app-store.ts         # Zustand store + useCan() hook
  hooks/
    form-guard/          # useFormGuard, useUnsavedChangesBeforeunload, useNavigationInterceptor, useBrowserBackGuard
    use-mobile.ts        # useIsMobile() — 768px breakpoint
    use-toast.ts         # legacy toast hook (mostly replaced by sonner)
    use-idempotent-mutation.ts
  lib/
    api-client.ts        # api.get/post/put/patch/delete + Bearer token auth
    routing/url-sync.ts  # routeToQuery, queryToRoute, pushRouteToURL, replaceRouteInURL
    workspace.ts         # getWorkspace, requirePermission, hasPermission, getOrdersDataScope (server-side)
    workspace-cache.ts   # 60s in-memory cache for WorkspaceContext
    permissions.ts       # PERMISSIONS constant + PERMISSION_GROUPS catalog
    session.ts           # createSessionToken, getCurrentUser, SESSION_COOKIE, SESSION_MAX_AGE
    session-payload.ts   # buildSessionPayload (resolves full session from user ID)
    types.ts             # UserPublic, CompanyPublic, SessionResponse type defs
    utils.ts             # cn() class merge helper + misc
    audit.ts             # insertAuditLog (fire-and-forget)
    metrics.ts           # insertMetricEvent (fire-and-forget)
    fire-and-forget.ts   # utility for non-blocking async work
    idempotency.ts       # withIdempotency() server-side wrapper
    stock-loss.ts        # recordStockLoss() unified helper
    inventory.ts         # processInventoryTransaction, reserveOrderStock, generatePoNumber, etc.
    order-scope.ts       # resolveOrderScope + resolveOrderItemScope (modern pattern)
    validations/         # Zod schemas (auth, customer, order, product, inventory, etc.)
    integrations/        # courier adapter registry + Leopard/PostEx/TCS implementations
    actions/             # server actions (order, customer, exchange, payroll, etc.)
    constants/           # fulfillment-types.ts etc.
    data/                # countries.ts, currencies.ts (lookup tables)
    utils/               # variant-grouping.ts, city-rank.ts, order-weight.ts, encryption.ts, internal-slip-pdf.ts, scan-pdf.ts, payslip-pdf.ts
```

### View component pattern

Every view component follows the same shape:

```tsx
'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, FetchError } from '@/lib/api-client'
import { useAppStore, useCan } from '@/stores/app-store'
import { PERMISSIONS } from '@/lib/permissions'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { getErrorMessage } from '@/components/orders/_shared'
// ...

export function OrdersView() {
  const can = useCan()
  const canView = can(PERMISSIONS.ORDERS_VIEW)
  const navigate = useAppStore(s => s.navigate)

  const { data, isLoading, isError } = useQuery<...>({
    queryKey: ['orders', queryString],
    queryFn: () => api.get<...>(`/api/orders${queryString}`),
    enabled: canView,
  })

  if (!canView) return <NoPermission />
  if (isLoading) return <Skeleton ... />
  if (isError) return <ErrorState />

  return (
    <div>
      <PageHeader title="Orders" description="..." actions={<Button>Create</Button>} />
      <OrdersTable orders={data.orders} />
    </div>
  )
}
```

### Shared helpers

`src/components/orders/_shared.ts` (used by all OMS views):
- `formatPKR(n)` — `Rs. 1,234,567` (Intl.NumberFormat en-PK).
- `formatDate(iso)` / `formatDateTime(iso)` — localized display.
- `getErrorMessage(err)` — extracts message from FetchError or generic Error.
- `STATUS_BADGE` / `PAYMENT_BADGE` maps — color classes per status value.

## 6. Key UI patterns

### 6.1 `CustomerSearchAutocomplete` (`src/components/customers/CustomerSearchAutocomplete.tsx`)

Debounced phone/name search input with a dropdown of matches. As the user types, calls `GET /api/customers?detailed=1&search=...` which normalizes the input via `normalize_phone()` and matches against `customer_phones.phoneNormalized` + customer name.

- Selecting a match fires `onSelect(customer)` with the full customer object (including all phones and addresses).
- A "+ Create New Customer" option at the bottom fires `onCreateNew` (which the caller uses to expand the `CreateCustomerForm` inline).
- Debounce: 300ms.
- Uses TanStack Query with `staleTime: 60_000` so back-to-back searches don't re-fetch the same query.

Used in: `OrderCreateView` (customer section), `CustomersView` (live search).

### 6.2 `CreateCustomerForm` (`src/components/customers/CreateCustomerForm.tsx`)

Inline form for creating a new customer with phone + address. React Hook Form + Zod validation. Submits to `POST /api/customers` with `Idempotency-Key` header. On success, calls `onCreated(customer)`.

### 6.3 `AddressSelector` (`src/components/customers/AddressSelector.tsx`)

Compact address selector for the order-create customer section. Redesign (Shopify-style compact):
- Saved address cards are single-line rows (not tall cards).
- Address text uses a single-line Input (not a Textarea).
- Helper text is inline and minimal.
- The selected/entered address text is ALWAYS editable (per the snapshot behavior: the order's `deliveryAddress` is a copy that can be tweaked per-order without altering the saved `customer_addresses` row).

Props:
- `addresses: AddressDTO[]` — saved addresses for the customer.
- `value: AddressSelectorValue` — `{ usedCustomerAddressId, deliveryAddress, deliveryCity, deliveryCountry, saveAddressForNextTime }`.
- `onChange(value)` — called on every change.
- `courierProviderKey?` — passed to `CityAutocomplete` for courier-aware city validation.

Integrates `CityAutocomplete` (for the city field) and `CountrySelector` (for the country field).

### 6.4 `CityAutocomplete` (`src/components/couriers/city-autocomplete.tsx`)

Reusable courier city search input. Text input with live suggestions dropdown, sourced from `courier_operational_cities` for the given provider via `GET /api/couriers/[providerKey]/cities?q=search_term`.

**AUTO-FETCH MISSING CITIES**: when the first (cache-only) search returns ZERO results, the component AUTOMATICALLY fires a second search with `?live=true`. The backend then calls the courier API live, caches the full city list, and re-runs the search. This means: if the courier serves a city that isn't in our local cache yet (recently added, or sync hasn't run), the user will STILL see it — they'll just see a "Checking live courier API…" loader for ~1-2s first.

Generic — not hardcoded into any specific form. Used in:
- Order Create (customer address section)
- Exchange Shipment forms
- Booking Workbench (per-row courier city)
- Pickup Address Book form

Shows courier badges (e.g. "Leopard + PostEx") via the `CourierBadges` component when multiple couriers cover the same city (in `providerKey='all'` mode).

### 6.5 `DeliverySidebar` (inside `src/components/orders/order-create-view.tsx`)

The right-side sticky sidebar in `OrderCreateView`. Renders the courier selection, pickup address selector, delivery charge estimate, order notes for courier, and the order detail (auto-generated from cart contents). The summary card and "Create Order" button sit below it.

The sidebar is **always visible** (not a modal) — the user can tweak courier / pickup / delivery charge while filling out the order form.

### 6.6 `BookingWorkbenchView` (`src/components/orders/booking-workbench-view.tsx`, ~1221 lines)

Bulk courier-booking workbench with 3 tabs:
1. **Orders** — `GET /api/booking-workbench/bookable` → `data.orders`
2. **Exchange Shipments** — `GET /api/booking-workbench/bookable` → `data.shipments`
3. **Booking Activity** — `GET /api/booking-workbench/activity?date_from=&date_to=`

Key behaviours:
- **Per-row courier `<Select>`** — defaults to `row.recommendedCourierCompanyIntegrationId`; drives that row's `<CityAutocomplete providerKey>`.
- **Bulk Apply** — toolbar dropdown + "Apply to Selected" sets the courier on all CHECKED rows in the active tab only.
- **Weight auto-compute** — each row's default `orderType` is computed via `calculateOrderWeightKg` + `determinePostExOrderType`. If `hasMissingWeight`, a ⚠️ tooltip is shown next to the Order Type dropdown. Still editable.
- **Upload Booking** — sequentially POSTs `/api/booking-workbench/book` for each checked row using THAT ROW's courier integration id. Failures don't block other rows. On success the row shows ✅ tracking number + auto-unchecks.
- **After any successful booking**, `['booking-workbench-bookable']` and `['booking-workbench-activity']` queries are invalidated.

### 6.7 `OrderScanView` (`src/components/orders/order-scan-view.tsx`, ~679 lines)

Barcode scanning workflow + reporting. Two tabs:
1. **Scan Station** — always-focused input, mode selector, instant feedback.
2. **Reports** — date range, summary cards, employee breakdown, PDF download.

Hardware: works with any USB/Bluetooth scanner in keyboard-emulation mode (types the value + Enter key — the input submits on Enter automatically).

Scan modes: `mark_processing`, `mark_packed`, `warehouse_handover`, `receive_return`, `locate_cancelled`, `cancel_via_scan`.

Each scan produces a `ScanResult` with `scanResult: 'success' | 'rejected' | 'not_found'` and optional `entity` info (entityType, entityId, trackingNumber, status, etc.). Rejected/not_found scans are still recorded in the immutable `ScanEvent` ledger.

### 6.8 `useFormGuard` (`src/hooks/form-guard/use-form-guard.tsx`)

Composes three interception points into one unified confirmation modal:
1. `useUnsavedChangesBeforeunload(isDirty)` — `beforeunload` event.
2. `useNavigationInterceptor()` — wraps `attemptNavigation(action)` for in-app nav.
3. `useBrowserBackGuard(isDirty, handleBackAttempt)` — `popstate` listener.

Renders `<UnsavedChangesModal>` with three buttons: Discard & leave, Save as draft, Cancel.

Usage:
```tsx
const { ConfirmModal, attemptNavigation } = useFormGuard({
  isDirty: form.formState.isDirty,
  onSaveDraft: async () => { await api.post('/api/orders/drafts', {...}) },
})

<button onClick={() => attemptNavigation(() => navigate({ name: 'orders' }))}>
  Back to Orders
</button>
{ConfirmModal}
```

## 7. shadcn/ui usage — 52 components

All shadcn/ui primitives live under `src/components/ui/`. The full list:

**Layout / containers**: `card.tsx`, `separator.tsx`, `scroll-area.tsx`, `tabs.tsx`, `resizable.tsx`, `accordion.tsx`, `collapsible.tsx`, `sheet.tsx`, `drawer.tsx`, `aspect-ratio.tsx`, `sidebar.tsx`.

**Form inputs**: `button.tsx`, `input.tsx`, `textarea.tsx`, `label.tsx`, `select.tsx`, `checkbox.tsx`, `radio-group.tsx`, `switch.tsx`, `toggle.tsx`, `toggle-group.tsx`, `slider.tsx`, `input-otp.tsx`, `calendar.tsx`, `form.tsx` (RHF bindings).

**Display**: `badge.tsx`, `avatar.tsx`, `initials-avatar.tsx`, `progress.tsx`, `skeleton.tsx`, `table.tsx`, `tooltip.tsx`, `alert.tsx`, `chart.tsx`.

**Overlays / menus**: `dialog.tsx`, `alert-dialog.tsx`, `popover.tsx`, `dropdown-menu.tsx`, `context-menu.tsx`, `hover-card.tsx`, `command.tsx`, `navigation-menu.tsx`, `menubar.tsx`, `breadcrumb.tsx`, `sheet.tsx`.

**Custom FlowOps components in `ui/`**: `country-selector.tsx` (ISO 3166-1 alpha-2 country picker, returns codes), `currency-selector.tsx`, `logo-upload.tsx` (image upload with preview + drag-and-drop), `sonner.tsx` + `toaster.tsx` + `toast.tsx` (toast notifications).

**Legacy**: `toast.tsx` + `toaster.tsx` are the older radix-based toast system; `sonner.tsx` is the modern replacement and is used by `providers.tsx` for the global `<Toaster richColors position="top-right" closeButton />`.

### Where each is used (selected examples)

| Component | Used by |
|---|---|
| `Card`, `CardContent`, `CardHeader`, `CardTitle` | Every view (PageHeader + content cards) |
| `Button` | Every interactive surface |
| `Input`, `Label`, `Textarea` | Every form |
| `Badge` | Status pills everywhere (orders, payments, courier, etc.) |
| `Skeleton` | Loading states in every list view |
| `Table`, `TableRow`, `TableCell`, `TableHead` | `OrdersView`, `BookingWorkbenchView`, `EmployeesView`, `InventoryDashboardView`, etc. |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | `OrderScanView`, `BookingWorkbenchView`, `EmployeeDetailView`, `OrderDetailView` (multi-tab detail pages) |
| `Dialog`, `AlertDialog` | Modals everywhere (RTO dialog, verify-old-item dialog, request-exchange dialog, send-exchange-shipment modal) |
| `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue` | Dropdowns for status filters, courier selection, employee role assignment |
| `Sheet`, `SheetContent`, `SheetTrigger` | `MobileNav` (mobile sidebar drawer) |
| `Sonner` (Toaster) | Global toast container (top-right, rich colors, close button) |
| `DropdownMenu` | `UserMenu` (navbar), row action menus in tables |
| `Checkbox` | Multi-select in `BookingWorkbenchView` |
| `Tooltip`, `TooltipTrigger`, `TooltipContent` | Field hints, weight-warning tooltips in Booking Workbench |
| `Alert`, `AlertDescription`, `AlertTitle` | Inline error/warning banners (e.g. `OrderCreateView` warnings) |
| `Separator` | Section dividers in detail pages |
| `Avatar`, `InitialsAvatar` | `UserMenu` avatar, employee profile |
| `Form` (RHF bindings) | Login, Register, Forgot, Reset, Invite Employee, Create Organization, Create Company |
| `Pagination` | Audit log view (pagination) |
| `Calendar` | Date range pickers in scan reports |
| `ScrollArea` | Long lists with custom scrollbars |
| `HoverCard` | Customer info hover in order rows |
| `ContextMenu` | Right-click menus in tables |

## 8. API client — `api.get/post/put/patch/delete`

The frontend fetch wrapper lives in `src/lib/api-client.ts` (~125 lines). Key design points:

### Dual-channel auth

```ts
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const token = getSessionToken()
  const headers = {
    'Content-Type': 'application/json',
    ...(options?.headers ?? {}),
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  const res = await fetch(url, {
    ...options,
    credentials: 'include',  // ALSO send cookies (fallback)
    headers,
    cache: 'no-store',        // never cache API responses
  })
  // ... parse + handle errors
}
```

The session token is stored in `localStorage` (key: `flowops_session_token`) after login/register. It's sent as `Authorization: Bearer <token>` on every request. **AND** cookies are also included via `credentials: 'include'` as a fallback.

This dual-channel approach ensures auth works in ALL contexts:
- **Same-origin** — cookie works.
- **Cross-origin / iframe / preview panel** — Bearer token works.
- **Mobile app** — Bearer token works.

### Session token management

```ts
const SESSION_TOKEN_KEY = 'flowops_session_token'

export function setSessionToken(token: string) {
  if (typeof window !== 'undefined') {
    localStorage.setItem(SESSION_TOKEN_KEY, token)
  }
}

export function clearSessionToken() { ... }
export function getSessionToken(): string | null { ... }
```

The login/register response includes a `sessionToken` field in the JSON body — the frontend stores it via `setSessionToken(token)` so subsequent requests carry it.

### Error handling

```ts
export class FetchError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// In request<T>():
if (!res.ok) {
  const message = body?.error ?? (typeof body === 'string' ? body : 'Request failed')
  throw new FetchError(res.status, message)
}
```

The `FetchError` class is used by `getErrorMessage(err)` in `src/components/orders/_shared.ts` to display user-friendly error toasts.

### Public API

```ts
export const api = {
  get: <T>(url: string) => request<T>(url, { method: 'GET' }),
  post: <T>(url: string, data?: unknown, headers?: Record<string, string>) =>
    request<T>(url, { method: 'POST', body: data ? JSON.stringify(data) : undefined, headers }),
  put: <T>(url: string, data?: unknown, headers?: Record<string, string>) => ...,
  patch: <T>(url: string, data?: unknown, headers?: Record<string, string>) => ...,
  delete: <T>(url: string) => request<T>(url, { method: 'DELETE' }),
}
```

For mutations that need an idempotency key:

```ts
api.post('/api/orders', orderData, { 'Idempotency-Key': idempotencyKey })
```

Or via `useIdempotentMutation({ url: '/api/orders' })` which auto-injects the header.

## 9. Real-time updates — TanStack Query invalidation patterns

FlowOps does NOT use WebSockets or SSE. All "real-time" updates are achieved via TanStack Query's invalidation + refetch mechanism:

### Global defaults

```ts
defaultOptions: {
  queries: {
    staleTime: 30_000,           // 30s — data is fresh for 30s
    refetchOnWindowFocus: false, // global default
    retry: 1,
  },
}
```

### Common invalidation patterns

**After a successful mutation**, invalidate the relevant query keys:

```tsx
const mutation = useMutation({
  mutationFn: (data) => api.post('/api/orders', data, { 'Idempotency-Key': key }),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['orders'] })
    queryClient.invalidateQueries({ queryKey: ['orders-pending'] })
    queryClient.invalidateQueries({ queryKey: ['orders-backordered'] })
    queryClient.invalidateQueries({ queryKey: ['dashboard'] })  // update counts
    toast.success('Order created')
  },
})
```

### Session refetch (special case)

The session query (`['session', 'me']`) overrides the global `refetchOnWindowFocus: false` default — it's the one query that DOES refetch on window focus, so terminated employees / permission changes propagate quickly:

```ts
const sessionQuery = useQuery<SessionResponse>({
  queryKey: ['session', 'me'],
  queryFn: () => api.get<SessionResponse>('/api/auth/me'),
  staleTime: 60_000,
  refetchOnWindowFocus: true,  // OVERRIDE global default
  refetchOnReconnect: true,
  retry: 1,
})
```

### Polling (for active processes)

Some queries use `refetchInterval` for polling:
- Sidebar draft count badges: `refetchInterval: 60_000` (every 60s).
- (Other polling patterns exist but are rare — most views rely on user-initiated refreshes or mutation invalidation.)

### Mutation invalidation via `useInvalidateWorkspaces`

`src/components/workspace/workspace-switcher.tsx` exports `useInvalidateWorkspaces()`:

```ts
const invalidate = useInvalidateWorkspaces()
// After switching workspace:
invalidate()  // refetch ['workspaces'] query
```

## 10. Key view components — full list

### Auth views

| Component | Route name | File | Purpose |
|---|---|---|---|
| `LoginForm` | `login` | `src/components/auth/login-form.tsx` | Email + password login. RHF + Zod validation. Stores `sessionToken` in localStorage on success. |
| `RegisterForm` | `register` | `src/components/auth/register-form.tsx` | New account registration (fullName, email, password). |
| `ForgotPasswordForm` | `forgot` | `src/components/auth/forgot-password-form.tsx` | Email-only recovery request (sandbox no-op). |
| `ResetPasswordForm` | `reset` | `src/components/auth/reset-password-form.tsx` | Set new password (token in URL). |
| `AuthShell` | (wrapper) | `src/components/auth/auth-shell.tsx` | Centered card layout for all auth views. |

### Onboarding views

| Component | Route name | File | Purpose |
|---|---|---|---|
| `OnboardingView` | `onboarding` | `src/components/onboarding/onboarding-view.tsx` | Decision screen: create org vs. accept invite. |
| `OnboardingSelector` | (wrapper) | `src/components/onboarding/onboarding-selector.tsx` | Renders the right onboarding sub-view. |
| `CreateOrganizationView` | `create-organization` | `src/components/onboarding/create-organization-view.tsx` | New org form (name, slug auto-gen). |
| `CreateCompanyView` | `create-company` | `src/components/onboarding/create-company-view.tsx` | New company form under an org. |
| `CreateCompanyWizard` | (wrapper) | `src/components/onboarding/create-company-wizard.tsx` | Multi-step company creation wizard. |
| `AcceptInviteCard` | `accept-invite` | `src/components/onboarding/accept-invite-card.tsx` | Token-based invite acceptance. |

### Dashboard

| Component | Route name | File | Purpose |
|---|---|---|---|
| `DashboardHome` | `dashboard` | `src/components/dashboard/dashboard-home.tsx` | KPI cards (employees, roles, pending invites), recent activity feed, 7-day metrics rollup. |

### Employees

| Component | Route name | File | Purpose |
|---|---|---|---|
| `EmployeesView` | `employees` | `src/components/employees/employees-view.tsx` | Company directory with search + filter. |
| `InviteEmployeeView` | `employees-invite` | `src/components/employees/invite-employee-view.tsx` | Invite by email (token-based). |
| `EmployeeDetailView` | `employee-detail` | `src/components/employees/employee-detail-view.tsx` | Profile + tabs: Performance, Salary, My Payslips. |
| `PerformanceTab` | (sub) | `src/components/employees/performance-tab.tsx` | Order funnel stats for the employee. |
| `SalaryTab` | (sub) | `src/components/employees/salary-tab.tsx` | Current salary profile + revision history. |
| `MyPayslipsTab` | (sub) | `src/components/employees/my-payslips-tab.tsx` | Self-service payslip access (own only). |
| `EmployeeStatusBadge` | (sub) | `src/components/employees/employee-status-badge.tsx` | Active/suspended/terminated badge. |

### Roles

| Component | Route name | File | Purpose |
|---|---|---|---|
| `RolesView` | `roles` | `src/components/roles/roles-view.tsx` | List + create custom roles. |
| `RoleEditView` | `role-edit` | `src/components/roles/role-edit-view.tsx` | Edit role name, description, permissions (full replace), ordersDataScope. |
| `PermissionKeySelector` | (sub) | `src/components/roles/permission-key-selector.tsx` | Grouped checkbox UI for the 30 permission keys. |

### Settings

| Component | Route name | File | Purpose |
|---|---|---|---|
| `OrganizationView` | `organization` | `src/components/settings/organization-view.tsx` | Org profile (name, logo, website). Owner-only. |
| `CompanySettingsView` | `company-settings` | `src/components/settings/company-settings-view.tsx` | Active company profile (legalName, taxId, address, timezone). |
| `SettingsView` | `settings` | `src/components/settings/settings-view.tsx` | Personal settings (theme, language, notification prefs). |
| `AuditLogView` | `audit` | `src/components/settings/audit-log-view.tsx` | Paginated, filterable audit log. |
| `IntegrationsView` | `integrations` | `src/components/settings/integrations-view.tsx` | Connect/disconnect courier + ecommerce integrations. Elevated-only. |
| `IntegrationLogsView` | `integration-logs` | `src/components/settings/integration-logs-view.tsx` | Filterable integration action logs. |
| `LeopardPreferencesSection` | (sub) | `src/components/settings/leopard-preferences-section.tsx` | Leopard-specific prefs (transactionNote etc). |

### Payroll

| Component | Route name | File | Purpose |
|---|---|---|---|
| `PayrollView` | `payroll` | `src/components/payroll/payroll-view.tsx` | List payroll runs + generate new run. |
| `PayrollRunDetailView` | `payroll-run-detail` | `src/components/payroll/payroll-run-detail-view.tsx` | Run detail with payslips table + finalize + mark-all-paid + per-payslip adjust/mark-paid. |
| `AdvancesView` | (sub) | `src/components/payroll/advances-view.tsx` | Salary advances list + record new advance. |

### Products

| Component | Route name | File | Purpose |
|---|---|---|---|
| `ProductsView` | `products` | `src/components/products/products-view.tsx` | List products visible to the active company (private/org/selective). Filters by category, brand, type, scope, active. Pagination. |
| `ProductCreateView` | `product-create` | `src/components/products/product-create-view.tsx` | Multi-step product creation wizard (basic info → variants → pricing → opening stock → images). Uses `useFormGuard`. |
| `ProductDetailView` | `product-detail` | `src/components/products/product-detail-view.tsx` | Full product detail with parent-child variant table, inventory panel, image gallery. |
| `CatalogSettingsView` | `product-settings` | `src/components/products/catalog-settings-view.tsx` | Manage categories, brands, attributes + values. Tabs for each. |
| `ReturnedStitchedView` | `returned-stitched` | `src/components/products/returned-stitched-view.tsx` | Returned made-to-order stitched inventory register. Mark sold / write off. |
| `OrgCatalogView` | `org-catalog` | `src/components/products/org-catalog-view.tsx` | Org-level catalog overview (elevated-only). |
| `AttributeSelector` | (sub) | `src/components/products/attribute-selector.tsx` | Generic attribute picker used in variant builder. |
| `ParentChildVariantTable` | (sub) | `src/components/products/parent-child-variant-table.tsx` | Server-driven parent-child variant grouping table. |
| `ClientSideParentChildVariantTable` | (sub) | `src/components/products/client-side-parent-child-variant-table.tsx` | Client-side variant grouping (used by the wizard). |
| `FulfillmentTypeBadge` | (sub) | `src/components/products/fulfillment-type-badge.tsx` | `stock_based` / `made_to_order` badge. |
| `ProductScopeBadge` | (sub) | `src/components/products/product-scope-badge.tsx` | `private` / `organization` / `selective` / `archived` badge. |
| `ReturnedStockBanner` | (sub) | `src/components/products/returned-stock-banner.tsx` | Banner showing returned-stock availability for an MTO variant. |
| `variant-table-parts.tsx` | (sub) | `src/components/products/variant-table-parts.tsx` | `SyncIndicator`, `ParentGroupHeader`, `ParentGroupInputs`, `WeightCell`, `CostCell` — table cell components. |

### Inventory

| Component | Route name | File | Purpose |
|---|---|---|---|
| `InventoryDashboardView` | `inventory` | `src/components/inventory/inventory-dashboard-view.tsx` | Stock value, low-stock count, out-of-stock count, dead stock value, recent transactions. |
| `LocationsView` | `inventory-locations` | `src/components/inventory/locations-view.tsx` | List + create inventory locations (org-level shared + company-level). |
| `LocationDetailView` | `inventory-location-detail` | `src/components/inventory/location-detail-view.tsx` | Location detail with stock pools at that location. |
| `SuppliersView` | `inventory-suppliers` | `src/components/inventory/suppliers-view.tsx` | List + create suppliers. |
| `SupplierDetailView` | `inventory-supplier-detail` | `src/components/inventory/supplier-detail-view.tsx` | Supplier detail with returns + purchase orders. |
| `ReceiveStockView` | `inventory-receive` | `src/components/inventory/receive-stock-view.tsx` | Receive stock directly (NOT against a PO). Multi-item form. |
| `AdjustStockView` | `inventory-adjust` | `src/components/inventory/adjust-stock-view.tsx` | Manual stock adjustment (positive or negative). |
| `TransferStockView` | `inventory-transfer` | `src/components/inventory/transfer-stock-view.tsx` | Stock transfer between two locations. |
| `PurchaseOrdersView` | `inventory-purchase-orders` | `src/components/inventory/purchase-orders-view.tsx` | List purchase orders + create. |
| `PoCreateView` | `inventory-po-create` | `src/components/inventory/po-create-view.tsx` | PO creation form (supplier, location, items). |
| `PoDetailView` | `inventory-po-detail` | `src/components/inventory/po-detail-view.tsx` | PO detail with confirm / cancel / receive actions. |
| `SupplierReturnsView` | `inventory-supplier-returns` | `src/components/inventory/supplier-returns-view.tsx` | List + create supplier returns. Mark disputed / resolved. |
| `ProductionOrdersView` | `inventory-production-orders` | `src/components/inventory/production-orders-view.tsx` | List + create production orders (MTO fabric tracking). |
| `LossesView` | `inventory-losses` | `src/components/inventory/losses-view.tsx` | List stock loss records. Tabs by loss type. Report damaged/theft/transit-loss buttons. |
| `LossDetailView` | `inventory-loss-detail` | `src/components/inventory/loss-detail-view.tsx` | Single loss record detail with resolve action. |
| `CycleCountsView` | `inventory-cycle-counts` | `src/components/inventory/cycle-counts-view.tsx` | List + create cycle counts. Start count / submit counts / approve actions. |

### Orders

| Component | Route name | File | Purpose |
|---|---|---|---|
| `OrdersView` | `orders` | `src/components/orders/orders-view.tsx` | All Orders list with extensive filters (statuses, payment_types, sources, couriers, amount range, date range, search). Revenue summary stat card. |
| `OrderCreateView` | `order-create` | `src/components/orders/order-create-view.tsx` | Multi-step order creation form. Integrates `CustomerSearchAutocomplete`, `CreateCustomerForm`, `AddressSelector`, `CityAutocomplete`, `DeliverySidebar`. Uses `useFormGuard`. |
| `OrderDetailView` | `order-detail` | `src/components/orders/order-detail-view.tsx` | Full order detail with timeline, payment info, courier tracking card, items table. Action buttons: confirm, dispatch, mark packed/processing/delivered, RTO, cancel, convert payment, refresh status, download self-fulfilled slip. |
| `OrdersPendingConfirmationView` | `orders-pending-confirmation` | `src/components/orders/orders-pending-confirmation-view.tsx` | Pending orders queue. Confirm / convert-payment actions. |
| `OrdersBackorderedView` | `orders-backordered` | `src/components/orders/orders-backordered-view.tsx` | Backordered order items grouped by variant (FIFO by backorderedAt). |
| `OrdersAwaitingProductionView` | `orders-awaiting-production` | `src/components/orders/orders-awaiting-production-view.tsx` | Made-to-order items awaiting production. |
| `OrdersReadyToDispatchView` | `orders-ready-to-dispatch` | `src/components/orders/orders-ready-to-dispatch-view.tsx` | Orders ready to dispatch (all items reserved). Single + bulk dispatch. |
| `BookingWorkbenchView` | `booking-workbench` | `src/components/orders/booking-workbench-view.tsx` | Bulk courier-booking workbench (3 tabs: Orders / Exchange Shipments / Activity). Per-row courier select + bulk apply + upload booking. |
| `OrderScanView` | `order-scan` | `src/components/orders/order-scan-view.tsx` | Barcode scanning station (2 tabs: Scan Station / Reports). Hardware-scanner compatible. |
| `OrdersReturnsView` | `orders-returns` | `src/components/orders/orders-returns-view.tsx` | RTO orders list with items-needing-review filter. |
| `OrdersReturnsReviewView` | `orders-returns-review` | `src/components/orders/orders-returns-review-view.tsx` | Auto-processed RTO review queue. Correct (mark damaged) / dismiss actions. |
| `ExchangesView` | `exchanges` | `src/components/orders/exchanges-view.tsx` | Exchange requests list with status + method filters. |
| `ExchangeDetailView` | `exchange-detail` | `src/components/orders/exchange-detail-view.tsx` | Single exchange detail with timeline, verify-old-item, dispatch-new-item, settle-price-difference, mark-not-returned actions. |
| `CustomersView` | `customers` | `src/components/orders/customers-view.tsx` | Customer directory (note: under `orders/` directory despite being top-level sidebar entry). |
| `CustomerDetailView` | `customer-detail` | `src/components/orders/customer-detail-view.tsx` | Customer profile with phones, addresses, external identities, recent order history. Flag/unflag. |
| `OrderWorkflowSettingsView` | `order-workflow-settings` | `src/components/orders/order-workflow-settings-view.tsx` | Company order settings (requireOrderConfirmation, requirePackingStep, courierBookingMode, defaultCourier, orderNumberPrefix). Elevated-only. |
| `OrdersCancelledView` | `orders-cancelled` | `src/components/orders/orders-cancelled-view.tsx` | Cancelled orders history (read-only). |
| `NeedsShipperAdviceView` | (no route — embedded) | `src/components/orders/needs-shipper-advice-view.tsx` | Orders needing shipper advice (Leopard-specific). |
| `LoadSheetsTab` | (embedded) | `src/components/orders/load-sheets-tab.tsx` | Load sheets history + download PDFs. |
| `CancelCourierBookingButton` | (sub) | `src/components/orders/cancel-courier-booking-button.tsx` | Button to cancel a courier booking. |
| `ShipmentTrackingCard` | (sub) | `src/components/orders/shipment-tracking-card.tsx` | Tracking timeline card for OrderDetailView. |
| `RequestExchangeDialog` | (sub) | `src/components/orders/request-exchange-dialog.tsx` | Modal to initiate a new exchange request. |
| `VerifyOldItemDialog` | (sub) | `src/components/orders/verify-old-item-dialog.tsx` | Modal to verify old item condition (perfect/good/open_box/damaged). |
| `SendExchangeShipmentModal` | (sub) | `src/components/orders/send-exchange-shipment-modal.tsx` | Modal to dispatch an exchange shipment. |

### Shared

| Component | File | Purpose |
|---|---|---|
| `DraftsView` | `src/components/shared/drafts-view.tsx` | Saved form drafts list (product + order). Resume / delete. |
| `UnsavedChangesModal` | `src/components/shared/unsaved-changes-modal.tsx` | The 3-button modal used by `useFormGuard`. |

### Layout

| Component | File | Purpose |
|---|---|---|
| `DashboardShell` | `src/components/layout/dashboard-shell.tsx` | Top-level layout: Sidebar + header (WorkspaceSwitcher + Search + UserMenu) + main content area. |
| `Sidebar` | `src/components/layout/sidebar.tsx` | Left navigation with 5 sections (Workspace, Products, Inventory, Orders, Admin). Collapsible groups. Draft count badges. |
| `Navbar` (WorkspaceSwitcher + UserMenu) | `src/components/layout/navbar.tsx` | Header bar with workspace switcher dropdown + user menu. |
| `MobileNav` | `src/components/layout/mobile-nav.tsx` | Sheet-based sidebar drawer for mobile (`< md` breakpoint). |
| `Brand` (FlowOpsLogo) | `src/components/layout/brand.tsx` | Logo SVG. |
| `PageHeader` | `src/components/layout/dashboard-shell.tsx` | Standardized page header (title, description, actions slot). |

### Workspace

| Component | File | Purpose |
|---|---|---|
| `WorkspaceSwitcher` | `src/components/workspace/workspace-switcher.tsx` | Dropdown to switch active company. Single DB query (replaces old N+1). |
| `useInvalidateWorkspaces` | (hook in same file) | Hook to invalidate the `['workspaces']` query after switching. |

### Customers (shared)

| Component | File | Purpose |
|---|---|---|
| `CustomerSearchAutocomplete` | `src/components/customers/CustomerSearchAutocomplete.tsx` | Debounced phone/name search with dropdown. |
| `CreateCustomerForm` | `src/components/customers/CreateCustomerForm.tsx` | Inline new-customer form. RHF + Zod. |
| `AddressSelector` | `src/components/customers/AddressSelector.tsx` | Compact saved-address picker + editable text input. |
| `types.ts` | `src/components/customers/types.ts` | Shared types (`CustomerSearchResult`, `CustomerDetail`, `AddressDTO`, etc.). |

### Couriers (shared)

| Component | File | Purpose |
|---|---|---|
| `CityAutocomplete` | `src/components/couriers/city-autocomplete.tsx` | Reusable courier city search input (auto-fetches missing cities). |
| `CityMismatchResolver` | `src/components/couriers/city-mismatch-resolver.tsx` | Modal to resolve a typed-city that didn't match any cached city. |
| `PickupAddressesSection` | `src/components/couriers/pickup-addresses-section.tsx` | Pickup address book management (add / sync / refresh / import-by-id). |
| `CourierBadge` | `src/components/couriers/courier-badge.tsx` | Small pill showing courier name + logo. |

## 11. Theme system — light/dark mode, Tailwind v4

### Tailwind v4 setup

`src/app/globals.css` uses Tailwind v4's `@theme inline` directive to expose CSS variables as Tailwind utilities:

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
  /* ... ~30 more tokens ... */
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}
```

### OKLCH color palette

FlowOps uses the OKLCH color space for both light and dark themes. The primary color is **emerald** (`oklch(0.52 0.13 165)` — "distinctive, trustworthy, not blue/indigo").

**Light theme** (`:root`):
```css
:root {
  --radius: 0.7rem;
  --background: oklch(0.99 0.002 240);
  --foreground: oklch(0.18 0.01 250);
  --card: oklch(1 0 0);
  --primary: oklch(0.52 0.13 165);  /* emerald */
  --primary-foreground: oklch(0.99 0.01 165);
  --secondary: oklch(0.96 0.005 240);
  --muted: oklch(0.965 0.004 240);
  --muted-foreground: oklch(0.5 0.012 250);
  --accent: oklch(0.95 0.02 165);
  --destructive: oklch(0.58 0.22 27);  /* red-orange */
  --border: oklch(0.91 0.005 240);
  --input: oklch(0.92 0.005 240);
  --ring: oklch(0.52 0.13 165);
  /* chart-1 through chart-5 — emerald, blue, yellow, magenta, orange */
  --sidebar: oklch(0.17 0.015 250);  /* dark sidebar even in light mode */
  --sidebar-foreground: oklch(0.92 0.005 240);
  --sidebar-primary: oklch(0.62 0.14 165);
  /* ... */
}
```

**Dark theme** (`.dark`):
```css
.dark {
  --background: oklch(0.15 0.01 250);
  --foreground: oklch(0.96 0.005 240);
  --card: oklch(0.2 0.012 250);
  --primary: oklch(0.62 0.14 165);  /* lighter emerald for dark mode */
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --sidebar: oklch(0.12 0.01 250);
  /* ... */
}
```

### Theme provider

`src/components/providers.tsx` wraps the app in `next-themes`:

```tsx
<ThemeProvider
  attribute="class"
  defaultTheme="light"
  enableSystem={false}
  disableTransitionOnChange
>
  {children}
  <Toaster richColors position="top-right" closeButton />
</ThemeProvider>
```

- `attribute="class"` — toggles `.dark` class on `<html>`.
- `defaultTheme="light"` — FlowOps defaults to light mode (NOT system).
- `enableSystem={false}` — explicit user choice, no auto-switching.
- `disableTransitionOnChange` — no CSS transition flicker on theme switch.

### Font

Geist Sans + Geist Mono via `next/font/google` (in `src/app/layout.tsx`):

```tsx
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] })

<html lang="en" suppressHydrationWarning>
  <body className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`} suppressHydrationWarning>
    <Providers>{children}</Providers>
  </body>
</html>
```

`suppressHydrationWarning` on both `<html>` and `<body>` is required because `next-themes` adds the `.dark` class before React hydrates, causing a hydration mismatch warning otherwise.

### Custom scrollbar

```css
@layer utilities {
  .scrollbar-thin {
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .scrollbar-thin::-webkit-scrollbar { width: 8px; height: 8px; }
  .scrollbar-thin::-webkit-scrollbar-track { background: transparent; }
  .scrollbar-thin::-webkit-scrollbar-thumb {
    background-color: var(--border);
    border-radius: 9999px;
  }
  .bg-grid {
    background-image: radial-gradient(circle at 1px 1px, oklch(0.5 0.01 250 / 0.12) 1px, transparent 0);
    background-size: 24px 24px;
  }
}
```

## 12. Responsive design

FlowOps is **desktop-first** (the primary user is a warehouse operator / sales agent on a laptop), but supports mobile for on-the-go access.

### Breakpoints (Tailwind defaults)

| Breakpoint | Width | Used for |
|---|---|---|
| `sm` | 640px | Small phones → large phones |
| `md` | 768px | Tablets (sidebar collapses to drawer below this) |
| `lg` | 1024px | Small laptops (sticky sidebars become sticky here) |
| `xl` | 1280px | Desktops (max-width container) |
| `2xl` | 1536px | Large monitors |

### Mobile-specific patterns

- **Sidebar** (`src/components/layout/sidebar.tsx`): `hidden md:flex w-60 shrink-0` — hidden below `md`, replaced by `MobileNav` (Sheet drawer).
- **MobileNav** (`src/components/layout/mobile-nav.tsx`): renders a hamburger button visible only below `md` (`md:hidden`), opens a `Sheet` with the same nav items.
- **Search bar**: `hidden lg:flex` in the navbar — only shows on `lg` and up.
- **PageHeader**: `flex flex-col sm:flex-row sm:items-end sm:justify-between` — stacks on mobile, row on `sm+`.

### Container width

The main content area is constrained:

```tsx
<main className="flex-1 overflow-y-auto scrollbar-thin">
  <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
    {children}
  </div>
</main>
```

`max-w-7xl` = 80rem = 1280px — content never stretches wider than 1280px.

### Mobile detection hook

`src/hooks/use-mobile.ts` exports `useIsMobile()` — returns `true` when `window.innerWidth < 768`. Used by Sheet components to render as bottom-drawer on mobile vs right-side panel on desktop.

### Sticky sidebars

Many detail pages use `lg:sticky lg:top-6` for the right-side sidebar (e.g. `OrderCreateView`'s `DeliverySidebar`). On mobile, the sidebar appears below the main content (in normal flow).

## 13. Form patterns

### React Hook Form + Zod

All forms use React Hook Form with `@hookform/resolvers/zod` for schema validation:

```tsx
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

const schema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(8, 'Min 8 characters'),
})
type FormValues = z.infer<typeof schema>

const form = useForm<FormValues>({
  resolver: zodResolver(schema),
  defaultValues: { email: '', password: '' },
})

const onSubmit = (data: FormValues) => {
  // call api.post(...)
}
```

The Zod schemas live in `src/lib/validations/`:
- `auth.ts` — `loginSchema`, `registerSchema`
- `customer.schemas.ts` — `createCustomerSchema`
- `order.schemas.ts` — `createManualOrderSchema`, `convertPaymentSchema`, `updatePaymentScreenshotSchema`, `markCodCollectedSchema`, `cancelOrderSchema`, `updateCompanyOrderSettingsSchema`, `shopifyOrderWebhookSchema`
- `product.ts` — `productSchema`, `variantSchema`, `updateProductSchema`, `promoteProductSchema`, `demoteProductSchema`, `selectiveAccessSchema`, `setCompanyPricingSchema`, `categorySchema`, `brandSchema`, `attributeSchema`, `attributeValueSchema`, `generateStitchedSchema`
- `inventory.ts` — `receiveStockSchema`, `adjustStockSchema`, `openingStockSchema`, `fulfillMadeToOrderSchema`
- `stock-loss.ts` — `reportDamagedLossSchema`, `reportTheftLossSchema`, `reportTransitLossSchema`, `resolveTheftOrMissingLossSchema`, `resolveTransitLossSchema`
- `exchange.schemas.ts` — `createExchangeRequestSchema`, `confirmCustomerShippedSchema`, `verifyOldItemReceivedSchema`, `settlePriceDifferenceSchema`, `markNotReturnedSchema`, `cancelExchangeSchema`, `listExchangesFiltersSchema`
- `employee.ts` — `inviteEmployeeSchema`, `terminateEmployeeSchema`
- `invitation.ts` — `createRoleSchema`, `updateRoleSchema`
- `organization.ts` — `createOrganizationSchema`, `updateOrganizationSchema`, `createCompanySchema`, `archiveSchema`
- `company.ts` — `updateCompanySchema`

### Idempotency pattern

Creation forms use the `useIdempotentMutation` hook (see §4) which auto-injects an `Idempotency-Key` header. The key is generated once per component mount and persists across re-renders — preventing duplicate submissions from rapid double-clicks.

## 14. Performance patterns

### Lazy loading

Every view component (except `AuthShell` and `DashboardShell`) is lazy-loaded via `next/dynamic` with `ssr: false`:

```tsx
const OrdersView = dynamic(() => import('@/components/orders/orders-view').then(m => ({ default: m.OrdersView })), {
  ssr: false,
  loading: LoadingFallback,
})
```

This keeps the initial bundle small — only the active view's code is loaded.

### Route-aware loading fallback

`ROUTE_METADATA` is a static map of route name → title/description. When the user navigates, the `PageHeader` (containing the LCP text element) renders IMMEDIATELY using the route metadata — it doesn't wait for the lazy chunk to download. This makes navigation feel instant.

```tsx
const ROUTE_METADATA: Record<string, { title: string; description?: string }> = {
  dashboard: { title: 'Dashboard' },
  products: { title: 'Products', description: '...' },
  'product-create': { title: 'Create Product', description: '...' },
  // ...
}
```

### Workspace cache (server-side)

The 60s in-memory cache in `src/lib/workspace-cache.ts` is critical for performance — `getWorkspace()` is called on EVERY API request, and without the cache, every request would do a 5-table JOIN. The cache hits ~99% of the time, dropping request latency from ~50ms to ~5ms.

### TanStack Query staleTime

The global `staleTime: 30_000` (30s) prevents excessive refetching. Most list views use the default; some use longer (e.g. session uses 60s, draft counts use 60s).

## 15. Sidebar navigation structure

The sidebar (`src/components/layout/sidebar.tsx`) has 5 main sections + ~30 nav items:

### Products (5 items)
- All Products (`products`)
- Add Product (`product-create`)
- Product Drafts (`product-drafts`)
- Returned Stock (`returned-stitched`)
- Catalog Settings (`product-settings`)

### Inventory (11 items)
- Dashboard (`inventory`)
- Locations (`inventory-locations`)
- Suppliers (`inventory-suppliers`)
- Receive Stock (`inventory-receive`)
- Adjust Stock (`inventory-adjust`)
- Transfer Stock (`inventory-transfer`)
- Purchase Orders (`inventory-purchase-orders`)
- Supplier Returns (`inventory-supplier-returns`)
- Production Orders (`inventory-production-orders`)
- Losses & Write-offs (`inventory-losses`)
- Cycle Counts (`inventory-cycle-counts`)

### Orders (12 items)
- All Orders (`orders`)
- Create Order (`order-create`)
- Order Drafts (`order-drafts`)
- Pending Confirmation (`orders-pending-confirmation`)
- Backordered (`orders-backordered`)
- Awaiting Production (`orders-awaiting-production`)
- Ready to Dispatch (`orders-ready-to-dispatch`)
- Booking Workbench (`booking-workbench`)
- Order Scan (`order-scan`)
- Returns & RTO (`orders-returns`)
- Exchanges (`exchanges`)
- Cancelled (`orders-cancelled`)

### Top-level
- Customers (`customers`)
- Order Options (`order-workflow-settings`) — elevated-only
- Integrations (`integrations`) — elevated-only
- Integration Logs (`integration-logs`) — elevated-only

### Admin (8 items)
- Employees (`employees`)
- Payroll (`payroll`)
- Roles & Permissions (`roles`)
- Org Catalog (`org-catalog`) — elevated-only
- Organization (`organization`) — elevated-only
- Company Settings (`company-settings`)
- Audit Log (`audit`)
- Personal Settings (`settings`)

### Draft count badges

The sidebar shows draft count badges next to "All Products", "Product Drafts", "All Orders", and "Order Drafts" — refreshed every 60s via `refetchInterval: 60_000`:

```tsx
const productDraftsQuery = useQuery<{ count: number }>({
  queryKey: ['draft-count', 'product'],
  queryFn: () => api.get('/api/drafts?draftType=product&mode=count'),
  staleTime: 60_000,
  refetchInterval: 60_000,
})
```

### Permission gating

Each nav item has either:
- `permission: PERMISSIONS.X` — visible only if `can(PERMISSIONS.X)` returns true (or user is elevated).
- `elevatedOnly: true` — visible only to elevated roles.
- Neither — visible to all authenticated users.

Items with `children` are rendered as collapsible groups (default expanded: Products, Inventory, Orders).

## 16. Layout shell

`src/components/layout/dashboard-shell.tsx` defines the authenticated app's layout:

```tsx
export function DashboardShell({ children }: { ReactNode }) {
  return (
    <div className="min-h-screen flex bg-background">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-background/80 backdrop-blur px-4 sm:px-6">
          <MobileNav />
          <WorkspaceSwitcher />
          <div className="hidden lg:flex items-center relative max-w-xs flex-1">
            <Search className="absolute left-3 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search…" className="pl-9 h-9 bg-muted/50 border-transparent focus-visible:bg-background" />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto scrollbar-thin">
          <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
```

The header has:
- `MobileNav` (hamburger button, hidden on `md+`)
- `WorkspaceSwitcher` (active company dropdown)
- Search bar (hidden below `lg`)
- `UserMenu` (avatar dropdown with logout)

The header is `sticky top-0 z-30` with `bg-background/80 backdrop-blur` — content scrolls under it.

`PageHeader` is a standardized header component for view pages:

```tsx
export function PageHeader({ title, description, actions }: { title, description?, actions? }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
```

## 17. Toasts & error feedback

### Sonner (global toaster)

`src/components/providers.tsx` mounts the global toaster:

```tsx
<Toaster richColors position="top-right" closeButton />
```

Used everywhere via `toast.success()` / `toast.error()` / `toast.loading()` from the `sonner` package.

### Standard error feedback pattern

```tsx
import { toast } from 'sonner'
import { getErrorMessage } from '@/components/orders/_shared'

const mutation = useMutation({
  mutationFn: (data) => api.post('/api/orders', data, { 'Idempotency-Key': key }),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['orders'] })
    toast.success('Order created successfully')
    navigate({ name: 'order-detail', id: data.orderId })
  },
  onError: (err) => {
    toast.error(getErrorMessage(err))
  },
})
```

## 18. Build / deployment notes

- **`runtime = 'nodejs'`** — every API route opts out of Edge runtime (uses Prisma + node-only deps).
- **`dynamic = 'force-dynamic'`** — every route is non-cacheable.
- **`'use client'`** directive at the top of every component that uses hooks (which is almost all of them).
- **`suppressHydrationWarning`** on `<html>` and `<body>` (required for `next-themes`).
- **`cache: 'no-store'`** in `api-client.ts` — API responses are never cached by the browser.
- **Local filesystem storage** for uploaded PDFs and images (`/public/uploads/...`) — **Vercel deployment bomb** (won't persist on serverless). Production uses Hostinger VPS.
- **Session token in localStorage** — works in all contexts (iframe, cross-origin, mobile) but is XSS-readable. Mitigation: short session lifetime (`SESSION_MAX_AGE`) + `httpOnly` cookie as a secondary channel.

---

End of FRONTEND_GUIDE.md.
