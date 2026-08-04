'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, FetchError } from '@/lib/api-client'
import { useAppStore, useCan } from '@/stores/app-store'
import { PERMISSIONS } from '@/lib/permissions'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  ArrowLeft,
  RefreshCw,
  AlertCircle,
  Loader2,
  User,
  Flag,
  Truck,
  MapPin,
  Package,
  CheckCircle2,
  Clock,
  XCircle,
  Banknote,
  CreditCard,
  ArrowRight,
  History,
  RotateCcw,
  PackageCheck,
  Boxes,
  ExternalLink,
  AlertTriangle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { RequestExchangeDialog } from './request-exchange-dialog'
import { CityMismatchResolver } from '@/components/couriers/city-mismatch-resolver'

// ─────────────────────────────────────────────────────────────────────────────
// Types — match GET /api/orders/[id] response shape
// ─────────────────────────────────────────────────────────────────────────────

interface OrderItem {
  id: string
  orgVariantId: string
  quantity: number
  unitPrice: number
  lineTotal: number
  fulfillmentStatus: string
  fulfillmentTypeSnapshot: string
  returnedStitchedUsed: boolean
  needsReview: boolean
  backorderedAt: string | null
  fulfilledAt: string | null
  productionOrderId: string | null
  productionOrder: { id: string; status: string; assignedTailor: string | null } | null
  variant: {
    sku: string
    productTitle: string
    attributeValues: Record<string, string>
    fulfillmentType: string
  }
}

interface OrderDetail {
  order: {
    id: string
    flowopsOrderNumber: string
    externalOrderReference: string | null
    externalOrderId: string | null
    orderSource: string
    status: string
    paymentType: string
    paymentStatus: string
    paymentSource: string

    subtotal: number
    discountAmount: number | null
    discountReason: string | null
    courierCharges: number | null
    totalOrderValue: number

    advanceAmount: number | null
    advancePaymentMethod: string | null
    advancePaymentReference: string | null
    advancePaymentScreenshotUrl: string | null
    advancePaidAt: string | null

    remainingCodAmount: number | null
    codCollected: boolean
    codCollectedAmount: number | null
    codCollectedAt: string | null

    deliveryAddress: string | null
    deliveryCity: string | null
    courierName: string | null
    trackingNumber: string | null
    courierCityStatus?: string
    courierSubStatus?: string | null
    needsShipperAdvice?: boolean
    notesForCourier: string | null
    dispatchLocationId: string | null
    dispatchLocation: { id: string; name: string; city: string } | null

    skippedConfirmation: boolean
    skippedPacking: boolean

    confirmedAt: string | null
    packedAt: string | null
    dispatchedAt: string | null
    deliveredAt: string | null
    cancelledAt: string | null
    cancellationReason: string | null
    returnedAt: string | null
    convertedAt: string | null

    createdAt: string
  }
  customer: {
    id: string
    name: string
    phone: string
    alternatePhone: string | null
    email: string | null
    isFlagged: boolean
    flaggedReason: string | null
    totalOrdersCount: number
    totalRtoCount: number
  }
  items: OrderItem[]
}

interface AuditLogResponse {
  rows: Array<{
    id: string
    action: string
    entityType: string
    entityId: string
    createdAt: string
    user: { id: string; fullName: string; email: string } | null
    newValues: Record<string, unknown> | null
  }>
  total: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Display maps
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

const FULFILLMENT_STATUS_BADGE: Record<string, { label: string; className: string }> = {
  reserved: { label: 'Reserved', className: 'bg-sky-50 text-sky-700 border-sky-200' },
  backordered: { label: 'Backordered', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  dispatched: { label: 'Dispatched', className: 'bg-violet-50 text-violet-700 border-violet-200' },
}

const PAYMENT_METHODS = [
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'easy_paisa', label: 'EasyPaisa' },
  { value: 'jazz_cash', label: 'JazzCash' },
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'other', label: 'Other' },
]

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const PKR = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 })

