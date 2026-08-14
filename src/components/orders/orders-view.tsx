'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
  TrendingUp,
  Percent,
  CalendarDays,
  RotateCcw,
  AlertTriangle,
  Truck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { CancelCourierBookingButton } from './cancel-courier-booking-button'

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
  customerId: string
  deliveryCity: string | null
  createdAt: string
  // Courier tracking fields (Prompt 4/5)
  courierCityStatus?: string
  courierSubStatus?: string | null
  needsShipperAdvice?: boolean
  trackingNumber?: string | null
  courierName?: string | null
  courierCompanyIntegrationId?: string | null
  courierBookingStatus?: string
  estimatedDeliveryCharge?: number | null
  taxAmount?: number | null
  taxLabel?: string | null
  // Universal courier reference fields (migration 015)
  orderRefNumber?: string | null
  orderDetail?: string | null
  notesForCourier?: string | null
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
  fulfillmentType: string | null
  salePrice: number | null
}

interface ProductsResponse {
  products: Array<{
    id: string
    title: string
    variants: Array<{
      id: string
      sku: string
      fulfillmentType: string | null
      salePrice: number | null
    }>
  }>
  total: number
}

interface CustomerOption {
  id: string
  name: string
  phone: string
  totalOrdersCount: number
  totalRtoCount: number
  isFlagged: boolean
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

// ─────────────────────────────────────────────────────────────────────────────
// Time-span selector
// ─────────────────────────────────────────────────────────────────────────────

type TimeSpanValue =
  | 'today'
  | 'yesterday'
  | 'last_7_days'
  | 'last_30_days'
  | 'this_month'
  | 'last_month'
  | 'this_year'
  | 'custom'

interface TimeSpanOption {
  value: TimeSpanValue
  label: string
}

const TIME_SPAN_OPTIONS: TimeSpanOption[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last_7_days', label: 'Last 7 Days' },
  { value: 'last_30_days', label: 'Last 30 Days' },
  { value: 'this_month', label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'this_year', label: 'This Year' },
  { value: 'custom', label: 'Custom Range' },
]

interface DateRange {
  from: string // YYYY-MM-DD
  to: string // YYYY-MM-DD
}

function toISODate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function resolveTimeSpan(value: TimeSpanValue, custom?: DateRange): DateRange {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  switch (value) {
    case 'today':
      return { from: toISODate(today), to: toISODate(today) }
    case 'yesterday': {
      const y = new Date(today)
      y.setDate(y.getDate() - 1)
      return { from: toISODate(y), to: toISODate(y) }
    }
    case 'last_7_days': {
      const from = new Date(today)
      from.setDate(from.getDate() - 6)
      return { from: toISODate(from), to: toISODate(today) }
    }
    case 'last_30_days': {
      const from = new Date(today)
      from.setDate(from.getDate() - 29)
      return { from: toISODate(from), to: toISODate(today) }
    }
    case 'this_month': {
      const from = new Date(now.getFullYear(), now.getMonth(), 1)
      return { from: toISODate(from), to: toISODate(today) }
    }
    case 'last_month': {
      const firstOfThis = new Date(now.getFullYear(), now.getMonth(), 1)
      const from = new Date(firstOfThis)
      from.setMonth(from.getMonth() - 1)
      const to = new Date(firstOfThis.getFullYear(), firstOfThis.getMonth(), 0)
      return { from: toISODate(from), to: toISODate(to) }
    }
    case 'this_year': {
      const from = new Date(now.getFullYear(), 0, 1)
      return { from: toISODate(from), to: toISODate(today) }
    }
    case 'custom':
      return {
        from: custom?.from ?? toISODate(today),
        to: custom?.to ?? toISODate(today),
      }
  }
}

function spanDayCount(range: DateRange): number {
  const from = new Date(range.from + 'T00:00:00')
  const to = new Date(range.to + 'T23:59:59')
  const diff = to.getTime() - from.getTime()
  return Math.max(1, Math.round(diff / (1000 * 60 * 60 * 24)) + 1)
}

function isMonthlyGranularity(range: DateRange): boolean {
  return spanDayCount(range) > 30
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const PKR = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 })

function formatPKR(n: number): string {
  return `Rs. ${PKR.format(n)}`
}

