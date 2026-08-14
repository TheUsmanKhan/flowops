'use client'

import { useEffect } from 'react'
import dynamic from 'next/dynamic'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import { queryToRoute, replaceRouteInURL } from '@/lib/routing/url-sync'
import type { SessionResponse } from '@/lib/types'
import { Loader2 } from 'lucide-react'

// ─── Always-needed (NOT lazy-loaded) ────────────────────────────────
import { AuthShell } from '@/components/auth/auth-shell'
import { DashboardShell } from '@/components/layout/dashboard-shell'

// ─── Loading fallback (reused for all lazy components) ─────────────
const LoadingFallback = () => (
  <div className="flex items-center justify-center py-20">
    <Loader2 className="h-6 w-6 animate-spin text-primary" />
  </div>
)

// ─── Auth views (small, but lazy-loaded to keep login page fast) ────
const LoginForm = dynamic(() => import('@/components/auth/login-form').then(m => ({ default: m.LoginForm })), { ssr: false, loading: LoadingFallback })
const RegisterForm = dynamic(() => import('@/components/auth/register-form').then(m => ({ default: m.RegisterForm })), { ssr: false, loading: LoadingFallback })
const ForgotPasswordForm = dynamic(() => import('@/components/auth/forgot-password-form').then(m => ({ default: m.ForgotPasswordForm })), { ssr: false, loading: LoadingFallback })
const ResetPasswordForm = dynamic(() => import('@/components/auth/reset-password-form').then(m => ({ default: m.ResetPasswordForm })), { ssr: false, loading: LoadingFallback })

// ─── Onboarding views ──────────────────────────────────────────────
const OnboardingView = dynamic(() => import('@/components/onboarding/onboarding-view').then(m => ({ default: m.OnboardingView })), { ssr: false, loading: LoadingFallback })
const CreateOrganizationView = dynamic(() => import('@/components/onboarding/create-organization-view').then(m => ({ default: m.CreateOrganizationView })), { ssr: false, loading: LoadingFallback })
const CreateCompanyView = dynamic(() => import('@/components/onboarding/create-company-view').then(m => ({ default: m.CreateCompanyView })), { ssr: false, loading: LoadingFallback })

// ─── Dashboard ─────────────────────────────────────────────────────
const DashboardHome = dynamic(() => import('@/components/dashboard/dashboard-home').then(m => ({ default: m.DashboardHome })), { ssr: false, loading: LoadingFallback })

// ─── Employees ─────────────────────────────────────────────────────
const EmployeesView = dynamic(() => import('@/components/employees/employees-view').then(m => ({ default: m.EmployeesView })), { ssr: false, loading: LoadingFallback })
const InviteEmployeeView = dynamic(() => import('@/components/employees/invite-employee-view').then(m => ({ default: m.InviteEmployeeView })), { ssr: false, loading: LoadingFallback })
const EmployeeDetailView = dynamic(() => import('@/components/employees/employee-detail-view').then(m => ({ default: m.EmployeeDetailView })), { ssr: false, loading: LoadingFallback })

// ─── Roles ─────────────────────────────────────────────────────────
const RolesView = dynamic(() => import('@/components/roles/roles-view').then(m => ({ default: m.RolesView })), { ssr: false, loading: LoadingFallback })
const RoleEditView = dynamic(() => import('@/components/roles/role-edit-view').then(m => ({ default: m.RoleEditView })), { ssr: false, loading: LoadingFallback })

// ─── Settings ──────────────────────────────────────────────────────
const OrganizationView = dynamic(() => import('@/components/settings/organization-view').then(m => ({ default: m.OrganizationView })), { ssr: false, loading: LoadingFallback })
const CompanySettingsView = dynamic(() => import('@/components/settings/company-settings-view').then(m => ({ default: m.CompanySettingsView })), { ssr: false, loading: LoadingFallback })
const SettingsView = dynamic(() => import('@/components/settings/settings-view').then(m => ({ default: m.SettingsView })), { ssr: false, loading: LoadingFallback })
const AuditLogView = dynamic(() => import('@/components/settings/audit-log-view').then(m => ({ default: m.AuditLogView })), { ssr: false, loading: LoadingFallback })
const IntegrationsView = dynamic(() => import('@/components/settings/integrations-view').then(m => ({ default: m.IntegrationsView })), { ssr: false, loading: LoadingFallback })
const IntegrationLogsView = dynamic(() => import('@/components/settings/integration-logs-view').then(m => ({ default: m.IntegrationLogsView })), { ssr: false, loading: LoadingFallback })

