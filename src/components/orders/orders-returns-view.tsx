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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { RefreshCw, Eye, RotateCcw, AlertTriangle, PackageX } from 'lucide-react'
import { formatPKR, formatDate, getErrorMessage, badgeForStatus } from './_shared'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface RtoOrderRow {
  id: string
  flowopsOrderNumber: string
  status: string
  totalOrderValue: number
  customerName: string
  customerPhone: string
  itemCount: number
  itemsNeedingReview: number
  needsReview: boolean
  returnedAt: string | null
}

interface ReturnsResponse {
  orders: RtoOrderRow[]
  stats: {
    totalRtoCount: number
    totalRtoValue: number
    itemsNeedingReview: number
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

type Filter = 'all' | 'needs_review'

export function OrdersReturnsView() {
  const navigate = useAppStore((s) => s.navigate)
  const [filter, setFilter] = useState<Filter>('all')

  const query = useQuery<ReturnsResponse>({
    queryKey: ['orders-returns', filter],
    queryFn: () =>
      api.get<ReturnsResponse>(
        `/api/orders/returns${filter === 'needs_review' ? '?filter=needs_review' : ''}`,
      ),
    staleTime: 15_000,
  })

  const orders = query.data?.orders ?? []
  const stats = query.data?.stats

  const needsReviewCount = useMemo(
    () => orders.filter((o) => o.needsReview).length,
    [orders],
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Returns (RTO)"
        description="Returned-to-origin orders. Review items flagged for physical spot-checking."
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
              <p className="text-xs uppercase tracking-wide text-muted-foreground">RTO orders</p>
              <RotateCcw className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1">{stats?.totalRtoCount ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">RTO value</p>
              <PackageX className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1">
              {formatPKR(stats?.totalRtoValue ?? 0)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Needs review</p>
              <AlertTriangle className="h-4 w-4 text-amber-600" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1 text-amber-700">
              {stats?.itemsNeedingReview ?? 0}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">items awaiting spot-check</p>
          </CardContent>
        </Card>
      </div>

      {/* Filter pills */}
      <div className="flex items-center gap-2">
        <FilterPill
          active={filter === 'all'}
          onClick={() => setFilter('all')}
          label={`All returns (${stats?.totalRtoCount ?? 0})`}
        />
        <FilterPill
          active={filter === 'needs_review'}
          onClick={() => setFilter('needs_review')}
          label={`Needs review (${needsReviewCount})`}
          highlight={needsReviewCount > 0}
        />
        {stats && stats.itemsNeedingReview > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => navigate({ name: 'orders-returns-review' })}
          >
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600" /> Open review queue
          </Button>
        )}
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
              Couldn&apos;t load returns. {getErrorMessage(query.error)}
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
              <RotateCcw className="h-7 w-7 text-emerald-600" />
            </div>
            <h3 className="text-lg font-semibold">No returns</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
              RTO orders will appear here when customers return shipped orders.
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
                    <TableHead className="text-right">Items</TableHead>
                    <TableHead>Returned</TableHead>
                    <TableHead className="text-right">Review</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.map((o) => {
                    const badge = badgeForStatus(o.status)
                    return (
                      <TableRow key={o.id}>
                        <TableCell>
                          <p className="font-medium text-sm">{o.flowopsOrderNumber}</p>
                          <Badge variant="outline" className={`text-[10px] mt-0.5 ${badge.className}`}>
                            {badge.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <p className="text-sm">{o.customerName}</p>
                          <p className="text-xs text-muted-foreground">{o.customerPhone}</p>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{o.itemCount}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDate(o.returnedAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          {o.itemsNeedingReview > 0 ? (
                            <Badge
                              variant="outline"
                              className="bg-amber-50 text-amber-700 border-amber-200"
                            >
                              {o.itemsNeedingReview} need review
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="bg-emerald-50 text-emerald-700 border-emerald-200"
                            >
                              Reviewed
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {formatPKR(o.totalOrderValue)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => navigate({ name: 'order-detail', id: o.id })}
                            aria-label={`View ${o.flowopsOrderNumber}`}
                          >
                            <Eye className="h-3.5 w-3.5" /> View
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground p-3">
              {orders.length} RTO order{orders.length === 1 ? '' : 's'}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter pill
// ─────────────────────────────────────────────────────────────────────────────

function FilterPill({
  active,
  onClick,
  label,
  highlight,
}: {
  active: boolean
  onClick: () => void
  label: string
  highlight?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
        active
          ? highlight
            ? 'bg-amber-50 text-amber-700 border-amber-200'
            : 'bg-primary text-primary-foreground border-primary'
          : 'bg-background text-muted-foreground border-border hover:bg-muted/50'
      }`}
    >
      {label}
    </button>
  )
}
