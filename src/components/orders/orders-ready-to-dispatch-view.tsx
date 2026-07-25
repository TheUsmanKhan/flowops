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
import { Checkbox } from '@/components/ui/checkbox'
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
  Loader2,
  Truck,
  PackageCheck,
  CheckCircle2,
} from 'lucide-react'
import { formatPKR, formatDate, getErrorMessage, badgeForStatus } from './_shared'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ReadyOrderRow {
  id: string
  flowopsOrderNumber: string
  status: string
  paymentType: string
  paymentStatus: string
  totalOrderValue: number
  itemCount: number
  customerName: string
  customerPhone: string
  courierName: string | null
  trackingNumber: string | null
  confirmedAt: string | null
  packedAt: string | null
  dispatchLocationId: string | null
}

interface ReadyResponse {
  orders: ReadyOrderRow[]
  stats: { count: number; totalValue: number }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function OrdersReadyToDispatchView() {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const queryClient = useQueryClient()

  const canFulfill = can(PERMISSIONS.ORDERS_FULFILL)
  const query = useQuery<ReadyResponse>({
    queryKey: ['orders-ready-to-dispatch'],
    queryFn: () => api.get<ReadyResponse>('/api/orders/ready-to-dispatch'),
    staleTime: 15_000,
  })

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dispatchOpen, setDispatchOpen] = useState(false)

  const orders = query.data?.orders ?? []
  const stats = query.data?.stats

  const allSelected = orders.length > 0 && selected.size === orders.length
  const someSelected = selected.size > 0