// ─── Payroll ───────────────────────────────────────────────────────
const PayrollView = dynamic(() => import('@/components/payroll/payroll-view').then(m => ({ default: m.PayrollView })), { ssr: false, loading: LoadingFallback })
const PayrollRunDetailView = dynamic(() => import('@/components/payroll/payroll-run-detail-view').then(m => ({ default: m.PayrollRunDetailView })), { ssr: false, loading: LoadingFallback })

// ─── Products (largest: product-create 2321, catalog-settings 2289, product-detail 1949) ──
const ProductsView = dynamic(() => import('@/components/products/products-view').then(m => ({ default: m.ProductsView })), { ssr: false, loading: LoadingFallback })
const ProductCreateView = dynamic(() => import('@/components/products/product-create-view').then(m => ({ default: m.ProductCreateView })), { ssr: false, loading: LoadingFallback })
const ProductDetailView = dynamic(() => import('@/components/products/product-detail-view').then(m => ({ default: m.ProductDetailView })), { ssr: false, loading: LoadingFallback })
const CatalogSettingsView = dynamic(() => import('@/components/products/catalog-settings-view').then(m => ({ default: m.CatalogSettingsView })), { ssr: false, loading: LoadingFallback })
const ReturnedStitchedView = dynamic(() => import('@/components/products/returned-stitched-view').then(m => ({ default: m.ReturnedStitchedView })), { ssr: false, loading: LoadingFallback })
const OrgCatalogView = dynamic(() => import('@/components/products/org-catalog-view').then(m => ({ default: m.OrgCatalogView })), { ssr: false, loading: LoadingFallback })

// ─── Inventory (largest: losses 2249, cycle-counts 2249) ───────────
const InventoryDashboardView = dynamic(() => import('@/components/inventory/inventory-dashboard-view').then(m => ({ default: m.InventoryDashboardView })), { ssr: false, loading: LoadingFallback })
const LocationsView = dynamic(() => import('@/components/inventory/locations-view').then(m => ({ default: m.LocationsView })), { ssr: false, loading: LoadingFallback })
const LocationDetailView = dynamic(() => import('@/components/inventory/location-detail-view').then(m => ({ default: m.LocationDetailView })), { ssr: false, loading: LoadingFallback })
const SuppliersView = dynamic(() => import('@/components/inventory/suppliers-view').then(m => ({ default: m.SuppliersView })), { ssr: false, loading: LoadingFallback })
const SupplierDetailView = dynamic(() => import('@/components/inventory/supplier-detail-view').then(m => ({ default: m.SupplierDetailView })), { ssr: false, loading: LoadingFallback })
const ReceiveStockView = dynamic(() => import('@/components/inventory/receive-stock-view').then(m => ({ default: m.ReceiveStockView })), { ssr: false, loading: LoadingFallback })
const AdjustStockView = dynamic(() => import('@/components/inventory/adjust-stock-view').then(m => ({ default: m.AdjustStockView })), { ssr: false, loading: LoadingFallback })
const TransferStockView = dynamic(() => import('@/components/inventory/transfer-stock-view').then(m => ({ default: m.TransferStockView })), { ssr: false, loading: LoadingFallback })
const PurchaseOrdersView = dynamic(() => import('@/components/inventory/purchase-orders-view').then(m => ({ default: m.PurchaseOrdersView })), { ssr: false, loading: LoadingFallback })
const PoCreateView = dynamic(() => import('@/components/inventory/po-create-view').then(m => ({ default: m.PoCreateView })), { ssr: false, loading: LoadingFallback })
const PoDetailView = dynamic(() => import('@/components/inventory/po-detail-view').then(m => ({ default: m.PoDetailView })), { ssr: false, loading: LoadingFallback })
const SupplierReturnsView = dynamic(() => import('@/components/inventory/supplier-returns-view').then(m => ({ default: m.SupplierReturnsView })), { ssr: false, loading: LoadingFallback })
const ProductionOrdersView = dynamic(() => import('@/components/inventory/production-orders-view').then(m => ({ default: m.ProductionOrdersView })), { ssr: false, loading: LoadingFallback })
const LossesView = dynamic(() => import('@/components/inventory/losses-view').then(m => ({ default: m.LossesView })), { ssr: false, loading: LoadingFallback })
const LossDetailView = dynamic(() => import('@/components/inventory/loss-detail-view').then(m => ({ default: m.LossDetailView })), { ssr: false, loading: LoadingFallback })
const CycleCountsView = dynamic(() => import('@/components/inventory/cycle-counts-view').then(m => ({ default: m.CycleCountsView })), { ssr: false, loading: LoadingFallback })

