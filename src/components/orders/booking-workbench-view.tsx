'use client'

/**
 * BookingWorkbenchView
 * ---------------------
 * Bulk booking workbench for external-platform orders that have NOT yet been
 * booked with a courier (i.e. courierCompanyIntegrationId === null).
 *
 * Fetches confirmed/processing orders via:
 *   GET /api/orders?statuses=confirmed,processing&limit=100
 *
 * Then client-side filters to orders where courierCompanyIntegrationId is null
 * (the API doesn't yet expose this as a query param — adding it would require
 * a /lib change which is out-of-scope for this task).
 *
 * Each row exposes editable inputs for customer name / phone / address,
 * a CityAutocomplete (providerKey from the batch-level courier dropdown),
 * COD amount, and an order type dropdown (Normal/Overland/Replacement —
 * pre-computed client-side via the same logic as the PostEx adapter for
 * convenience, but editable so the operator can override).
 *
 * The top toolbar has:
 *   - Courier integration dropdown (drives the CityAutocomplete providerKey)
 *   - "Select All" / "Select None"
 *   - "Upload Booking" button — fires POST /api/booking-workbench/book for
 *     each CHECKED row independently. Failures do NOT block other rows.
 *
 * Per-row result: ✅ tracking number, or ❌ error message.
 */

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, FetchError } from '@/lib/api-client'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardContent } from '@/components/ui/card'
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
  Truck,
  RefreshCw,
  Loader2,
  CheckCircle2,
  XCircle,
  Upload,
  Inbox,
  AlertCircle,
  Search,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { CityAutocomplete } from '@/components/couriers/city-autocomplete'
import { formatPKR, formatDate, getErrorMessage } from './_shared'

// ─────────────────────────────────────────────────────────────────────────────
// Types — match GET /api/orders response
// ─────────────────────────────────────────────────────────────────────────────

interface OrderRow {
  id: string
  flowopsOrderNumber: string
  externalOrderReference: string | null
  orderSource: string
  status: string
  paymentType: string
  totalOrderValue: number
  remainingCodAmount: number | null
  courierCompanyIntegrationId: string | null
  customerId: string
  deliveryCity: string | null
  customerName: string
  customerPhone: string | null
  itemCount: number
  createdAt: string
}

