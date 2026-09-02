'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api-client'
import { useAppStore } from '@/stores/app-store'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { RefreshCw, XCircle, Archive } from 'lucide-react'
import { formatPKR, formatDate, getErrorMessage, badgeForStatus } from './_shared'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface CancelledOrderRow {
  id: string
  flowopsOrderNumber: string
  orderSource: string
  status: string
  totalOrderValue: number
  customerName: string
  customerPhone: string
  cancellationReason: string
  cancelledAt: string | null
  createdAt: string
}

interface CancelledResponse {
  orders: CancelledOrderRow[]
  stats: { count: number }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function OrdersCancelledView() {
  const navigate = useAppStore((s) => s.navigate)
  const query = useQuery<CancelledResponse>({
    queryKey: ['orders-cancelled'],
    queryFn: () => api.get<CancelledResponse>('/api/orders/cancelled'),
    staleTime: 30_000,
  })

  const orders = query.data?.orders ?? []
  const count = query.data?.stats.count ?? orders.length
  const totalValue = orders.reduce((s, o) => s + o.totalOrderValue, 0)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cancelled Orders"
        description="Read-only history of all cancelled orders. Stock was released back to inventory at cancellation time."
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

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Cancelled orders</p>
              <XCircle className="h-4 w-4 text-rose-600" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1">{count}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Lost value</p>
              <Archive className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1">{formatPKR(totalValue)}</p>
          </CardContent>
        </Card>
      </div>

      {query.isLoading ? (
        <Card>
          <CardContent className="p-3 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </CardContent>
        </Card>
      ) : query.isError ? (
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">
              Couldn&apos;t load cancelled orders. {getErrorMessage(query.error)}
            </p>
            <Button variant="outline" onClick={() => query.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : orders.length === 0 ? (
        <Card>
          <CardContent className="p-10 sm:p-14 text-center">
            <div className="mx-auto h-14 w-14 rounded-full bg-emerald-50 flex items-center justify-center mb-4">
              <XCircle className="h-7 w-7 text-emerald-600" />
            </div>
            <h3 className="text-lg font-semibold">No cancelled orders</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
              Cancelled orders will be archived here for audit purposes.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Cancelled date</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="text-right">Total value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.map((o) => {
                    const badge = badgeForStatus(o.status)
                    return (
                      <TableRow
                        key={o.id}
                        className="cursor-pointer hover:bg-muted/40"
                        onClick={() => navigate({ name: 'order-detail', id: o.id })}
                      >
                        <TableCell>
                          <p className="font-medium text-sm">{o.flowopsOrderNumber}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <Badge variant="outline" className={`text-[10px] ${badge.className}`}>
                              {badge.label}
                            </Badge>
                            <span className="text-xs text-muted-foreground">{o.orderSource}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <p className="text-sm">{o.customerName}</p>
                          <p className="text-xs text-muted-foreground">{o.customerPhone}</p>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDate(o.cancelledAt)}
                        </TableCell>
                        <TableCell className="text-sm max-w-xs">
                          <span className="line-clamp-2">{o.cancellationReason}</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium text-muted-foreground">
                          {formatPKR(o.totalOrderValue)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground p-3">
              {orders.length} cancelled order{orders.length === 1 ? '' : 's'}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
