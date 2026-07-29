'use client'

import { useState } from 'react'
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
  Truck,
  UserCheck,
  Package,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Banknote,
  Loader2,
  ExternalLink,
  Camera,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatPKR, formatDateTime, getErrorMessage, badgeForStatus } from './_shared'
import { VerifyOldItemDialog } from './verify-old-item-dialog'

interface ExchangeDetail {
  id: string
  exchangeMethod: 'courier_replacement' | 'customer_self_return'
  status: string
  reason: string
  oldItemPrice: number
  newItemPrice: number
  priceDifference: number
  priceDifferenceStatus: string
  priceDifferenceSettledAmount: number | null
  priceDifferenceSettledAt: string | null
  requestedAt: string
  completedAt: string | null
  cancelledAt: string | null
  cancellationReason: string | null
  oldItemCondition: string | null
  oldItemVerifiedAt: string | null
  oldItemNotes: string | null
  oldItemEvidenceUrls: string
  customerReturnTrackingNumber: string | null
  customerReturnCourier: string | null
  customerConfirmedShippedAt: string | null
  markedAsNotReturned: boolean
  notReturnedReason: string | null
  notReturnedRecoveryStatus: string | null
  notReturnedRecoveryAmount: number | null
  originalOrder: {
    id: string
    flowopsOrderNumber: string
    status: string
    customer: { id: string; name: string; phones: Array<{ phoneRaw: string }> }
  }
  originalOrderItem: {
    id: string
    quantity: number
    unitPrice: number
    fulfillmentTypeSnapshot: string
    orgVariant: { sku: string; product: { title: string } }
  }
  newOrgVariant: {
    id: string
    sku: string
    fulfillmentType: string
    product: { title: string }
  }
  newOrder: {
    id: string
    flowopsOrderNumber: string
    status: string
    dispatchedAt: string | null
    deliveredAt: string | null
  } | null
  newOrderItem: { id: string; fulfillmentStatus: string } | null
  requestedByEmployee: { id: string; user: { fullName: string } }
  oldItemVerifiedByEmployee: { id: string; user: { fullName: string } } | null
}

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