function formatCompactPKR(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `Rs. ${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `Rs. ${(n / 1_000).toFixed(1)}k`
  return formatPKR(n)
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

// ─────────────────────────────────────────────────────────────────────────────
// Search type selector
// ─────────────────────────────────────────────────────────────────────────────

type SearchType = 'order_number' | 'customer' | 'product' | 'city'

const SEARCH_TYPE_OPTIONS: { value: SearchType; label: string }[] = [
  { value: 'order_number', label: 'Order Number' },
  { value: 'customer', label: 'Customer' },
  { value: 'product', label: 'Product / Variant' },
  { value: 'city', label: 'City' },
]

// ─────────────────────────────────────────────────────────────────────────────
// Chart metric definitions
// ─────────────────────────────────────────────────────────────────────────────

type ChartMetric =
  | 'total_orders'
  | 'revenue'
  | 'rto_rate'
  | 'cancellation_rate'
  | 'pending_current'
  | 'backordered_current'

interface ChartPoint {
  label: string
  value: number
  count?: number
  total?: number
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
  deliveryCity: string
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
  deliveryCity: '',
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
  if (f.deliveryCity.trim()) n++
  if (f.courier.trim()) n++
  return n
}

// ─────────────────────────────────────────────────────────────────────────────
// Date-preset helper for the Filters sheet (existing — kept for back-compat)
// ─────────────────────────────────────────────────────────────────────────────

const DATE_PRESETS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 Days' },
  { value: '30d', label: 'Last 30 Days' },
  { value: 'this_month', label: 'This Month' },
] as const

type DatePresetValue = (typeof DATE_PRESETS)[number]['value']

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
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function OrdersView() {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()

  const [search, setSearch] = useState('')
  const [searchType, setSearchType] = useState<SearchType>('order_number')
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [sheetOpen, setSheetOpen] = useState(false)

  // Time-span state for activity-based stat cards + drill-down charts
  const [timeSpan, setTimeSpan] = useState<TimeSpanValue>('last_30_days')
  const [customRange, setCustomRange] = useState<DateRange>(() =>
    resolveTimeSpan('last_30_days'),
  )

  // Active chart metric — controls the drill-down panel
  const [activeChart, setActiveChart] = useState<ChartMetric | null>(null)

  const canView = can(PERMISSIONS.ORDERS_VIEW)
  const canCreate = can(PERMISSIONS.ORDERS_CREATE)

  // ── Resolve the time span into a date range ──────────────────────────────
  const dateRange = useMemo(
    () => resolveTimeSpan(timeSpan, customRange),
    [timeSpan, customRange],
  )
  const monthly = isMonthlyGranularity(dateRange)

  // ── Build the query string for the main orders list ──────────────────────
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
    if (filters.deliveryCity.trim()) params.set('delivery_city', filters.deliveryCity.trim())
    if (filters.courier.trim()) params.set('courier', filters.courier.trim())
    if (search.trim() && searchType === 'order_number') params.set('search', search.trim())
    const qs = params.toString()
    return qs ? `?${qs}` : ''
  }, [filters, search, searchType])

  const { data, isLoading, isError, refetch, isFetching, error } = useQuery<OrdersListResponse>({
    queryKey: ['orders', queryString],
    queryFn: () => api.get<OrdersListResponse>(`/api/orders${queryString}`),
    staleTime: 15_000,
    enabled: canView,
  })

  const orders = data?.orders ?? []

  // ── Separate stats query — fetches ALL orders in the time span (no other
  //    filters) so the activity-based cards are accurate regardless of any
  //    filter applied to the table below. Limit bumped to the server max.
  const statsQueryString = useMemo(() => {
    const params = new URLSearchParams()
    params.set('dateFrom', dateRange.from)
    params.set('dateTo', dateRange.to)
    params.set('limit', '100')
    return `?${params.toString()}`
  }, [dateRange])

  const { data: statsData, isLoading: statsLoading } = useQuery<OrdersListResponse>({
    queryKey: ['orders-stats', statsQueryString],
    queryFn: () => api.get<OrdersListResponse>(`/api/orders${statsQueryString}`),
    staleTime: 15_000,
    enabled: canView,
  })

  const statsOrders = statsData?.orders ?? []

  // ── Stat-card values (4 activity-based, 2 current-state) ─────────────────
  const stats = useMemo(() => {
    const list = statsOrders
    const total = list.length

    const revenue = list
      .filter((o) => o.status !== 'cancelled')
      .reduce((sum, o) => sum + o.totalOrderValue, 0)

    const rtoCount = list.filter((o) => o.status === 'rto').length
    const cancelledCount = list.filter((o) => o.status === 'cancelled').length
    const rtoRate = total > 0 ? (rtoCount / total) * 100 : 0
    const cancelRate = total > 0 ? (cancelledCount / total) * 100 : 0

    // Current-state cards — counted RIGHT NOW from the loaded orders list
    // (uses the same data we already fetched for the table; this gives a
    // "currently pending / backordered" snapshot independent of the time span).
    const pendingCurrent = orders.filter((o) => o.status === 'pending').length
    const backorderedCurrent = orders.filter((o) => o.status === 'partially_backordered').length

    return {
      total,
      revenue,
      rtoCount,
      rtoRate,
      cancelledCount,
      cancelRate,
      pendingCurrent,
      backorderedCurrent,
    }
  }, [statsOrders, orders])

  // ── Drill-down chart data (computed client-side from the stats query) ────
  const chartData = useMemo<ChartPoint[]>(() => {
    if (!activeChart) return []
    return buildChartData(statsOrders, dateRange, monthly, activeChart)
  }, [statsOrders, dateRange, monthly, activeChart])

  const activeFilterCount = countActiveFilters(filters)
  const hasAnyFilter =
    activeFilterCount > 0 || (search.trim() !== '' && searchType === 'order_number')

  // ── Handlers for the structured search selections ───────────────────────
  const handleSelectCustomer = useCallback((c: CustomerOption) => {
    setFilters((p) => ({ ...p, customerId: c.id, customerLabel: `${c.name} · ${c.phone}` }))
    setSearch('')
  }, [])

  const handleSelectProduct = useCallback((v: ProductOption) => {
    setFilters((p) => ({
      ...p,
      orgVariantId: v.variantId,
      orgVariantLabel: `${v.title} (${v.sku})`,
    }))
    setSearch('')
  }, [])

  const handleSelectCity = useCallback((city: string) => {
    setFilters((p) => ({ ...p, deliveryCity: city }))
    setSearch('')
  }, [])

  // ── Stat card click → toggle chart ───────────────────────────────────────
  const handleCardClick = useCallback((metric: ChartMetric) => {
    setActiveChart((prev) => (prev === metric ? null : metric))
  }, [])

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
            <Button variant="outline" size="sm" onClick={() => navigate({ name: 'booking-workbench' })}>
              <Truck className="h-4 w-4" />
              Booking Workbench
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

      {/* ── Time-span selector ─────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <CalendarDays className="h-4 w-4" />
              <span>Time Span</span>
            </div>
            <div className="flex flex-1 flex-col sm:flex-row sm:items-center gap-2">
              <Select
                value={timeSpan}
                onValueChange={(v) => {
                  const next = v as TimeSpanValue
                  setTimeSpan(next)
                  if (next !== 'custom') setCustomRange(resolveTimeSpan(next))
                }}
              >
                <SelectTrigger size="sm" className="h-9 w-full sm:w-56">
                  <SelectValue placeholder="Select time span" />
                </SelectTrigger>
                <SelectContent>
                  {TIME_SPAN_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {timeSpan === 'custom' && (
                <div className="flex items-center gap-2">
                  <Input
                    type="date"
                    className="h-9 w-full sm:w-40 text-sm"
                    value={customRange.from}
                    onChange={(e) =>
                      setCustomRange((p) => ({ ...p, from: e.target.value }))
                    }
                    aria-label="From date"
                  />
                  <span className="text-xs text-muted-foreground">→</span>
                  <Input
                    type="date"
                    className="h-9 w-full sm:w-40 text-sm"
                    value={customRange.to}
                    onChange={(e) =>
                      setCustomRange((p) => ({ ...p, to: e.target.value }))
                    }
                    aria-label="To date"
                  />
                </div>
              )}

              <div className="text-xs text-muted-foreground sm:ml-auto">
                {dateRange.from} → {dateRange.to}{' '}
                <span className="ml-1 rounded bg-muted px-1.5 py-0.5">
                  {monthly ? 'monthly' : 'daily'}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Stat cards (4 activity-based + 2 current-state) ────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Total Orders"
          sublabel={`Created · ${monthly ? 'monthly' : 'daily'} view`}
          value={statsLoading ? undefined : String(stats.total)}
          icon={<ShoppingCart className="h-5 w-5" />}
          tone="emerald"
          loading={statsLoading}
          active={activeChart === 'total_orders'}
          onClick={() => handleCardClick('total_orders')}
        />
        <StatCard
          label="Revenue"
          sublabel="Non-cancelled orders"
          value={statsLoading ? undefined : formatCompactPKR(stats.revenue)}
          icon={<Banknote className="h-5 w-5" />}
          tone="sky"
          loading={statsLoading}
          active={activeChart === 'revenue'}
          onClick={() => handleCardClick('revenue')}
        />
        <StatCard
          label="RTO Rate"
          sublabel={`${stats.rtoCount} of ${stats.total} orders`}
          value={statsLoading ? undefined : `${stats.rtoRate.toFixed(1)}%`}
          icon={<RotateCcw className="h-5 w-5" />}
          tone="rose"
          loading={statsLoading}
          active={activeChart === 'rto_rate'}
          onClick={() => handleCardClick('rto_rate')}
        />
        <StatCard
          label="Cancellation Rate"
          sublabel={`${stats.cancelledCount} of ${stats.total} orders`}
          value={statsLoading ? undefined : `${stats.cancelRate.toFixed(1)}%`}
          icon={<Percent className="h-5 w-5" />}
          tone="amber"
          loading={statsLoading}
          active={activeChart === 'cancellation_rate'}
          onClick={() => handleCardClick('cancellation_rate')}
        />
        <StatCard
          label="Pending Confirmation"
          sublabel="(current)"
          value={isLoading ? undefined : String(stats.pendingCurrent)}
          icon={<Clock className="h-5 w-5" />}
          tone="sky"
          loading={isLoading}
          active={activeChart === 'pending_current'}
          onClick={() => handleCardClick('pending_current')}
        />
        <StatCard
          label="Backordered"
          sublabel="(current)"
          value={isLoading ? undefined : String(stats.backorderedCurrent)}
          icon={<PackageX className="h-5 w-5" />}
          tone="rose"
          loading={isLoading}
          active={activeChart === 'backordered_current'}
          onClick={() => handleCardClick('backordered_current')}
        />
      </div>

      {/* ── Drill-down chart panel ─────────────────────────────────────────── */}
      {activeChart && (
        <ChartPanel
          metric={activeChart}
          data={chartData}
          monthly={monthly}
          dateRange={dateRange}
          onClose={() => setActiveChart(null)}
        />
      )}

      {/* ── Search + filter bar ────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <Select
              value={searchType}
              onValueChange={(v) => {
                setSearchType(v as SearchType)
                setSearch('')
              }}
            >
              <SelectTrigger size="sm" className="h-9 w-full lg:w-44 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEARCH_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex-1">
              {searchType === 'order_number' && (
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search order #, external ref, customer…"
                    className="pl-9 h-9"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              )}
              {searchType === 'customer' && (
                <CustomerAutocomplete
                  onSelect={handleSelectCustomer}
                  onClear={() => setSearch('')}
                />
              )}
              {searchType === 'product' && (
                <ProductAutocomplete
                  onSelect={handleSelectProduct}
                  onClear={() => setSearch('')}
                />
              )}
              {searchType === 'city' && (
                <CityAutocomplete onSelect={handleSelectCity} onClear={() => setSearch('')} />
              )}
            </div>

            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 shrink-0">
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
                className="h-9 shrink-0 text-muted-foreground"
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
              label={`Product: ${filters.orgVariantLabel || filters.orgVariantId}`}
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
          {filters.deliveryCity.trim() && (
            <FilterChip
              label={`City: ${filters.deliveryCity.trim()}`}
              onRemove={() => setFilters((p) => ({ ...p, deliveryCity: '' }))}
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
                    <TableHead>Courier</TableHead>
                    <TableHead>Tracking #</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Delivery</TableHead>
                    <TableHead className="text-right">Tax</TableHead>
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
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-sm">{order.customerName}</span>
                              {order.courierCityStatus === 'unresolved' && (
                                <span title="City mismatch — needs resolution before booking" className="inline-flex items-center gap-0.5 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-0.5">
                                  <AlertTriangle className="h-2.5 w-2.5" /> City
                                </span>
                              )}
                              {order.needsShipperAdvice && (
                                <span title="Courier status requires shipper advice" className="inline-flex items-center gap-0.5 text-[10px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-1 py-0.5">
                                  <AlertCircle className="h-2.5 w-2.5" /> Advice
                                </span>
                              )}
                            </div>
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
                        {/* Courier — name + booking status badge */}
                        <TableCell>
                          {order.courierName ? (
                            <div className="flex flex-col gap-0.5">
                              <span className="text-xs font-medium">{order.courierName}</span>
                              {order.courierBookingStatus && order.courierBookingStatus !== 'booked' && (
                                <span
                                  title={order.courierBookingStatus}
                                  className={cn(
                                    'text-[9px] inline-flex items-center gap-0.5 px-1 py-0.5 rounded border w-fit',
                                    order.courierBookingStatus === 'failed'
                                      ? 'bg-rose-50 text-rose-700 border-rose-200'
                                      : 'bg-gray-50 text-gray-600 border-gray-200',
                                  )}
                                >
                                  {order.courierBookingStatus === 'failed' ? 'Failed' : 'Not booked'}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        {/* Tracking # — monospace, click to copy */}
                        <TableCell>
                          {order.trackingNumber ? (
                            <span
                              className="text-xs font-mono text-primary cursor-pointer hover:underline"
                              title="Click to copy"
                              onClick={(e) => {
                                e.stopPropagation()
                                navigator.clipboard?.writeText(order.trackingNumber!).catch(() => {})
                              }}
                            >
                              {order.trackingNumber}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        {/* Reference — universal courier reference (migration 015) */}
                        <TableCell>
                          {order.orderRefNumber ? (
                            <span className="text-xs font-mono" title={order.orderDetail ?? ''}>
                              {order.orderRefNumber}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {formatDate(order.createdAt)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs">
                          {order.estimatedDeliveryCharge != null && order.estimatedDeliveryCharge > 0
                            ? formatPKR(order.estimatedDeliveryCharge)
                            : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs">
                          {order.taxAmount != null && order.taxAmount > 0 ? (
                            <span title={order.taxLabel || ''}>
                              {formatPKR(order.taxAmount)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <CancelCourierBookingButton
                              entityType="order"
                              entityId={order.id}
                              courierSubStatus={order.courierSubStatus}
                            />
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
                          </div>
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
// Chart data builder
// ─────────────────────────────────────────────────────────────────────────────

function buildChartData(
  orders: OrderRow[],
  range: DateRange,
  monthly: boolean,
  metric: ChartMetric,
): ChartPoint[] {
  // Build the list of interval buckets
  const buckets = buildIntervalBuckets(range, monthly)

  // For each order, compute its bucket key (yyyy-mm-dd or yyyy-mm)
  for (const o of orders) {
    const created = new Date(o.createdAt)
    if (Number.isNaN(created.getTime())) continue
    const key = monthly
      ? `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}`
      : toISODate(created)
    const b = buckets.find((x) => x.key === key)
    if (!b) continue
    b.total += 1
    if (o.status === 'rto') b.rto += 1
    if (o.status === 'cancelled') b.cancelled += 1
    if (o.status !== 'cancelled') b.revenue += o.totalOrderValue
    if (o.status === 'pending') b.pending += 1
    if (o.status === 'partially_backordered') b.backordered += 1
  }

  return buckets.map((b) => {
    let value = 0
    let count: number | undefined
    let total: number | undefined
    switch (metric) {
      case 'total_orders':
        value = b.total
        break
      case 'revenue':
        value = b.revenue
        break
      case 'rto_rate':
        value = b.total > 0 ? (b.rto / b.total) * 100 : 0
        count = b.rto
        total = b.total
        break
      case 'cancellation_rate':
        value = b.total > 0 ? (b.cancelled / b.total) * 100 : 0
        count = b.cancelled
        total = b.total
        break
      case 'pending_current':
        value = b.pending
        break
      case 'backordered_current':
        value = b.backordered
        break
    }
    return { label: b.label, value, count, total }
  })
}

interface Bucket {
  key: string
  label: string
  total: number
  revenue: number
  rto: number
  cancelled: number
  pending: number
  backordered: number
}

function buildIntervalBuckets(range: DateRange, monthly: boolean): Bucket[] {
  const out: Bucket[] = []
  const start = new Date(range.from + 'T00:00:00')
  const end = new Date(range.to + 'T23:59:59')

  if (monthly) {
    // Iterate by month from start month to end month (inclusive)
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1)
    const endMonth = new Date(end.getFullYear(), end.getMonth(), 1)
    while (cursor <= endMonth) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`
      const label = cursor.toLocaleDateString('en-PK', { month: 'short', year: '2-digit' })
      out.push({ key, label, total: 0, revenue: 0, rto: 0, cancelled: 0, pending: 0, backordered: 0 })
      cursor.setMonth(cursor.getMonth() + 1)
    }
  } else {
    // Iterate by day from start to end (inclusive)
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate())
    const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate())
    while (cursor <= endDay) {
      const key = toISODate(cursor)
      const label = cursor.toLocaleDateString('en-PK', { day: '2-digit', month: 'short' })
      out.push({ key, label, total: 0, revenue: 0, rto: 0, cancelled: 0, pending: 0, backordered: 0 })
      cursor.setDate(cursor.getDate() + 1)
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

const FilterChip = memo(function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
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
})

