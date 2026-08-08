'use client'

import { useEffect } from 'react'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import { queryToRoute, replaceRouteInURL } from '@/lib/routing/url-sync'
import type { SessionResponse } from '@/lib/types'
import { Loader2 } from 'lucide-react'

import { AuthShell } from '@/components/auth/auth-shell'
import { LoginForm } from '@/components/auth/login-form'
import { RegisterForm } from '@/components/auth/register-form'
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form'
import { ResetPasswordForm } from '@/components/auth/reset-password-form'
import { OnboardingView } from '@/components/onboarding/onboarding-view'
import { CreateOrganizationView } from '@/components/onboarding/create-organization-view'
import { CreateCompanyView } from '@/components/onboarding/create-company-view'
import { DashboardShell, PageHeader } from '@/components/layout/dashboard-shell'
import { DashboardHome } from '@/components/dashboard/dashboard-home'
import { EmployeesView } from '@/components/employees/employees-view'
import { InviteEmployeeView } from '@/components/employees/invite-employee-view'
import { EmployeeDetailView } from '@/components/employees/employee-detail-view'
import { RolesView } from '@/components/roles/roles-view'
import { RoleEditView } from '@/components/roles/role-edit-view'
import { OrganizationView } from '@/components/settings/organization-view'
import { CompanySettingsView } from '@/components/settings/company-settings-view'
import { SettingsView } from '@/components/settings/settings-view'
import { AuditLogView } from '@/components/settings/audit-log-view'
import { ProductsView } from '@/components/products/products-view'
import { ProductCreateView } from '@/components/products/product-create-view'
import { ProductDetailView } from '@/components/products/product-detail-view'
import { CatalogSettingsView } from '@/components/products/catalog-settings-view'
import { ReturnedStitchedView } from '@/components/products/returned-stitched-view'
import { OrgCatalogView } from '@/components/products/org-catalog-view'
import { InventoryDashboardView } from '@/components/inventory/inventory-dashboard-view'
import { LocationsView } from '@/components/inventory/locations-view'
import { LocationDetailView } from '@/components/inventory/location-detail-view'
import { SuppliersView } from '@/components/inventory/suppliers-view'
import { SupplierDetailView } from '@/components/inventory/supplier-detail-view'
import { ReceiveStockView } from '@/components/inventory/receive-stock-view'
import { AdjustStockView } from '@/components/inventory/adjust-stock-view'
import { TransferStockView } from '@/components/inventory/transfer-stock-view'
import { PurchaseOrdersView } from '@/components/inventory/purchase-orders-view'
import { PoCreateView } from '@/components/inventory/po-create-view'
import { PoDetailView } from '@/components/inventory/po-detail-view'
import { SupplierReturnsView } from '@/components/inventory/supplier-returns-view'
import { ProductionOrdersView } from '@/components/inventory/production-orders-view'
import { LossesView } from '@/components/inventory/losses-view'
import { LossDetailView } from '@/components/inventory/loss-detail-view'
import { CycleCountsView } from '@/components/inventory/cycle-counts-view'
import { OrdersView } from '@/components/orders/orders-view'
import { OrderCreateView } from '@/components/orders/order-create-view'
import { OrderDetailView } from '@/components/orders/order-detail-view'
import { OrdersPendingConfirmationView } from '@/components/orders/orders-pending-confirmation-view'
import { OrdersBackorderedView } from '@/components/orders/orders-backordered-view'
import { OrdersAwaitingProductionView } from '@/components/orders/orders-awaiting-production-view'
import { OrdersReadyToDispatchView } from '@/components/orders/orders-ready-to-dispatch-view'
import { OrdersReturnsView } from '@/components/orders/orders-returns-view'
import { OrdersReturnsReviewView } from '@/components/orders/orders-returns-review-view'
import { OrdersCancelledView } from '@/components/orders/orders-cancelled-view'
import { ExchangesView } from '@/components/orders/exchanges-view'
import { ExchangeDetailView } from '@/components/orders/exchange-detail-view'
import { CustomersView } from '@/components/orders/customers-view'
import { CustomerDetailView } from '@/components/orders/customer-detail-view'
import { OrderWorkflowSettingsView } from '@/components/orders/order-workflow-settings-view'
import { BookingWorkbenchView } from '@/components/orders/booking-workbench-view'
import { OrderScanView } from '@/components/orders/order-scan-view'
import { IntegrationsView } from '@/components/settings/integrations-view'
import { IntegrationLogsView } from '@/components/settings/integration-logs-view'
import { DraftsView } from '@/components/shared/drafts-view'
import { Card, CardContent } from '@/components/ui/card'

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
