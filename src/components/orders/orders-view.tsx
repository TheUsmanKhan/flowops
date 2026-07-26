'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, FetchError } from '@/lib/api-client'
import { useAppStore, useCan } from '@/stores/app-store'
import { PERMISSIONS } from '@/lib/permissions'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
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
  SlidersHorizontal,
  X,
  Loader2,
  CheckCircle2,
} from 'lucide-react'
import { cn } from '@/lib/utils'

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
  advanceAmount: number | null
  remainingCodAmount: number | null
  codCollected: boolean
  customerName: string
  customerPhone: string
  createdAt: string
}

interface OrdersListResponse {
  orders: OrderRow[]
  total: number
}

interface ProductOption {
  productId: string
  variantId: string
  sku: string
  title: string
}

interface ProductsResponse {
  products: Array<{
    id: string
    title: string
    variants: Array<{ id: string; sku: string }>
  }>
  total: number
}

interface CustomerOption {
  id: string
  name: string
  phone: string
}

interface CustomersSearchResponse {
  customers: CustomerOption[]
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

// ─────────────────────────────────────────────────────────────────────────────
// Filter option lists
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
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

const PAYMENT_TYPE_OPTIONS = [
  { value: 'full_cod', label: 'Full COD' },
  { value: 'partial_advance', label: 'Partial Advance' },
  { value: 'fully_prepaid', label: 'Fully Prepaid' },
]

const PAYMENT_STATUS_OPTIONS = [
  { value: 'cod_pending', label: 'COD Pending' },
  { value: 'advance_paid', label: 'Advance Paid' },
  { value: 'fully_prepaid', label: 'Fully Prepaid' },
  { value: 'cod_collected', label: 'COD Collected' },
]

const SOURCE_OPTIONS = [
  { value: 'manual', label: 'Manual' },
  { value: 'shopify', label: 'Shopify' },
  { value: 'daraz', label: 'Daraz' },
  { value: 'instagram', label: 'Instagram' },
]

const DATE_PRESETS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 Days' },
  { value: '30d', label: 'Last 30 Days' },
  { value: 'this_month', label: 'This Month' },
] as const

type DatePresetValue = (typeof DATE_PRESETS)[number]['value']

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

function sourceLabel(source: string): string {
  return SOURCE_BADGE[source]?.label ?? source.charAt(0).toUpperCase() + source.slice(1)
}

