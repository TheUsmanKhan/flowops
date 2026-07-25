'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api-client'
import { useAppStore } from '@/stores/app-store'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { RefreshCw, Factory, Scissors, PackageCheck } from 'lucide-react'
import {
  formatPKR,
  formatDate,
  getErrorMessage,
  PRODUCTION_STATUS_BADGE,
} from './_shared'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface AwaitingProductionItem {
  orderItemId: string
  orderId: string
  flowopsOrderNumber: string
  variantId: string
  sku: string
  productTitle: string
  quantity: number
  productionOrderId: string
  productionStatus: string
  productionStatusLabel: string
  estimatedCompletionDate: string | null
  assignedTailor: string | null
}

interface ProductionGroup {
  status: string
  label: string
  count: number
  items: AwaitingProductionItem[]
}

interface AwaitingProductionResponse {
  groups: ProductionGroup[]
  stats: { totalItems: number; groupCount: number }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function OrdersAwaitingProductionView() {
  const navigate = useAppStore((s) => s.navigate)
  const query = useQuery<AwaitingProductionResponse>({
    queryKey: ['orders-awaiting-production'],
    queryFn: () => api.get<AwaitingProductionResponse>('/api/orders/awaiting-production'),
    staleTime: 15_000,
  })

  const groups = (query.data?.groups ?? []).filter((g) => g.count > 0)
  const totalItems = query.data?.stats.totalItems ?? 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="Awaiting Production"
        description="Made-to-order items with active production orders. Grouped by production stage."
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

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Items in production</p>
              <Factory className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1">{totalItems}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Active stages</p>
              <Scissors className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1">{groups.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Ready to ship</p>
              <PackageCheck className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1 text-emerald-700">0</p>
            <p className="text-xs text-muted-foreground mt-0.5">Stays here until completed</p>
          </CardContent>
        </Card>
      </div>

      {query.isLoading ? (
        <Card>
          <CardContent className="p-3 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </CardContent>
        </Card>
      ) : query.isError ? (
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">
              Couldn&apos;t load awaiting-production items. {getErrorMessage(query.error)}
            </p>
            <Button variant="outline" onClick={() => query.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="p-10 sm:p-14 text-center">
            <div className="mx-auto h-14 w-14 rounded-full bg-emerald-50 flex items-center justify-center mb-4">
              <PackageCheck className="h-7 w-7 text-emerald-600" />
            </div>
            <h3 className="text-lg font-semibold">No items awaiting production</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
              All made-to-order items are completed or dispatched. New production orders will appear
              here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => {
            const badge = PRODUCTION_STATUS_BADGE[g.status] ?? {
              label: g.label,
              className: 'bg-gray-100 text-gray-700 border-gray-200',
            }
            return (
              <Card key={g.status}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Factory className="h-4 w-4 text-muted-foreground" />
                      {g.label}
                    </CardTitle>
                    <Badge variant="outline" className={badge.className}>
                      {g.count} item{g.count === 1 ? '' : 's'}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs uppercase tracking-wide text-muted-foreground border-b">
                          <th className="text-left font-medium p-2.5">Order</th>
                          <th className="text-left font-medium p-2.5">Variant</th>
                          <th className="text-right font-medium p-2.5">Qty</th>
                          <th className="text-left font-medium p-2.5">Tailor</th>
                          <th className="text-left font-medium p-2.5">Est. completion</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.items.map((item) => (
                          <tr
                            key={item.orderItemId}
                            className="border-b last:border-0 hover:bg-muted/40 cursor-pointer"
                            onClick={() => navigate({ name: 'order-detail', id: item.orderId })}
                          >
                            <td className="p-2.5 font-medium text-sm">
                              {item.flowopsOrderNumber}
                            </td>
                            <td className="p-2.5">
                              <p className="text-sm">{item.productTitle}</p>
                              <p className="text-xs text-muted-foreground">{item.sku}</p>
                            </td>
                            <td className="p-2.5 text-right tabular-nums font-medium">
                              {item.quantity}
                            </td>
                            <td className="p-2.5 text-sm">
                              {item.assignedTailor ?? (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="p-2.5 text-xs text-muted-foreground">
                              {formatDate(item.estimatedCompletionDate)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
