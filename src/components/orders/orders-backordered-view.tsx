'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api-client'
import { useAppStore } from '@/stores/app-store'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  ChevronRight,
  RefreshCw,
  PackageX,
  Clock,
  Layers,
  AlertCircle,
} from 'lucide-react'
import { formatPKR, formatDate, getErrorMessage, badgeForStatus } from './_shared'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface BackorderedOrder {
  orderItemId: string
  orderId: string
  flowopsOrderNumber: string
  orderStatus: string
  customerName: string
  customerPhone: string
  quantity: number
  backorderedAt: string | null
  daysWaiting: number
}

interface BackorderGroup {
  variantId: string
  sku: string
  productTitle: string
  orders: BackorderedOrder[]
  totalQuantity: number
  totalValue: number
  oldestDays: number
}

interface BackorderedResponse {
  groups: BackorderGroup[]
  stats: {
    totalBackorderedItems: number
    totalBackorderedValue: number
    oldestWaitDays: number
    variantCount: number
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function OrdersBackorderedView() {
  const navigate = useAppStore((s) => s.navigate)
  const query = useQuery<BackorderedResponse>({
    queryKey: ['orders-backordered'],
    queryFn: () => api.get<BackorderedResponse>('/api/orders/backordered'),
    staleTime: 15_000,
  })

  const groups = query.data?.groups ?? []
  const stats = query.data?.stats

  // Sort groups: oldest first (FIFO — most urgent at top)
  const sortedGroups = useMemo(
    () => [...groups].sort((a, b) => b.oldestDays - a.oldestDays),
    [groups],
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Backordered"
        description="Items awaiting stock. Grouped by variant in FIFO order — fulfill from incoming PO receipts."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={query.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            Refresh
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Variants affected"
          value={`${stats?.variantCount ?? 0}`}
          icon={<Layers className="h-4 w-4" />}
        />
        <StatCard
          label="Backordered units"
          value={`${stats?.totalBackorderedItems ?? 0}`}
          icon={<PackageX className="h-4 w-4" />}
        />
        <StatCard
          label="Backordered value"
          value={formatPKR(stats?.totalBackorderedValue ?? 0)}
          icon={<AlertCircle className="h-4 w-4" />}
        />
        <StatCard
          label="Oldest wait"
          value={`${stats?.oldestWaitDays ?? 0}d`}
          icon={<Clock className="h-4 w-4" />}
        />
      </div>

      {query.isLoading ? (
        <Card>
          <CardContent className="p-3 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </CardContent>
        </Card>
      ) : query.isError ? (
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">
              Couldn&apos;t load backordered items. {getErrorMessage(query.error)}
            </p>
            <Button variant="outline" onClick={() => query.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : sortedGroups.length === 0 ? (
        <Card>
          <CardContent className="p-10 sm:p-14 text-center">
            <div className="mx-auto h-14 w-14 rounded-full bg-emerald-50 flex items-center justify-center mb-4">
              <PackageX className="h-7 w-7 text-emerald-600" />
            </div>
            <h3 className="text-lg font-semibold">No backordered items</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
              All orders have stock reserved. New backorders will appear here when stock runs out.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3 max-h-[75vh] overflow-y-auto scrollbar-thin pr-1">
          {sortedGroups.map((g) => (
            <BackorderGroupCard
              key={g.variantId}
              group={g}
              onNavigate={(orderId) => navigate({ name: 'order-detail', id: orderId })}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Group card (collapsible)
// ─────────────────────────────────────────────────────────────────────────────

function BackorderGroupCard({
  group,
  onNavigate,
}: {
  group: BackorderGroup
  onNavigate: (orderId: string) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="w-full text-left p-4 hover:bg-muted/40 transition-colors flex items-start justify-between gap-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-medium text-sm truncate">{group.productTitle}</p>
                <Badge variant="outline" className="text-[10px]">
                  {group.sku}
                </Badge>
                {group.oldestDays >= 7 && (
                  <Badge
                    variant="outline"
                    className="text-[10px] bg-rose-50 text-rose-700 border-rose-200"
                  >
                    <Clock className="h-3 w-3 mr-1" /> {group.oldestDays}d waiting
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {group.orders.length} order{group.orders.length === 1 ? '' : 's'} waiting ·{' '}
                {group.totalQuantity} unit{group.totalQuantity === 1 ? '' : 's'} ·{' '}
                {formatPKR(group.totalValue)} · oldest: {group.oldestDays} day
                {group.oldestDays === 1 ? '' : 's'}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <ChevronRight
                className={`h-4 w-4 text-muted-foreground transition-transform ${
                  open ? 'rotate-90' : ''
                }`}
              />
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t bg-muted/20">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-muted-foreground border-b">
                    <th className="text-left font-medium p-2.5">Order #</th>
                    <th className="text-left font-medium p-2.5">Customer</th>
                    <th className="text-right font-medium p-2.5">Qty</th>
                    <th className="text-left font-medium p-2.5">Backordered since</th>
                    <th className="text-right font-medium p-2.5">Days waiting</th>
                  </tr>
                </thead>
                <tbody>
                  {group.orders.map((o) => {
                    const badge = badgeForStatus(o.orderStatus)
                    return (
                      <tr
                        key={o.orderItemId}
                        className="border-b last:border-0 hover:bg-muted/40 cursor-pointer"
                        onClick={() => onNavigate(o.orderId)}
                      >
                        <td className="p-2.5">
                          <p className="font-medium text-sm">{o.flowopsOrderNumber}</p>
                          <Badge variant="outline" className={`text-[10px] mt-0.5 ${badge.className}`}>
                            {badge.label}
                          </Badge>
                        </td>
                        <td className="p-2.5">
                          <p className="text-sm">{o.customerName}</p>
                          <p className="text-xs text-muted-foreground">{o.customerPhone}</p>
                        </td>
                        <td className="p-2.5 text-right tabular-nums font-medium">
                          {o.quantity}
                        </td>
                        <td className="p-2.5 text-xs text-muted-foreground">
                          {formatDate(o.backorderedAt)}
                        </td>
                        <td className="p-2.5 text-right tabular-nums">
                          <span
                            className={`font-medium ${
                              o.daysWaiting >= 7
                                ? 'text-rose-600'
                                : o.daysWaiting >= 3
                                  ? 'text-amber-700'
                                  : 'text-muted-foreground'
                            }`}
                          >
                            {o.daysWaiting}d
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground p-2.5">
              No direct action — receive stock via a purchase order to fulfill these orders
              automatically.
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Stat card
// ─────────────────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon,
}: {
  label: string
  value: string
  icon: React.ReactNode
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
          <span className="text-muted-foreground">{icon}</span>
        </div>
        <p className="text-xl font-semibold tabular-nums mt-1">{value}</p>
      </CardContent>
    </Card>
  )
}
