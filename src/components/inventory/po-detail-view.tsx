'use client'

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, FetchError } from '@/lib/api-client'
import { useAppStore, useCan } from '@/stores/app-store'
import { PERMISSIONS } from '@/lib/permissions'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  ArrowLeft,
  Truck,
  Warehouse,
  Calendar,
  Wallet,
  PackageCheck,
  AlertTriangle,
  Loader2,
  Send,
  Ban,
  CheckCircle2,
  History,
  RefreshCw,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types — match GET /api/purchase-orders/{id}
// ─────────────────────────────────────────────────────────────────────────────

type POStatus = 'draft' | 'ordered' | 'partially_received' | 'received' | 'cancelled'

interface POItem {
  id: string
  variant: {
    id: string
    sku: string
    productTitle: string
  }
  orderedQuantity: number
  receivedQuantity: number
  costPerUnit: number
  lineTotal: number
  fullyReceived: boolean
}

interface ReceiptItem {
  id: string
  purchaseOrderItemId: string
  receivedQuantity: number
  actualCostPerUnit: number
  shortageQuantity: number
  shortageReason: string | null
}

interface Receipt {
  id: string
  receivedAt: string
  receivedBy: string
  notes: string | null
  items: ReceiptItem[]
}

interface PODetail {
  id: string
  poNumber: string
  status: POStatus
  supplier: {
    id: string
    name: string
    contactPerson: string | null
    phone: string | null
    paymentTerms: string
  }
  deliveryLocation: { id: string; name: string }
  orderDate: string
  expectedDeliveryDate: string | null
  advancePayment: number
  paymentMethod: string | null
  notes: string | null
  totalItemsValue: number
  balanceDue: number
  items: POItem[]
  receipts: Receipt[]
}

interface PODetailResponse {
  order: PODetail
}

interface ReceivePayload {
  notes?: string
  items: Array<{
    purchase_order_item_id: string
    org_variant_id: string
    received_quantity: number
    actual_cost_per_unit: number
    shortage_quantity: number
    shortage_reason?: string
  }>
}

