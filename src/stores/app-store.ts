'use client'

import { create } from 'zustand'
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
  | { name: 'audit' }
  | { name: 'create-organization' }
  | { name: 'create-company'; orgId?: string }
  | { name: 'products' }
  | { name: 'product-create' }
  | { name: 'product-detail'; id: string }
  | { name: 'product-settings' }
  | { name: 'returned-stitched' }
  | { name: 'org-catalog' }

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
    }
  },

  reset: () =>
    set({
      user: null,
      activeCompany: null,
      companies: [],
      employee: null,
      route: { name: 'login' },
      hydrated: true,
      loading: false,
    }),
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
