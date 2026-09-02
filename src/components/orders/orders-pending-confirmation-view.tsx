'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api-client'
import { useAppStore, useCan } from '@/stores/app-store'
import { PERMISSIONS } from '@/lib/permissions'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  RefreshCw,
  Loader2,
  CheckCircle2,
  XCircle,
  CreditCard,
  AlertTriangle,
  Clock,
} from 'lucide-react'
import {
  formatPKR,
  formatDate,
  getErrorMessage,
  badgeForStatus,
} from './_shared'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface PendingOrderRow {
  id: string
  flowopsOrderNumber: string
  orderSource: string
  status: string
  paymentType: string
  paymentStatus: string
  totalOrderValue: number
  itemCount: number
  customerName: string
  customerPhone: string
  createdAt: string
}

interface PendingResponse {
  orders: PendingOrderRow[]
  stats: { count: number; totalValueAtRisk: number }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function OrdersPendingConfirmationView() {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const queryClient = useQueryClient()

  const canManage = can(PERMISSIONS.ORDERS_MANAGE)
  const canCancel = can(PERMISSIONS.ORDERS_CANCEL)

  const query = useQuery<PendingResponse>({
    queryKey: ['orders-pending'],
    queryFn: () => api.get<PendingResponse>('/api/orders/pending'),
    staleTime: 15_000,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['orders-pending'] })
    void queryClient.invalidateQueries({ queryKey: ['orders'] })
  }