// ─── Orders (largest: orders-view 2599, order-create 2390, order-detail 2040) ──
const OrdersView = dynamic(() => import('@/components/orders/orders-view').then(m => ({ default: m.OrdersView })), { ssr: false, loading: LoadingFallback })
const OrderCreateView = dynamic(() => import('@/components/orders/order-create-view').then(m => ({ default: m.OrderCreateView })), { ssr: false, loading: LoadingFallback })
const OrderDetailView = dynamic(() => import('@/components/orders/order-detail-view').then(m => ({ default: m.OrderDetailView })), { ssr: false, loading: LoadingFallback })
const OrdersPendingConfirmationView = dynamic(() => import('@/components/orders/orders-pending-confirmation-view').then(m => ({ default: m.OrdersPendingConfirmationView })), { ssr: false, loading: LoadingFallback })
const OrdersBackorderedView = dynamic(() => import('@/components/orders/orders-backordered-view').then(m => ({ default: m.OrdersBackorderedView })), { ssr: false, loading: LoadingFallback })
const OrdersAwaitingProductionView = dynamic(() => import('@/components/orders/orders-awaiting-production-view').then(m => ({ default: m.OrdersAwaitingProductionView })), { ssr: false, loading: LoadingFallback })
const OrdersReadyToDispatchView = dynamic(() => import('@/components/orders/orders-ready-to-dispatch-view').then(m => ({ default: m.OrdersReadyToDispatchView })), { ssr: false, loading: LoadingFallback })
const OrdersReturnsView = dynamic(() => import('@/components/orders/orders-returns-view').then(m => ({ default: m.OrdersReturnsView })), { ssr: false, loading: LoadingFallback })
const OrdersReturnsReviewView = dynamic(() => import('@/components/orders/orders-returns-review-view').then(m => ({ default: m.OrdersReturnsReviewView })), { ssr: false, loading: LoadingFallback })
const OrdersCancelledView = dynamic(() => import('@/components/orders/orders-cancelled-view').then(m => ({ default: m.OrdersCancelledView })), { ssr: false, loading: LoadingFallback })
const ExchangesView = dynamic(() => import('@/components/orders/exchanges-view').then(m => ({ default: m.ExchangesView })), { ssr: false, loading: LoadingFallback })
const ExchangeDetailView = dynamic(() => import('@/components/orders/exchange-detail-view').then(m => ({ default: m.ExchangeDetailView })), { ssr: false, loading: LoadingFallback })
const CustomersView = dynamic(() => import('@/components/orders/customers-view').then(m => ({ default: m.CustomersView })), { ssr: false, loading: LoadingFallback })
const CustomerDetailView = dynamic(() => import('@/components/orders/customer-detail-view').then(m => ({ default: m.CustomerDetailView })), { ssr: false, loading: LoadingFallback })
const OrderWorkflowSettingsView = dynamic(() => import('@/components/orders/order-workflow-settings-view').then(m => ({ default: m.OrderWorkflowSettingsView })), { ssr: false, loading: LoadingFallback })
const BookingWorkbenchView = dynamic(() => import('@/components/orders/booking-workbench-view').then(m => ({ default: m.BookingWorkbenchView })), { ssr: false, loading: LoadingFallback })
const OrderScanView = dynamic(() => import('@/components/orders/order-scan-view').then(m => ({ default: m.OrderScanView })), { ssr: false, loading: LoadingFallback })

// ─── Shared ────────────────────────────────────────────────────────
const DraftsView = dynamic(() => import('@/components/shared/drafts-view').then(m => ({ default: m.DraftsView })), { ssr: false, loading: LoadingFallback })

