'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, FetchError } from '@/lib/api-client'
import { useAppStore } from '@/stores/app-store'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  RefreshCw,
  Truck,
  UserCheck,
  Package,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Banknote,
  Loader2,
  Eye,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatPKR, formatDate, getErrorMessage } from './_shared'
import { VerifyOldItemDialog } from './verify-old-item-dialog'

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface ExchangeRow {
  id: string
  exchangeMethod: 'courier_replacement' | 'customer_self_return'
  status: string
  reason: string
  oldItemPrice: number
  newItemPrice: number
  priceDifference: number
  priceDifferenceStatus: string
  requestedAt: string
  completedAt: string | null
  originalOrderId: string
  originalOrder: { flowopsOrderNumber: string }
  newOrderId: string | null
  newOrder: { flowopsOrderNumber: string } | null
}

interface ExchangesResponse {
  exchanges: ExchangeRow[]
  total: number
}

interface OverdueResponse {
  exchanges: Array<{ id: string; daysWaiting: number }>
}

// ──────────────────────────────────────────────────────────────
// Status + method badges
// ──────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  requested: { label: 'Requested', className: 'bg-gray-100 text-gray-700 border-gray-200' },
  new_item_dispatched: { label: 'New Item Dispatched', className: 'bg-violet-50 text-violet-700 border-violet-200' },
  awaiting_old_item_return: { label: 'Awaiting Old Item', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  awaiting_customer_to_ship_old_item: { label: 'Awaiting Customer Ship', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  customer_confirmed_shipped: { label: 'Customer Shipped', className: 'bg-sky-50 text-sky-700 border-sky-200' },
  old_item_manually_verified: { label: 'Old Item Verified', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  completed: { label: 'Completed', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  customer_did_not_return: { label: 'Not Returned', className: 'bg-rose-50 text-rose-700 border-rose-200' },
  cancelled: { label: 'Cancelled', className: 'bg-slate-100 text-slate-500 border-slate-200' },
}

const METHOD_BADGE: Record<string, { label: string; className: string; icon: typeof Truck }> = {
  courier_replacement: { label: 'Courier Replacement', className: 'bg-violet-50 text-violet-700 border-violet-200', icon: Truck },
  customer_self_return: { label: 'Customer Self-Return', className: 'bg-sky-50 text-sky-700 border-sky-200', icon: UserCheck },
}

// ──────────────────────────────────────────────────────────────
// Main view
// ──────────────────────────────────────────────────────────────

export function ExchangesView() {
  const navigate = useAppStore((s) => s.navigate)
  const queryClient = useQueryClient()

  const [statusFilter, setStatusFilter] = useState<string>('')
  const [methodFilter, setMethodFilter] = useState<string>('')

  // Verify dialog state
  const [verifyTarget, setVerifyTarget] = useState<ExchangeRow | null>(null)
  // Confirm shipped dialog
  const [confirmShippedTarget, setConfirmShippedTarget] = useState<ExchangeRow | null>(null)
  // Mark not returned dialog
  const [notReturnedTarget, setNotReturnedTarget] = useState<ExchangeRow | null>(null)
  // Settle payment dialog
  const [settleTarget, setSettleTarget] = useState<ExchangeRow | null>(null)

  const query = useQuery<ExchangesResponse>({
    queryKey: ['exchanges', statusFilter, methodFilter],
    queryFn: () => {
      const params = new URLSearchParams()
      if (statusFilter) params.set('status', statusFilter)
      if (methodFilter) params.set('exchange_method', methodFilter)
      const qs = params.toString()
      return api.get<ExchangesResponse>(`/api/exchanges${qs ? `?${qs}` : ''}`)
    },
    staleTime: 15_000,
  })

  const overdueQuery = useQuery<OverdueResponse>({
    queryKey: ['exchanges-overdue'],
    queryFn: () => api.get<OverdueResponse>('/api/exchanges/overdue?days_threshold=7'),
    staleTime: 60_000,
  })

  const exchanges = query.data?.exchanges ?? []
  const overdueIds = useMemo(() => new Set(overdueQuery.data?.exchanges.map((e) => e.id) ?? []), [overdueQuery.data])

  // Stats
  const activeCount = exchanges.filter((e) => !['completed', 'customer_did_not_return', 'cancelled'].includes(e.status)).length
  const awaitingVerification = exchanges.filter((e) =>
    ['awaiting_old_item_return', 'customer_confirmed_shipped', 'awaiting_customer_to_ship_old_item'].includes(e.status),
  )
  const overdueCount = awaitingVerification.filter((e) => overdueIds.has(e.id)).length
  const now = new Date()
  const completedThisMonth = exchanges.filter((e) => {
    if (e.status !== 'completed' || !e.completedAt) return false
    const d = new Date(e.completedAt)
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
  }).length
  const notReturned = exchanges.filter((e) => e.status === 'customer_did_not_return')
  const notReturnedValue = notReturned.reduce((s, e) => s + e.oldItemPrice, 0)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['exchanges'] })
    queryClient.invalidateQueries({ queryKey: ['exchanges-overdue'] })
    queryClient.invalidateQueries({ queryKey: ['inventory-pools'] })
  }

  // Mutations
  const confirmShippedMutation = useMutation({
    mutationFn: (data: { id: string; tracking: string; courier: string }) =>
      api.post(`/api/exchanges/${data.id}/confirm-shipped`, {
        customer_return_tracking_number: data.tracking || undefined,
        customer_return_courier: data.courier || undefined,
      }),
    onSuccess: () => {
      toast.success('Customer shipment confirmed.')
      setConfirmShippedTarget(null)
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const notReturnedMutation = useMutation({
    mutationFn: (data: { id: string; reason: string; recoveryStatus: string; recoveryAmount: number }) =>
      api.post(`/api/exchanges/${data.id}/mark-not-returned`, {
        not_returned_reason: data.reason,
        recovery_status: data.recoveryStatus,
        recovery_amount: data.recoveryAmount || undefined,
      }),
    onSuccess: () => {
      toast.success('Marked as not returned. Customer flagged for follow-up.')
      setNotReturnedTarget(null)
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const settleMutation = useMutation({
    mutationFn: (data: { id: string; amount: number; type: string }) =>
      api.post(`/api/exchanges/${data.id}/settle-price-difference`, {
        settled_amount: data.amount,
        settlement_type: data.type,
      }),
    onSuccess: () => {
      toast.success('Price difference settled.')
      setSettleTarget(null)
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Exchanges"
        description="Manage item exchanges — courier replacement and customer self-return flows."
        actions={
          <Button variant="outline" size="sm" onClick={() => query.refetch()} disabled={query.isFetching}>
            <RefreshCw className={query.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            Refresh
          </Button>
        }
      />

      {/* Stats cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Active Exchanges</p>
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1">{activeCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Awaiting Verification</p>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1">{awaitingVerification.length}</p>
            {overdueCount > 0 && (
              <p className="text-xs text-rose-600 font-medium mt-0.5">{overdueCount} overdue (7+ days)</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Completed This Month</p>
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1">{completedThisMonth}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Not Returned (loss)</p>
              <AlertTriangle className="h-4 w-4 text-rose-600" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1 text-rose-700">{notReturned.length}</p>
            {notReturnedValue > 0 && (
              <p className="text-xs text-muted-foreground mt-0.5">{formatPKR(notReturnedValue)}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v === 'all' ? '' : v)}>
          <SelectTrigger className="sm:w-52">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="requested">Requested</SelectItem>
            <SelectItem value="awaiting_customer_to_ship_old_item">Awaiting Customer Ship</SelectItem>
            <SelectItem value="customer_confirmed_shipped">Customer Shipped</SelectItem>
            <SelectItem value="awaiting_old_item_return">Awaiting Old Item</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="customer_did_not_return">Not Returned</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <Select value={methodFilter} onValueChange={(v) => setMethodFilter(v === 'all' ? '' : v)}>
          <SelectTrigger className="sm:w-48">
            <SelectValue placeholder="All methods" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All methods</SelectItem>
            <SelectItem value="courier_replacement">Courier Replacement</SelectItem>
            <SelectItem value="customer_self_return">Customer Self-Return</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      {query.isLoading ? (
        <Card>
          <CardContent className="p-3 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
          </CardContent>
        </Card>
      ) : query.isError ? (
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">Couldn&apos;t load exchanges. {getErrorMessage(query.error)}</p>
            <Button variant="outline" onClick={() => query.refetch()}>Try again</Button>
          </CardContent>
        </Card>
      ) : exchanges.length === 0 ? (
        <Card>
          <CardContent className="p-10 sm:p-14 text-center">
            <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <RefreshCw className="h-7 w-7 text-primary" />
            </div>
            <h3 className="text-lg font-semibold">No exchanges yet</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
              Exchanges are created from delivered order detail pages. Click an order item&apos;s [Request Exchange] button to start one.
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
                    <TableHead>Original Order</TableHead>
                    <TableHead>Items</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Price Diff</TableHead>
                    <TableHead>Age</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {exchanges.map((e) => {
                    const statusBadge = STATUS_BADGE[e.status] ?? { label: e.status, className: 'bg-gray-100 text-gray-700 border-gray-200' }
                    const methodBadge = METHOD_BADGE[e.exchangeMethod]
                    const MethodIcon = methodBadge.icon
                    const isOverdue = overdueIds.has(e.id)
                    const daysSince = Math.floor((Date.now() - new Date(e.requestedAt).getTime()) / 86400000)
                    const isTerminal = ['completed', 'customer_did_not_return', 'cancelled'].includes(e.status)
                    const needsSettlement = e.priceDifferenceStatus === 'customer_owes' || e.priceDifferenceStatus === 'refund_due'

                    return (
                      <TableRow
                        key={e.id}
                        className="cursor-pointer hover:bg-muted/40"
                        onClick={() => navigate({ name: 'exchange-detail', id: e.id })}
                      >
                        <TableCell>
                          <p className="text-sm font-medium font-mono">{e.originalOrder.flowopsOrderNumber}</p>
                          <p className="text-xs text-muted-foreground">{formatDate(e.requestedAt)}</p>
                        </TableCell>
                        <TableCell>
                          <div className="text-xs space-y-0.5">
                            <p className="text-muted-foreground">Old: Rs. {e.oldItemPrice.toLocaleString('en-PK')}</p>
                            <p className="font-medium">New: Rs. {e.newItemPrice.toLocaleString('en-PK')}</p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn('text-[10px]', methodBadge.className)}>
                            <MethodIcon className="h-2.5 w-2.5 mr-0.5" /> {methodBadge.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn('text-[10px]', statusBadge.className)}>
                            {statusBadge.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs">
                          {e.priceDifference > 0 ? (
                            <span className="text-amber-700">+{formatPKR(e.priceDifference)}</span>
                          ) : e.priceDifference < 0 ? (
                            <span className="text-sky-700">−{formatPKR(Math.abs(e.priceDifference))}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                          {needsSettlement && (
                            <Badge variant="outline" className="ml-1 text-[9px] bg-amber-50 text-amber-700 border-amber-200">
                              {e.priceDifferenceStatus === 'customer_owes' ? 'owes' : 'due'}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className={cn('text-xs tabular-nums', isOverdue ? 'text-rose-600 font-medium' : 'text-muted-foreground')}>
                            {daysSince}d
                          </span>
                          {isOverdue && <AlertTriangle className="inline ml-1 h-3 w-3 text-rose-600" />}
                        </TableCell>
                        <TableCell className="text-right" onClick={(ev) => ev.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1 flex-wrap">
                            {/* Context-aware row actions */}
                            {e.status === 'awaiting_customer_to_ship_old_item' && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                                onClick={() => setConfirmShippedTarget(e)}
                              >
                                <UserCheck className="h-3 w-3" /> Confirm Shipped
                              </Button>
                            )}
                            {(e.status === 'customer_confirmed_shipped' || e.status === 'awaiting_old_item_return') && (
                              <Button
                                size="sm"
                                variant="default"
                                className="h-7 text-xs"
                                onClick={() => setVerifyTarget(e)}
                              >
                                <Package className="h-3 w-3" /> Verify Old Item
                              </Button>
                            )}
                            {needsSettlement && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                                onClick={() => setSettleTarget(e)}
                              >
                                <Banknote className="h-3 w-3" /> Settle
                              </Button>
                            )}
                            {!isTerminal && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                                onClick={() => setNotReturnedTarget(e)}
                              >
                                <XCircle className="h-3 w-3" /> Not Returned
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7"
                              onClick={() => navigate({ name: 'exchange-detail', id: e.id })}
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground p-3">{exchanges.length} exchange{exchanges.length === 1 ? '' : 's'}</p>
          </CardContent>
        </Card>
      )}

      {/* Verify dialog */}
      {verifyTarget && (
        <VerifyOldItemDialog
          open={!!verifyTarget}
          onOpenChange={(v) => !v && setVerifyTarget(null)}
          exchangeId={verifyTarget.id}
          exchangeMethod={verifyTarget.exchangeMethod}
          onVerified={() => invalidate()}
        />
      )}

      {/* Confirm shipped dialog */}
      {confirmShippedTarget && (
        <ConfirmShippedDialog
          exchange={confirmShippedTarget}
          open={!!confirmShippedTarget}
          onOpenChange={(v) => !v && setConfirmShippedTarget(null)}
          loading={confirmShippedMutation.isPending}
          onConfirm={(tracking, courier) =>
            confirmShippedMutation.mutate({ id: confirmShippedTarget.id, tracking, courier })
          }
        />
      )}

      {/* Mark not returned dialog */}
      {notReturnedTarget && (
        <NotReturnedDialog
          exchange={notReturnedTarget}
          open={!!notReturnedTarget}
          onOpenChange={(v) => !v && setNotReturnedTarget(null)}
          loading={notReturnedMutation.isPending}
          onConfirm={(reason, recoveryStatus, recoveryAmount) =>
            notReturnedMutation.mutate({
              id: notReturnedTarget.id,
              reason,
              recoveryStatus,
              recoveryAmount,
            })
          }
        />
      )}

      {/* Settle payment dialog */}
      {settleTarget && (
        <SettlePaymentDialog
          exchange={settleTarget}
          open={!!settleTarget}
          onOpenChange={(v) => !v && setSettleTarget(null)}
          loading={settleMutation.isPending}
          onConfirm={(amount, type) =>
            settleMutation.mutate({ id: settleTarget.id, amount, type })
          }
        />
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Confirm Shipped dialog
// ──────────────────────────────────────────────────────────────

function ConfirmShippedDialog({
  exchange,
  open,
  onOpenChange,
  loading,
  onConfirm,
}: {
  exchange: ExchangeRow
  open: boolean
  onOpenChange: (open: boolean) => void
  loading: boolean
  onConfirm: (tracking: string, courier: string) => void
}) {
  const [tracking, setTracking] = useState('')
  const [courier, setCourier] = useState('')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Confirm Customer Shipped Old Item</DialogTitle>
          <DialogDescription>
            Mark that the customer has confirmed they shipped the old item back. This does NOT dispatch the new item — that happens only after you verify the old item is received.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Customer&apos;s Tracking Number (optional)</Label>
            <Input
              placeholder="e.g. LEOPARD-12345"
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Courier (optional)</Label>
            <Input
              placeholder="e.g. Leopard, TCS"
              value={courier}
              onChange={(e) => setCourier(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={loading} onClick={() => onConfirm(tracking, courier)}>
            {loading ? <><Loader2 className="h-4 w-4 animate-spin" /> Confirming…</> : 'Confirm Shipped'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ──────────────────────────────────────────────────────────────
// Mark Not Returned dialog
// ──────────────────────────────────────────────────────────────

function NotReturnedDialog({
  exchange,
  open,
  onOpenChange,
  loading,
  onConfirm,
}: {
  exchange: ExchangeRow
  open: boolean
  onOpenChange: (open: boolean) => void
  loading: boolean
  onConfirm: (reason: string, recoveryStatus: string, recoveryAmount: number) => void
}) {
  const [reason, setReason] = useState('')
  const [recoveryStatus, setRecoveryStatus] = useState('pending')
  const [recoveryAmount, setRecoveryAmount] = useState(exchange.oldItemPrice.toString())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-rose-700">
            <XCircle className="h-4 w-4" /> Mark as Not Returned
          </DialogTitle>
          <DialogDescription>
            This is a terminal outcome. The customer will be flagged with reason &quot;Exchange item not returned&quot; and the old item&apos;s value becomes a recoverable amount.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Reason *</Label>
            <Textarea
              placeholder="e.g. Customer never shipped the item back after 2 weeks of follow-up"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Recovery Status</Label>
            <Select value={recoveryStatus} onValueChange={setRecoveryStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Pending (follow up later)</SelectItem>
                <SelectItem value="recovered">Recovered (collected)</SelectItem>
                <SelectItem value="written_off">Written Off (loss accepted)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Recovery Amount (Rs.)</Label>
            <Input
              type="number"
              min="0"
              value={recoveryAmount}
              onChange={(e) => setRecoveryAmount(e.target.value)}
            />
            <p className="text-[10px] text-muted-foreground">Defaults to the old item&apos;s value: Rs. {exchange.oldItemPrice.toLocaleString('en-PK')}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={loading || reason.trim().length < 3}
            onClick={() => onConfirm(reason.trim(), recoveryStatus, Number(recoveryAmount) || 0)}
          >
            {loading ? <><Loader2 className="h-4 w-4 animate-spin" /> Marking…</> : 'Mark as Not Returned'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ──────────────────────────────────────────────────────────────
// Settle Payment dialog
// ──────────────────────────────────────────────────────────────

function SettlePaymentDialog({
  exchange,
  open,
  onOpenChange,
  loading,
  onConfirm,
}: {
  exchange: ExchangeRow
  open: boolean
  onOpenChange: (open: boolean) => void
  loading: boolean
  onConfirm: (amount: number, type: string) => void
}) {
  const isCustomerOwes = exchange.priceDifference > 0
  const [amount, setAmount] = useState(Math.abs(exchange.priceDifference).toString())
  const [type, setType] = useState(isCustomerOwes ? 'collected_from_customer' : 'refunded_to_customer')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Banknote className="h-4 w-4" /> Settle Price Difference
          </DialogTitle>
          <DialogDescription>
            {isCustomerOwes
              ? `Customer owes Rs. ${Math.abs(exchange.priceDifference).toLocaleString('en-PK')} for the price difference.`
              : `Rs. ${Math.abs(exchange.priceDifference).toLocaleString('en-PK')} is due as a refund to the customer.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Amount (Rs.)</Label>
            <Input
              type="number"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Settlement Type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="collected_from_customer">Collected from customer</SelectItem>
                <SelectItem value="refunded_to_customer">Refunded to customer</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={loading} onClick={() => onConfirm(Number(amount) || 0, type)}>
            {loading ? <><Loader2 className="h-4 w-4 animate-spin" /> Settling…</> : 'Settle Payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