type StatTone = 'emerald' | 'amber' | 'rose' | 'sky'

const STAT_TONE_CLASSES: Record<StatTone, string> = {
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  rose: 'bg-rose-50 text-rose-600',
  sky: 'bg-sky-50 text-sky-600',
}

const STAT_ACTIVE_RING: Record<StatTone, string> = {
  emerald: 'ring-emerald-400/60 bg-emerald-50/40',
  amber: 'ring-amber-400/60 bg-amber-50/40',
  rose: 'ring-rose-400/60 bg-rose-50/40',
  sky: 'ring-sky-400/60 bg-sky-50/40',
}

const StatCard = memo(function StatCard({
  label,
  sublabel,
  value,
  icon,
  tone,
  loading,
  active,
  onClick,
}: {
  label: string
  sublabel?: string
  value?: string
  icon: React.ReactNode
  tone: StatTone
  loading?: boolean
  active?: boolean
  onClick?: () => void
}) {
  return (
    <Card
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (!onClick) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className={cn(
        'transition-all',
        onClick && 'cursor-pointer hover:shadow-md hover:-translate-y-0.5',
        active && cn('ring-2', STAT_ACTIVE_RING[tone]),
      )}
    >
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <div
            className={cn(
              'flex h-10 w-10 items-center justify-center rounded-lg',
              STAT_TONE_CLASSES[tone],
            )}
          >
            {icon}
          </div>
          {active && (
            <TrendingUp className={cn('h-4 w-4', STAT_TONE_CLASSES[tone].split(' ')[1])} />
          )}
        </div>
        <div className="mt-3">
          {loading ? (
            <Skeleton className="h-7 w-24" />
          ) : (
            <span className="text-xl font-semibold tracking-tight tabular-nums">
              {value ?? '—'}
            </span>
          )}
          <p className="mt-1 text-sm font-medium text-foreground/80">{label}</p>
          {sublabel && (
            <p className="text-[11px] text-muted-foreground mt-0.5">{sublabel}</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Chart panel
// ─────────────────────────────────────────────────────────────────────────────

const CHART_METRIC_META: Record<
  ChartMetric,
  { title: string; description: string; format: 'count' | 'currency' | 'percent' }
> = {
  total_orders: {
    title: 'Total Orders Created',
    description: 'Orders created per interval within the selected time span',
    format: 'count',
  },
  revenue: {
    title: 'Revenue',
    description: 'Sum of total order value (non-cancelled) per interval',
    format: 'currency',
  },
  rto_rate: {
    title: 'RTO Rate',
    description: 'RTO orders as a % of total orders per interval',
    format: 'percent',
  },
  cancellation_rate: {
    title: 'Cancellation Rate',
    description: 'Cancelled orders as a % of total orders per interval',
    format: 'percent',
  },
  pending_current: {
    title: 'Pending Confirmation (current)',
    description: 'Orders created per interval that are currently pending',
    format: 'count',
  },
  backordered_current: {
    title: 'Backordered (current)',
    description: 'Orders created per interval that are currently backordered',
    format: 'count',
  },
}

function ChartPanel({
  metric,
  data,
  monthly,
  dateRange,
  onClose,
}: {
  metric: ChartMetric
  data: ChartPoint[]
  monthly: boolean
  dateRange: DateRange
  onClose: () => void
}) {
  const meta = CHART_METRIC_META[metric]
  const isRate = meta.format === 'percent'
  const isCurrency = meta.format === 'currency'

  const tooltipFormatter = useCallback(
    (val: number) => {
      if (isCurrency) return [formatPKR(val), meta.title]
      if (isRate) return [`${val.toFixed(1)}%`, meta.title]
      return [String(val), meta.title]
    },
    [isCurrency, isRate, meta.title],
  )

  // Choose chart type: line for revenue & rates; bar for counts
  const useLine = isCurrency || isRate
  const barColor = 'hsl(158 64% 40%)' // emerald-600
  const lineColor = 'hsl(199 89% 40%)' // sky-600

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-2 mb-4">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              {meta.title}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">{meta.description}</p>
            <p className="text-[11px] text-muted-foreground mt-1">
              {dateRange.from} → {dateRange.to} · {monthly ? 'monthly' : 'daily'} granularity ·{' '}
              {data.length} {monthly ? 'months' : 'days'}
            </p>
          </div>
          <Button variant="ghost" size="sm" className="h-8 shrink-0" onClick={onClose}>
            <X className="h-4 w-4" />
            Close
          </Button>
        </div>

        {data.length === 0 ? (
          <div className="h-[250px] flex items-center justify-center text-sm text-muted-foreground">
            No data in this time span.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            {useLine ? (
              <LineChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(0 0% 90%)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: 'hsl(0 0% 45%)' }}
                  tickLine={false}
                  axisLine={{ stroke: 'hsl(0 0% 90%)' }}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'hsl(0 0% 45%)' }}
                  tickLine={false}
                  axisLine={false}
                  width={isCurrency ? 60 : 40}
                  tickFormatter={(v: number) =>
                    isCurrency ? formatCompactPKR(v) : isRate ? `${v}%` : String(v)
                  }
                />
                <Tooltip
                  formatter={tooltipFormatter}
                  contentStyle={{
                    borderRadius: 8,
                    border: '1px solid hsl(0 0% 90%)',
                    fontSize: 12,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={lineColor}
                  strokeWidth={2}
                  dot={{ r: 3, fill: lineColor }}
                  activeDot={{ r: 5 }}
                  name={meta.title}
                />
              </LineChart>
            ) : (
              <BarChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(0 0% 90%)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: 'hsl(0 0% 45%)' }}
                  tickLine={false}
                  axisLine={{ stroke: 'hsl(0 0% 90%)' }}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'hsl(0 0% 45%)' }}
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  allowDecimals={false}
                />
                <Tooltip
                  formatter={tooltipFormatter}
                  contentStyle={{
                    borderRadius: 8,
                    border: '1px solid hsl(0 0% 90%)',
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="value" fill={barColor} radius={[4, 4, 0, 0]} name={meta.title} />
              </BarChart>
            )}
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Customer autocomplete (debounced + keyboard nav)
// ─────────────────────────────────────────────────────────────────────────────

function CustomerAutocomplete({
  onSelect,
  onClear,
}: {
  onSelect: (c: CustomerOption) => void
  onClear: () => void
}) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)

  // Debounce 300ms
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300)
    return () => clearTimeout(t)
  }, [query])

  const { data, isFetching, isLoading } = useQuery<CustomersSearchResponse>({
    queryKey: ['customers', 'autocomplete', debounced],
    queryFn: () =>
      api.get<CustomersSearchResponse>(
        `/api/customers?search=${encodeURIComponent(debounced)}&limit=10`,
      ),
    enabled: debounced.length >= 2,
    staleTime: 10_000,
  })

  const results = data?.customers ?? []

  // Reset highlight when results change
  useEffect(() => {
    setHighlight(results.length > 0 ? 0 : -1)
  }, [results])

  // Close on outside click
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const choose = (c: CustomerOption) => {
    onSelect(c)
    setQuery('')
    setDebounced('')
    setOpen(false)
    onClear()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setHighlight((h) => Math.min(h + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlight >= 0 && highlight < results.length) choose(results[highlight])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  const showDropdown = open && debounced.length >= 2

  return (
    <div ref={containerRef} className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <Input
        placeholder="Type customer name or phone (min 2 chars)…"
        className="pl-9 h-9"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        aria-label="Search customers"
        aria-expanded={showDropdown}
        aria-autocomplete="list"
        role="combobox"
      />
      {isFetching && (
        <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
      )}

      {showDropdown && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md overflow-hidden">
          {isLoading ? (
            <div className="space-y-1 p-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          ) : results.length === 0 ? (
            <div className="p-3 text-xs text-muted-foreground flex items-center gap-2">
              <AlertCircle className="h-3.5 w-3.5" />
              No customers found for &ldquo;{debounced}&rdquo;
            </div>
          ) : (
            <ul role="listbox" className="max-h-72 overflow-y-auto py-1">
              {results.map((c, idx) => (
                <li key={c.id} role="option" aria-selected={idx === highlight}>
                  <button
                    type="button"
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={() => choose(c)}
                    className={cn(
                      'w-full text-left px-3 py-2 flex items-center justify-between gap-2',
                      idx === highlight ? 'bg-muted/80' : 'hover:bg-muted/40',
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{c.name}</span>
                        {c.isFlagged && (
                          <Badge
                            variant="outline"
                            className="h-4 px-1 text-[10px] bg-rose-50 text-rose-700 border-rose-200"
                          >
                            RTO risk
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono">{c.phone}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs text-muted-foreground">
                        {c.totalOrdersCount} order{c.totalOrdersCount === 1 ? '' : 's'}
                      </div>
                      {c.totalRtoCount > 0 && (
                        <div className="text-[10px] text-rose-600">
                          {c.totalRtoCount} RTO
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Product / Variant autocomplete
// ─────────────────────────────────────────────────────────────────────────────

function ProductAutocomplete({
  onSelect,
  onClear,
}: {
  onSelect: (v: ProductOption) => void
  onClear: () => void
}) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300)
    return () => clearTimeout(t)
  }, [query])

  const { data, isFetching, isLoading } = useQuery<ProductsResponse>({
    queryKey: ['products', 'autocomplete', debounced],
    queryFn: () =>
      api.get<ProductsResponse>(
        `/api/products?search=${encodeURIComponent(debounced)}&pageSize=10`,
      ),
    enabled: debounced.length >= 2,
    staleTime: 30_000,
  })

  const results = useMemo<ProductOption[]>(() => {
    const list: ProductOption[] = []
    for (const p of data?.products ?? []) {
      for (const v of p.variants) {
        list.push({
          productId: p.id,
          variantId: v.id,
          sku: v.sku,
          title: p.title,
          fulfillmentType: v.fulfillmentType,
          salePrice: v.salePrice,
        })
      }
    }
    return list
  }, [data])

  useEffect(() => {
    setHighlight(results.length > 0 ? 0 : -1)
  }, [results])

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const choose = (v: ProductOption) => {
    onSelect(v)
    setQuery('')
    setDebounced('')
    setOpen(false)
    onClear()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setHighlight((h) => Math.min(h + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlight >= 0 && highlight < results.length) choose(results[highlight])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  const showDropdown = open && debounced.length >= 2

  return (
    <div ref={containerRef} className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <Input
        placeholder="Type product title or SKU (min 2 chars)…"
        className="pl-9 h-9"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        aria-label="Search products"
        aria-expanded={showDropdown}
        aria-autocomplete="list"
        role="combobox"
      />
      {isFetching && (
        <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
      )}

      {showDropdown && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md overflow-hidden">
          {isLoading ? (
            <div className="space-y-1 p-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          ) : results.length === 0 ? (
            <div className="p-3 text-xs text-muted-foreground flex items-center gap-2">
              <AlertCircle className="h-3.5 w-3.5" />
              No products found for &ldquo;{debounced}&rdquo;
            </div>
          ) : (
            <ul role="listbox" className="max-h-72 overflow-y-auto py-1">
              {results.map((v, idx) => (
                <li key={v.variantId} role="option" aria-selected={idx === highlight}>
                  <button
                    type="button"
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={() => choose(v)}
                    className={cn(
                      'w-full text-left px-3 py-2 flex items-center justify-between gap-2',
                      idx === highlight ? 'bg-muted/80' : 'hover:bg-muted/40',
                    )}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{v.title}</div>
                      <div className="text-xs text-muted-foreground font-mono">
                        SKU: {v.sku}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {v.salePrice != null && (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {formatPKR(v.salePrice)}
                        </span>
                      )}
                      <FulfillmentBadge type={v.fulfillmentType} />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

const FulfillmentBadge = memo(function FulfillmentBadge({ type }: { type: string | null }) {
  if (!type) return null
  const map: Record<string, { label: string; cls: string }> = {
    stock_based: { label: 'In Stock', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    made_to_order: {
      label: 'Made to Order',
      cls: 'bg-purple-50 text-purple-700 border-purple-200',
    },
    backorder: { label: 'Backorder', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  }
  const meta = map[type] ?? { label: type, cls: 'bg-gray-100 text-gray-700 border-gray-200' }
  return (
    <Badge variant="outline" className={cn('h-5 px-1.5 text-[10px]', meta.cls)}>
      {meta.label}
    </Badge>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// City autocomplete (datalist of distinct cities from loaded orders)
// ─────────────────────────────────────────────────────────────────────────────

function CityAutocomplete({
  onSelect,
  onClear,
}: {
  onSelect: (city: string) => void
  onClear: () => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)

  // Fetch a broad set of orders (no other filters) to compute distinct cities
  const { data, isLoading } = useQuery<OrdersListResponse>({
    queryKey: ['orders-cities'],
    queryFn: () => api.get<OrdersListResponse>(`/api/orders?limit=100`),
    staleTime: 60_000,
  })

  const cities = useMemo(() => {
    const set = new Set<string>()
    for (const o of data?.orders ?? []) {
      if (o.deliveryCity && o.deliveryCity.trim()) set.add(o.deliveryCity.trim())
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [data])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return cities
    return cities.filter((c) => c.toLowerCase().includes(q))
  }, [cities, query])

  useEffect(() => {
    setHighlight(results.length > 0 ? 0 : -1)
  }, [results])

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const choose = (c: string) => {
    onSelect(c)
    setQuery('')
    setOpen(false)
    onClear()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setHighlight((h) => Math.min(h + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // Prefer highlighted match, otherwise exact-match the typed text
      if (highlight >= 0 && highlight < results.length) choose(results[highlight])
      else if (query.trim()) choose(query.trim())
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  const showDropdown = open && query.trim().length > 0

  return (
    <div ref={containerRef} className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <Input
        placeholder="Type delivery city to filter (e.g. Lahore, Karachi)…"
        className="pl-9 h-9"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        list="orders-city-list"
        aria-label="Search delivery city"
        aria-expanded={showDropdown}
        aria-autocomplete="list"
        role="combobox"
      />
      <datalist id="orders-city-list">
        {cities.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      {showDropdown && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md overflow-hidden">
          {isLoading ? (
            <div className="space-y-1 p-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-7" />
              ))}
            </div>
          ) : results.length === 0 ? (
            <div className="p-3 text-xs text-muted-foreground flex items-center gap-2">
              <AlertCircle className="h-3.5 w-3.5" />
              No matching cities — press Enter to filter by &ldquo;{query.trim()}&rdquo; anyway
            </div>
          ) : (
            <ul role="listbox" className="max-h-72 overflow-y-auto py-1">
              {results.slice(0, 50).map((c, idx) => (
                <li key={c} role="option" aria-selected={idx === highlight}>
                  <button
                    type="button"
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={() => choose(c)}
                    className={cn(
                      'w-full text-left px-3 py-1.5 text-sm',
                      idx === highlight ? 'bg-muted/80' : 'hover:bg-muted/40',
                    )}
                  >
                    {c}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Skeletons + empty states
// ─────────────────────────────────────────────────────────────────────────────

const OrdersTableSkeleton = memo(function OrdersTableSkeleton() {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 7 }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  )
})

const EmptyState = memo(function EmptyState({
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
})

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
        list.push({
          productId: p.id,
          variantId: v.id,
          sku: v.sku,
          title: p.title,
          fulfillmentType: v.fulfillmentType,
          salePrice: v.salePrice,
        })
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

        {/* Delivery City */}
        <FilterSection title="Delivery City">
          <Input
            placeholder="e.g. Lahore"
            className="h-8 text-sm"
            value={draft.deliveryCity}
            onChange={(e) => patch({ deliveryCity: e.target.value })}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Case-insensitive contains on the order&apos;s delivery city.
          </p>
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

const FilterSection = memo(function FilterSection({
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
})
