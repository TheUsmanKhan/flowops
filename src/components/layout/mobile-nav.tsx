'use client'

import { useState } from 'react'
import { useAppStore, type AppRoute } from '@/stores/app-store'
import { FlowOpsLogo } from '@/components/layout/brand'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  LayoutDashboard,
  Users,
  ShieldCheck,
  Building2,
  Settings,
  ScrollText,
  Menu,
  Package,
  RotateCcw,
  Sliders,
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
} from 'lucide-react'
import { useCan } from '@/stores/app-store'
import { PERMISSIONS } from '@/lib/permissions'

interface NavItem {
  route: AppRoute
  label: string
  icon: typeof LayoutDashboard
  permission?: string
  matchPrefixes?: string[]
  elevatedOnly?: boolean
}

const NAV: NavItem[] = [
  { route: { name: 'dashboard' }, label: 'Dashboard', icon: LayoutDashboard, matchPrefixes: ['dashboard'] },
  { route: { name: 'products' }, label: 'Products', icon: Package, permission: PERMISSIONS.PRODUCTS_VIEW, matchPrefixes: ['products', 'product'] },
  { route: { name: 'returned-stitched' }, label: 'Returned Stock', icon: RotateCcw, matchPrefixes: ['returned-stitched'] },
  { route: { name: 'product-settings' }, label: 'Catalog Settings', icon: Sliders, matchPrefixes: ['product-settings'] },
  { route: { name: 'inventory' }, label: 'Inventory Dashboard', icon: Warehouse, permission: PERMISSIONS.INVENTORY_VIEW, matchPrefixes: ['inventory'] },
  { route: { name: 'inventory-locations' }, label: 'Locations', icon: Warehouse, matchPrefixes: ['inventory-location'] },
  { route: { name: 'inventory-suppliers' }, label: 'Suppliers', icon: Truck, matchPrefixes: ['inventory-supplier'] },
  { route: { name: 'inventory-receive' }, label: 'Receive Stock', icon: PackagePlus, matchPrefixes: ['inventory-receive'] },
  { route: { name: 'inventory-adjust' }, label: 'Adjust Stock', icon: SlidersHorizontal, matchPrefixes: ['inventory-adjust'] },
  { route: { name: 'inventory-transfer' }, label: 'Transfer Stock', icon: ArrowLeftRight, matchPrefixes: ['inventory-transfer'] },
  { route: { name: 'inventory-purchase-orders' }, label: 'Purchase Orders', icon: ShoppingCart, matchPrefixes: ['inventory-po'] },
  { route: { name: 'inventory-supplier-returns' }, label: 'Supplier Returns', icon: Undo2, matchPrefixes: ['inventory-supplier-return'] },
  { route: { name: 'inventory-production-orders' }, label: 'Production Orders', icon: Factory, matchPrefixes: ['inventory-production'] },
  { route: { name: 'inventory-losses' }, label: 'Losses', icon: AlertTriangle, matchPrefixes: ['inventory-loss'] },
  { route: { name: 'inventory-cycle-counts' }, label: 'Cycle Counts', icon: ClipboardCheck, matchPrefixes: ['inventory-cycle'] },
  { route: { name: 'orders' }, label: 'Orders', icon: ShoppingCart, permission: PERMISSIONS.ORDERS_VIEW, matchPrefixes: ['order'] },
  { route: { name: 'customers' }, label: 'Customers', icon: Users, permission: PERMISSIONS.ORDERS_VIEW, matchPrefixes: ['customers'] },
  { route: { name: 'order-workflow-settings' }, label: 'Order Settings', icon: SlidersHorizontal, elevatedOnly: true, matchPrefixes: ['order-workflow'] },
  { route: { name: 'org-catalog' }, label: 'Org Catalog', icon: Globe, matchPrefixes: ['org-catalog'] },
  { route: { name: 'employees' }, label: 'Employees', icon: Users, permission: PERMISSIONS.EMPLOYEES_VIEW, matchPrefixes: ['employees'] },
  { route: { name: 'roles' }, label: 'Roles & Permissions', icon: ShieldCheck, permission: PERMISSIONS.SETTINGS_ROLES_MANAGE, matchPrefixes: ['roles'] },
  { route: { name: 'organization' }, label: 'Organization', icon: Building2, matchPrefixes: ['organization', 'create-company'] },
  { route: { name: 'company-settings' }, label: 'Company Settings', icon: Settings, matchPrefixes: ['company-settings'] },
  { route: { name: 'audit' }, label: 'Audit Log', icon: ScrollText, permission: PERMISSIONS.AUDIT_VIEW, matchPrefixes: ['audit'] },
  { route: { name: 'settings' }, label: 'Personal Settings', icon: Settings, matchPrefixes: ['settings'] },
]

export function MobileNav() {
  const [open, setOpen] = useState(false)
  const route = useAppStore((s) => s.route)
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()

  const isMatch = (item: NavItem) =>
    item.matchPrefixes
      ? item.matchPrefixes.some((p) => route.name.startsWith(p))
      : route.name === item.route.name

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden h-9 w-9">
          <Menu className="h-5 w-5" />
          <span className="sr-only">Open menu</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-64 p-0 bg-sidebar text-sidebar-foreground">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <div className="flex items-center gap-2.5 h-16 px-5 border-b border-sidebar-border">
          <FlowOpsLogo className="h-7 w-7 text-primary" />
          <span className="font-semibold tracking-tight">FlowOps</span>
        </div>
        <nav className="p-3 space-y-1">
          {NAV.map((item) => {
            const Icon = item.icon
            const allowed = !item.permission || can(item.permission)
            if (!allowed) return null
            const active = isMatch(item)
            return (
              <button
                key={item.label}
                onClick={() => {
                  navigate(item.route)
                  setOpen(false)
                }}
                className={cn(
                  'w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                    : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
      </SheetContent>
    </Sheet>
  )
}