function toISODate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function applyPreset(preset: DatePresetValue): { from: string; to: string } {
  const now = new Date()
  const to = new Date(now)
  const from = new Date(now)
  if (preset === 'today') {
    // from = today
  } else if (preset === '7d') {
    from.setDate(now.getDate() - 6)
  } else if (preset === '30d') {
    from.setDate(now.getDate() - 29)
  } else if (preset === 'this_month') {
    from.setDate(1)
  }
  return { from: toISODate(from), to: toISODate(to) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Filters state shape
// ─────────────────────────────────────────────────────────────────────────────

interface FilterState {
  statuses: string[]
  paymentTypes: string[]
  paymentStatuses: string[]
  orderSources: string[]
  dateFrom: string
  dateTo: string
  amountMin: string
  amountMax: string
  orgVariantId: string
  orgVariantLabel: string
  customerId: string
  customerLabel: string
  courier: string
}

const EMPTY_FILTERS: FilterState = {
  statuses: [],
  paymentTypes: [],
  paymentStatuses: [],
  orderSources: [],
  dateFrom: '',
  dateTo: '',
  amountMin: '',
  amountMax: '',
  orgVariantId: '',
  orgVariantLabel: '',
  customerId: '',
  customerLabel: '',
  courier: '',
}

function toggleArray(arr: string[], value: string): string[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value]
}

function countActiveFilters(f: FilterState): number {
  let n = 0
  if (f.statuses.length) n++
  if (f.paymentTypes.length) n++
  if (f.paymentStatuses.length) n++
  if (f.orderSources.length) n++
  if (f.dateFrom || f.dateTo) n++
  if (f.amountMin || f.amountMax) n++
  if (f.orgVariantId) n++
  if (f.customerId) n++
  if (f.courier.trim()) n++
  return n
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function OrdersView() {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()

  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [sheetOpen, setSheetOpen] = useState(false)

  const canView = can(PERMISSIONS.ORDERS_VIEW)
  const canCreate = can(PERMISSIONS.ORDERS_CREATE)

  // Build the query string from filters + search.
  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    if (filters.statuses.length) params.set('statuses', filters.statuses.join(','))
    if (filters.paymentTypes.length) params.set('paymentTypes', filters.paymentTypes.join(','))
    if (filters.paymentStatuses.length)
      params.set('paymentStatuses', filters.paymentStatuses.join(','))
    if (filters.orderSources.length) params.set('orderSources', filters.orderSources.join(','))
    if (filters.dateFrom) params.set('dateFrom', filters.dateFrom)
    if (filters.dateTo) params.set('dateTo', filters.dateTo)
    if (filters.amountMin) params.set('amountMin', filters.amountMin)
    if (filters.amountMax) params.set('amountMax', filters.amountMax)
    if (filters.orgVariantId) params.set('orgVariantId', filters.orgVariantId)
    if (filters.customerId) params.set('customer_id', filters.customerId)
    if (filters.courier.trim()) params.set('courier', filters.courier.trim())
    if (search.trim()) params.set('search', search.trim())
    const qs = params.toString()
    return qs ? `?${qs}` : ''
  }, [filters, search])

  const { data, isLoading, isError, refetch, isFetching, error } = useQuery<OrdersListResponse>({
    queryKey: ['orders', queryString],
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

  const activeFilterCount = countActiveFilters(filters)
  const hasAnyFilter = activeFilterCount > 0 || search.trim() !== ''

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
                placeholder="Search order #, external ref, customer…"
                className="pl-9 h-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="h-9">
                  <SlidersHorizontal className="h-4 w-4" />
                  Filters
                  {activeFilterCount > 0 && (
                    <Badge
                      variant="secondary"
                      className="ml-1 h-5 px-1.5 text-[10px] bg-primary text-primary-foreground"
                    >
                      {activeFilterCount}
                    </Badge>
                  )}
                </Button>
              </SheetTrigger>
              <FiltersSheet
                filters={filters}
                onChange={setFilters}
                onClose={() => setSheetOpen(false)}
              />
            </Sheet>
            {hasAnyFilter && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9 text-muted-foreground"
                onClick={() => {
                  setSearch('')
                  setFilters(EMPTY_FILTERS)
                }}
              >
                <X className="h-3.5 w-3.5" />
                Clear all
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Active filter chips ─────────────────────────────────────────────── */}
      {activeFilterCount > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {filters.statuses.map((s) => (
            <FilterChip
              key={`st-${s}`}
              label={`Status: ${STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s}`}
              onRemove={() =>
                setFilters((p) => ({ ...p, statuses: p.statuses.filter((v) => v !== s) }))
              }
            />
          ))}
          {filters.paymentTypes.map((s) => (
            <FilterChip
              key={`pt-${s}`}
              label={`Payment: ${PAYMENT_TYPE_OPTIONS.find((o) => o.value === s)?.label ?? s}`}
              onRemove={() =>
                setFilters((p) => ({
                  ...p,
                  paymentTypes: p.paymentTypes.filter((v) => v !== s),
                }))
              }
            />
          ))}
          {filters.paymentStatuses.map((s) => (
            <FilterChip
              key={`ps-${s}`}
              label={`Pay Status: ${PAYMENT_STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s}`}
              onRemove={() =>
                setFilters((p) => ({
                  ...p,
                  paymentStatuses: p.paymentStatuses.filter((v) => v !== s),
                }))
              }
            />
          ))}
          {filters.orderSources.map((s) => (
            <FilterChip
              key={`os-${s}`}
              label={`Source: ${SOURCE_OPTIONS.find((o) => o.value === s)?.label ?? s}`}
              onRemove={() =>
                setFilters((p) => ({
                  ...p,
                  orderSources: p.orderSources.filter((v) => v !== s),
                }))
              }
            />
          ))}
          {(filters.dateFrom || filters.dateTo) && (
            <FilterChip
              label={`Date: ${filters.dateFrom || '…'} → ${filters.dateTo || '…'}`}
              onRemove={() => setFilters((p) => ({ ...p, dateFrom: '', dateTo: '' }))}
            />
          )}
          {(filters.amountMin || filters.amountMax) && (
            <FilterChip
              label={`Amount: ${filters.amountMin ? formatPKR(Number(filters.amountMin)) : 'Rs. 0'}–${
                filters.amountMax ? formatPKR(Number(filters.amountMax)) : '∞'
              }`}
              onRemove={() => setFilters((p) => ({ ...p, amountMin: '', amountMax: '' }))}
            />
          )}
          {filters.orgVariantId && (
            <FilterChip
              label={`Variant: ${filters.orgVariantLabel || filters.orgVariantId}`}
              onRemove={() =>
                setFilters((p) => ({ ...p, orgVariantId: '', orgVariantLabel: '' }))
              }
            />
          )}
          {filters.customerId && (
            <FilterChip
              label={`Customer: ${filters.customerLabel || filters.customerId}`}
              onRemove={() => setFilters((p) => ({ ...p, customerId: '', customerLabel: '' }))}
            />
          )}
          {filters.courier.trim() && (
            <FilterChip
              label={`Courier: ${filters.courier.trim()}`}
              onRemove={() => setFilters((p) => ({ ...p, courier: '' }))}
            />
          )}
        </div>
      )}

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
              hasFilters={hasAnyFilter}
              canCreate={canCreate}
              onCreate={() => navigate({ name: 'order-create' })}
              onClear={() => {
                setSearch('')
                setFilters(EMPTY_FILTERS)
              }}
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order #</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Payment</TableHead>
                    <TableHead className="text-right">To Collect</TableHead>
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
                    const showExternalRef =
                      !!order.externalOrderReference && order.orderSource !== 'manual'
                    const toCollect =
                      order.paymentType === 'fully_prepaid'
                        ? 0
                        : order.remainingCodAmount ?? 0
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
                            {showExternalRef && (
                              <span className="text-xs text-muted-foreground">
                                {sourceLabel(order.orderSource)}: {order.externalOrderReference}
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
                        <TableCell className="text-right tabular-nums">
                          {order.paymentType === 'fully_prepaid' ? (
                            <span className="text-xs text-emerald-600 inline-flex items-center gap-1">
                              <CheckCircle2 className="h-3 w-3" />
                              Paid
                            </span>
                          ) : order.codCollected ? (
                            <span className="text-xs text-emerald-600 inline-flex items-center gap-1">
                              <CheckCircle2 className="h-3 w-3" />
                              Collected
                            </span>
                          ) : (
                            <span
                              className={cn(
                                'font-medium',
                                toCollect > 0 ? 'text-amber-700' : 'text-muted-foreground',
                              )}
                            >
                              {formatPKR(toCollect)}
                            </span>
                          )}
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

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border bg-background px-2.5 py-1 text-xs font-medium text-foreground">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 rounded-full p-0.5 hover:bg-muted text-muted-foreground hover:text-foreground"
        aria-label={`Remove filter ${label}`}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  )
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Filters slide-over (Sheet)
// ─────────────────────────────────────────────────────────────────────────────

function FiltersSheet({
  filters,
  onChange,
  onClose,
}: {
  filters: FilterState
  onChange: (next: FilterState) => void
  onClose: () => void
}) {
  // Local draft so the user can apply all changes at once on "Apply".
  const [draft, setDraft] = useState<FilterState>(filters)
  useEffect(() => {
    setDraft(filters)
  }, [filters])

  // Products for variant picker (lazy-loaded once when sheet opens).
  const productsQuery = useQuery<ProductsResponse>({
    queryKey: ['products', 'filter-picker'],
    queryFn: () => api.get<ProductsResponse>('/api/products?pageSize=200'),
    staleTime: 60_000,
  })

  const variantOptions: ProductOption[] = useMemo(() => {
    const list: ProductOption[] = []
    for (const p of productsQuery.data?.products ?? []) {
      for (const v of p.variants) {
        list.push({ productId: p.id, variantId: v.id, sku: v.sku, title: p.title })
      }
    }
    return list
  }, [productsQuery.data])

  const [variantSearch, setVariantSearch] = useState('')
  const variantResults = useMemo(() => {
    if (!variantSearch.trim()) return variantOptions.slice(0, 50)
    const q = variantSearch.toLowerCase()
    return variantOptions
      .filter((v) => v.sku.toLowerCase().includes(q) || v.title.toLowerCase().includes(q))
      .slice(0, 50)
  }, [variantOptions, variantSearch])

  // Customer search (debounced via query key + min length gate).
  const [customerSearch, setCustomerSearch] = useState(draft.customerLabel)
  const trimmedCustomer = customerSearch.trim()
  const customersQuery = useQuery<CustomersSearchResponse>({
    queryKey: ['customers', 'filter', trimmedCustomer],
    queryFn: () =>
      api.get<CustomersSearchResponse>(
        `/api/customers?search=${encodeURIComponent(trimmedCustomer)}&limit=10`,
      ),
    enabled: trimmedCustomer.length >= 3,
    staleTime: 10_000,
  })

  const patch = (p: Partial<FilterState>) => setDraft((prev) => ({ ...prev, ...p }))

  return (
    <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4" />
          Filters
        </SheetTitle>
        <SheetDescription>
          Refine the order list by status, payment, date, amount and more.
        </SheetDescription>
      </SheetHeader>

      <div className="flex-1 space-y-6 px-4 pb-2">
        {/* Status */}
        <FilterSection title="Status">
          <div className="grid grid-cols-1 gap-2">
            {STATUS_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/40 rounded px-1 py-0.5"
              >
                <Checkbox
                  checked={draft.statuses.includes(opt.value)}
                  onCheckedChange={() =>
                    patch({ statuses: toggleArray(draft.statuses, opt.value) })
                  }
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </FilterSection>

        {/* Payment Type */}
        <FilterSection title="Payment Type">
          <div className="grid grid-cols-1 gap-2">
            {PAYMENT_TYPE_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/40 rounded px-1 py-0.5"
              >
                <Checkbox
                  checked={draft.paymentTypes.includes(opt.value)}
                  onCheckedChange={() =>
                    patch({ paymentTypes: toggleArray(draft.paymentTypes, opt.value) })
                  }
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </FilterSection>

        {/* Payment Status */}
        <FilterSection title="Payment Status">
          <div className="grid grid-cols-1 gap-2">
            {PAYMENT_STATUS_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/40 rounded px-1 py-0.5"
              >
                <Checkbox
                  checked={draft.paymentStatuses.includes(opt.value)}
                  onCheckedChange={() =>
                    patch({
                      paymentStatuses: toggleArray(draft.paymentStatuses, opt.value),
                    })
                  }
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </FilterSection>

        {/* Order Source */}
        <FilterSection title="Order Source">
          <div className="grid grid-cols-1 gap-2">
            {SOURCE_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/40 rounded px-1 py-0.5"
              >
                <Checkbox
                  checked={draft.orderSources.includes(opt.value)}
                  onCheckedChange={() =>
                    patch({ orderSources: toggleArray(draft.orderSources, opt.value) })
                  }
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </FilterSection>

        {/* Date Range + presets */}
        <FilterSection title="Date Range">
          <div className="flex flex-wrap gap-1.5 mb-2">
            {DATE_PRESETS.map((preset) => (
              <Button
                key={preset.value}
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  const { from, to } = applyPreset(preset.value)
                  patch({ dateFrom: from, dateTo: to })
                }}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="f-date-from" className="text-xs text-muted-foreground">
                From
              </Label>
              <Input
                id="f-date-from"
                type="date"
                className="h-8 text-sm"
                value={draft.dateFrom}
                onChange={(e) => patch({ dateFrom: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="f-date-to" className="text-xs text-muted-foreground">
                To
              </Label>
              <Input
                id="f-date-to"
                type="date"
                className="h-8 text-sm"
                value={draft.dateTo}
                onChange={(e) => patch({ dateTo: e.target.value })}
              />
            </div>
          </div>
        </FilterSection>

        {/* Amount Range */}
        <FilterSection title="Amount Range (Rs.)">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="f-amt-min" className="text-xs text-muted-foreground">
                Min
              </Label>
              <Input
                id="f-amt-min"
                type="number"
                min="0"
                placeholder="0"
                className="h-8 text-sm tabular-nums"
                value={draft.amountMin}
                onChange={(e) => patch({ amountMin: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="f-amt-max" className="text-xs text-muted-foreground">
                Max
              </Label>
              <Input
                id="f-amt-max"
                type="number"
                min="0"
                placeholder="∞"
                className="h-8 text-sm tabular-nums"
                value={draft.amountMax}
                onChange={(e) => patch({ amountMax: e.target.value })}
              />
            </div>
          </div>
        </FilterSection>

        {/* Product / Variant */}
        <FilterSection title="Product / Variant">
          {draft.orgVariantId ? (
            <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{draft.orgVariantLabel}</p>
                <p className="text-xs text-muted-foreground font-mono">{draft.orgVariantId}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => patch({ orgVariantId: '', orgVariantLabel: '' })}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search SKU or product title…"
                  className="h-8 pl-8 text-sm"
                  value={variantSearch}
                  onChange={(e) => setVariantSearch(e.target.value)}
                />
                {productsQuery.isFetching && (
                  <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
              </div>
              <div className="mt-2 max-h-48 overflow-y-auto rounded-md border">
                {productsQuery.isLoading ? (
                  <div className="space-y-1 p-2">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <Skeleton key={i} className="h-7" />
                    ))}
                  </div>
                ) : variantResults.length === 0 ? (
                  <div className="p-3 text-xs text-muted-foreground">No variants found.</div>
                ) : (
                  <ul className="divide-y">
                    {variantResults.map((v) => (
                      <li key={v.variantId}>
                        <button
                          type="button"
                          className="w-full text-left px-3 py-1.5 hover:bg-muted/60 flex items-center justify-between gap-2"
                          onClick={() => {
                            patch({
                              orgVariantId: v.variantId,
                              orgVariantLabel: `${v.title} (${v.sku})`,
                            })
                            setVariantSearch('')
                          }}
                        >
                          <span className="text-sm truncate">{v.title}</span>
                          <span className="text-xs text-muted-foreground font-mono">{v.sku}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </FilterSection>

        {/* Customer */}
        <FilterSection title="Customer">
          {draft.customerId ? (
            <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{draft.customerLabel}</p>
                <p className="text-xs text-muted-foreground font-mono">{draft.customerId}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => {
                  patch({ customerId: '', customerLabel: '' })
                  setCustomerSearch('')
                }}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search name or phone…"
                  className="h-8 pl-8 text-sm"
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                />
                {customersQuery.isFetching && (
                  <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
              </div>
              {trimmedCustomer.length >= 3 && (
                <div className="mt-2 max-h-48 overflow-y-auto rounded-md border">
                  {customersQuery.isLoading ? (
                    <div className="space-y-1 p-2">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <Skeleton key={i} className="h-7" />
                      ))}
                    </div>
                  ) : (customersQuery.data?.customers ?? []).length === 0 ? (
                    <div className="p-3 text-xs text-muted-foreground">No customers found.</div>
                  ) : (
                    <ul className="divide-y">
                      {(customersQuery.data?.customers ?? []).map((c) => (
                        <li key={c.id}>
                          <button
                            type="button"
                            className="w-full text-left px-3 py-1.5 hover:bg-muted/60 flex items-center justify-between gap-2"
                            onClick={() => {
                              patch({ customerId: c.id, customerLabel: `${c.name} · ${c.phone}` })
                              setCustomerSearch(`${c.name} · ${c.phone}`)
                            }}
                          >
                            <span className="text-sm truncate">{c.name}</span>
                            <span className="text-xs text-muted-foreground font-mono">{c.phone}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </FilterSection>

        {/* Courier */}
        <FilterSection title="Courier">
          <Input
            placeholder="e.g. TCS, Leopards"
            className="h-8 text-sm"
            value={draft.courier}
            onChange={(e) => patch({ courier: e.target.value })}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Matches any order whose courier name contains this text.
          </p>
        </FilterSection>
      </div>

      <SheetFooter className="flex-row gap-2 border-t pt-4">
        <Button
          variant="outline"
          className="flex-1"
          onClick={() => {
            setDraft(EMPTY_FILTERS)
            setCustomerSearch('')
            setVariantSearch('')
          }}
        >
          Reset
        </Button>
        <Button
          className="flex-1"
          onClick={() => {
            onChange(draft)
            onClose()
          }}
        >
          Apply Filters
        </Button>
      </SheetFooter>
    </SheetContent>
  )
}

function FilterSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      {children}
    </section>
  )
}
