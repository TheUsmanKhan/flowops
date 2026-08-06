'use client'

/**
 * BookingWorkbenchView (v2) — bulk courier-booking workbench with 3 tabs.
 *
 *  1. Orders             — GET /api/booking-workbench/bookable → data.orders
 *  2. Exchange Shipments — GET /api/booking-workbench/bookable → data.shipments
 *  3. Booking Activity   — GET /api/booking-workbench/activity?date_from=&date_to=
 *
 * Key behaviours:
 *  • Per-row courier <Select> — defaults to row.recommendedCourierCompanyIntegrationId;
 *    drives that row's <CityAutocomplete providerKey>.
 *  • Bulk Apply — toolbar dropdown + "Apply to Selected" sets the courier on all
 *    CHECKED rows in the active tab only.
 *  • Weight auto-compute — each row's default orderType is computed via
 *    calculateOrderWeightKg + determinePostExOrderType. If hasMissingWeight,
 *    a ⚠️ tooltip is shown next to the Order Type dropdown. Still editable.
 *  • Upload Booking — sequentially POSTs /api/booking-workbench/book for each
 *    checked row using THAT ROW's courier integration id. Failures don't block
 *    other rows. On success the row shows ✅ tracking number + auto-unchecks.
 *  • After any successful booking, ['booking-workbench-bookable'] and
 *    ['booking-workbench-activity'] queries are invalidated.
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  RefreshCw, Loader2, CheckCircle2, XCircle, Upload, Inbox,
  AlertCircle, Search, AlertTriangle, Truck, ArrowRight,
  ChevronDown, ChevronRight, StickyNote, FileText, Hash,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { CityAutocomplete } from '@/components/couriers/city-autocomplete'
import { calculateOrderWeightKg } from '@/lib/utils/order-weight'
import {
  determinePostExOrderType, type PostExOrderType,
} from '@/lib/integrations/couriers/postex.order-type'
import { formatPKR, formatDate, formatDateTime, getErrorMessage } from './_shared'
import { CancelCourierBookingButton } from './cancel-courier-booking-button'

// ── Types: bookable rows (GET /api/booking-workbench/bookable) ────────────────

interface BookableItem {
  variantId: string
  sku: string
  productTitle: string
  quantity: number
  weightKg: number | null
  fulfillmentType: string
}

interface BookableRow {
  id: string
  type: 'order' | 'exchange_shipment'
  referenceNumber: string
  orderSource: string
  status: string
  customerName: string
  customerPhone: string
  customerId: string
  deliveryAddress: string
  deliveryCity: string
  codAmount: number
  recommendedCourierCompanyIntegrationId: string | null
  courierBookingStatus: string
  // Universal courier reference fields (migration 015) — pre-fill the
  // per-row inputs from the stored values so staff can see/edit them.
  orderRefNumber: string
  orderDetail: string
  notesForCourier: string
  createdAt: string
  exchangeMethod?: string
  originalOrderNumber?: string
  items: BookableItem[]
}

interface BookableResponse { orders: BookableRow[]; shipments: BookableRow[] }

// ── Types: integrations + booking ─────────────────────────────────────────────

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

interface BookRequest {
  orderId?: string
  shipmentId?: string
  companyIntegrationId: string
  customerName?: string
  customerPhone?: string
  deliveryAddress?: string
  deliveryCity?: string
  codAmount?: number
  orderType?: string
  // Universal courier reference fields (migration 015) — per-row overrides
  transactionNotes?: string
  itemDescription?: string
  orderRefNumber?: string
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

interface ActivityRow {
  id: string
  type: 'order' | 'exchange_shipment'
  referenceNumber: string
  courierName: string
  trackingNumber: string
  bookedAt: string
  bookedBy: string
  courierSubStatus?: string | null
}
interface ActivityResponse {
  activity: ActivityRow[]
  summary: Record<string, number>
}

// ── Row state (editable overrides + per-row booking result) ───────────────────

interface RowState {
  customerName: string
  customerPhone: string
  deliveryAddress: string
  deliveryCity: string
  codAmount: string
  orderType: PostExOrderType
  hasMissingWeight: boolean
  totalWeightKg: number
  companyIntegrationId: string
  // Universal courier reference fields (migration 015) — editable per-row
  orderRefNumber: string
  orderDetail: string
  transactionNotes: string
  // Toggle to expand/collapse the per-row courier-reference fields
  showAdvanced: boolean
  checked: boolean
  result: BookResult | null
  isBooking: boolean
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ORDER_TYPES: { value: PostExOrderType; label: string; desc: string }[] = [
  { value: 'Normal', label: 'Normal', desc: 'Standard delivery (≤1kg)' },
  { value: 'Overland', label: 'Overland', desc: 'Heavy/oversized (>1kg)' },
  { value: 'Replacement', label: 'Replacement', desc: 'Exchange replacement' },
]

const SOURCE_BADGE: Record<string, string> = {
  shopify: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  daraz: 'bg-orange-50 text-orange-700 border-orange-200',
  manual: 'bg-gray-100 text-gray-700 border-gray-200',
  instagram: 'bg-pink-50 text-pink-700 border-pink-200',
  exchange: 'bg-violet-50 text-violet-700 border-violet-200',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowKey(row: BookableRow): string {
  return `${row.type}:${row.id}`
}

function computeRowOrderType(row: BookableRow): {
  orderType: PostExOrderType
  hasMissingWeight: boolean
  totalWeightKg: number
} {
  const weightResult = calculateOrderWeightKg(
    row.items.map((i) => ({
      quantity: i.quantity,
      variant: { weightKg: i.weightKg },
    })),
  )
  const isExchangeReplacement =
    row.type === 'exchange_shipment' && row.exchangeMethod === 'courier_replacement'
  return {
    orderType: determinePostExOrderType(
      weightResult.totalWeightKg,
      weightResult.hasMissingWeight,
      isExchangeReplacement,
    ),
    hasMissingWeight: weightResult.hasMissingWeight,
    totalWeightKg: weightResult.totalWeightKg,
  }
}

function defaultRowState(row: BookableRow): RowState {
  const computed = computeRowOrderType(row)
  return {
    customerName: row.customerName ?? '',
    customerPhone: row.customerPhone ?? '',
    deliveryAddress: row.deliveryAddress ?? '',
    deliveryCity: row.deliveryCity ?? '',
    codAmount: String(row.codAmount ?? 0),
    orderType: computed.orderType,
    hasMissingWeight: computed.hasMissingWeight,
    totalWeightKg: computed.totalWeightKg,
    companyIntegrationId: row.recommendedCourierCompanyIntegrationId ?? '',
    // Seed from the stored universal courier reference fields (migration 015)
    orderRefNumber: row.orderRefNumber ?? row.referenceNumber ?? '',
    orderDetail: row.orderDetail ?? '',
    transactionNotes: row.notesForCourier ?? '',
    showAdvanced: false,
    checked: false,
    result: null,
    isBooking: false,
  }
}

// ── Main component ────────────────────────────────────────────────────────────

export function BookingWorkbenchView() {
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<'orders' | 'shipments' | 'activity'>('orders')
  const [search, setSearch] = useState('')
  const [bulkApplyIntegrationId, setBulkApplyIntegrationId] = useState('')
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({})

  // ── Data: bookable orders + shipments ──
  const bookableQuery = useQuery<BookableResponse>({
    queryKey: ['booking-workbench-bookable'],
    queryFn: () => api.get<BookableResponse>('/api/booking-workbench/bookable'),
    staleTime: 15_000,
  })

  // ── Data: courier integrations ──
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

  const integrationById = useMemo(() => {
    const m = new Map<string, CompanyIntegration>()
    for (const ci of courierIntegrations) m.set(ci.id, ci)
    return m
  }, [courierIntegrations])

  function onTabChange(v: string) {
    setActiveTab(v as 'orders' | 'shipments' | 'activity')
    setSearch('')
  }

  // ── Rows currently visible in the active bookable tab ──
  const rowsForActiveTab = useMemo<BookableRow[]>(() => {
    if (activeTab === 'orders') return bookableQuery.data?.orders ?? []
    if (activeTab === 'shipments') return bookableQuery.data?.shipments ?? []
    return []
  }, [bookableQuery.data, activeTab])

  const filteredRows = useMemo(() => {
    if (!search.trim()) return rowsForActiveTab
    const q = search.trim().toLowerCase()
    return rowsForActiveTab.filter(
      (r) =>
        r.referenceNumber.toLowerCase().includes(q) ||
        r.customerName.toLowerCase().includes(q) ||
        r.customerPhone?.toLowerCase().includes(q) ||
        r.originalOrderNumber?.toLowerCase().includes(q),
    )
  }, [rowsForActiveTab, search])

  // ── Row state helpers ──
  function getRowState(row: BookableRow): RowState {
    const key = rowKey(row)
    return rowStates[key] ?? defaultRowState(row)
  }

  function patchRow(row: BookableRow, patch: Partial<RowState>) {
    const key = rowKey(row)
    setRowStates((prev) => ({
      ...prev,
      [key]: {
        ...(prev[key] ?? defaultRowState(row)),
        ...patch,
        // Any edit clears the previous booking result so the user knows to re-submit.
        result: patch.result !== undefined ? patch.result : null,
      },
    }))
  }

  // ── Select-all ──
  const checkedCount = filteredRows.filter((r) => getRowState(r).checked).length
  const allChecked = filteredRows.length > 0 && checkedCount === filteredRows.length

  function toggleSelectAll() {
    const next = { ...rowStates }
    const target = !allChecked
    for (const r of filteredRows) {
      const key = rowKey(r)
      const cur = next[key] ?? defaultRowState(r)
      next[key] = { ...cur, checked: target }
    }
    setRowStates(next)
  }

  // ── Bulk Apply ──
  function handleBulkApply() {
    if (!bulkApplyIntegrationId) {
      toast.error('Pick a courier in the Bulk Apply dropdown first.')
      return
    }
    const checkedRows = filteredRows.filter((r) => getRowState(r).checked)
    if (checkedRows.length === 0) {
      toast.error('No rows selected. Tick at least one row first.')
      return
    }
    setRowStates((prev) => {
      const next = { ...prev }
      for (const r of checkedRows) {
        const key = rowKey(r)
        const cur = next[key] ?? defaultRowState(r)
        next[key] = { ...cur, companyIntegrationId: bulkApplyIntegrationId, result: null }
      }
      return next
    })
    const integ = integrationById.get(bulkApplyIntegrationId)
    toast.success(
      `Applied ${integ?.provider?.providerName ?? 'courier'} to ${checkedRows.length} row(s).`,
    )
  }

  // ── Booking mutation (per-row) ──
  const bookMutation = useMutation({
    mutationFn: async (body: BookRequest): Promise<BookSuccess> =>
      api.post<BookSuccess>('/api/booking-workbench/book', body),
  })

  async function handleUploadBooking() {
    const checkedRows = filteredRows.filter((r) => {
      const s = getRowState(r)
      return s.checked && !s.isBooking
    })
    if (checkedRows.length === 0) {
      toast.error('No rows selected. Tick the checkbox on at least one row.')
      return
    }
    const missingCourier = checkedRows.find((r) => !getRowState(r).companyIntegrationId)
    if (missingCourier) {
      toast.error(`Row ${missingCourier.referenceNumber} has no courier selected.`)
      return
    }

    toast.info(`Booking ${checkedRows.length} row(s)…`)

    let successCount = 0
    let failureCount = 0

    // Sequential — external courier APIs typically don't tolerate parallel hits,
    // and per-row errors must not block other rows.
    for (const row of checkedRows) {
      const state = getRowState(row)
      const body: BookRequest = {
        companyIntegrationId: state.companyIntegrationId,
        customerName: state.customerName.trim() || undefined,
        customerPhone: state.customerPhone.trim() || undefined,
        deliveryAddress: state.deliveryAddress.trim() || undefined,
        deliveryCity: state.deliveryCity.trim() || undefined,
        codAmount: Number(state.codAmount) || 0,
        orderType: state.orderType,
        // Universal courier reference fields (migration 015) — only send if
        // the user overrode the seeded value (the backend falls back to the
        // stored value when these are undefined).
        orderRefNumber: state.orderRefNumber.trim() || undefined,
        itemDescription: state.orderDetail.trim() || undefined,
        transactionNotes: state.transactionNotes.trim() || undefined,
      }
      if (row.type === 'order') body.orderId = row.id
      else body.shipmentId = row.id

      patchRow(row, { isBooking: true, result: null })

      try {
        const result = await bookMutation.mutateAsync(body)
        successCount++
        patchRow(row, {
          isBooking: false,
          checked: false,
          result: { ok: true, trackingNumber: result.trackingNumber, orderType: result.orderType },
        })
      } catch (err) {
        failureCount++
        const message =
          err instanceof FetchError ? err.message
          : err instanceof Error ? err.message
          : 'Booking failed'
        patchRow(row, { isBooking: false, result: { ok: false, error: message } })
      }
    }

    if (successCount > 0 && failureCount === 0) {
      toast.success(`All ${successCount} row(s) booked successfully.`)
    } else if (successCount > 0 && failureCount > 0) {
      toast.warning(`${successCount} booked, ${failureCount} failed. See per-row status.`)
    } else {
      toast.error(`All ${failureCount} booking(s) failed. See per-row errors.`)
    }

    if (successCount > 0) {
      queryClient.invalidateQueries({ queryKey: ['booking-workbench-bookable'] })
      queryClient.invalidateQueries({ queryKey: ['booking-workbench-activity'] })
      queryClient.invalidateQueries({ queryKey: ['orders'] })
    }
  }

  // ── Outer chrome ──
  return (
    <div className="space-y-4">
      <PageHeader
        title="Booking Workbench"
        description="Bulk-book confirmed orders and exchange shipments with a courier."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              bookableQuery.refetch()
              integrationsQuery.refetch()
            }}
            disabled={bookableQuery.isFetching && !bookableQuery.isLoading}
          >
            <RefreshCw
              className={cn('h-3.5 w-3.5', bookableQuery.isFetching && 'animate-spin')}
            />
            Refresh
          </Button>
        }
      />

      {courierIntegrations.length === 0 && activeTab !== 'activity' && (
        <Card className="border-amber-200 bg-amber-50/40">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
            <div className="text-sm text-amber-800">
              No courier integrations are connected yet. Connect one in
              <span className="font-medium"> Settings → Integrations</span> before booking shipments.
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={onTabChange}>
        <TabsList className="w-full sm:w-auto overflow-x-auto">
          <TabsTrigger value="orders" className="gap-1.5">
            <Truck className="h-3.5 w-3.5" />
            Orders
            <Badge variant="secondary" className="ml-1 text-[10px] h-4 px-1">
              {bookableQuery.data?.orders.length ?? 0}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="shipments" className="gap-1.5">
            <ArrowRight className="h-3.5 w-3.5" />
            Exchange Shipments
            <Badge variant="secondary" className="ml-1 text-[10px] h-4 px-1">
              {bookableQuery.data?.shipments.length ?? 0}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="activity" className="gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Booking Activity
          </TabsTrigger>
        </TabsList>

        <TabsContent value="orders" className="mt-4">
          <BookableTabContent
            rows={filteredRows}
            isLoading={bookableQuery.isLoading}
            isError={bookableQuery.isError}
            error={bookableQuery.error}
            onRetry={() => bookableQuery.refetch()}
            search={search}
            setSearch={setSearch}
            searchPlaceholder="Search order #, customer, phone…"
            emptyHint="orders"
            allChecked={allChecked}
            onToggleSelectAll={toggleSelectAll}
            checkedCount={checkedCount}
            courierIntegrations={courierIntegrations}
            integrationById={integrationById}
            getRowState={getRowState}
            patchRow={patchRow}
            bulkApplyIntegrationId={bulkApplyIntegrationId}
            onBulkApplyIntegrationIdChange={setBulkApplyIntegrationId}
            onBulkApply={handleBulkApply}
            onUploadBooking={handleUploadBooking}
          />
        </TabsContent>

        <TabsContent value="shipments" className="mt-4">
          <BookableTabContent
            rows={filteredRows}
            isLoading={bookableQuery.isLoading}
            isError={bookableQuery.isError}
            error={bookableQuery.error}
            onRetry={() => bookableQuery.refetch()}
            search={search}
            setSearch={setSearch}
            searchPlaceholder="Search shipment #, customer, phone…"
            emptyHint="exchange shipments"
            allChecked={allChecked}
            onToggleSelectAll={toggleSelectAll}
            checkedCount={checkedCount}
            courierIntegrations={courierIntegrations}
            integrationById={integrationById}
            getRowState={getRowState}
            patchRow={patchRow}
            bulkApplyIntegrationId={bulkApplyIntegrationId}
            onBulkApplyIntegrationIdChange={setBulkApplyIntegrationId}
            onBulkApply={handleBulkApply}
            onUploadBooking={handleUploadBooking}
          />
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <BookingActivityTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ── BookableTabContent — toolbar + table for the Orders / Exchange Shipments tabs ─

interface BookableTabContentProps {
  rows: BookableRow[]
  isLoading: boolean
  isError: boolean
  error: unknown
  onRetry: () => void
  search: string
  setSearch: (v: string) => void
  searchPlaceholder: string
  emptyHint: string
  allChecked: boolean
  onToggleSelectAll: () => void
  checkedCount: number
  courierIntegrations: CompanyIntegration[]
  integrationById: Map<string, CompanyIntegration>
  getRowState: (row: BookableRow) => RowState
  patchRow: (row: BookableRow, patch: Partial<RowState>) => void
  bulkApplyIntegrationId: string
  onBulkApplyIntegrationIdChange: (v: string) => void
  onBulkApply: () => void
  onUploadBooking: () => void
}

function BookableTabContent(props: BookableTabContentProps) {
  const {
    rows, isLoading, isError, error, onRetry,
    search, setSearch, searchPlaceholder, emptyHint,
    allChecked, onToggleSelectAll, checkedCount,
    courierIntegrations, integrationById, getRowState, patchRow,
    bulkApplyIntegrationId, onBulkApplyIntegrationIdChange, onBulkApply, onUploadBooking,
  } = props

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-10 text-center">
          <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground mt-2">
            Loading bookable {emptyHint}…
          </p>
        </CardContent>
      </Card>
    )
  }

  if (isError) {
    return (
      <Card className="border-rose-200">
        <CardContent className="p-10 text-center space-y-3">
          <AlertCircle className="h-6 w-6 mx-auto text-rose-600" />
          <p className="text-sm text-rose-700">{getErrorMessage(error)}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[200px] space-y-1">
              <Label className="text-xs text-muted-foreground">Search</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={searchPlaceholder}
                  className="pl-8 h-9"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Bulk Apply courier</Label>
              <Select
                value={bulkApplyIntegrationId}
                onValueChange={onBulkApplyIntegrationIdChange}
              >
                <SelectTrigger className="h-9 w-[220px]">
                  <SelectValue placeholder="Pick courier…" />
                </SelectTrigger>
                <SelectContent>
                  {courierIntegrations.map((ci) => (
                    <SelectItem key={ci.id} value={ci.id}>
                      {ci.connectionName} ({ci.provider.providerName})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button
              variant="secondary"
              size="sm"
              onClick={onBulkApply}
              className="h-9"
              disabled={checkedCount === 0}
            >
              Apply to Selected ({checkedCount})
            </Button>

            <Button
              size="sm"
              onClick={onUploadBooking}
              className="h-9 ml-auto"
              disabled={checkedCount === 0}
            >
              <Upload className="h-3.5 w-3.5" />
              Upload Booking ({checkedCount})
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      {rows.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center space-y-2">
            <Inbox className="h-8 w-8 mx-auto text-muted-foreground" />
            <p className="text-sm font-medium">
              {search.trim() ? 'No rows match your search.' : `No bookable ${emptyHint} — all caught up!`}
            </p>
            <p className="text-xs text-muted-foreground">
              {search.trim()
                ? 'Try a different search term.'
                : 'Confirmed orders/shipments awaiting courier booking will appear here.'}
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
                    <TableHead className="w-[40px]">
                      <Checkbox
                        checked={allChecked}
                        onCheckedChange={onToggleSelectAll}
                        aria-label="Select all rows"
                      />
                    </TableHead>
                    <TableHead className="min-w-[150px]">Reference</TableHead>
                    <TableHead className="min-w-[180px]">Customer</TableHead>
                    <TableHead className="min-w-[200px]">Delivery Address</TableHead>
                    <TableHead className="min-w-[180px]">City</TableHead>
                    <TableHead className="w-[110px]">COD</TableHead>
                    <TableHead className="min-w-[160px]">Courier</TableHead>
                    <TableHead className="min-w-[150px]">Order Type</TableHead>
                    <TableHead className="min-w-[200px]">Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <BookableTableRow
                      key={rowKey(row)}
                      row={row}
                      state={getRowState(row)}
                      patch={(p) => patchRow(row, p)}
                      courierIntegrations={courierIntegrations}
                      integrationById={integrationById}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ── BookableTableRow — single editable row in the Orders / Shipments tabs ──────

interface BookableTableRowProps {
  row: BookableRow
  state: RowState
  patch: (p: Partial<RowState>) => void
  courierIntegrations: CompanyIntegration[]
  integrationById: Map<string, CompanyIntegration>
}

function BookableTableRow({
  row, state, patch, courierIntegrations, integrationById,
}: BookableTableRowProps) {
  const booked = state.result?.ok === true
  const failed = state.result?.ok === false
  const disabled = state.isBooking || booked
  const isExchangeReplacement =
    row.type === 'exchange_shipment' && row.exchangeMethod === 'courier_replacement'
  const integration = integrationById.get(state.companyIntegrationId)
  const providerKey = integration?.provider?.providerKey ?? 'postex'

  // Total columns in the main row (must match <TableHeader>)
  // checkbox + reference + customer + address + city + COD + courier + type + result = 9
  const COL_SPAN = 9

  return (
    <>
      <TableRow className={cn(booked && 'bg-emerald-50/40', failed && 'bg-rose-50/40')}>
        {/* Checkbox + expand toggle */}
        <TableCell>
          <div className="flex items-center gap-1">
            <Checkbox
              checked={state.checked}
              onCheckedChange={(v) => patch({ checked: v === true })}
              disabled={disabled}
              aria-label={`Select ${row.referenceNumber}`}
            />
            <button
              type="button"
              onClick={() => patch({ showAdvanced: !state.showAdvanced })}
              className="text-muted-foreground hover:text-foreground transition-colors p-0.5"
              aria-label={state.showAdvanced ? 'Hide courier reference fields' : 'Show courier reference fields'}
              title={state.showAdvanced ? 'Hide courier reference fields' : 'Show courier reference fields (reference, detail, notes)'}
            >
              {state.showAdvanced
                ? <ChevronDown className="h-3.5 w-3.5" />
                : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          </div>
        </TableCell>

      {/* Reference + source + date + weight */}
      <TableCell>
        <div className="font-mono text-xs font-semibold">{row.referenceNumber}</div>
        {row.originalOrderNumber && (
          <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
            <ArrowRight className="h-2.5 w-2.5" />
            from {row.originalOrderNumber}
          </div>
        )}
        <Badge
          variant="outline"
          className={cn('mt-1 text-[10px]', SOURCE_BADGE[row.orderSource] ?? SOURCE_BADGE.manual)}
        >
          {row.orderSource}
        </Badge>
        <div className="text-[10px] text-muted-foreground mt-1">{formatDate(row.createdAt)}</div>
        <div className="text-[10px] text-muted-foreground mt-0.5">
          {state.totalWeightKg.toFixed(2)} kg
        </div>
      </TableCell>

      {/* Customer name + phone */}
      <TableCell className="space-y-1">
        <Input
          value={state.customerName}
          onChange={(e) => patch({ customerName: e.target.value })}
          disabled={disabled}
          className="h-8 text-xs"
          placeholder="Customer name"
        />
        <Input
          value={state.customerPhone}
          onChange={(e) => patch({ customerPhone: e.target.value })}
          disabled={disabled}
          className="h-8 text-xs"
          placeholder="Phone"
        />
      </TableCell>

      {/* Delivery address */}
      <TableCell>
        <Input
          value={state.deliveryAddress}
          onChange={(e) => patch({ deliveryAddress: e.target.value })}
          disabled={disabled}
          className="h-8 text-xs"
          placeholder="Full delivery address"
        />
      </TableCell>

      {/* City — per-row courier providerKey */}
      <TableCell>
        <CityAutocomplete
          providerKey={providerKey}
          value={state.deliveryCity}
          onChange={(city) => patch({ deliveryCity: city })}
          disabled={disabled}
          placeholder="Search city…"
        />
      </TableCell>

      {/* COD */}
      <TableCell>
        <Input
          type="number"
          value={state.codAmount}
          onChange={(e) => patch({ codAmount: e.target.value })}
          disabled={disabled}
          className="h-8 text-xs w-[100px]"
        />
        <div className="text-[10px] text-muted-foreground mt-0.5">
          {formatPKR(Number(state.codAmount) || 0)}
        </div>
      </TableCell>

      {/* Per-row courier */}
      <TableCell>
        <Select
          value={state.companyIntegrationId}
          onValueChange={(v) => patch({ companyIntegrationId: v })}
          disabled={disabled || courierIntegrations.length === 0}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Pick courier…" />
          </SelectTrigger>
          <SelectContent>
            {courierIntegrations.map((ci) => (
              <SelectItem key={ci.id} value={ci.id} className="text-xs">
                {ci.connectionName} ({ci.provider.providerName})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>

      {/* Order type with missing-weight tooltip */}
      <TableCell>
        <div className="flex items-center gap-1">
          <Select
            value={state.orderType}
            onValueChange={(v) => patch({ orderType: v as PostExOrderType })}
            disabled={disabled || isExchangeReplacement}
          >
            <SelectTrigger className="h-8 text-xs w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ORDER_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value} className="text-xs">
                  <div className="flex flex-col">
                    <span>{t.label}</span>
                    <span className="text-[10px] text-muted-foreground">{t.desc}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {state.hasMissingWeight && (
            <Tooltip>
              <TooltipTrigger asChild>
                <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                Some items missing weight data — defaulted to Overland
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {isExchangeReplacement && (
          <div className="text-[10px] text-violet-700 mt-0.5">Replacement (locked)</div>
        )}
      </TableCell>

      {/* Result */}
      <TableCell>
        {state.isBooking ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Booking…
          </div>
        ) : state.result?.ok ? (
          <div className="flex items-start gap-1.5 text-xs text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="font-mono break-all">{state.result.trackingNumber}</div>
              <Badge variant="outline" className="mt-0.5 text-[9px] bg-emerald-50 border-emerald-200">
                {state.result.orderType}
              </Badge>
            </div>
          </div>
        ) : state.result && !state.result.ok ? (
          <div
            className="flex items-start gap-1.5 text-xs text-rose-700 max-w-[220px]"
            title={state.result.error}
          >
            <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span className="line-clamp-3">{state.result.error}</span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      </TableRow>

      {/* ── Collapsible second row: courier reference fields (migration 015) ──
          These are universal OMS fields that get mapped to whatever courier
          field the active adapter uses (PostEx → orderRefNumber, future TCS
          → consigneeRef, etc.). Pre-filled from the stored Order/ExchangeShipment
          values; editing here overrides per-booking only (does NOT write back
          to the Order). */}
      {state.showAdvanced && (
        <TableRow className={cn('bg-muted/20', booked && 'bg-emerald-50/20')}>
          <TableCell colSpan={COL_SPAN} className="py-3">
            <div className="grid sm:grid-cols-3 gap-3">
              {/* Order Reference — universal courier reference field */}
              <div className="space-y-1">
                <Label className="text-[10px] flex items-center gap-1 text-muted-foreground">
                  <Hash className="h-3 w-3" /> Order Reference
                  <span className="text-amber-700">(for courier)</span>
                </Label>
                <Input
                  value={state.orderRefNumber}
                  onChange={(e) => patch({ orderRefNumber: e.target.value })}
                  disabled={disabled}
                  className="h-8 text-xs"
                  placeholder={row.referenceNumber}
                />
                <p className="text-[10px] text-muted-foreground">
                  Maps to the courier's reference field. Defaults to {row.referenceNumber}.
                </p>
              </div>

              {/* Order Detail — item description string */}
              <div className="space-y-1">
                <Label className="text-[10px] flex items-center gap-1 text-muted-foreground">
                  <FileText className="h-3 w-3" /> Order Detail
                  <span className="text-amber-700">(item summary)</span>
                </Label>
                <Input
                  value={state.orderDetail}
                  onChange={(e) => patch({ orderDetail: e.target.value })}
                  disabled={disabled}
                  className="h-8 text-xs"
                  placeholder="Auto-generated from items"
                />
                <p className="text-[10px] text-muted-foreground">
                  Item summary passed to the courier (e.g. "Silk Kurta (SKU-001) ×2").
                </p>
              </div>

              {/* Transaction Notes — courier instructions */}
              <div className="space-y-1">
                <Label className="text-[10px] flex items-center gap-1 text-muted-foreground">
                  <StickyNote className="h-3 w-3" /> Transaction Notes
                  <span className="text-amber-700">(courier instructions)</span>
                </Label>
                <Input
                  value={state.transactionNotes}
                  onChange={(e) => patch({ transactionNotes: e.target.value })}
                  disabled={disabled}
                  className="h-8 text-xs"
                  placeholder="Optional notes for the courier"
                />
                <p className="text-[10px] text-muted-foreground">
                  Free-text instructions appended to the courier booking.
                </p>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

// ── BookingActivityTab — read-only report of completed bookings ───────────────

function BookingActivityTab() {
  const today = new Date().toISOString().slice(0, 10)
  const [dateFrom, setDateFrom] = useState(today)
  const [dateTo, setDateTo] = useState(today)

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<ActivityResponse>({
    queryKey: ['booking-workbench-activity', dateFrom, dateTo],
    queryFn: () => {
      const params = new URLSearchParams()
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)
      const qs = params.toString()
      return api.get<ActivityResponse>(
        qs ? `/api/booking-workbench/activity?${qs}` : '/api/booking-workbench/activity',
      )
    },
    staleTime: 30_000,
  })

  const summaryEntries = useMemo(
    () => Object.entries(data?.summary ?? {}).sort((a, b) => b[1] - a[1]),
    [data?.summary],
  )
  const activity = data?.activity ?? []

  return (
    <div className="space-y-4">
      {/* Date range filter */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">From</Label>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="h-9 w-[160px]"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">To</Label>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="h-9 w-[160px]"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="h-9"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
              Refresh
            </Button>
            <div className="ml-auto text-xs text-muted-foreground">
              {activity.length} booking{activity.length === 1 ? '' : 's'} in range
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Loading / error / empty states */}
      {isLoading ? (
        <Card>
          <CardContent className="p-10 text-center">
            <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
            <p className="text-sm text-muted-foreground mt-2">Loading booking activity…</p>
          </CardContent>
        </Card>
      ) : isError ? (
        <Card className="border-rose-200">
          <CardContent className="p-10 text-center space-y-3">
            <AlertCircle className="h-6 w-6 mx-auto text-rose-600" />
            <p className="text-sm text-rose-700">{getErrorMessage(error)}</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          </CardContent>
        </Card>
      ) : activity.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center space-y-2">
            <Inbox className="h-8 w-8 mx-auto text-muted-foreground" />
            <p className="text-sm font-medium">No bookings in this date range.</p>
            <p className="text-xs text-muted-foreground">
              Try widening the date range, or check back after bookings are made.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary cards */}
          {summaryEntries.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {summaryEntries.map(([name, count]) => (
                <Card key={name} className="px-4 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {name}
                  </div>
                  <div className="text-xl font-semibold leading-tight">{count}</div>
                </Card>
              ))}
              <Card className="px-4 py-2 bg-muted/40">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Total</div>
                <div className="text-xl font-semibold leading-tight">{activity.length}</div>
              </Card>
            </div>
          )}

          {/* Activity table */}
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[140px]">Reference #</TableHead>
                      <TableHead className="w-[80px]">Type</TableHead>
                      <TableHead className="min-w-[120px]">Courier</TableHead>
                      <TableHead className="min-w-[160px]">Tracking #</TableHead>
                      <TableHead className="min-w-[140px]">Booked At</TableHead>
                      <TableHead className="min-w-[120px]">Booked By</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {activity.map((a) => (
                      <TableRow key={`${a.type}:${a.id}`}>
                        <TableCell className="font-mono text-xs font-medium">
                          {a.referenceNumber}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-[10px]',
                              a.type === 'order'
                                ? 'bg-sky-50 text-sky-700 border-sky-200'
                                : 'bg-violet-50 text-violet-700 border-violet-200',
                            )}
                          >
                            {a.type === 'order' ? 'ORD' : 'EXCH'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">{a.courierName}</TableCell>
                        <TableCell className="font-mono text-xs break-all">
                          {a.trackingNumber || '—'}
                        </TableCell>
                        <TableCell className="text-xs">
                          {a.bookedAt ? formatDateTime(a.bookedAt) : '—'}
                        </TableCell>
                        <TableCell className="text-xs">{a.bookedBy}</TableCell>
                        <TableCell className="text-right">
                          <CancelCourierBookingButton
                            entityType={a.type}
                            entityId={a.id}
                            courierSubStatus={a.courierSubStatus}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
