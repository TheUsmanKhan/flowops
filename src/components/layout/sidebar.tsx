'use client'

import { useState } from 'react'
import { useAppStore, useCan, type AppRoute } from '@/stores/app-store'
import { FlowOpsLogo } from '@/components/layout/brand'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  Users,
  ShieldCheck,
  Building2,
  Settings,
  ScrollText,
  Package,
  Plus,
  RotateCcw,
  Sliders,
  ChevronDown,
  Globe,
  Warehouse,
  Truck,
  ArrowLeftRight,
  ShoppingCart,
  Undo2,
  Factory,
  AlertTriangle,
  ClipboardCheck,
  PackagePlus,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react'
import { PERMISSIONS } from '@/lib/permissions'

interface NavItem {
  route: AppRoute
  label: string
  icon: LucideIcon
  permission?: string
  matchPrefixes?: string[]
  children?: { route: AppRoute; label: string; icon: LucideIcon; matchPrefixes?: string[] }[]
  elevatedOnly?: boolean
}

const NAV: NavItem[] = [
  { route: { name: 'dashboard' }, label: 'Dashboard', icon: LayoutDashboard, matchPrefixes: ['dashboard'] },
  {
    route: { name: 'products' },
    label: 'Products',
    icon: Package,
    permission: PERMISSIONS.PRODUCTS_VIEW,
    matchPrefixes: ['product'],
    children: [
      { route: { name: 'products' }, label: 'All Products', icon: Package, matchPrefixes: ['products'] },
      { route: { name: 'product-create' }, label: 'Add Product', icon: Plus, matchPrefixes: ['product-create'] },
      { route: { name: 'returned-stitched' }, label: 'Returned Stock', icon: RotateCcw, matchPrefixes: ['returned-stitched'] },
      { route: { name: 'product-settings' }, label: 'Catalog Settings', icon: Sliders, matchPrefixes: ['product-settings'] },
    ],
  },
  {
    route: { name: 'inventory' },
    label: 'Inventory',
    icon: Warehouse,
    permission: PERMISSIONS.INVENTORY_VIEW,
    matchPrefixes: ['inventory'],
    children: [
      { route: { name: 'inventory' }, label: 'Dashboard', icon: LayoutDashboard, matchPrefixes: ['inventory'] },
      { route: { name: 'inventory-locations' }, label: 'Locations', icon: Warehouse, matchPrefixes: ['inventory-location'] },
      { route: { name: 'inventory-suppliers' }, label: 'Suppliers', icon: Truck, matchPrefixes: ['inventory-supplier'] },
      { route: { name: 'inventory-receive' }, label: 'Receive Stock', icon: PackagePlus, matchPrefixes: ['inventory-receive'] },
      { route: { name: 'inventory-adjust' }, label: 'Adjust Stock', icon: SlidersHorizontal, matchPrefixes: ['inventory-adjust'] },
      { route: { name: 'inventory-transfer' }, label: 'Transfer Stock', icon: ArrowLeftRight, matchPrefixes: ['inventory-transfer'] },
      { route: { name: 'inventory-purchase-orders' }, label: 'Purchase Orders', icon: ShoppingCart, matchPrefixes: ['inventory-po'] },
      { route: { name: 'inventory-supplier-returns' }, label: 'Supplier Returns', icon: Undo2, matchPrefixes: ['inventory-supplier-return'] },
      { route: { name: 'inventory-production-orders' }, label: 'Production Orders', icon: Factory, matchPrefixes: ['inventory-production'] },
      { route: { name: 'inventory-losses' }, label: 'Losses & Write-offs', icon: AlertTriangle, matchPrefixes: ['inventory-loss'] },
      { route: { name: 'inventory-cycle-counts' }, label: 'Cycle Counts', icon: ClipboardCheck, matchPrefixes: ['inventory-cycle'] },
    ],
  },
  { route: { name: 'employees' }, label: 'Employees', icon: Users, permission: PERMISSIONS.EMPLOYEES_VIEW, matchPrefixes: ['employees'] },
  { route: { name: 'roles' }, label: 'Roles & Permissions', icon: ShieldCheck, permission: PERMISSIONS.SETTINGS_ROLES_MANAGE, matchPrefixes: ['roles'] },
  { route: { name: 'org-catalog' }, label: 'Org Catalog', icon: Globe, elevatedOnly: true, matchPrefixes: ['org-catalog'] },
  { route: { name: 'organization' }, label: 'Organization', icon: Building2, matchPrefixes: ['organization', 'create-company'] },
  { route: { name: 'company-settings' }, label: 'Company Settings', icon: Settings, matchPrefixes: ['company-settings'] },
  { route: { name: 'audit' }, label: 'Audit Log', icon: ScrollText, permission: PERMISSIONS.AUDIT_VIEW, matchPrefixes: ['audit'] },
  { route: { name: 'settings' }, label: 'Personal Settings', icon: Settings, matchPrefixes: ['settings'] },
]

export function Sidebar() {
  const route = useAppStore((s) => s.route)
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const activeCompany = useAppStore((s) => s.activeCompany)
  const employee = useAppStore((s) => s.employee)
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['Products', 'Inventory']))

  const isElevated = employee?.isElevated ?? false

  const isMatch = (item: NavItem | { matchPrefixes?: string[] }) => {
    if (item.matchPrefixes) {
      return item.matchPrefixes.some((p) => route.name.startsWith(p))
    }
    return false
  }

  function toggle(label: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  return (
    <aside className="hidden md:flex w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border">
      <div className="flex items-center gap-2.5 h-16 px-5 border-b border-sidebar-border">
        <FlowOpsLogo className="h-7 w-7 text-primary" />
        <span className="font-semibold tracking-tight">FlowOps</span>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto scrollbar-thin">
        <p className="px-3 pb-2 text-[11px] font-medium uppercase tracking-wider text-sidebar-foreground/40">
          Workspace
        </p>
        {NAV.map((item) => {
          // Permission/elevated gate
          if (item.elevatedOnly && !isElevated) return null
          if (item.permission && !can(item.permission) && !isElevated) return null

          const Icon = item.icon
          const active = isMatch(item)
          const isExpanded = expanded.has(item.label)

          if (item.children) {
            return (
              <div key={item.label}>
                <button
                  onClick={() => toggle(item.label)}
                  className={cn(
                    'w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                    active
                      ? 'text-sidebar-accent-foreground'
                      : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1 text-left truncate">{item.label}</span>
                  <ChevronDown
                    className={cn(
                      'h-3.5 w-3.5 transition-transform',
                      isExpanded && 'rotate-180',
                    )}
                  />
                </button>
                {isExpanded && (
                  <div className="ml-4 mt-0.5 space-y-0.5 border-l border-sidebar-border pl-3">
                    {item.children.map((child) => {
                      const ChildIcon = child.icon
                      const childActive = isMatch(child)
                      return (
                        <button
                          key={child.label}
                          onClick={() => navigate(child.route)}
                          className={cn(
                            'w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                            childActive
                              ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                              : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/40 hover:text-sidebar-accent-foreground',
                          )}
                        >
                          <ChildIcon className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{child.label}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          }

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