  const toggleAll = () => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(orders.map((o) => o.id)))
  }

  const toggleOne = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['orders-ready-to-dispatch'] })
    void queryClient.invalidateQueries({ queryKey: ['orders'] })
  }

  // Single-order dispatch (used by per-row Dispatch button)
  const singleMutation = useMutation({
    mutationFn: async ({ id, tracking, courier }: { id: string; tracking: string; courier: string }) =>
      api.post(`/api/orders/${id}/dispatch`, {
        tracking_number: tracking,
        courier_name: courier || undefined,
      }),
    onSuccess: () => {
      toast.success('Order dispatched. Stock deducted.')
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  // Bulk dispatch — calls the single dispatch endpoint for each selected order
  // sequentially (server-side transaction per order). Reports per-order failures.
  const bulkMutation = useMutation({
    mutationFn: async ({
      ids,
      tracking,
      courier,
    }: {
      ids: string[]
      tracking: string
      courier: string
    }) => {
      const results: Array<{ id: string; ok: boolean; error?: string }> = []
      for (const id of ids) {
        try {
          await api.post(`/api/orders/${id}/dispatch`, {
            tracking_number: tracking,
            courier_name: courier || undefined,
          })
          results.push({ id, ok: true })
        } catch (err) {
          results.push({ id, ok: false, error: getErrorMessage(err) })
        }
      }
      return results
    },
    onSuccess: (results) => {
      const ok = results.filter((r) => r.ok).length
      const failed = results.filter((r) => !r.ok).length
      if (failed === 0) {
        toast.success(`${ok} order${ok === 1 ? '' : 's'} dispatched.`)
      } else {
        toast.error(
          `${ok} dispatched, ${failed} failed. ${results.find((r) => !r.ok)?.error ?? ''}`,
        )
      }
      setSelected(new Set())
      setDispatchOpen(false)
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const selectedOrders = useMemo(
    () => orders.filter((o) => selected.has(o.id)),
    [orders, selected],
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ready to Dispatch"
        description="Confirmed orders with all items reserved. Bulk-select and dispatch with shared courier + tracking."
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

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Ready orders</p>
              <PackageCheck className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1">{stats?.count ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Total value</p>
              <Truck className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1">
              {formatPKR(stats?.totalValue ?? 0)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Selected</p>
              <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1">{selected.size}</p>
          </CardContent>
        </Card>
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
              Couldn&apos;t load ready-to-dispatch orders. {getErrorMessage(query.error)}
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
              <Truck className="h-7 w-7 text-emerald-600" />
            </div>
            <h3 className="text-lg font-semibold">No orders ready to dispatch</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
              Confirmed orders with all stock reserved will appear here. Backordered items must be
              fulfilled first.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center justify-between p-3 border-b bg-muted/30">
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <Checkbox
                  checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                  onCheckedChange={(v) => {
                    if (v === true) toggleAll()
                    else setSelected(new Set())
                  }}
                />
                <span className="font-medium">
                  {allSelected ? 'Deselect all' : 'Select all'}
                </span>
              </label>
              {canFulfill && (
                <Button
                  size="sm"
                  disabled={!someSelected}
                  onClick={() => setDispatchOpen(true)}
                >
                  <Truck className="h-3.5 w-3.5" /> Dispatch {selected.size || ''} order
                  {selected.size === 1 ? '' : 's'}
                </Button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-muted-foreground border-b">
                    <th className="w-10 p-2.5" />
                    <th className="text-left font-medium p-2.5">Order</th>
                    <th className="text-left font-medium p-2.5">Customer</th>
                    <th className="text-left font-medium p-2.5">Status</th>
                    <th className="text-right font-medium p-2.5">Value</th>
                    <th className="text-left font-medium p-2.5">Confirmed</th>
                    <th className="text-right font-medium p-2.5">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => {
                    const badge = badgeForStatus(o.status)
                    const isSel = selected.has(o.id)
                    return (
                      <tr
                        key={o.id}
                        className={`border-b last:border-0 ${isSel ? 'bg-primary/5' : ''}`}
                      >
                        <td className="p-2.5">
                          <Checkbox
                            checked={isSel}
                            onCheckedChange={() => toggleOne(o.id)}
                            aria-label={`Select ${o.flowopsOrderNumber}`}
                          />
                        </td>
                        <td className="p-2.5">
                          <button
                            type="button"
                            onClick={() => navigate({ name: 'order-detail', id: o.id })}
                            className="text-left group"
                          >
                            <p className="font-medium text-sm group-hover:text-primary transition-colors">
                              {o.flowopsOrderNumber}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {o.itemCount} item{o.itemCount === 1 ? '' : 's'}
                            </p>
                          </button>
                        </td>
                        <td className="p-2.5">
                          <p className="text-sm">{o.customerName}</p>
                          <p className="text-xs text-muted-foreground">{o.customerPhone}</p>
                        </td>
                        <td className="p-2.5">
                          <Badge variant="outline" className={badge.className}>
                            {badge.label}
                          </Badge>
                          {o.packedAt && (
                            <p className="text-[10px] text-muted-foreground mt-0.5">Packed</p>
                          )}
                        </td>
                        <td className="p-2.5 text-right tabular-nums font-medium">
                          {formatPKR(o.totalOrderValue)}
                        </td>
                        <td className="p-2.5 text-xs text-muted-foreground">
                          {formatDate(o.confirmedAt)}
                        </td>
                        <td className="p-2.5">
                          <div className="flex items-center justify-end gap-1">
                            {canFulfill && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  singleMutation.mutate({
                                    id: o.id,
                                    tracking: o.trackingNumber ?? '',
                                    courier: o.courierName ?? '',
                                  })
                                }
                                disabled={
                                  singleMutation.isPending || !o.trackingNumber
                                }
                                title={
                                  o.trackingNumber
                                    ? `Dispatch with tracking ${o.trackingNumber}`
                                    : 'No tracking number set — use bulk dispatch to add one'
                                }
                              >
                                {singleMutation.isPending &&
                                singleMutation.variables?.id === o.id ? (
                                  <>
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Dispatching…
                                  </>
                                ) : (
                                  <>
                                    <Truck className="h-3.5 w-3.5" /> Dispatch
                                  </>
                                )}
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground p-3">
              {orders.length} order{orders.length === 1 ? '' : 's'} ready · {selected.size} selected
            </p>
          </CardContent>
        </Card>
      )}

      {/* Bulk dispatch dialog */}
      {dispatchOpen && (
        <BulkDispatchDialog
          selectedCount={selected.size}
          open={dispatchOpen}
          onOpenChange={setDispatchOpen}
          loading={bulkMutation.isPending}
          defaultCourier={selectedOrders[0]?.courierName ?? ''}
          onConfirm={({ tracking, courier }) =>
            bulkMutation.mutate({
              ids: Array.from(selected),
              tracking,
              courier,
            })
          }
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk dispatch dialog
// ─────────────────────────────────────────────────────────────────────────────

function BulkDispatchDialog({
  selectedCount,
  open,
  onOpenChange,
  loading,
  defaultCourier,
  onConfirm,
}: {
  selectedCount: number
  open: boolean
  onOpenChange: (open: boolean) => void
  loading: boolean
  defaultCourier: string
  onConfirm: ({ tracking, courier }: { tracking: string; courier: string }) => void
}) {
  const [tracking, setTracking] = useState('')
  const [courier, setCourier] = useState(defaultCourier)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Dispatch {selectedCount} order{selectedCount === 1 ? '' : 's'}</DialogTitle>
          <DialogDescription>
            Apply a shared courier and tracking number to all selected orders. Each order will be
            dispatched individually — per-order failures are reported.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="bulk-courier">Courier name</Label>
            <Input
              id="bulk-courier"
              placeholder="e.g. TCS, Leopards"
              value={courier}
              onChange={(e) => setCourier(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-tracking">Tracking number</Label>
            <Input
              id="bulk-tracking"
              placeholder="Shared tracking number"
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Use this for batch shipments. For per-order tracking, dispatch each order individually
              from its detail page.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={loading || !tracking.trim()}
            onClick={() => onConfirm({ tracking: tracking.trim(), courier: courier.trim() })}
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Dispatching…
              </>
            ) : (
              <>
                <Truck className="h-4 w-4" /> Dispatch {selectedCount} order
                {selectedCount === 1 ? '' : 's'}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