function formatPKR(n: number): string {
  return `Rs. ${PKR.format(n)}`
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
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

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-PK', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function getErrorMessage(err: unknown): string {
  if (err instanceof FetchError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong.'
}

function formatAttributeValues(values: Record<string, string>): string {
  if (!values || Object.keys(values).length === 0) return ''
  return Object.entries(values)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ')
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function OrderDetailView({ orderId }: { orderId: string }) {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const queryClient = useQueryClient()

  const canManage = can(PERMISSIONS.ORDERS_MANAGE)
  const canFulfill = can(PERMISSIONS.ORDERS_FULFILL)
  const canCancel = can(PERMISSIONS.ORDERS_CANCEL)

  // ── Data queries ──────────────────────────────────────────────────────────
  const orderQuery = useQuery<OrderDetail>({
    queryKey: ['order', orderId],
    queryFn: () => api.get<OrderDetail>(`/api/orders/${orderId}`),
    staleTime: 10_000,
  })

  const auditQuery = useQuery<AuditLogResponse>({
    queryKey: ['order', orderId, 'activity'],
    queryFn: () =>
      api.get<AuditLogResponse>(
        `/api/audit-logs?entityType=order&entity_id=${encodeURIComponent(orderId)}&pageSize=50`,
      ),
    staleTime: 10_000,
  })

  // ── Dialog state ──────────────────────────────────────────────────────────
  const [dispatchDialogOpen, setDispatchDialogOpen] = useState(false)
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false)
  const [rtoDialogOpen, setRtoDialogOpen] = useState(false)
  const [convertDialogOpen, setConvertDialogOpen] = useState(false)
  const [codDialogOpen, setCodDialogOpen] = useState(false)
  const [proofDialogOpen, setProofDialogOpen] = useState(false)
  const [exchangeTarget, setExchangeTarget] = useState<{
    id: string
    variant: { sku: string; productTitle: string }
    unitPrice: number
  } | null>(null)

  // ── Invalidate helper ─────────────────────────────────────────────────────
  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['order', orderId] })
    void queryClient.invalidateQueries({ queryKey: ['order', orderId, 'activity'] })
    void queryClient.invalidateQueries({ queryKey: ['orders'] })
  }

  // ── Mutations ─────────────────────────────────────────────────────────────
  const confirmMutation = useMutation({
    mutationFn: () => api.post(`/api/orders/${orderId}/confirm`),
    onSuccess: () => {
      toast.success('Confirm order succeeded.')
      invalidateAll()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })
  const processingMutation = useMutation({
    mutationFn: () => api.post(`/api/orders/${orderId}/processing`),
    onSuccess: () => {
      toast.success('Mark as processing succeeded.')
      invalidateAll()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })
  const packedMutation = useMutation({
    mutationFn: () => api.post(`/api/orders/${orderId}/packed`),
    onSuccess: () => {
      toast.success('Mark as packed succeeded.')
      invalidateAll()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })
  const deliveredMutation = useMutation({
    mutationFn: () => api.post(`/api/orders/${orderId}/delivered`),
    onSuccess: () => {
      toast.success('Mark as delivered succeeded.')
      invalidateAll()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const dispatchMutation = useMutation({
    mutationFn: (vars: { tracking_number: string; courier_name?: string }) =>
      api.post(`/api/orders/${orderId}/dispatch`, vars),
    onSuccess: () => {
      toast.success('Order dispatched.')
      setDispatchDialogOpen(false)
      invalidateAll()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const cancelMutation = useMutation({
    mutationFn: (vars: { cancellation_reason: string }) =>
      api.post(`/api/orders/${orderId}/cancel`, vars),
    onSuccess: () => {
      toast.success('Order cancelled.')
      setCancelDialogOpen(false)
      invalidateAll()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const rtoMutation = useMutation({
    mutationFn: (vars: { return_reason: string }) =>
      api.post(`/api/orders/${orderId}/rto`, vars),
    onSuccess: () => {
      toast.success('Order marked as RTO.')
      setRtoDialogOpen(false)
      invalidateAll()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const convertMutation = useMutation({
    mutationFn: (vars: {
      new_payment_type: 'partial_advance' | 'fully_prepaid'
      advance_amount?: number
      advance_payment_method?: string
      advance_payment_reference?: string
      advance_payment_screenshot_url?: string
    }) => api.post(`/api/orders/${orderId}/convert-payment`, vars),
    onSuccess: () => {
      toast.success('Payment converted.')
      setConvertDialogOpen(false)
      invalidateAll()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const codMutation = useMutation({
    mutationFn: (vars: { collected_amount: number }) =>
      api.post(`/api/orders/${orderId}/cod-collected`, vars),
    onSuccess: () => {
      toast.success('COD marked as collected.')
      setCodDialogOpen(false)
      invalidateAll()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  // ── Loading state ─────────────────────────────────────────────────────────
  if (orderQuery.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Order detail"
          actions={
            <Button variant="outline" size="sm" onClick={() => navigate({ name: 'orders' })}>
              <ArrowLeft className="h-4 w-4" /> Back to Orders
            </Button>
          }
        />
        <Card>
          <CardContent className="p-6 space-y-3">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (orderQuery.isError || !orderQuery.data) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Order detail"
          actions={
            <Button variant="outline" size="sm" onClick={() => navigate({ name: 'orders' })}>
              <ArrowLeft className="h-4 w-4" /> Back to Orders
            </Button>
          }
        />
        <Card>
          <CardContent className="p-10 text-center">
            <AlertCircle className="h-10 w-10 mx-auto text-rose-500 mb-3" />
            <p className="text-sm text-muted-foreground mb-4">
              {getErrorMessage(orderQuery.error)}
            </p>
            <Button variant="outline" onClick={() => orderQuery.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const { order, customer, items } = orderQuery.data

  // ── Status + action availability ──────────────────────────────────────────
  const status = order.status
  const canConfirm = status === 'pending' && canManage
  const canProcess =
    (status === 'confirmed' || status === 'partially_backordered') && canFulfill
  const canPack =
    (status === 'confirmed' ||
      status === 'partially_backordered' ||
      status === 'processing') &&
    canFulfill &&
    !order.packedAt
  const canDispatch =
    (status === 'confirmed' ||
      status === 'partially_backordered' ||
      status === 'processing') &&
    canFulfill
  const canMarkDelivered = status === 'dispatched' && canFulfill
  const canMarkRto = status === 'dispatched' && canManage
  const canCancelOrder =
    !['dispatched', 'delivered', 'rto', 'cancelled', 'refunded'].includes(status) &&
    canCancel

  const canConvertPayment = order.paymentStatus === 'cod_pending' && canManage
  const canMarkCodCollected =
    (status === 'dispatched' || status === 'delivered') &&
    !order.codCollected &&
    order.paymentType !== 'fully_prepaid' &&
    canManage

  const statusBadge = ORDER_STATUS_BADGE[status] ?? {
    label: status,
    className: 'bg-gray-100 text-gray-700 border-gray-200',
  }
  const paymentBadge = PAYMENT_STATUS_BADGE[order.paymentStatus] ?? {
    label: order.paymentStatus,
    className: 'bg-gray-100 text-gray-700 border-gray-200',
  }
  const sourceBadge = SOURCE_BADGE[order.orderSource] ?? {
    label: order.orderSource,
    className: 'bg-gray-100 text-gray-700 border-gray-200',
  }

  const remainingCod = order.remainingCodAmount ?? Math.max(
    0,
    order.totalOrderValue - (order.advanceAmount ?? 0),
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title={order.flowopsOrderNumber}
        description={
          order.externalOrderReference
            ? `External ref: ${order.externalOrderReference}`
            : 'Order detail'
        }
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => orderQuery.refetch()}
              disabled={orderQuery.isFetching}
            >
              <RefreshCw className={orderQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate({ name: 'orders' })}>
              <ArrowLeft className="h-4 w-4" /> Back to Orders
            </Button>
          </div>
        }
      />

      {/* ── External reference + source badge band ─────────────────────── */}
      {(order.externalOrderReference || order.orderSource !== 'manual') && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-4 py-2.5">
          {order.externalOrderReference && (
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground shrink-0">
                External Ref
              </span>
              <span className="text-sm font-semibold font-mono truncate">
                {order.externalOrderReference}
              </span>
            </div>
          )}
          {order.orderSource !== 'manual' && (
            <Badge variant="outline" className={sourceBadge.className}>
              {sourceBadge.label}
            </Badge>
          )}
        </div>
      )}

      {/* ── Status badge row ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={statusBadge.className}>
          {statusBadge.label}
        </Badge>
        <Badge variant="outline" className={paymentBadge.className}>
          {paymentBadge.label}
        </Badge>
        {order.paymentType === 'partial_advance' && (
          <Badge variant="outline" className="bg-sky-50 text-sky-700 border-sky-200">
            Partial Advance
          </Badge>
        )}
        {order.paymentType === 'fully_prepaid' && (
          <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
            Prepaid
          </Badge>
        )}
        {order.skippedConfirmation && (
          <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
            Skipped Confirmation
          </Badge>
        )}
      </div>

      {/* ── Action buttons (context-sensitive) ─────────────────────────────── */}
      <Card>
        <CardContent className="p-4 flex flex-wrap gap-2">
          {canConfirm && (
            <Button
              size="sm"
              onClick={() => confirmMutation.mutate()}
              disabled={confirmMutation.isPending}
            >
              {confirmMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Confirm Order
            </Button>
          )}
          {canProcess && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => processingMutation.mutate()}
              disabled={processingMutation.isPending}
            >
              {processingMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Package className="h-4 w-4" />
              )}
              Mark as Processing
            </Button>
          )}
          {canPack && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => packedMutation.mutate()}
              disabled={packedMutation.isPending}
            >
              {packedMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <PackageCheck className="h-4 w-4" />
              )}
              Mark as Packed
            </Button>
          )}
          {canDispatch && (
            <Button size="sm" onClick={() => setDispatchDialogOpen(true)}>
              <Truck className="h-4 w-4" />
              Dispatch Order
            </Button>
          )}
          {canMarkDelivered && (
            <Button
              size="sm"
              onClick={() => deliveredMutation.mutate()}
              disabled={deliveredMutation.isPending}
            >
              {deliveredMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Mark as Delivered
            </Button>
          )}
          {canMarkRto && (
            <Button size="sm" variant="outline" onClick={() => setRtoDialogOpen(true)}>
              <RotateCcw className="h-4 w-4" />
              Mark as Returned/RTO
            </Button>
          )}
          {canConvertPayment && (
            <Button size="sm" variant="outline" onClick={() => setConvertDialogOpen(true)}>
              <CreditCard className="h-4 w-4" />
              Convert Payment
            </Button>
          )}
          {canMarkCodCollected && (
            <Button size="sm" variant="outline" onClick={() => setCodDialogOpen(true)}>
              <Banknote className="h-4 w-4" />
              Mark COD Collected
            </Button>
          )}
          {canCancelOrder && (
            <Button
              size="sm"
              variant="outline"
              className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
              onClick={() => setCancelDialogOpen(true)}
            >
              <XCircle className="h-4 w-4" />
              Cancel Order
            </Button>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ── Main column: items + payment + delivery ────────────────────── */}
        <div className="lg:col-span-2 space-y-6">
          {/* ── Items table ───────────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Items ({items.length})</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Variant</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Unit price</TableHead>
                      <TableHead className="text-right">Line total</TableHead>
                      <TableHead>Fulfillment</TableHead>
                      {order.status === 'delivered' && <TableHead className="text-right">Actions</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => {
                      const fBadge = FULFILLMENT_STATUS_BADGE[item.fulfillmentStatus] ?? {
                        label: item.fulfillmentStatus,
                        className: 'bg-gray-100 text-gray-700 border-gray-200',
                      }
                      return (
                        <TableRow key={item.id}>
                          <TableCell>
                            <div className="flex flex-col">
                              <span className="font-medium text-sm">
                                {item.variant.productTitle}
                              </span>
                              <span className="text-xs text-muted-foreground font-mono">
                                {item.variant.sku}
                              </span>
                              {Object.keys(item.variant.attributeValues).length > 0 && (
                                <span className="text-xs text-muted-foreground">
                                  {formatAttributeValues(item.variant.attributeValues)}
                                </span>
                              )}
                              <div className="flex flex-wrap gap-1 mt-1">
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    'text-[10px]',
                                    item.fulfillmentTypeSnapshot === 'made_to_order'
                                      ? 'bg-purple-50 text-purple-700 border-purple-200'
                                      : 'bg-sky-50 text-sky-700 border-sky-200',
                                  )}
                                >
                                  {item.fulfillmentTypeSnapshot === 'made_to_order'
                                    ? 'MTO'
                                    : 'Stock'}
                                </Badge>
                                {item.returnedStitchedUsed && (
                                  <Badge
                                    variant="outline"
                                    className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200"
                                  >
                                    Returned-stitched used
                                  </Badge>
                                )}
                                {item.productionOrder && (
                                  <a
                                    href="#"
                                    onClick={(e) => {
                                      e.preventDefault()
                                      navigate({
                                        name: 'inventory-production-orders',
                                      })
                                    }}
                                    className="inline-flex"
                                  >
                                    <Badge
                                      variant="outline"
                                      className="text-[10px] bg-purple-50 text-purple-700 border-purple-200 cursor-pointer hover:bg-purple-100"
                                    >
                                      Production: {item.productionOrder.status}
                                      <ExternalLink className="h-2.5 w-2.5 ml-1" />
                                    </Badge>
                                  </a>
                                )}
                                {item.needsReview && (
                                  <Badge
                                    variant="outline"
                                    className="text-[10px] bg-amber-50 text-amber-700 border-amber-200"
                                  >
                                    Needs Review
                                  </Badge>
                                )}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {item.quantity}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {formatPKR(item.unitPrice)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums font-medium">
                            {formatPKR(item.lineTotal)}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={fBadge.className}>
                              {fBadge.label}
                            </Badge>
                            {item.backorderedAt && (
                              <p className="text-[10px] text-muted-foreground mt-1">
                                Since {formatDate(item.backorderedAt)}
                              </p>
                            )}
                          </TableCell>
                          {order.status === 'delivered' && (
                            <TableCell className="text-right">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                                onClick={() => setExchangeTarget(item)}
                              >
                                <RefreshCw className="h-3 w-3" /> Request Exchange
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* ── Payment breakdown ─────────────────────────────────────────── */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Payment Breakdown</CardTitle>
              <Badge variant="outline" className={paymentBadge.className}>
                {paymentBadge.label}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* ── Order value summary ─────────────────────────────────────── */}
              <div className="space-y-2 text-sm">
                <PaymentRow label="Subtotal" value={formatPKR(order.subtotal)} />
                {order.discountAmount !== null && order.discountAmount > 0 && (
                  <>
                    <PaymentRow
                      label="Discount"
                      value={`−${formatPKR(order.discountAmount)}`}
                      valueClassName="text-rose-600"
                    />
                    {order.discountReason && (
                      <PaymentRow label="Reason" value={order.discountReason} muted />
                    )}
                  </>
                )}
                {order.courierCharges !== null && order.courierCharges > 0 && (
                  <PaymentRow label="Courier charges" value={formatPKR(order.courierCharges)} />
                )}
                <Separator />
                <div className="flex items-center justify-between pt-1">
                  <span className="text-sm font-medium">Total Order Value</span>
                  <span className="text-lg font-bold tabular-nums">
                    {formatPKR(order.totalOrderValue)}
                  </span>
                </div>
              </div>

              {/* ── Fully prepaid: just confirm full payment ───────────────── */}
              {order.paymentType === 'fully_prepaid' ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 flex items-start gap-2.5 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-emerald-700">Fully Paid</p>
                    <p className="text-xs text-emerald-600">
                      The entire order value was received before dispatch. No COD collection
                      required.
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  {/* ── Advance Received block (if any) ────────────────────── */}
                  {(order.advanceAmount ?? 0) > 0 && (
                    <div className="rounded-lg border bg-sky-50/50 p-3 space-y-2 text-sm">
                      <p className="text-xs font-semibold uppercase tracking-wide text-sky-700 flex items-center gap-1.5">
                        <CreditCard className="h-3.5 w-3.5" /> Advance Received
                      </p>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Amount</span>
                        <span className="font-semibold tabular-nums">
                          {formatPKR(order.advanceAmount ?? 0)}
                        </span>
                      </div>
                      {order.advancePaymentMethod && (
                        <PaymentRow
                          label="Method"
                          value={
                            PAYMENT_METHODS.find(
                              (m) => m.value === order.advancePaymentMethod,
                            )?.label ?? order.advancePaymentMethod
                          }
                          muted
                        />
                      )}
                      {order.advancePaymentReference && (
                        <PaymentRow
                          label="Reference"
                          value={order.advancePaymentReference}
                          muted
                        />
                      )}
                      {order.advancePaidAt && (
                        <PaymentRow
                          label="Paid at"
                          value={formatDateTime(order.advancePaidAt)}
                          muted
                        />
                      )}
                      {order.paymentSource && order.paymentSource !== 'manual' && (
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">Source</span>
                          <Badge
                            variant="outline"
                            className="text-[10px] bg-gray-100 text-gray-700 border-gray-200"
                          >
                            {order.paymentSource}
                          </Badge>
                        </div>
                      )}
                      {order.advancePaymentScreenshotUrl && (
                        <div className="pt-1">
                          <p className="text-xs text-muted-foreground mb-1">Payment Proof</p>
                          <button
                            type="button"
                            onClick={() => setProofDialogOpen(true)}
                            className="block rounded-md border overflow-hidden hover:ring-2 hover:ring-primary/40 transition-shadow"
                            aria-label="View payment proof full size"
                          >
                            <img
                              src={order.advancePaymentScreenshotUrl}
                              alt="Payment proof"
                              className="h-24 w-24 object-cover"
                            />
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── Remaining COD to Collect block ─────────────────────── */}
                  <div
                    className={cn(
                      'rounded-lg border p-3 space-y-2 text-sm',
                      order.codCollected
                        ? 'border-emerald-200 bg-emerald-50'
                        : 'border-amber-200 bg-amber-50/60',
                    )}
                  >
                    <p
                      className={cn(
                        'text-xs font-semibold uppercase tracking-wide flex items-center gap-1.5',
                        order.codCollected ? 'text-emerald-700' : 'text-amber-700',
                      )}
                    >
                      <Banknote className="h-3.5 w-3.5" />
                      Remaining (COD to Collect)
                    </p>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">To Collect</span>
                      <span className="font-semibold tabular-nums">
                        {formatPKR(remainingCod)}
                      </span>
                    </div>

                    {order.codCollected ? (
                      <div className="flex items-center gap-2 rounded-md bg-emerald-100/60 px-2.5 py-1.5 text-xs text-emerald-700">
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                        <span>
                          Collected:{' '}
                          <strong>
                            {order.codCollectedAmount
                              ? formatPKR(order.codCollectedAmount)
                              : '—'}
                          </strong>
                          {order.codCollectedAt && (
                            <> on {formatDateTime(order.codCollectedAt)}</>
                          )}
                        </span>
                      </div>
                    ) : (order.status === 'dispatched' || order.status === 'delivered') ? (
                      <div className="flex items-center justify-between gap-2 pt-1">
                        <span className="inline-flex items-center gap-1.5 text-xs text-amber-700">
                          <Clock className="h-3.5 w-3.5" />
                          Pending Collection
                        </span>
                        {canManage && (
                          <Button size="sm" variant="outline" onClick={() => setCodDialogOpen(true)}>
                            <Banknote className="h-3.5 w-3.5" />
                            Mark COD Collected
                          </Button>
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground pt-1">
                        COD will be collected on delivery.
                      </p>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* ── Payment proof enlarge dialog ────────────────────────────────── */}
          <Dialog open={proofDialogOpen} onOpenChange={setProofDialogOpen}>
            <DialogContent className="sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>Payment Proof</DialogTitle>
                <DialogDescription>
                  Advance payment screenshot for {order.flowopsOrderNumber}.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center justify-center">
                <img
                  src={order.advancePaymentScreenshotUrl ?? ''}
                  alt="Payment proof"
                  className="max-h-[70vh] w-auto rounded-md border"
                />
              </div>
            </DialogContent>
          </Dialog>

          {/* ── Delivery info ─────────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Delivery</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <InfoRow
                icon={<MapPin className="h-3.5 w-3.5" />}
                label="Address"
                value={order.deliveryAddress ?? '—'}
              />
              <InfoRow label="City" value={order.deliveryCity ?? '—'} />
              {order.courierCityStatus === 'unresolved' && order.deliveryCity && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-2 mt-1">
                  <div className="flex items-center gap-1.5 mb-1">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                    <span className="text-xs font-medium text-amber-900">City mismatch</span>
                  </div>
                  <p className="text-[11px] text-amber-700 mb-2">
                    The delivery city &quot;{order.deliveryCity}&quot; doesn&apos;t match any cached courier city. Resolve it below to enable booking.
                  </p>
                  <CityMismatchResolver
                    providerKey="postex"
                    typedCity={order.deliveryCity}
                    suggestions={[]}
                    onResolved={async (resolvedCity) => {
                      try {
                        await api.patch(`/api/orders/${orderId}`, {
                          delivery_city: resolvedCity,
                          courier_city_status: 'matched',
                        })
                        toast.success(`City resolved to "${resolvedCity}"`)
                        invalidateAll()
                      } catch {
                        toast.error('Failed to update city')
                      }
                    }}
                    onCancelled={() => {}}
                  />
                </div>
              )}
              {order.courierSubStatus && (
                <InfoRow label="Courier Status" value={order.courierSubStatus} />
              )}
              {order.needsShipperAdvice && (
                <div className="rounded-lg border border-rose-300 bg-rose-50 p-2 mt-1 flex items-center gap-1.5">
                  <AlertCircle className="h-3.5 w-3.5 text-rose-600" />
                  <span className="text-xs text-rose-800">Courier status requires shipper advice</span>
                </div>
              )}
              <InfoRow label="Courier" value={order.courierName ?? '—'} />
              {order.trackingNumber && (
                <InfoRow
                  label="Tracking #"
                  value={order.trackingNumber}
                  valueClassName="font-mono"
                />
              )}
              {order.dispatchLocation && (
                <InfoRow
                  icon={<Boxes className="h-3.5 w-3.5" />}
                  label="Dispatch from"
                  value={`${order.dispatchLocation.name}${
                    order.dispatchLocation.city ? ` · ${order.dispatchLocation.city}` : ''
                  }`}
                />
              )}
              {order.notesForCourier && (
                <InfoRow label="Notes" value={order.notesForCourier} muted />
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Side column: customer + timeline + activity ────────────────── */}
        <div className="space-y-6">
          {/* ── Customer info ─────────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Customer</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-start gap-2">
                <User className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                <div>
                  <p className="font-medium">{customer.name}</p>
                  <p className="text-xs text-muted-foreground font-mono">{customer.phone}</p>
                  {customer.alternatePhone && (
                    <p className="text-xs text-muted-foreground font-mono">
                      alt: {customer.alternatePhone}
                    </p>
                  )}
                  {customer.email && (
                    <p className="text-xs text-muted-foreground">{customer.email}</p>
                  )}
                </div>
              </div>
              <Separator />
              <InfoRow
                label="Previous orders"
                value={String(customer.totalOrdersCount)}
              />
              <InfoRow label="Total RTOs" value={String(customer.totalRtoCount)} />
              {customer.isFlagged && (
                <div className="rounded-md bg-rose-50 border border-rose-200 p-2.5 flex items-start gap-2">
                  <Flag className="h-3.5 w-3.5 text-rose-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs font-medium text-rose-700">Flagged customer</p>
                    {customer.flaggedReason && (
                      <p className="text-xs text-rose-600">{customer.flaggedReason}</p>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Status timeline ──────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <Timeline order={order} />
            </CardContent>
          </Card>

          {/* ── Activity log ─────────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-1.5">
                <History className="h-4 w-4" /> Activity
              </CardTitle>
            </CardHeader>
            <CardContent>
              {auditQuery.isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-12" />
                  ))}
                </div>
              ) : auditQuery.isError ? (
                <p className="text-xs text-muted-foreground">Failed to load activity log.</p>
              ) : auditQuery.data && auditQuery.data.rows.length > 0 ? (
                <ol className="space-y-3 max-h-96 overflow-y-auto scrollbar-thin pr-1">
                  {auditQuery.data.rows.map((row) => (
                    <li key={row.id} className="flex gap-2.5 text-xs">
                      <div className="flex flex-col items-center pt-1">
                        <div className="h-2 w-2 rounded-full bg-primary/60" />
                        <div className="w-px flex-1 bg-border" />
                      </div>
                      <div className="min-w-0 flex-1 pb-1">
                        <p className="font-medium">{row.action}</p>
                        <p className="text-muted-foreground">
                          {row.user?.fullName ?? 'System'} ·{' '}
                          {formatDateTime(row.createdAt)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-xs text-muted-foreground">No activity recorded.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── Dialogs ──────────────────────────────────────────────────────── */}
      <DispatchDialog
        open={dispatchDialogOpen}
        onOpenChange={setDispatchDialogOpen}
        onSubmit={(vars) => dispatchMutation.mutate(vars)}
        isPending={dispatchMutation.isPending}
        defaultCourier={order.courierName ?? ''}
      />
      <CancelDialog
        open={cancelDialogOpen}
        onOpenChange={setCancelDialogOpen}
        onSubmit={(reason) => cancelMutation.mutate({ cancellation_reason: reason })}
        isPending={cancelMutation.isPending}
      />
      <RtoDialog
        open={rtoDialogOpen}
        onOpenChange={setRtoDialogOpen}
        onSubmit={(reason) => rtoMutation.mutate({ return_reason: reason })}
        isPending={rtoMutation.isPending}
      />
      <ConvertPaymentDialog
        open={convertDialogOpen}
        onOpenChange={setConvertDialogOpen}
        onSubmit={(vars) => convertMutation.mutate(vars)}
        isPending={convertMutation.isPending}
        total={order.totalOrderValue}
      />
      <CodCollectedDialog
        open={codDialogOpen}
        onOpenChange={setCodDialogOpen}
        onSubmit={(amount) => codMutation.mutate({ collected_amount: amount })}
        isPending={codMutation.isPending}
        defaultAmount={remainingCod}
      />
      {exchangeTarget && (
        <RequestExchangeDialog
          open={!!exchangeTarget}
          onOpenChange={(v) => !v && setExchangeTarget(null)}
          orderItemId={exchangeTarget.id}
          orderItemSku={exchangeTarget.variant.sku}
          orderItemTitle={exchangeTarget.variant.productTitle}
          orderItemPrice={exchangeTarget.unitPrice}
          orderId={orderId}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function PaymentRow({
  label,
  value,
  valueClassName,
  muted,
}: {
  label: string
  value: string
  valueClassName?: string
  muted?: boolean
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={cn(muted ? 'text-muted-foreground text-xs' : 'text-muted-foreground')}>
        {label}
      </span>
      <span
        className={cn(
          'tabular-nums',
          muted && 'text-xs text-muted-foreground',
          valueClassName,
        )}
      >
        {value}
      </span>
    </div>
  )
}

function InfoRow({
  icon,
  label,
  value,
  valueClassName,
  muted,
}: {
  icon?: React.ReactNode
  label: string
  value: string
  valueClassName?: string
  muted?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="flex items-center gap-1.5 text-muted-foreground shrink-0">
        {icon}
        {label}
      </span>
      <span
        className={cn(
          'text-right',
          muted && 'text-muted-foreground text-xs',
          valueClassName,
        )}
      >
        {value}
      </span>
    </div>
  )
}

function Timeline({
  order,
}: {
  order: OrderDetail['order']
}) {
  const steps = useMemo(() => {
    return [
      {
        key: 'created',
        label: 'Order placed',
        time: order.createdAt,
        icon: Clock,
        tone: 'muted' as const,
      },
      {
        key: 'confirmed',
        label: 'Confirmed',
        time: order.confirmedAt,
        icon: CheckCircle2,
        tone: 'sky' as const,
      },
      {
        key: 'processing',
        label: 'Processing',
        time: order.status === 'processing' || order.packedAt || order.dispatchedAt
          ? order.createdAt
          : null,
        icon: Package,
        tone: 'blue' as const,
      },
      {
        key: 'packed',
        label: 'Packed',
        time: order.packedAt,
        icon: PackageCheck,
        tone: 'blue' as const,
      },
      {
        key: 'dispatched',
        label: 'Dispatched',
        time: order.dispatchedAt,
        icon: Truck,
        tone: 'violet' as const,
      },
      {
        key: 'delivered',
        label: 'Delivered',
        time: order.deliveredAt,
        icon: CheckCircle2,
        tone: 'emerald' as const,
      },
      {
        key: 'rto',
        label: 'Returned (RTO)',
        time: order.returnedAt,
        icon: RotateCcw,
        tone: 'rose' as const,
      },
      {
        key: 'cancelled',
        label: 'Cancelled',
        time: order.cancelledAt,
        icon: XCircle,
        tone: 'slate' as const,
      },
    ]
  }, [order])

  const toneClasses: Record<string, string> = {
    muted: 'bg-gray-100 text-gray-500',
    sky: 'bg-sky-50 text-sky-600',
    blue: 'bg-blue-50 text-blue-600',
    violet: 'bg-violet-50 text-violet-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    rose: 'bg-rose-50 text-rose-600',
    slate: 'bg-slate-100 text-slate-500',
  }

  // Filter to relevant steps — show cancelled/rto only if they occurred
  const visibleSteps = steps.filter((s) => {
    if (s.key === 'rto') return !!s.time
    if (s.key === 'cancelled') return !!s.time
    if (s.key === 'processing')
      return order.status === 'processing' || !!order.packedAt || !!order.dispatchedAt
    if (s.key === 'packed') return !!s.time
    return true
  })

  return (
    <ol className="space-y-3">
      {visibleSteps.map((s, idx) => {
        const Icon = s.icon
        const reached = !!s.time
        return (
          <li key={s.key} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full',
                  reached ? toneClasses[s.tone] : 'bg-muted text-muted-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </div>
              {idx < visibleSteps.length - 1 && (
                <div className={cn('w-px flex-1 my-1', reached ? 'bg-border' : 'bg-muted')} />
              )}
            </div>
            <div className="min-w-0 flex-1 pb-1">
              <p className={cn('text-sm', reached ? 'font-medium' : 'text-muted-foreground')}>
                {s.label}
              </p>
              <p className="text-xs text-muted-foreground">
                {reached ? formatDateTime(s.time) : 'Pending'}
              </p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Dialogs
// ─────────────────────────────────────────────────────────────────────────────

function DispatchDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
  defaultCourier,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSubmit: (vars: { tracking_number: string; courier_name?: string }) => void
  isPending: boolean
  defaultCourier: string
}) {
  const [trackingNumber, setTrackingNumber] = useState('')
  const [courierName, setCourierName] = useState(defaultCourier)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dispatch order</DialogTitle>
          <DialogDescription>
            Enter the courier tracking number. Stock will be deducted from inventory.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="d-tracking">Tracking number *</Label>
            <Input
              id="d-tracking"
              placeholder="e.g. TCS-12345"
              value={trackingNumber}
              onChange={(e) => setTrackingNumber(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="d-courier">Courier name</Label>
            <Input
              id="d-courier"
              placeholder="e.g. TCS, Leopards"
              value={courierName}
              onChange={(e) => setCourierName(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              onSubmit({
                tracking_number: trackingNumber.trim(),
                courier_name: courierName.trim() || undefined,
              })
            }
            disabled={isPending || !trackingNumber.trim()}
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />}
            Dispatch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CancelDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSubmit: (reason: string) => void
  isPending: boolean
}) {
  const [reason, setReason] = useState('')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel order</DialogTitle>
          <DialogDescription>
            Reserved stock will be released back to inventory. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 py-2">
          <Label htmlFor="c-reason">Reason *</Label>
          <Textarea
            id="c-reason"
            placeholder="e.g. Customer changed mind, out of stock, etc."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Keep order
          </Button>
          <Button
            variant="destructive"
            onClick={() => onSubmit(reason.trim())}
            disabled={isPending || reason.trim().length < 3}
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
            Cancel Order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RtoDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSubmit: (reason: string) => void
  isPending: boolean
}) {
  const [reason, setReason] = useState('')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Process return (RTO)</DialogTitle>
          <DialogDescription>
            The order will be marked as RTO. Returned items will be auto-processed (made-to-order
            items assumed perfect, stock-based items assumed resellable). Items will be flagged for
            review.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 py-2">
          <Label htmlFor="r-reason">Return reason *</Label>
          <Textarea
            id="r-reason"
            placeholder="e.g. Customer refused delivery, wrong address, etc."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => onSubmit(reason.trim())}
            disabled={isPending || reason.trim().length < 3}
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
            Process RTO
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ConvertPaymentDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
  total,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSubmit: (vars: {
    new_payment_type: 'partial_advance' | 'fully_prepaid'
    advance_amount?: number
    advance_payment_method?: string
    advance_payment_reference?: string
    advance_payment_screenshot_url?: string
  }) => void
  isPending: boolean
  total: number
}) {
  const [newType, setNewType] = useState<'partial_advance' | 'fully_prepaid'>('partial_advance')
  const [advanceAmount, setAdvanceAmount] = useState('')
  const [method, setMethod] = useState('')
  const [reference, setReference] = useState('')
  const [screenshot, setScreenshot] = useState('')

  const effectiveAdvance =
    newType === 'fully_prepaid' ? total : Number(advanceAmount) || 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Convert payment</DialogTitle>
          <DialogDescription>
            Convert this COD order to partial advance or fully prepaid. If the order is still
            pending, this also confirms it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <RadioGroup
            value={newType}
            onValueChange={(v) => setNewType(v as 'partial_advance' | 'fully_prepaid')}
            className="grid gap-2"
          >
            <label
              htmlFor="cp-partial"
              className={cn(
                'flex items-start gap-3 rounded-lg border p-3 cursor-pointer',
                newType === 'partial_advance'
                  ? 'border-primary bg-primary/5'
                  : 'border-border',
              )}
            >
              <RadioGroupItem value="partial_advance" id="cp-partial" className="mt-1" />
              <div>
                <p className="text-sm font-medium">Partial advance</p>
                <p className="text-xs text-muted-foreground">Customer pays a portion upfront</p>
              </div>
            </label>
            <label
              htmlFor="cp-full"
              className={cn(
                'flex items-start gap-3 rounded-lg border p-3 cursor-pointer',
                newType === 'fully_prepaid'
                  ? 'border-primary bg-primary/5'
                  : 'border-border',
              )}
            >
              <RadioGroupItem value="fully_prepaid" id="cp-full" className="mt-1" />
              <div>
                <p className="text-sm font-medium">Fully prepaid</p>
                <p className="text-xs text-muted-foreground">
                  Full amount ({formatPKR(total)}) paid upfront
                </p>
              </div>
            </label>
          </RadioGroup>

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cp-amount">Advance amount</Label>
              <Input
                id="cp-amount"
                type="number"
                min="0"
                step="0.01"
                value={newType === 'fully_prepaid' ? String(total) : advanceAmount}
                onChange={(e) => setAdvanceAmount(e.target.value)}
                disabled={newType === 'fully_prepaid'}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cp-method">Method</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger id="cp-method">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="cp-ref">Reference</Label>
              <Input
                id="cp-ref"
                placeholder="Transaction ID"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="cp-shot">Screenshot URL</Label>
              <Input
                id="cp-shot"
                type="url"
                placeholder="https://…"
                value={screenshot}
                onChange={(e) => setScreenshot(e.target.value)}
              />
            </div>
          </div>

          <div className="rounded-md bg-muted/40 p-2 text-xs flex items-center justify-between">
            <span className="text-muted-foreground">Remaining COD</span>
            <span className="font-medium tabular-nums">
              {formatPKR(Math.max(0, total - effectiveAdvance))}
            </span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              onSubmit({
                new_payment_type: newType,
                advance_amount: effectiveAdvance,
                advance_payment_method: method || undefined,
                advance_payment_reference: reference.trim() || undefined,
                advance_payment_screenshot_url: screenshot.trim() || undefined,
              })
            }
            disabled={isPending || (newType === 'partial_advance' && effectiveAdvance <= 0)}
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
            Convert
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CodCollectedDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
  defaultAmount,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSubmit: (amount: number) => void
  isPending: boolean
  defaultAmount: number
}) {
  const [amount, setAmount] = useState(String(defaultAmount))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark COD collected</DialogTitle>
          <DialogDescription>
            Record the amount collected from the customer on delivery.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 py-2">
          <Label htmlFor="cod-amount">Collected amount *</Label>
          <Input
            id="cod-amount"
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Expected COD: {formatPKR(defaultAmount)}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => onSubmit(Number(amount) || 0)}
            disabled={isPending || Number(amount) <= 0}
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
            Mark Collected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
