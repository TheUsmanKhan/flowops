'use client'

import { create } from 'zustand'
import { pushRouteToURL, replaceRouteInURL, queryToRoute } from '@/lib/routing/url-sync'
import type {
  UserPublic,
  CompanyPublic,
} from '@/lib/types'

/**
 * Client-side view routing for the FlowOps single-page shell.
 * The app lives on the `/` route; navigation between "pages" is handled
 * here so the preview is always reachable from the root URL.
 */
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
  // OMS
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

interface AppState {
  // session
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
  } | null
  hydrated: boolean
  loading: boolean

  // routing
  route: AppRoute

  // actions
  setSession: (s: {
    user: UserPublic | null
    activeCompany: CompanyPublic | null
    companies: CompanyPublic[]
    employee?: AppState['employee']
  }) => void
  setHydrated: (v: boolean) => void
  setLoading: (v: boolean) => void
  navigate: (route: AppRoute) => void
  reset: () => void
}

export const useAppStore = create<AppState>((set) => ({
  user: null,
  activeCompany: null,
  companies: [],
  employee: null,
  hydrated: false,
  loading: false,
  route: { name: 'login' },

  setSession: (s) =>
    set({
      user: s.user,
      activeCompany: s.activeCompany,
      companies: s.companies,
      employee: s.employee ?? null,
      hydrated: true,
      loading: false,
    }),

  setHydrated: (v) => set({ hydrated: v }),
  setLoading: (v) => set({ loading: v }),

  navigate: (route) => {
    set({ route })
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
      // URL sync: push the new route to the browser address bar
      pushRouteToURL(route)
    }
  },

  reset: () => {
    set({
      user: null,
      activeCompany: null,
      companies: [],
      employee: null,
      route: { name: 'login' },
      hydrated: true,
      loading: false,
    })
    if (typeof window !== 'undefined') {
      replaceRouteInURL({ name: 'login' })
    }
  },
}))

/** Permission check hook usable anywhere in the client. */
export function useCan(): (key: string) => boolean {
  const employee = useAppStore((s) => s.employee)
  return (key: string) => {
    if (!employee) return false
    if (employee.isElevated) return true
    return employee.permissions.includes(key)
  }
}