interface OrdersListResponse {
  orders: OrderRow[]
  total: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Types — integrations
// ─────────────────────────────────────────────────────────────────────────────

interface IntegrationProvider {
  id: string
  providerKey: string
  providerName: string
  category: string
  logoUrl: string | null
}

interface CompanyIntegration {
  id: string
  connectionName: string
  isActive: boolean
  provider: IntegrationProvider
}

interface IntegrationsResponse {
  providers: IntegrationProvider[]
  integrations: CompanyIntegration[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Types — booking workbench book endpoint
// ─────────────────────────────────────────────────────────────────────────────

interface BookRequest {
  orderId: string
  companyIntegrationId: string
  customerName?: string
  customerPhone?: string
  deliveryAddress?: string
  deliveryCity?: string
  codAmount?: number
  orderType?: string
}

interface BookSuccess {
  success: true
  trackingNumber: string
  orderType: string
  providerStatus: string | null
}

type BookResult =
  | { ok: true; trackingNumber: string; orderType: string }
  | { ok: false; error: string }

// ─────────────────────────────────────────────────────────────────────────────
// Row state (editable overrides)
// ─────────────────────────────────────────────────────────────────────────────

interface RowState {
  customerName: string
  customerPhone: string
  deliveryAddress: string
  deliveryCity: string
  codAmount: string
  orderType: 'Normal' | 'Overland' | 'Replacement'
  checked: boolean
  // Per-row booking result (cleared on edit)
  result: BookResult | null
  isBooking: boolean
}

type OrderType = 'Normal' | 'Overland' | 'Replacement'

const ORDER_TYPES: { value: OrderType; label: string; desc: string }[] = [
  { value: 'Normal', label: 'Normal', desc: 'Standard delivery (≤1kg)' },
  { value: 'Overland', label: 'Overland', desc: 'Heavy/oversized (>1kg)' },
  { value: 'Replacement', label: 'Replacement', desc: 'Exchange replacement' },
]

const SOURCE_BADGE: Record<string, string> = {
  shopify: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  daraz: 'bg-orange-50 text-orange-700 border-orange-200',
  manual: 'bg-gray-100 text-gray-700 border-gray-200',
  instagram: 'bg-pink-50 text-pink-700 border-pink-200',
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export function BookingWorkbenchView() {
  const queryClient = useQueryClient()

  // Batch-level state
  const [companyIntegrationId, setCompanyIntegrationId] = useState<string>('')
  const [search, setSearch] = useState('')

  // Per-row editable state keyed by order id
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({})

  // ── Data: orders ────────────────────────────────────────────────────────
  const ordersQuery = useQuery<OrdersListResponse>({
    queryKey: ['orders', 'booking-workbench'],
    queryFn: () =>
      api.get<OrdersListResponse>(
        '/api/orders?statuses=confirmed,processing&limit=100',
      ),
    staleTime: 15_000,
  })

  // Client-side filter: only unbooked orders (no courier integration)
  const unbookedOrders = useMemo(() => {
    if (!ordersQuery.data?.orders) return []
    return ordersQuery.data.orders.filter(
      (o) => !o.courierCompanyIntegrationId,
    )
  }, [ordersQuery.data])

  // Apply search filter (order # / customer / phone)
  const filteredOrders = useMemo(() => {
    if (!search.trim()) return unbookedOrders
    const q = search.trim().toLowerCase()
    return unbookedOrders.filter(
      (o) =>
        o.flowopsOrderNumber.toLowerCase().includes(q) ||
        o.externalOrderReference?.toLowerCase().includes(q) ||
        o.customerName.toLowerCase().includes(q) ||
        o.customerPhone?.toLowerCase().includes(q),
    )
  }, [unbookedOrders, search])

  // ── Data: courier integrations ──────────────────────────────────────────
  const integrationsQuery = useQuery<IntegrationsResponse>({
    queryKey: ['integrations', 'courier'],
    queryFn: () => api.get<IntegrationsResponse>('/api/integrations?category=courier'),
    staleTime: 30_000,
  })

  const courierIntegrations = useMemo(
    () =>
      (integrationsQuery.data?.integrations ?? []).filter(
        (i) => i.isActive && i.provider?.category === 'courier',
      ),
    [integrationsQuery.data],
  )

  const selectedIntegration = useMemo(
    () => courierIntegrations.find((i) => i.id === companyIntegrationId),
    [courierIntegrations, companyIntegrationId],
  )
  const selectedProviderKey = selectedIntegration?.provider?.providerKey ?? ''

  // ── Row state helpers ───────────────────────────────────────────────────
  function getRowState(order: OrderRow): RowState {
    if (rowStates[order.id]) return rowStates[order.id]
    return {
      customerName: order.customerName ?? '',
      customerPhone: order.customerPhone ?? '',
      deliveryAddress: '', // not returned by listOrders endpoint — user fills in
      deliveryCity: order.deliveryCity ?? '',
      codAmount: String(
        order.remainingCodAmount ?? order.totalOrderValue ?? 0,
      ),
      orderType: 'Normal',
      checked: false,
      result: null,
      isBooking: false,
    }
  }

  function patchRow(orderId: string, patch: Partial<RowState>) {
    setRowStates((prev) => ({
      ...prev,
      [orderId]: {
        ...(prev[orderId] ?? getRowStateLookup(orderId)),
        ...patch,
        // Clear any previous result when the user edits a field
        result:
          patch.result !== undefined ? patch.result : null,
      },
    }))
  }

  // Lookup that doesn't depend on filteredOrders (for patchRow safety)
  function getRowStateLookup(orderId: string): RowState {
    if (rowStates[orderId]) return rowStates[orderId]
    const order = ordersQuery.data?.orders?.find((o) => o.id === orderId)
    if (order) {
      return {
        customerName: order.customerName ?? '',
        customerPhone: order.customerPhone ?? '',
        deliveryAddress: '',
        deliveryCity: order.deliveryCity ?? '',
        codAmount: String(
          order.remainingCodAmount ?? order.totalOrderValue ?? 0,
        ),
        orderType: 'Normal' as const,
        checked: false,
        result: null,
        isBooking: false,
      }
    }
    return {
      customerName: '',
      customerPhone: '',
      deliveryAddress: '',
      deliveryCity: '',
      codAmount: '0',
      orderType: 'Normal' as const,
      checked: false,
      result: null,
      isBooking: false,
    }
  }

  // ── Select-all helpers ──────────────────────────────────────────────────
  const checkedCount = filteredOrders.filter(
    (o) => getRowState(o).checked,
  ).length
  const allChecked =
    filteredOrders.length > 0 && checkedCount === filteredOrders.length

  function toggleSelectAll() {
    const next: Record<string, RowState> = { ...rowStates }
    const target = !allChecked
    for (const o of filteredOrders) {
      const cur = next[o.id] ?? getRowState(o)
      next[o.id] = { ...cur, checked: target }
    }
    setRowStates(next)
  }

  // ── Booking mutation (per-row) ──────────────────────────────────────────
  const bookMutation = useMutation({
    mutationFn: async (input: {
      orderId: string
      body: BookRequest
    }): Promise<BookSuccess> => {
      return api.post<BookSuccess>('/api/booking-workbench/book', input.body)
    },
    // We handle success/failure in the batchSubmit loop below, not here.
  })

  // ── Batch submit ────────────────────────────────────────────────────────
  async function handleUploadBooking() {
    if (!companyIntegrationId) {
      toast.error('Select a courier integration first.')
      return
    }
    const checkedRows = filteredOrders.filter((o) => {
      const s = getRowState(o)
      return s.checked && !s.isBooking
    })
    if (checkedRows.length === 0) {
      toast.error('No rows selected. Tick the checkbox on at least one order.')
      return
    }

    toast.info(`Booking ${checkedRows.length} order(s) with ${selectedIntegration?.provider?.providerName ?? 'courier'}…`)

    let successCount = 0
    let failureCount = 0

    // Fire requests sequentially — booking calls external courier APIs which
    // typically don't tolerate parallel hits well, and per-row errors must
    // not block other rows.
    for (const order of checkedRows) {
      const state = getRowState(order)
      const body: BookRequest = {
        orderId: order.id,
        companyIntegrationId,
        customerName: state.customerName.trim() || undefined,
        customerPhone: state.customerPhone.trim() || undefined,
        deliveryAddress: state.deliveryAddress.trim() || undefined,
        deliveryCity: state.deliveryCity.trim() || undefined,
        codAmount: Number(state.codAmount) || 0,
        orderType: state.orderType,
      }

      // Mark as booking in progress
      patchRow(order.id, { isBooking: true, result: null })

      try {
        const result = await bookMutation.mutateAsync({
          orderId: order.id,
          body,
        })
        successCount++
        patchRow(order.id, {
          isBooking: false,
          checked: false,
          result: {
            ok: true,
            trackingNumber: result.trackingNumber,
            orderType: result.orderType,
          },
        })
      } catch (err) {
        failureCount++
        const message =
          err instanceof FetchError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Booking failed'
        patchRow(order.id, {
          isBooking: false,
          result: { ok: false, error: message },
        })
      }
    }

    // Final toast + invalidate orders list so successfully booked rows
    // disappear (they now have courierCompanyIntegrationId set).
    if (successCount > 0 && failureCount === 0) {
      toast.success(
        `All ${successCount} order(s) booked successfully.`,
      )
    } else if (successCount > 0 && failureCount > 0) {
      toast.warning(
        `${successCount} booked, ${failureCount} failed. See per-row status.`,
      )
    } else {
      toast.error(`All ${failureCount} booking(s) failed. See per-row errors.`)
    }

    if (successCount > 0) {
      queryClient.invalidateQueries({ queryKey: ['orders', 'booking-workbench'] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
    }
  }

  // ── Render: loading / error / empty ─────────────────────────────────────
  if (ordersQuery.isLoading) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Booking Workbench"
          description="Bulk-book external-platform orders with a courier."
        />
        <Card>
          <CardContent className="p-10 text-center">
            <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
            <p className="text-sm text-muted-foreground mt-2">
              Loading unbooked orders…
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (ordersQuery.isError) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Booking Workbench"
          description="Bulk-book external-platform orders with a courier."
        />
        <Card className="border-rose-200">
          <CardContent className="p-10 text-center space-y-3">
            <AlertCircle className="h-6 w-6 mx-auto text-rose-600" />
            <p className="text-sm text-rose-700">
              {getErrorMessage(ordersQuery.error)}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => ordersQuery.refetch()}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Booking Workbench"
        description="Bulk-book confirmed external-platform orders that haven't yet been booked with a courier."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => ordersQuery.refetch()}
            disabled={ordersQuery.isFetching}
          >
            <RefreshCw
              className={cn(
                'h-3.5 w-3.5',
                ordersQuery.isFetching && 'animate-spin',
              )}
            />
            Refresh
          </Button>
        }
      />

      {/* Batch toolbar */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
            {/* Courier integration */}
            <div className="space-y-1.5">
              <Label className="text-xs flex items-center gap-1">
                <Truck className="h-3 w-3" /> Courier Integration
              </Label>
              <Select
                value={companyIntegrationId}
                onValueChange={(v) => {
                  setCompanyIntegrationId(v)
                  // City provider changes — clear per-row city overrides so
                  // they re-query against the new courier's operational cities.
                  const next: Record<string, RowState> = {}
                  for (const [id, s] of Object.entries(rowStates)) {
                    next[id] = { ...s, deliveryCity: '', result: null }
                  }
                  setRowStates(next)
                }}
                disabled={integrationsQuery.isLoading}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      integrationsQuery.isLoading
                        ? 'Loading…'
                        : courierIntegrations.length === 0
                          ? 'No courier integrations'
                          : 'Select courier'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {courierIntegrations.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      <span className="flex items-center gap-2">
                        <span className="font-medium">
                          {i.provider.providerName}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          ({i.connectionName})
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Search */}
            <div className="space-y-1.5">
              <Label className="text-xs flex items-center gap-1">
                <Search className="h-3 w-3" /> Search
              </Label>
              <Input
                placeholder="Order #, customer, phone…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {/* Upload button */}
            <Button
              onClick={handleUploadBooking}
              disabled={
                !companyIntegrationId ||
                checkedCount === 0 ||
                bookMutation.isPending
              }
              className="md:w-auto"
            >
              {bookMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Booking…
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4" /> Upload Booking ({checkedCount})
                </>
              )}
            </Button>
          </div>

          {/* Helper text */}
          {courierIntegrations.length === 0 && !integrationsQuery.isLoading && (
            <p className="text-xs text-amber-700 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" /> No courier integrations
              connected. Connect one in Settings → Integrations before booking.
            </p>
          )}
          {companyIntegrationId && (
            <p className="text-xs text-muted-foreground">
              Using{' '}
              <strong className="text-foreground">
                {selectedIntegration?.provider?.providerName}
              </strong>{' '}
              — city dropdown is filtered to this courier's operational cities.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Orders table */}
      <Card>
        <CardContent className="p-0">
          {filteredOrders.length === 0 ? (
            <div className="p-10 text-center space-y-2">
              <Inbox className="h-8 w-8 mx-auto text-muted-foreground" />
              <p className="text-sm font-medium">
                {unbookedOrders.length === 0
                  ? 'All caught up!'
                  : 'No matching orders'}
              </p>
              <p className="text-xs text-muted-foreground">
                {unbookedOrders.length === 0
                  ? 'No confirmed/processing orders are awaiting courier booking.'
                  : 'Try a different search term.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allChecked}
                        onCheckedChange={toggleSelectAll}
                        aria-label="Select all rows"
                      />
                    </TableHead>
                    <TableHead className="min-w-[140px]">Order</TableHead>
                    <TableHead className="min-w-[160px]">Customer Name</TableHead>
                    <TableHead className="min-w-[140px]">Phone</TableHead>
                    <TableHead className="min-w-[200px]">Address</TableHead>
                    <TableHead className="min-w-[180px]">City</TableHead>
                    <TableHead className="min-w-[110px]">COD (Rs.)</TableHead>
                    <TableHead className="min-w-[130px]">Type</TableHead>
                    <TableHead className="min-w-[180px]">Status / Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredOrders.map((order) => {
                    const s = getRowState(order)
                    const sourceBadge =
                      SOURCE_BADGE[order.orderSource] ??
                      'bg-gray-100 text-gray-700 border-gray-200'
                    return (
                      <TableRow
                        key={order.id}
                        className={cn(
                          s.result?.ok && 'bg-emerald-50/40',
                          s.result && !s.result.ok && 'bg-rose-50/40',
                        )}
                      >
                        {/* Select */}
                        <TableCell>
                          <Checkbox
                            checked={s.checked}
                            onCheckedChange={(v) =>
                              patchRow(order.id, {
                                checked: v === true,
                                result: null,
                              })
                            }
                            disabled={s.isBooking || s.result?.ok === true}
                            aria-label={`Select order ${order.flowopsOrderNumber}`}
                          />
                        </TableCell>

                        {/* Order # + source */}
                        <TableCell>
                          <div className="space-y-1">
                            <p className="font-mono text-xs font-medium">
                              {order.flowopsOrderNumber}
                            </p>
                            {order.externalOrderReference && (
                              <p className="text-[10px] text-muted-foreground font-mono">
                                ext: {order.externalOrderReference}
                              </p>
                            )}
                            <div className="flex items-center gap-1">
                              <Badge
                                variant="outline"
                                className={cn('text-[9px] px-1', sourceBadge)}
                              >
                                {order.orderSource}
                              </Badge>
                              <span className="text-[10px] text-muted-foreground">
                                {order.itemCount} item{order.itemCount === 1 ? '' : 's'}
                              </span>
                            </div>
                            <p className="text-[10px] text-muted-foreground">
                              {formatDate(order.createdAt)}
                            </p>
                          </div>
                        </TableCell>

                        {/* Customer name (editable) */}
                        <TableCell>
                          <Input
                            value={s.customerName}
                            onChange={(e) =>
                              patchRow(order.id, { customerName: e.target.value })
                            }
                            disabled={s.isBooking || s.result?.ok === true}
                            className="h-8 text-xs"
                            placeholder="Customer name"
                          />
                        </TableCell>

                        {/* Phone (editable) */}
                        <TableCell>
                          <Input
                            value={s.customerPhone}
                            onChange={(e) =>
                              patchRow(order.id, { customerPhone: e.target.value })
                            }
                            disabled={s.isBooking || s.result?.ok === true}
                            className="h-8 text-xs font-mono"
                            placeholder="03001234567"
                          />
                        </TableCell>

                        {/* Address (editable) */}
                        <TableCell>
                          <Input
                            value={s.deliveryAddress}
                            onChange={(e) =>
                              patchRow(order.id, {
                                deliveryAddress: e.target.value,
                              })
                            }
                            disabled={s.isBooking || s.result?.ok === true}
                            className="h-8 text-xs"
                            placeholder="House #, street, area"
                          />
                        </TableCell>

                        {/* City (autocomplete using selected courier's providerKey) */}
                        <TableCell>
                          <CityAutocomplete
                            providerKey={selectedProviderKey || 'postex'}
                            value={s.deliveryCity}
                            onChange={(city) =>
                              patchRow(order.id, { deliveryCity: city })
                            }
                            disabled={
                              s.isBooking ||
                              s.result?.ok === true ||
                              !selectedProviderKey
                            }
                            placeholder={
                              selectedProviderKey
                                ? 'Search city…'
                                : 'Select courier first'
                            }
                            className="text-xs"
                          />
                        </TableCell>

                        {/* COD amount */}
                        <TableCell>
                          <Input
                            type="number"
                            min="0"
                            value={s.codAmount}
                            onChange={(e) =>
                              patchRow(order.id, { codAmount: e.target.value })
                            }
                            disabled={s.isBooking || s.result?.ok === true}
                            className="h-8 text-xs tabular-nums"
                          />
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {formatPKR(Number(s.codAmount) || 0)}
                          </p>
                        </TableCell>

                        {/* Order type */}
                        <TableCell>
                          <Select
                            value={s.orderType}
                            onValueChange={(v) =>
                              patchRow(order.id, { orderType: v as OrderType })
                            }
                            disabled={s.isBooking || s.result?.ok === true}
                          >
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ORDER_TYPES.map((t) => (
                                <SelectItem key={t.value} value={t.value}>
                                  <span className="flex flex-col">
                                    <span>{t.label}</span>
                                    <span className="text-[10px] text-muted-foreground">
                                      {t.desc}
                                    </span>
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>

                        {/* Status / Result */}
                        <TableCell>
                          {s.isBooking ? (
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              <span>Booking…</span>
                            </div>
                          ) : s.result?.ok ? (
                            <div className="space-y-1">
                              <div className="flex items-center gap-1.5 text-xs text-emerald-700">
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                                <span className="font-medium">Booked</span>
                              </div>
                              <p className="font-mono text-[10px] truncate max-w-[160px]">
                                {s.result.trackingNumber}
                              </p>
                              <Badge
                                variant="outline"
                                className="text-[9px] bg-emerald-50 text-emerald-700 border-emerald-200"
                              >
                                {s.result.orderType}
                              </Badge>
                            </div>
                          ) : s.result && !s.result.ok ? (
                            <div className="space-y-1">
                              <div className="flex items-center gap-1.5 text-xs text-rose-700">
                                <XCircle className="h-3.5 w-3.5 shrink-0" />
                                <span className="font-medium">Failed</span>
                              </div>
                              <p
                                className="text-[10px] text-rose-700 line-clamp-3 max-w-[200px]"
                                title={s.result.error}
                              >
                                {s.result.error}
                              </p>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground italic">
                              Pending
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Footer count */}
      {filteredOrders.length > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          Showing {filteredOrders.length} of {unbookedOrders.length} unbooked{' '}
          order{unbookedOrders.length === 1 ? '' : 's'} · {checkedCount}{' '}
          selected
        </p>
      )}
    </div>
  )
}