export function ExchangeDetailView({ exchangeId }: { exchangeId: string }) {
  const navigate = useAppStore((s) => s.navigate)
  const queryClient = useQueryClient()

  const [verifyOpen, setVerifyOpen] = useState(false)
  const [settleOpen, setSettleOpen] = useState(false)
  const [notReturnedOpen, setNotReturnedOpen] = useState(false)

  const query = useQuery<ExchangeDetail>({
    queryKey: ['exchange', exchangeId],
    queryFn: () => api.get<ExchangeDetail>(`/api/exchanges/${exchangeId}`),
    staleTime: 10_000,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['exchanges'] })
    queryClient.invalidateQueries({ queryKey: ['exchange', exchangeId] })
    queryClient.invalidateQueries({ queryKey: ['inventory-pools'] })
  }

  const settleMutation = useMutation({
    mutationFn: (data: { amount: number; type: string }) =>
      api.post(`/api/exchanges/${exchangeId}/settle-price-difference`, {
        settled_amount: data.amount,
        settlement_type: data.type,
      }),
    onSuccess: () => { toast.success('Price difference settled.'); setSettleOpen(false); invalidate() },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const notReturnedMutation = useMutation({
    mutationFn: (data: { reason: string; recoveryStatus: string; recoveryAmount: number }) =>
      api.post(`/api/exchanges/${exchangeId}/mark-not-returned`, {
        not_returned_reason: data.reason,
        recovery_status: data.recoveryStatus,
        recovery_amount: data.recoveryAmount || undefined,
      }),
    onSuccess: () => { toast.success('Marked as not returned.'); setNotReturnedOpen(false); invalidate() },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  if (query.isError || !query.data) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate({ name: 'exchanges' })}>
          <ArrowLeft className="h-4 w-4" /> Back to Exchanges
        </Button>
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground">{query.isError ? getErrorMessage(query.error) : 'Exchange not found'}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const e = query.data
  const statusBadge = STATUS_BADGE[e.status] ?? { label: e.status, className: 'bg-gray-100 text-gray-700 border-gray-200' }
  const methodBadge = METHOD_BADGE[e.exchangeMethod]
  const MethodIcon = methodBadge.icon
  const isTerminal = ['completed', 'customer_did_not_return', 'cancelled'].includes(e.status)
  const needsSettlement = e.priceDifferenceStatus === 'customer_owes' || e.priceDifferenceStatus === 'refund_due'

  // Parse evidence URLs
  let evidenceUrls: string[] = []
  try { evidenceUrls = JSON.parse(e.oldItemEvidenceUrls || '[]') } catch { /* ignore */ }

  // Timeline events
  const timeline: Array<{ label: string; time: string | null; icon: typeof Clock }> = [
    { label: 'Exchange Requested', time: e.requestedAt, icon: RefreshCw },
    { label: 'Customer Confirmed Shipped', time: e.customerConfirmedShippedAt, icon: UserCheck },
    { label: 'Old Item Verified', time: e.oldItemVerifiedAt, icon: Package },
    { label: 'Completed', time: e.completedAt, icon: CheckCircle2 },
  ].filter((t) => t.time !== null || t.label === 'Exchange Requested')

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Exchange ${e.originalOrder.flowopsOrderNumber}`}
        description={`${methodBadge.label} · ${statusBadge.label}`}
        actions={
          <Button variant="ghost" size="sm" onClick={() => navigate({ name: 'exchanges' })}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Items */}
          <Card>
            <CardHeader><CardTitle className="text-base">Items</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {/* Old item */}
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Old Item (being exchanged)</p>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{e.originalOrderItem.orgVariant.product.title}</p>
                    <p className="text-xs text-muted-foreground font-mono">{e.originalOrderItem.orgVariant.sku}</p>
                    <Badge variant="outline" className="text-[10px] mt-1 bg-sky-50 text-sky-700 border-sky-200">
                      {e.originalOrderItem.fulfillmentTypeSnapshot === 'made_to_order' ? 'MTO' : 'Stock'}
                    </Badge>
                  </div>
                  <p className="text-sm font-medium tabular-nums">{formatPKR(e.oldItemPrice)}</p>
                </div>
              </div>
              {/* Arrow */}
              <div className="flex items-center justify-center">
                <RefreshCw className="h-5 w-5 text-muted-foreground" />
              </div>
              {/* New item */}
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">New Item (replacement)</p>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{e.newOrgVariant.product.title}</p>
                    <p className="text-xs text-muted-foreground font-mono">{e.newOrgVariant.sku}</p>
                    <Badge variant="outline" className="text-[10px] mt-1 bg-sky-50 text-sky-700 border-sky-200">
                      {e.newOrgVariant.fulfillmentType === 'made_to_order' ? 'MTO' : 'Stock'}
                    </Badge>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium tabular-nums">{formatPKR(e.newItemPrice)}</p>
                    {e.newOrder && (
                      <button
                        onClick={() => navigate({ name: 'order-detail', id: e.newOrder!.id })}
                        className="text-[10px] text-primary hover:underline flex items-center gap-0.5 mt-1"
                      >
                        {e.newOrder.flowopsOrderNumber} <ExternalLink className="h-2.5 w-2.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Verification details */}
          {e.oldItemVerifiedAt && (
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><Package className="h-4 w-4" /> Old Item Verification</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="grid sm:grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Condition</p>
                    <Badge variant="outline" className={cn(
                      'mt-1',
                      e.oldItemCondition === 'damaged' ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200',
                    )}>
                      {e.oldItemCondition}
                    </Badge>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Verified By</p>
                    <p className="text-sm font-medium">{e.oldItemVerifiedByEmployee?.user.fullName ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Verified At</p>
                    <p className="text-sm">{formatDateTime(e.oldItemVerifiedAt)}</p>
                  </div>
                </div>
                {e.oldItemNotes && (
                  <div>
                    <p className="text-xs text-muted-foreground">Notes</p>
                    <p className="text-sm mt-0.5">{e.oldItemNotes}</p>
                  </div>
                )}
                {evidenceUrls.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground flex items-center gap-1"><Camera className="h-3 w-3" /> Evidence Photos</p>
                    <div className="flex flex-wrap gap-2 mt-1">
                      {evidenceUrls.map((url, i) => (
                        <img key={i} src={url} alt={`Evidence ${i + 1}`} className="h-16 w-16 rounded object-cover border" />
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Timeline */}
          <Card>
            <CardHeader><CardTitle className="text-base">Timeline</CardTitle></CardHeader>
            <CardContent>
              <ol className="space-y-3">
                {timeline.map((t, i) => {
                  const Icon = t.icon
                  return (
                    <li key={i} className="flex items-start gap-2.5">
                      <div className={cn(
                        'flex h-6 w-6 items-center justify-center rounded-full shrink-0',
                        t.time ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                      )}>
                        <Icon className="h-3 w-3" />
                      </div>
                      <div>
                        <p className={cn('text-sm', t.time ? 'font-medium' : 'text-muted-foreground')}>{t.label}</p>
                        {t.time && <p className="text-xs text-muted-foreground">{formatDateTime(t.time)}</p>}
                      </div>
                    </li>
                  )
                })}
              </ol>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar column */}
        <div className="space-y-6">
          {/* Price difference */}
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><Banknote className="h-4 w-4" /> Price Difference</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Old item</span>
                <span className="tabular-nums">{formatPKR(e.oldItemPrice)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">New item</span>
                <span className="tabular-nums">{formatPKR(e.newItemPrice)}</span>
              </div>
              <Separator className="my-2" />
              <div className="flex justify-between font-medium">
                <span>Difference</span>
                <span className={cn(
                  'tabular-nums',
                  e.priceDifference > 0 ? 'text-amber-700' : e.priceDifference < 0 ? 'text-sky-700' : 'text-muted-foreground',
                )}>
                  {e.priceDifference > 0 ? '+' : ''}{formatPKR(e.priceDifference)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <Badge variant="outline" className={cn(
                  'text-[10px]',
                  e.priceDifferenceStatus === 'settled' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200',
                )}>
                  {e.priceDifferenceStatus.replace(/_/g, ' ')}
                </Badge>
              </div>
              {e.priceDifferenceSettledAmount !== null && (
                <p className="text-xs text-muted-foreground pt-1">
                  Settled: {formatPKR(e.priceDifferenceSettledAmount)} on {formatDateTime(e.priceDifferenceSettledAt)}
                </p>
              )}
              {needsSettlement && (
                <Button size="sm" className="w-full mt-2" onClick={() => setSettleOpen(true)}>
                  <Banknote className="h-3.5 w-3.5" /> Settle Payment
                </Button>
              )}
            </CardContent>
          </Card>

          {/* Customer self-return tracking */}
          {e.exchangeMethod === 'customer_self_return' && (
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><UserCheck className="h-4 w-4" /> Customer Return Tracking</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tracking #</span>
                  <span className="font-mono text-xs">{e.customerReturnTrackingNumber ?? '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Courier</span>
                  <span>{e.customerReturnCourier ?? '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Confirmed Shipped</span>
                  <span>{e.customerConfirmedShippedAt ? formatDateTime(e.customerConfirmedShippedAt) : '—'}</span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Not returned info */}
          {e.markedAsNotReturned && (
            <Card className="border-rose-200">
              <CardHeader><CardTitle className="text-base flex items-center gap-2 text-rose-700"><XCircle className="h-4 w-4" /> Not Returned</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p><span className="text-muted-foreground">Reason:</span> {e.notReturnedReason}</p>
                <p><span className="text-muted-foreground">Recovery:</span> {e.notReturnedRecoveryStatus}</p>
                {e.notReturnedRecoveryAmount !== null && (
                  <p><span className="text-muted-foreground">Amount:</span> {formatPKR(e.notReturnedRecoveryAmount)}</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Actions */}
          <Card>
            <CardHeader><CardTitle className="text-base">Actions</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {e.status === 'awaiting_customer_to_ship_old_item' && (
                <Button className="w-full" variant="outline" onClick={() => navigate({ name: 'exchanges' })}>
                  <UserCheck className="h-3.5 w-3.5" /> Confirm Customer Shipped (from list)
                </Button>
              )}
              {(e.status === 'customer_confirmed_shipped' || e.status === 'awaiting_old_item_return') && (
                <Button className="w-full" onClick={() => setVerifyOpen(true)}>
                  <Package className="h-3.5 w-3.5" /> Verify Old Item Received
                </Button>
              )}
              {!isTerminal && (
                <Button
                  className="w-full"
                  variant="outline"
                  onClick={() => setNotReturnedOpen(true)}
                >
                  <XCircle className="h-3.5 w-3.5" /> Mark as Not Returned
                </Button>
              )}
              {e.status === 'requested' && e.exchangeMethod === 'courier_replacement' && (
                <Button className="w-full" variant="outline" onClick={() => navigate({ name: 'exchanges' })}>
                  <Truck className="h-3.5 w-3.5" /> Dispatch New Item (from list)
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Dialogs */}
      {verifyOpen && (
        <VerifyOldItemDialog
          open={verifyOpen}
          onOpenChange={setVerifyOpen}
          exchangeId={exchangeId}
          exchangeMethod={e.exchangeMethod}
          onVerified={() => invalidate()}
        />
      )}
      {settleOpen && (
        <SettleDialog
          exchange={e}
          open={settleOpen}
          onOpenChange={setSettleOpen}
          loading={settleMutation.isPending}
          onConfirm={(amount, type) => settleMutation.mutate({ amount, type })}
        />
      )}
      {notReturnedOpen && (
        <NotReturnedDialog
          exchange={e}
          open={notReturnedOpen}
          onOpenChange={setNotReturnedOpen}
          loading={notReturnedMutation.isPending}
          onConfirm={(reason, recoveryStatus, recoveryAmount) =>
            notReturnedMutation.mutate({ reason, recoveryStatus, recoveryAmount })
          }
        />
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Settle dialog
// ──────────────────────────────────────────────────────────────

function SettleDialog({
  exchange,
  open,
  onOpenChange,
  loading,
  onConfirm,
}: {
  exchange: ExchangeDetail
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
          <DialogTitle>Settle Price Difference</DialogTitle>
          <DialogDescription>
            {isCustomerOwes
              ? `Customer owes Rs. ${Math.abs(exchange.priceDifference).toLocaleString('en-PK')}.`
              : `Rs. ${Math.abs(exchange.priceDifference).toLocaleString('en-PK')} due as refund.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Amount (Rs.)</Label>
            <Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Type</Label>
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

// ──────────────────────────────────────────────────────────────
// Not Returned dialog
// ──────────────────────────────────────────────────────────────

function NotReturnedDialog({
  exchange,
  open,
  onOpenChange,
  loading,
  onConfirm,
}: {
  exchange: ExchangeDetail
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
            Terminal outcome. Customer will be flagged with &quot;Exchange item not returned&quot;.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Reason *</Label>
            <Textarea placeholder="e.g. Customer never shipped the item back" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Recovery Status</Label>
            <Select value={recoveryStatus} onValueChange={setRecoveryStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="recovered">Recovered</SelectItem>
                <SelectItem value="written_off">Written Off</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Recovery Amount (Rs.)</Label>
            <Input type="number" min="0" value={recoveryAmount} onChange={(e) => setRecoveryAmount(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" disabled={loading || reason.trim().length < 3} onClick={() => onConfirm(reason.trim(), recoveryStatus, Number(recoveryAmount) || 0)}>
            {loading ? <><Loader2 className="h-4 w-4 animate-spin" /> Marking…</> : 'Mark as Not Returned'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