  const confirmMutation = useMutation({
    mutationFn: async (id: string) => api.post(`/api/orders/${id}/confirm`),
    onSuccess: () => {
      toast.success('Order confirmed. Stock reservation started.')
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const cancelMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) =>
      api.post(`/api/orders/${id}/cancel`, { cancellation_reason: reason }),
    onSuccess: () => {
      toast.success('Order cancelled.')
      setCancelTarget(null)
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const [convertTarget, setConvertTarget] = useState<PendingOrderRow | null>(null)
  const [cancelTarget, setCancelTarget] = useState<PendingOrderRow | null>(null)

  const orders = query.data?.orders ?? []
  const stats = query.data?.stats

  const totalValueAtRisk = useMemo(
    () => stats?.totalValueAtRisk ?? orders.reduce((s, o) => s + o.totalOrderValue, 0),
    [stats, orders],
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pending Confirmation"
        description="Orders awaiting manual confirmation. Convert payment, confirm to reserve stock, or cancel."
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Pending orders"
          value={`${orders.length}`}
          icon={<Clock className="h-4 w-4" />}
          hint="Awaiting confirmation"
        />
        <StatCard
          label="Value at risk"
          value={formatPKR(totalValueAtRisk)}
          icon={<AlertTriangle className="h-4 w-4" />}
          hint="Total COD value pending"
        />
        <StatCard
          label="Oldest pending"
          value={orders[0] ? formatDate(orders[0].createdAt) : '—'}
          icon={<Clock className="h-4 w-4" />}
          hint="First in queue (FIFO)"
        />
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
              Couldn&apos;t load pending orders. {getErrorMessage(query.error)}
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
              <CheckCircle2 className="h-7 w-7 text-emerald-600" />
            </div>
            <h3 className="text-lg font-semibold">No orders awaiting confirmation</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
              All incoming orders are confirmed. New orders will appear here.
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
                    <TableHead>Payment</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.map((o) => {
                    const badge = badgeForStatus(o.status)
                    return (
                      <TableRow key={o.id}>
                        <TableCell>
                          <button
                            type="button"
                            onClick={() => navigate({ name: 'order-detail', id: o.id })}
                            className="text-left group"
                          >
                            <p className="font-medium text-sm group-hover:text-primary transition-colors">
                              {o.flowopsOrderNumber}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {o.itemCount} item{o.itemCount === 1 ? '' : 's'} · {o.orderSource}
                            </p>
                          </button>
                        </TableCell>
                        <TableCell>
                          <p className="text-sm font-medium">{o.customerName}</p>
                          <p className="text-xs text-muted-foreground">{o.customerPhone}</p>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={badge.className}>
                            {o.paymentType === 'full_cod'
                              ? 'Full COD'
                              : o.paymentType === 'partial_advance'
                                ? 'Partial Advance'
                                : 'Prepaid'}
                          </Badge>
                          <p className="text-xs text-muted-foreground mt-1">
                            {o.paymentStatus.replace(/_/g, ' ')}
                          </p>
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {formatPKR(o.totalOrderValue)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDate(o.createdAt)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
                            {canManage && (
                              <>
                                <Button
                                  size="sm"
                                  onClick={() => confirmMutation.mutate(o.id)}
                                  disabled={confirmMutation.isPending}
                                >
                                  {confirmMutation.isPending &&
                                  confirmMutation.variables === o.id ? (
                                    <>
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Confirming…
                                    </>
                                  ) : (
                                    <>
                                      <CheckCircle2 className="h-3.5 w-3.5" /> Confirm
                                    </>
                                  )}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setConvertTarget(o)}
                                >
                                  <CreditCard className="h-3.5 w-3.5" /> Convert
                                </Button>
                              </>
                            )}
                            {canCancel && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                                onClick={() => setCancelTarget(o)}
                              >
                                <XCircle className="h-3.5 w-3.5" /> Cancel
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground p-3">
              Showing {orders.length} pending order{orders.length === 1 ? '' : 's'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Convert payment dialog */}
      {convertTarget && (
        <ConvertPaymentDialog
          order={convertTarget}
          open={!!convertTarget}
          onOpenChange={(open) => {
            if (!open) setConvertTarget(null)
          }}
          onSuccess={() => {
            setConvertTarget(null)
            invalidate()
          }}
        />
      )}

      {/* Cancel dialog */}
      {cancelTarget && (
        <CancelOrderDialog
          order={cancelTarget}
          open={!!cancelTarget}
          onOpenChange={(open) => {
            if (!open) setCancelTarget(null)
          }}
          loading={cancelMutation.isPending}
          onConfirm={(reason) =>
            cancelMutation.mutate({ id: cancelTarget.id, reason })
          }
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Stat card
// ─────────────────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string
  value: string
  hint?: string
  icon: React.ReactNode
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
          <span className="text-muted-foreground">{icon}</span>
        </div>
        <p className="text-xl font-semibold tabular-nums mt-1">{value}</p>
        {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Convert payment dialog
// ─────────────────────────────────────────────────────────────────────────────

function ConvertPaymentDialog({
  order,
  open,
  onOpenChange,
  onSuccess,
}: {
  order: PendingOrderRow
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}) {
  const queryClient = useQueryClient()
  const [newType, setNewType] = useState<'partial_advance' | 'fully_prepaid'>('partial_advance')
  const [advanceAmount, setAdvanceAmount] = useState('')
  const [method, setMethod] = useState('')
  const [reference, setReference] = useState('')

  const mutation = useMutation({
    mutationFn: async () =>
      api.post(`/api/orders/${order.id}/convert-payment`, {
        new_payment_type: newType,
        advance_amount: newType === 'partial_advance' ? Number(advanceAmount) || 0 : undefined,
        advance_payment_method: method || undefined,
        advance_payment_reference: reference || undefined,
      }),
    onSuccess: () => {
      toast.success('Payment converted. Order confirmed.')
      void queryClient.invalidateQueries({ queryKey: ['orders-pending'] })
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
      onSuccess()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Convert payment — {order.flowopsOrderNumber}</DialogTitle>
          <DialogDescription>
            Mark this COD order as partially paid or fully prepaid. Payment acts as a confirmation
            signal — the order will be confirmed automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>New payment type</Label>
            <Select
              value={newType}
              onValueChange={(v) => setNewType(v as 'partial_advance' | 'fully_prepaid')}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="partial_advance">Partial Advance</SelectItem>
                <SelectItem value="fully_prepaid">Fully Prepaid</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {newType === 'partial_advance' && (
            <div className="space-y-1.5">
              <Label htmlFor="advance-amount">Advance amount (Rs.)</Label>
              <Input
                id="advance-amount"
                type="number"
                placeholder="e.g. 1000"
                value={advanceAmount}
                onChange={(e) => setAdvanceAmount(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Order total: {formatPKR(order.totalOrderValue)}
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="method">Payment method</Label>
            <Input
              id="method"
              placeholder="e.g. bank_transfer, jazzcash"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reference">Reference / transaction ID</Label>
            <Input
              id="reference"
              placeholder="Optional"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={mutation.isPending || (newType === 'partial_advance' && !advanceAmount)}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Converting…
              </>
            ) : (
              'Convert payment'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancel dialog
// ─────────────────────────────────────────────────────────────────────────────

function CancelOrderDialog({
  order,
  open,
  onOpenChange,
  loading,
  onConfirm,
}: {
  order: PendingOrderRow
  open: boolean
  onOpenChange: (open: boolean) => void
  loading: boolean
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState('')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel order — {order.flowopsOrderNumber}?</DialogTitle>
          <DialogDescription>
            The order will be marked as cancelled and any reserved stock will be released. This
            cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="cancel-reason">Cancellation reason</Label>
          <Input
            id="cancel-reason"
            placeholder="e.g. Customer requested cancellation"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
          {reason.length > 0 && reason.length < 3 && (
            <p className="text-xs text-rose-600">Reason must be at least 3 characters.</p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Keep order
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={loading || reason.trim().length < 3}
            onClick={() => onConfirm(reason.trim())}
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Cancelling…
              </>
            ) : (
              <>
                <XCircle className="h-4 w-4" /> Cancel order
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