export default function Page() {
  const { hydrated, loading, route, user, activeCompany, employee, setSession, setHydrated, navigate, reset } =
    useAppStore()

  // Hydrate session on first load.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const session = await api.get<SessionResponse>('/api/auth/me')
        if (cancelled) return

        // URL sync: restore route from URL query string on initial load/refresh
        const urlRoute = queryToRoute()
        const currentRoute = useAppStore.getState().route

        setSession({
          user: session.user,
          activeCompany: session.activeCompany,
          companies: session.companies,
          employee: session.employee ?? undefined,
        })

        // If the URL has a route, restore it (overrides the default 'login')
        if (urlRoute && urlRoute.name !== currentRoute.name) {
          // Only restore if user is authenticated (urlRoute could be a protected view)
          if (session.user) {
            useAppStore.getState().navigate(urlRoute)
          }
        }
      } catch {
        if (cancelled) return
        setHydrated(true)
      }
    })()
    return () => {
      cancelled = true
    }
     
  }, [])

  // Browser back/forward: sync URL → Zustand state
  // NOTE: The useFormGuard's use-browser-back-guard also listens to popstate.
  // When the guard is active (form is dirty), it re-pushes the URL to cancel
  // the back navigation. We need to make sure our handler doesn't fight it.
  // We use a global flag that the guard sets when it's intercepting.
  useEffect(() => {
    function handlePopState() {
      // If the form guard is intercepting, skip our sync — the guard will
      // handle the modal, and if the user confirms, the guard calls
      // window.history.back() which will trigger another popstate that we'll handle.
      if (typeof window !== 'undefined' && window.__formGuardIntercepting) {
        return
      }
      const urlRoute = queryToRoute()
      if (urlRoute) {
        // Use set() directly, NOT navigate(), to avoid pushing a new history entry
        useAppStore.setState({ route: urlRoute })
      }
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  // URL sync: ensure the address bar always reflects the current route
  // (covers the case where user lands on "/" with no query string)
  // Must be before any early returns to satisfy React Hooks rules.
  useEffect(() => {
    if (hydrated) {
      replaceRouteInURL(route)
    }
     
  }, [hydrated, route.name, 'id' in route ? route.id : '', 'token' in route ? route.token : ''])

  // Loading screen while hydrating.
  if (!hydrated && loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }
  if (!hydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  // ---- Unauthenticated views ----
  if (!user) {
    if (route.name === 'register') {
      return (
        <AuthShell
          title="Create your account"
          subtitle="Start managing your e-commerce operations in minutes."
        >
          <RegisterForm />
        </AuthShell>
      )
    }
    if (route.name === 'forgot') {
      return (
        <AuthShell
          title="Reset your password"
          subtitle="We'll email you a secure recovery link."
        >
          <ForgotPasswordForm />
        </AuthShell>
      )
    }
    if (route.name === 'reset') {
      return (
        <AuthShell
          title="Set a new password"
          subtitle="Choose a strong password for your account."
        >
          <ResetPasswordForm token={route.token} />
        </AuthShell>
      )
    }
    // default: login
    return (
      <AuthShell
        title="Welcome back"
        subtitle="Sign in to your FlowOps workspace."
      >
        <LoginForm />
      </AuthShell>
    )
  }

  // ---- Authenticated but not onboarded ----
  // Allow create-organization even before onboarding completes.
  if (user && route.name === 'create-organization') {
    return (
      <DashboardShell>
        <CreateOrganizationView onBack={() => navigate({ name: user.isOnboarded && activeCompany ? 'dashboard' : 'onboarding' })} />
      </DashboardShell>
    )
  }
  if (!user.isOnboarded || !activeCompany) {
    if (route.name === 'create-company') {
      return (
        <DashboardShell>
          <CreateCompanyView onBack={() => navigate({ name: 'onboarding' })} />
        </DashboardShell>
      )
    }
    return <OnboardingView />
  }

  // ---- Authenticated + onboarded: dashboard shell ----
  return <DashboardShell>{renderRoute(route, employee)}</DashboardShell>
}

function renderRoute(
  route: ReturnType<typeof useAppStore.getState>['route'],
  employee: ReturnType<typeof useAppStore.getState>['employee'],
) {
  switch (route.name) {
    case 'dashboard':
      return <DashboardHome />
    case 'employees':
      return <EmployeesView />
    case 'employees-invite':
      return <InviteEmployeeView />
    case 'employee-detail':
      return <EmployeeDetailView employeeId={route.id} />
    case 'roles':
      return <RolesView />
    case 'role-edit':
      return <RoleEditView roleId={route.id} />
    case 'organization':
      return <OrganizationView />
    case 'company-settings':
      return <CompanySettingsView />
    case 'settings':
      return <SettingsView />
    case 'audit':
      return <AuditLogView />
    case 'payroll':
      return <PayrollView />
    case 'payroll-run-detail':
      return <PayrollRunDetailView runId={route.id} />
    case 'create-organization':
      return <CreateOrganizationViewWithBack />
    case 'create-company':
      return <CreateCompanyViewWithBack orgId={route.orgId} />
    case 'products':
      return <ProductsView />
    case 'product-create':
      return <ProductCreateViewWithBack draftId={route.draftId} />
    case 'product-drafts':
      return <DraftsView />
    case 'product-detail':
      return <ProductDetailView productId={route.id} />
    case 'product-settings':
      return <CatalogSettingsView />
    case 'returned-stitched':
      return <ReturnedStitchedView />
    case 'org-catalog':
      return <OrgCatalogView />
    case 'inventory':
      return <InventoryDashboardView />
    case 'inventory-locations':
      return <LocationsView />
    case 'inventory-location-detail':
      return <LocationDetailView locationId={route.id} />
    case 'inventory-suppliers':
      return <SuppliersView />
    case 'inventory-supplier-detail':
      return <SupplierDetailView supplierId={route.id} />
    case 'inventory-receive':
      return <ReceiveStockView />
    case 'inventory-adjust':
      return <AdjustStockView />
    case 'inventory-transfer':
      return <TransferStockView />
    case 'inventory-purchase-orders':
      return <PurchaseOrdersView />
    case 'inventory-po-create':
      return <PoCreateView />
    case 'inventory-po-detail':
      return <PoDetailView poId={route.id} />
    case 'inventory-supplier-returns':
      return <SupplierReturnsView />
    case 'inventory-production-orders':
      return <ProductionOrdersView />
    case 'inventory-losses':
      return <LossesView />
    case 'inventory-loss-detail':
      return <LossDetailView lossId={route.id} />
    case 'inventory-cycle-counts':
      return <CycleCountsView />
    case 'orders':
      return <OrdersView />
    case 'order-create':
      return <OrderCreateViewWithBack draftId={route.draftId} />
    case 'order-drafts':
      return <DraftsView />
    case 'order-detail':
      return <OrderDetailView orderId={route.id} />
    case 'orders-pending-confirmation':
      return <OrdersPendingConfirmationView />
    case 'orders-backordered':
      return <OrdersBackorderedView />
    case 'orders-awaiting-production':
      return <OrdersAwaitingProductionView />
    case 'orders-ready-to-dispatch':
      return <OrdersReadyToDispatchView />
    case 'orders-returns':
      return <OrdersReturnsView />
    case 'orders-returns-review':
      return <OrdersReturnsReviewView />
    case 'orders-cancelled':
      return <OrdersCancelledView />
    case 'exchanges':
      return <ExchangesView />
    case 'exchange-detail':
      return <ExchangeDetailView exchangeId={route.id} />
    case 'customers':
      return <CustomersView />
    case 'customer-detail':
      return <CustomerDetailView customerId={route.id} />
    case 'order-workflow-settings':
      return <OrderWorkflowSettingsView />
    case 'booking-workbench':
      return <BookingWorkbenchView />
    case 'order-scan':
      return <OrderScanView />
    case 'integrations':
      return <IntegrationsView />
    case 'integration-logs':
      return <IntegrationLogsView />
    default:
      return <DashboardHome />
  }
}

function CreateOrganizationViewWithBack() {
  const navigate = useAppStore((s) => s.navigate)
  return <CreateOrganizationView onBack={() => navigate({ name: 'dashboard' })} />
}

function CreateCompanyViewWithBack({ orgId }: { orgId?: string }) {
  const navigate = useAppStore((s) => s.navigate)
  return <CreateCompanyView orgId={orgId} onBack={() => navigate({ name: 'organization' })} />
}

function ProductCreateViewWithBack({ draftId }: { draftId?: string }) {
  const navigate = useAppStore((s) => s.navigate)
  return <ProductCreateView onBack={() => navigate({ name: 'products' })} draftId={draftId} />
}

function OrderCreateViewWithBack({ draftId }: { draftId?: string }) {
  const navigate = useAppStore((s) => s.navigate)
  return <OrderCreateView onBack={() => navigate({ name: 'orders' })} draftId={draftId} />
}