// ─────────────────────────────────────────────────────────────────────────────
// Display maps
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<POStatus, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-gray-100 text-gray-700 border-gray-200' },
  ordered: { label: 'Ordered', className: 'bg-sky-50 text-sky-700 border-sky-200' },
  partially_received: {
    label: 'Partially Received',
    className: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  received: {
    label: 'Received',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  cancelled: { label: 'Cancelled', className: 'bg-rose-50 text-rose-700 border-rose-200' },
}

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

function formatDateTime(iso: string): string {
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
  return 'Something went wrong. Please try again.'
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function PoDetailView({ poId }: { poId: string }) {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const queryClient = useQueryClient()

  const canManage = can(PERMISSIONS.INVENTORY_MANAGE_PURCHASE_ORDERS)
  const canReceive = can(PERMISSIONS.INVENTORY_RECEIVE)

  const [receiveOpen, setReceiveOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState('')

  const detailQuery = useQuery<PODetailResponse>({
    queryKey: ['purchase-order', poId],
    queryFn: () => api.get<PODetailResponse>(`/api/purchase-orders/${poId}`),
    staleTime: 10_000,
  })

  const order = detailQuery.data?.order

  const isOverdue = useMemo(() => {
    if (!order?.expectedDeliveryDate) return false
    if (order.status === 'received' || order.status === 'cancelled') return false
    return new Date(order.expectedDeliveryDate) < new Date()
  }, [order])

  const canCancel =
    order && order.status !== 'cancelled' && order.status !== 'received'
  const canConfirm = order && order.status === 'draft'
  const canReceiveStock =
    order &&
    order.status !== 'cancelled' &&
    order.status !== 'received' &&
    order.items.some((i) => !i.fullyReceived)

  // ── Mutations ────────────────────────────────────────────────────────────
  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['purchase-order', poId] })
    void queryClient.invalidateQueries({ queryKey: ['purchase-orders'] })
    void queryClient.invalidateQueries({ queryKey: ['inventory-dashboard'] })
    void queryClient.invalidateQueries({ queryKey: ['locations'] })
  }

  const confirmMutation = useMutation({
    mutationFn: async () => api.post(`/api/purchase-orders/${poId}/confirm`),
    onSuccess: () => {
      toast.success('PO confirmed and sent. Incoming stock updated.')
      invalidateAll()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const cancelMutation = useMutation({
    mutationFn: async () =>
      api.post(`/api/purchase-orders/${poId}/cancel`, { reason: cancelReason.trim() }),
    onSuccess: () => {
      toast.success('PO cancelled.')
      setCancelOpen(false)
      setCancelReason('')
      invalidateAll()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  if (detailQuery.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Purchase Order" />
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  if (detailQuery.isError || !order) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Purchase Order"
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate({ name: 'inventory-purchase-orders' })}
            >
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
          }
        />
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">
              {detailQuery.isError
                ? getErrorMessage(detailQuery.error)
                : 'Purchase order not found.'}
            </p>
            <Button variant="outline" onClick={() => detailQuery.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const badge = STATUS_BADGE[order.status]
  const totalReceivedValue = order.items.reduce(
    (s, i) => s + Math.min(i.receivedQuantity, i.orderedQuantity) * i.costPerUnit,
    0,
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title={`PO ${order.poNumber}`}
        description={`Created ${formatDate(order.orderDate)} · Ordered from ${order.supplier.name}`}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate({ name: 'inventory-purchase-orders' })}
            >
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => detailQuery.refetch()}
              disabled={detailQuery.isFetching}
            >
              <RefreshCw
                className={detailQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}
              />
              Refresh
            </Button>
          </div>
        }
      />

      {/* ── Status header ──────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Badge variant="outline" className={badge.className}>
                {badge.label}
              </Badge>
              {isOverdue && (
                <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200">
                  <AlertTriangle className="h-3 w-3 mr-1" /> Overdue
                </Badge>
              )}
              <div className="text-sm text-muted-foreground">
                {order.items.length} item{order.items.length === 1 ? '' : 's'} ·{' '}
                {order.items.reduce((s, i) => s + i.orderedQuantity, 0)} units ordered
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {canConfirm && canManage && (
                <Button
                  onClick={() => confirmMutation.mutate()}
                  disabled={confirmMutation.isPending}
                >
                  {confirmMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Confirming…
                    </>
                  ) : (
                    <>
                      <Send className="h-4 w-4" /> Confirm Draft
                    </>
                  )}
                </Button>
              )}
              {canReceiveStock && canReceive && (
                <Button onClick={() => setReceiveOpen(true)}>
                  <PackageCheck className="h-4 w-4" /> Receive Stock
                </Button>
              )}
              {canCancel && canManage && (
                <Button
                  variant="outline"
                  className="text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                  onClick={() => setCancelOpen(true)}
                >
                  <Ban className="h-4 w-4" /> Cancel PO
                </Button>
              )}
            </div>
          </div>

          {isOverdue && (
            <Alert variant="destructive" className="mt-4">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>This PO is overdue</AlertTitle>
              <AlertDescription>
                Expected delivery was {formatDate(order.expectedDeliveryDate)} but stock hasn&apos;t
                been fully received yet.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ── Items table ──────────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Items</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Variant</TableHead>
                      <TableHead className="text-right">Ordered</TableHead>
                      <TableHead className="text-right">Received</TableHead>
                      <TableHead className="w-32">Progress</TableHead>
                      <TableHead className="text-right">Cost / unit</TableHead>
                      <TableHead className="text-right">Line total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {order.items.map((item) => {
                      const pct =
                        item.orderedQuantity === 0
                          ? 0
                          : Math.min(
                              100,
                              Math.round(
                                (item.receivedQuantity / item.orderedQuantity) * 100,
                              ),
                            )
                      return (
                        <TableRow key={item.id}>
                          <TableCell>
                            <div className="flex flex-col">
                              <span className="font-medium text-sm">{item.variant.productTitle}</span>
                              <span className="text-xs text-muted-foreground font-mono">
                                {item.variant.sku}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {item.orderedQuantity}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            <span
                              className={
                                item.fullyReceived
                                  ? 'text-emerald-600 font-medium'
                                  : item.receivedQuantity > 0
                                    ? 'text-amber-600 font-medium'
                                    : 'text-muted-foreground'
                              }
                            >
                              {item.receivedQuantity}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Progress value={pct} className="h-2" />
                              <span className="text-[11px] text-muted-foreground tabular-nums w-8 text-right">
                                {pct}%
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {formatPKR(item.costPerUnit)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums font-medium">
                            {formatPKR(item.lineTotal)}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* ── Receipts history ──────────────────────────────────────── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <History className="h-4 w-4" /> Receiving history
              </CardTitle>
            </CardHeader>
            <CardContent>
              {order.receipts.length === 0 ? (
                <div className="text-center py-8">
                  <PackageCheck className="h-8 w-8 mx-auto text-muted-foreground/40 mb-2" />
                  <p className="text-sm text-muted-foreground">
                    No receipts recorded yet for this PO.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {order.receipts.map((r) => {
                    const totalReceived = r.items.reduce(
                      (s, i) => s + i.receivedQuantity,
                      0,
                    )
                    const totalValue = r.items.reduce(
                      (s, i) => s + i.receivedQuantity * i.actualCostPerUnit,
                      0,
                    )
                    return (
                      <div
                        key={r.id}
                        className="rounded-md border p-3 bg-muted/20"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="text-sm">
                            <span className="font-medium">{r.receivedBy}</span>
                            <span className="text-muted-foreground"> received </span>
                            <span className="font-medium tabular-nums">{totalReceived}</span>
                            <span className="text-muted-foreground"> units</span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {formatDateTime(r.receivedAt)}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {r.items.map((ri) => {
                            const poItem = order.items.find(
                              (i) => i.id === ri.purchaseOrderItemId,
                            )
                            return (
                              <Badge
                                key={ri.id}
                                variant="outline"
                                className="text-[10px] font-mono"
                              >
                                {poItem?.variant.sku ?? '—'}: {ri.receivedQuantity} @{' '}
                                {formatPKR(ri.actualCostPerUnit)}
                                {ri.shortageQuantity > 0 && (
                                  <span className="text-rose-600 ml-1">
                                    (short {ri.shortageQuantity})
                                  </span>
                                )}
                              </Badge>
                            )
                          })}
                        </div>
                        {r.notes && (
                          <p className="text-xs text-muted-foreground mt-2 italic">
                            “{r.notes}”
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground mt-1.5">
                          Receipt value: <span className="font-medium">{formatPKR(totalValue)}</span>
                        </p>
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Right: meta ──────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Order summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <SummaryRow
                icon={<Truck className="h-3.5 w-3.5" />}
                label="Supplier"
                value={order.supplier.name}
              />
              {order.supplier.contactPerson && (
                <SummaryRow label="Contact" value={order.supplier.contactPerson} />
              )}
              {order.supplier.phone && (
                <SummaryRow label="Phone" value={order.supplier.phone} />
              )}
              <SummaryRow label="Payment terms" value={order.supplier.paymentTerms} />
              <div className="border-t pt-3 space-y-2">
                <SummaryRow
                  icon={<Warehouse className="h-3.5 w-3.5" />}
                  label="Deliver to"
                  value={order.deliveryLocation.name}
                />
                <SummaryRow
                  icon={<Calendar className="h-3.5 w-3.5" />}
                  label="Order date"
                  value={formatDate(order.orderDate)}
                />
                <SummaryRow
                  icon={<Calendar className="h-3.5 w-3.5" />}
                  label="Expected"
                  value={formatDate(order.expectedDeliveryDate)}
                />
              </div>
              <div className="border-t pt-3 space-y-2">
                <SummaryRow
                  icon={<Wallet className="h-3.5 w-3.5" />}
                  label="Order value"
                  value={formatPKR(order.totalItemsValue)}
                />
                <SummaryRow label="Received value" value={formatPKR(totalReceivedValue)} />
                <SummaryRow
                  label="Advance paid"
                  value={formatPKR(order.advancePayment)}
                />
                <div className="flex items-center justify-between pt-2 border-t">
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Balance due
                  </span>
                  <span className="text-base font-semibold text-amber-700 tabular-nums">
                    {formatPKR(order.balanceDue)}
                  </span>
                </div>
                {order.paymentMethod && (
                  <SummaryRow label="Payment method" value={order.paymentMethod} />
                )}
              </div>
              {order.notes && (
                <div className="border-t pt-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                    Notes
                  </p>
                  <p className="text-xs text-foreground whitespace-pre-wrap">{order.notes}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── Receive dialog ────────────────────────────────────────────────── */}
      {canReceiveStock && (
        <ReceiveDialog
          open={receiveOpen}
          onOpenChange={setReceiveOpen}
          po={order}
          onSuccess={() => {
            invalidateAll()
            setReceiveOpen(false)
          }}
        />
      )}

      {/* ── Cancel dialog ──────────────────────────────────────────────────── */}
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel PO {order.poNumber}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will mark the PO as cancelled and release any reserved incoming stock for
              unreceived items. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5 py-2">
            <Label htmlFor="cancel-reason">Reason (optional)</Label>
            <Textarea
              id="cancel-reason"
              placeholder="e.g. Supplier couldn't deliver, no longer needed…"
              rows={3}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelMutation.isPending}>Keep PO</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700"
              disabled={cancelMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                cancelMutation.mutate()
              }}
            >
              {cancelMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Cancelling…
                </>
              ) : (
                <>
                  <Ban className="h-4 w-4" /> Cancel PO
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function SummaryRow({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground flex items-center gap-1.5">
        {icon}
        {label}
      </span>
      <span className="font-medium text-right">{value}</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Receive dialog — pre-filled with remaining quantities
// ─────────────────────────────────────────────────────────────────────────────

interface ReceiveLine {
  itemId: string
  variantId: string
  sku: string
  productTitle: string
  remaining: number
  received: number
  actualCost: number
  shortage: number
  shortageReason: string
}

function ReceiveDialog({
  open,
  onOpenChange,
  po,
  onSuccess,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  po: PODetail
  onSuccess: () => void
}) {
  const [lines, setLines] = useState<ReceiveLine[]>([])
  const [notes, setNotes] = useState('')

  // Initialize lines when opening.
  useEffect(() => {
    if (open) {
      setLines(
        po.items
          .filter((i) => !i.fullyReceived)
          .map((i) => ({
            itemId: i.id,
            variantId: i.variant.id,
            sku: i.variant.sku,
            productTitle: i.variant.productTitle,
            remaining: i.orderedQuantity - i.receivedQuantity,
            received: i.orderedQuantity - i.receivedQuantity,
            actualCost: i.costPerUnit,
            shortage: 0,
            shortageReason: '',
          })),
      )
      setNotes('')
    }
  }, [open, po])

  const updateLine = (itemId: string, patch: Partial<ReceiveLine>) => {
    setLines((prev) =>
      prev.map((l) => {
        if (l.itemId !== itemId) return l
        const next = { ...l, ...patch }
        // Recompute shortage whenever received changes.
        if (patch.received !== undefined) {
          next.shortage = Math.max(0, next.remaining - patch.received)
        }
        return next
      }),
    )
  }

  const totalReceivingValue = lines.reduce(
    (s, l) => s + l.received * l.actualCost,
    0,
  )
  const hasShortage = lines.some((l) => l.shortage > 0)
  const hasAnyReceived = lines.some((l) => l.received > 0)

  const receiveMutation = useMutation({
    mutationFn: async (payload: ReceivePayload) =>
      api.post(`/api/purchase-orders/${po.id}/receive`, payload),
    onSuccess: (_data, vars) => {
      const total = vars.items.reduce((s, i) => s + i.received_quantity, 0)
      toast.success(`Received ${total} units against ${po.poNumber}.`)
      onSuccess()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const handleSubmit = () => {
    if (!hasAnyReceived) {
      toast.error('Enter at least one received quantity.')
      return
    }
    // Require shortage reasons where applicable.
    const missingReason = lines.find((l) => l.shortage > 0 && !l.shortageReason.trim())
    if (missingReason) {
      toast.error(`Provide a shortage reason for ${missingReason.sku}.`)
      return
    }
    const payload: ReceivePayload = {
      notes: notes.trim() || undefined,
      items: lines
        .filter((l) => l.received > 0)
        .map((l) => ({
          purchase_order_item_id: l.itemId,
          org_variant_id: l.variantId,
          received_quantity: l.received,
          actual_cost_per_unit: l.actualCost,
          shortage_quantity: l.shortage,
          shortage_reason: l.shortage > 0 ? l.shortageReason.trim() : undefined,
        })),
    }
    receiveMutation.mutate(payload)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageCheck className="h-4 w-4" /> Receive stock — {po.poNumber}
          </DialogTitle>
          <DialogDescription>
            Pre-filled with remaining quantities. Adjust the actually-received amount and cost
            per unit if they differ from the PO.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Variant</TableHead>
                <TableHead className="text-right">Remaining</TableHead>
                <TableHead className="w-28">Received</TableHead>
                <TableHead className="w-32">Cost / unit</TableHead>
                <TableHead className="text-right">Line total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l) => (
                <TableRow key={l.itemId}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium text-sm">{l.productTitle}</span>
                      <span className="text-xs text-muted-foreground font-mono">{l.sku}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {l.remaining}
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min="0"
                      max={l.remaining}
                      step="1"
                      className="h-8 tabular-nums"
                      value={l.received}
                      onChange={(e) =>
                        updateLine(l.itemId, {
                          received: Math.max(0, parseQty(e.target.value)),
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      className="h-8 tabular-nums"
                      value={l.actualCost}
                      onChange={(e) =>
                        updateLine(l.itemId, { actualCost: parseCost(e.target.value) })
                      }
                    />
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {formatPKR(l.received * l.actualCost)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {hasShortage && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Shortages detected</AlertTitle>
            <AlertDescription>
              The following items have received quantities less than remaining. A reason is
              required for each.
              <div className="mt-2 space-y-2">
                {lines
                  .filter((l) => l.shortage > 0)
                  .map((l) => (
                    <div key={l.itemId} className="space-y-1">
                      <Label htmlFor={`sr-${l.itemId}`} className="text-xs">
                        {l.sku} — short by {l.shortage} unit{l.shortage === 1 ? '' : 's'}
                      </Label>
                      <Input
                        id={`sr-${l.itemId}`}
                        placeholder="e.g. Damaged in transit, supplier short-shipped…"
                        value={l.shortageReason}
                        onChange={(e) =>
                          updateLine(l.itemId, { shortageReason: e.target.value })
                        }
                      />
                    </div>
                  ))}
              </div>
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="recv-notes">Notes (optional)</Label>
          <Textarea
            id="recv-notes"
            placeholder="Any context for this receipt…"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between gap-3">
          <div className="text-sm text-muted-foreground">
            Total receiving value:{' '}
            <span className="font-semibold text-foreground tabular-nums">
              {formatPKR(totalReceivingValue)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={receiveMutation.isPending || !hasAnyReceived}>
              {receiveMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Receiving…
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4" /> Confirm Receipt
                </>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function parseQty(v: string): number {
  if (v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

function parseCost(v: string): number {
  if (v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : 0
}
