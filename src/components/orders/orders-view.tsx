'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, FetchError } from '@/lib/api-client'
import { useAppStore, useCan } from '@/stores/app-store'
import { PERMISSIONS } from '@/lib/permissions'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  ShoppingCart,
  Plus,
  Search,
  RefreshCw,
  AlertCircle,
  Clock,
  PackageX,
  Banknote,
  ArrowRight,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types — match GET /api/orders response shape
// ─────────────────────────────────────────────────────────────────────────────

interface OrderRow {
  id: string
  flowopsOrderNumber: string
  externalOrderReference: string | null
  orderSource: string
  status: string
  paymentType: string
  paymentStatus: string
  totalOrderValue: number
  customerName: string
  customerPhone: string
  createdAt: string
}

interface OrdersListResponse {
  orders: OrderRow[]
  total: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Display maps — status + payment + source badges
// ─────────────────────────────────────────────────────────────────────────────

const ORDER_STATUS_BADGE: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-gray-100 text-gray-700 border-gray-200' },
  confirmed: { label: 'Confirmed', className: 'bg-sky-50 text-sky-700 border-sky-200' },
  partially_backordered: {
    label: 'Backordered',
    className: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  processing: { label: 'Processing', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  dispatched: { label: 'Dispatched', className: 'bg-violet-50 text-violet-700 border-violet-200' },
  delivered: { label: 'Delivered', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  rto: { label: 'RTO', className: 'bg-rose-50 text-rose-700 border-rose-200' },
  cancelled: { label: 'Cancelled', className: 'bg-slate-100 text-slate-600 border-slate-200' },
  refunded: { label: 'Refunded', className: 'bg-purple-50 text-purple-700 border-purple-200' },
}

const PAYMENT_STATUS_BADGE: Record<string, { label: string; className: string }> = {
  cod_pending: { label: 'COD Pending', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  advance_paid: { label: 'Advance Paid', className: 'bg-sky-50 text-sky-700 border-sky-200' },
  fully_prepaid: { label: 'Prepaid', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  cod_collected: {
    label: 'COD Collected',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
}

const SOURCE_BADGE: Record<string, { label: string; className: string }> = {
  manual: { label: 'Manual', className: 'bg-gray-100 text-gray-700 border-gray-200' },
  shopify: { label: 'Shopify', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  daraz: { label: 'Daraz', className: 'bg-orange-50 text-orange-700 border-orange-200' },
  instagram: { label: 'Instagram', className: 'bg-pink-50 text-pink-700 border-pink-200' },
}

const PAYMENT_TYPE_LABEL: Record<string, string> = {
  full_cod: 'Full COD',
  partial_advance: 'Partial Advance',
  fully_prepaid: 'Fully Prepaid',
}

const STATUS_FILTERS = [
  { value: 'all', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'partially_backordered', label: 'Backordered' },
  { value: 'processing', label: 'Processing' },
  { value: 'dispatched', label: 'Dispatched' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'rto', label: 'RTO' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'refunded', label: 'Refunded' },
]

const PAYMENT_TYPE_FILTERS = [
  { value: 'all', label: 'All payments' },
  { value: 'full_cod', label: 'Full COD' },
  { value: 'partial_advance', label: 'Partial Advance' },
  { value: 'fully_prepaid', label: 'Fully Prepaid' },
]

const SOURCE_FILTERS = [
  { value: 'all', label: 'All sources' },
  { value: 'manual', label: 'Manual' },
  { value: 'shopify', label: 'Shopify' },
  { value: 'daraz', label: 'Daraz' },
  { value: 'instagram', label: 'Instagram' },
]

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const PKR = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 })

function formatPKR(n: number): string {
  return `Rs. ${PKR.format(n)}`
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-PK', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return iso
  }
}

function getErrorMessage(err: unknown): string {
  if (err instanceof FetchError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong. Please try again.'
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function OrdersView() {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [paymentTypeFilter, setPaymentTypeFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')

  const canView = can(PERMISSIONS.ORDERS_VIEW)
  const canCreate = can(PERMISSIONS.ORDERS_CREATE)

  // Build the query string from filters + search.
  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    if (statusFilter !== 'all') params.set('status', statusFilter)
    if (paymentTypeFilter !== 'all') params.set('payment_type', paymentTypeFilter)
    if (sourceFilter !== 'all') params.set('order_source', sourceFilter)
    if (search.trim()) params.set('search', search.trim())
    const qs = params.toString()
    return qs ? `?${qs}` : ''
  }, [statusFilter, paymentTypeFilter, sourceFilter, search])

  const { data, isLoading, isError, refetch, isFetching, error } = useQuery<OrdersListResponse>({
    queryKey: ['orders', statusFilter, paymentTypeFilter, sourceFilter, search.trim()],
    queryFn: () => api.get<OrdersListResponse>(`/api/orders${queryString}`),
    staleTime: 15_000,
    enabled: canView,
  })

  const orders = data?.orders ?? []

  // ── Stat cards (computed from current page of orders) ────────────────────
  const stats = useMemo(() => {
    const list = orders
    const pending = list.filter((o) => o.status === 'pending').length
    const backordered = list.filter((o) => o.status === 'partially_backordered').length
    const today = new Date()
    const todayRevenue = list
      .filter((o) => {
        const created = new Date(o.createdAt)
        return (
          created.getDate() === today.getDate() &&
          created.getMonth() === today.getMonth() &&
          created.getFullYear() === today.getFullYear() &&
          o.status !== 'cancelled' &&
          o.status !== 'rto'
        )
      })
      .reduce((sum, o) => sum + o.totalOrderValue, 0)
    return { total: list.length, pending, backordered, todayRevenue }
  }, [orders])

  // ── Permission gate ───────────────────────────────────────────────────────
  if (!canView) {
    return (
      <div className="space-y-6">
        <PageHeader title="Orders" description="Manage all customer orders" />
        <Card>
          <CardContent className="p-10 text-center">
            <AlertCircle className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">
              You don&apos;t have permission to view orders. Contact your administrator.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Orders"
        description="Manage all customer orders"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
              Refresh
            </Button>
            {canCreate && (
              <Button size="sm" onClick={() => navigate({ name: 'order-create' })}>
                <Plus className="h-4 w-4" />
                Create Order
              </Button>
            )}
          </div>
        }
      />

      {/* ── Stat cards ─────────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total Orders"
          value={isLoading ? undefined : String(stats.total)}
          icon={<ShoppingCart className="h-5 w-5" />}
          tone="emerald"
          loading={isLoading}
        />
        <StatCard
          label="Pending Confirmation"
          value={isLoading ? undefined : String(stats.pending)}
          icon={<Clock className="h-5 w-5" />}
          tone="amber"
          loading={isLoading}
        />
        <StatCard
          label="Backordered"
          value={isLoading ? undefined : String(stats.backordered)}
          icon={<PackageX className="h-5 w-5" />}
          tone="rose"
          loading={isLoading}
        />
        <StatCard
          label="Today's Revenue"
          value={isLoading ? undefined : formatPKR(stats.todayRevenue)}
          icon={<Banknote className="h-5 w-5" />}
          tone="sky"
          loading={isLoading}
        />
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search order #, customer, phone…"
                className="pl-9 h-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full sm:w-44 h-9">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={paymentTypeFilter} onValueChange={setPaymentTypeFilter}>
              <SelectTrigger className="w-full sm:w-44 h-9">
                <SelectValue placeholder="All payments" />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_TYPE_FILTERS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sourceFilter} onValueChange={setSourceFilter}>
              <SelectTrigger className="w-full sm:w-40 h-9">
                <SelectValue placeholder="All sources" />
              </SelectTrigger>
              <SelectContent>
                {SOURCE_FILTERS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* ── Orders table ───────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <OrdersTableSkeleton />
          ) : isError ? (
            <div className="text-center py-12">
              <AlertCircle className="h-10 w-10 mx-auto text-rose-500 mb-3" />
              <p className="text-sm text-muted-foreground mb-4">
                {getErrorMessage(error) || 'Couldn&apos;t load orders. The server may have restarted.'}
              </p>
              <Button variant="outline" onClick={() => refetch()}>
                Try again
              </Button>
            </div>
          ) : orders.length === 0 ? (
            <EmptyState
              hasFilters={
                statusFilter !== 'all' ||
                paymentTypeFilter !== 'all' ||
                sourceFilter !== 'all' ||
                search.trim() !== ''
              }
              canCreate={canCreate}
              onCreate={() => navigate({ name: 'order-create' })}
              onClear={() => {
                setSearch('')
                setStatusFilter('all')
                setPaymentTypeFilter('all')
                setSourceFilter('all')
              }}
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order #</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-right">Items</TableHead>
                    <TableHead className="text-right">Total Value</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Payment</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.map((order) => {
                    const statusBadge = ORDER_STATUS_BADGE[order.status] ?? {
                      label: order.status,
                      className: 'bg-gray-100 text-gray-700 border-gray-200',
                    }
                    const paymentBadge = PAYMENT_STATUS_BADGE[order.paymentStatus] ?? {
                      label: order.paymentStatus,
                      className: 'bg-gray-100 text-gray-700 border-gray-200',
                    }
                    return (
                      <TableRow
                        key={order.id}
                        className="cursor-pointer hover:bg-muted/40"
                        onClick={() => navigate({ name: 'order-detail', id: order.id })}
                      >
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium text-sm">
                              {order.flowopsOrderNumber}
                            </span>
                            {order.externalOrderReference && (
                              <span className="text-xs text-muted-foreground">
                                {order.externalOrderReference}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium text-sm">{order.customerName}</span>
                            <span className="text-xs text-muted-foreground font-mono">
                              {order.customerPhone}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground">
                          —
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {formatPKR(order.totalOrderValue)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={statusBadge.className}>
                            {statusBadge.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <Badge variant="outline" className={paymentBadge.className}>
                              {paymentBadge.label}
                            </Badge>
                            <span className="text-[11px] text-muted-foreground">
                              {PAYMENT_TYPE_LABEL[order.paymentType] ?? order.paymentType}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {formatDate(order.createdAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation()
                              navigate({ name: 'order-detail', id: order.id })
                            }}
                          >
                            View
                            <ArrowRight className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
              <p className="text-xs text-muted-foreground mt-3 mb-3 ml-4">
                Showing {orders.length} of {data?.total ?? 0} orders
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

type StatTone = 'emerald' | 'amber' | 'rose' | 'sky'

const STAT_TONE_CLASSES: Record<StatTone, string> = {
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  rose: 'bg-rose-50 text-rose-600',
  sky: 'bg-sky-50 text-sky-600',
}

function StatCard({
  label,
  value,
  icon,
  tone,
  loading,
}: {
  label: string
  value?: string
  icon: React.ReactNode
  tone: StatTone
  loading?: boolean
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${STAT_TONE_CLASSES[tone]}`}>
            {icon}
          </div>
          {loading ? (
            <Skeleton className="h-7 w-24" />
          ) : (
            <span className="text-xl font-semibold tracking-tight">{value ?? '—'}</span>
          )}
        </div>
        <p className="mt-3 text-sm text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  )
}

function OrdersTableSkeleton() {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 7 }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  )
}

function EmptyState({
  hasFilters,
  canCreate,
  onCreate,
  onClear,
}: {
  hasFilters: boolean
  canCreate: boolean
  onCreate: () => void
  onClear: () => void
}) {
  return (
    <div className="m-4 rounded-lg border-2 border-dashed border-border p-12 text-center">
      <ShoppingCart className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
      <p className="text-sm font-medium mb-1">
        {hasFilters ? 'No orders match your filters' : 'No orders yet'}
      </p>
      <p className="text-xs text-muted-foreground mb-4">
        {hasFilters
          ? 'Try clearing filters or adjusting your search.'
          : 'Create your first manual order to get started.'}
      </p>
      <div className="flex items-center justify-center gap-2">
        {hasFilters ? (
          <Button variant="outline" size="sm" onClick={onClear}>
            Clear filters
          </Button>
        ) : canCreate ? (
          <Button size="sm" onClick={onCreate}>
            <Plus className="h-4 w-4" />
            Create Order
          </Button>
        ) : null}
      </div>
    </div>
  )
}
