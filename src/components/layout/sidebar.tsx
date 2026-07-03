'use client'

import { useAppStore, type AppRoute } from '@/stores/app-store'
import { FlowOpsLogo } from '@/components/layout/brand'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  Users,
  ShieldCheck,
  Building2,
  Settings,
  ScrollText,
  Gauge,
} from 'lucide-react'
import { useCan } from '@/stores/app-store'
import { PERMISSIONS } from '@/lib/permissions'
import { Button } from '@/components/ui/button'

interface NavItem {
  route: AppRoute
  label: string
  icon: typeof LayoutDashboard
  permission?: string
  matchPrefixes?: string[]
}

const NAV: NavItem[] = [
  { route: { name: 'dashboard' }, label: 'Dashboard', icon: LayoutDashboard, matchPrefixes: ['dashboard'] },
  { route: { name: 'employees' }, label: 'Employees', icon: Users, permission: PERMISSIONS.EMPLOYEES_VIEW, matchPrefixes: ['employees'] },
  { route: { name: 'roles' }, label: 'Roles & Permissions', icon: ShieldCheck, permission: PERMISSIONS.SETTINGS_ROLES_MANAGE, matchPrefixes: ['roles'] },
  { route: { name: 'organization' }, label: 'Organization', icon: Building2 },
  { route: { name: 'audit' }, label: 'Audit Log', icon: ScrollText, permission: PERMISSIONS.AUDIT_VIEW, matchPrefixes: ['audit'] },
  { route: { name: 'settings' }, label: 'Settings', icon: Settings, matchPrefixes: ['settings', 'company-settings'] },
]

export function Sidebar() {
  const route = useAppStore((s) => s.route)
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const activeCompany = useAppStore((s) => s.activeCompany)

  const isMatch = (item: NavItem) => {
    if (item.matchPrefixes) {
      return item.matchPrefixes.some((p) => route.name.startsWith(p))
    }
    return route.name === item.route.name
  }

  return (
    <aside className="hidden md:flex w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border">
      <div className="flex items-center gap-2.5 h-16 px-5 border-b border-sidebar-border">
        <FlowOpsLogo className="h-7 w-7 text-primary" />
        <span className="font-semibold tracking-tight">FlowOps</span>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto scrollbar-thin">
        <p className="px-3 pb-2 text-[11px] font-medium uppercase tracking-wider text-sidebar-foreground/40">
          Workspace
        </p>
        {NAV.map((item) => {
          const Icon = item.icon
          const allowed = !item.permission || can(item.permission)
          if (!allowed) return null
          const active = isMatch(item)
          return (
            <button
              key={item.label}
              onClick={() => navigate(item.route)}
              className={cn(
                'w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <div className="rounded-lg bg-sidebar-accent/50 p-3">
          <p className="text-[11px] uppercase tracking-wider text-sidebar-foreground/50 font-medium">
            Active company
          </p>
          <p className="mt-1 text-sm font-medium truncate">
            {activeCompany?.name ?? 'None'}
          </p>
          <p className="text-xs text-sidebar-foreground/50 truncate">
            {activeCompany?.baseCurrency ?? 'PKR'} · {activeCompany?.countryCode ?? 'PK'}
          </p>
        </div>
      </div>
    </aside>
  )
}
