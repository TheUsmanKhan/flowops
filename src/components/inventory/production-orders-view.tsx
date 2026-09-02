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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
  Scissors,
  Search,
  RefreshCw,
  Loader2,
  MoreHorizontal,
  Ban,
  CheckCircle2,
  PlayCircle,
  Send,
  Clock,
  Factory,
  Calendar,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types — match GET /api/production-orders
// ─────────────────────────────────────────────────────────────────────────────

type ProductionStatus =
  | 'fabric_reserved'
  | 'in_production'
  | 'completed'
  | 'dispatched'
  | 'cancelled'

interface ProductionOrderRow {
  id: string
  productTitle: string
  stitchedSku: string
  fabricSku: string
  fabricLocation: string
  quantity: number
  status: ProductionStatus
  stitchingCost: number
  fabricCost: number
  totalCost: number
  assignedTailor: string | null
  estimatedCompletionDate: string | null
  actualCompletionDate: string | null
  createdAt: string
}

interface ProductionOrdersResponse {
  orders: ProductionOrderRow[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Display maps
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<ProductionStatus, { label: string; className: string }> = {
  fabric_reserved: {
    label: 'Fabric Reserved',
    className: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  in_production: {
    label: 'In Production',
    className: 'bg-sky-50 text-sky-700 border-sky-200',
  },
  completed: {
    label: 'Completed',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  dispatched: {
    label: 'Dispatched',
    className: 'bg-violet-50 text-violet-700 border-violet-200',
  },
  cancelled: { label: 'Cancelled', className: 'bg-rose-50 text-rose-700 border-rose-200' },
}

const STATUS_OPTIONS: { value: ProductionStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'fabric_reserved', label: 'Fabric Reserved' },
  { value: 'in_production', label: 'In Production' },
  { value: 'completed', label: 'Completed' },
  { value: 'dispatched', label: 'Dispatched' },
  { value: 'cancelled', label: 'Cancelled' },
]

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

function getErrorMessage(err: unknown): string {
  if (err instanceof FetchError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong. Please try again.'
}

function isThisMonth(iso: string): boolean {
  const d = new Date(iso)
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function ProductionOrdersView() {
  const can = useCan()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<ProductionStatus | 'all'>('all')
  const [cancelTarget, setCancelTarget] = useState<ProductionOrderRow | null>(null)
  const [cancelReason, setCancelReason] = useState('')

  const canManage = can(PERMISSIONS.INVENTORY_MANAGE_PRODUCTION)

  const ordersQuery = useQuery<ProductionOrdersResponse>({
    queryKey: ['production-orders'],
    queryFn: () => api.get<ProductionOrdersResponse>('/api/production-orders'),
    staleTime: 15_000,
  })

  const orders = ordersQuery.data?.orders ?? []

  const stats = useMemo(() => {
    const pending = orders.filter(
      (o) => o.status === 'fabric_reserved' || o.status === 'in_production',
    ).length
    const inProduction = orders.filter((o) => o.status === 'in_production').length
    const completedThisMonth = orders.filter(
      (o) => o.status === 'completed' && o.actualCompletionDate && isThisMonth(o.actualCompletionDate),
    ).length
    const completedOrders = orders.filter((o) => o.status === 'completed' && o.actualCompletionDate)
    let avgTurnaround = 0
    if (completedOrders.length > 0) {
      const totalDays = completedOrders.reduce((s, o) => {
        const start = new Date(o.createdAt).getTime()
        const end = new Date(o.actualCompletionDate!).getTime()
        return s + Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)))
      }, 0)
      avgTurnaround = Math.round(totalDays / completedOrders.length)
    }
    return { pending, inProduction, completedThisMonth, avgTurnaround }
  }, [orders])

  const filtered = useMemo(() => {
    return orders.filter((o) => {
      if (statusFilter !== 'all' && o.status !== statusFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return (
          o.productTitle.toLowerCase().includes(q) ||
          o.stitchedSku.toLowerCase().includes(q) ||
          o.fabricSku.toLowerCase().includes(q) ||
          (o.assignedTailor ?? '').toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [orders, statusFilter, search])

  // ── Mutations ────────────────────────────────────────────────────────────
  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: ProductionStatus }) =>
      api.patch(`/api/production-orders/${id}`, { status }),
    onSuccess: (_data, vars) => {
      toast.success(`Order marked as ${STATUS_BADGE[vars.status].label}.`)
      void queryClient.invalidateQueries({ queryKey: ['production-orders'] })
      void queryClient.invalidateQueries({ queryKey: ['inventory-dashboard'] })
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const cancelMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) =>
      api.patch(`/api/production-orders/${id}`, {
        status: 'cancelled',
        cancellation_reason: reason,
      }),
    onSuccess: () => {
      toast.success('Production order cancelled.')
      void queryClient.invalidateQueries({ queryKey: ['production-orders'] })
      setCancelTarget(null)
      setCancelReason('')
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Production Orders"
        description="Made-to-order stitching jobs. Created automatically when made-to-order variants are fulfilled — no manual creation."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => ordersQuery.refetch()}
            disabled={ordersQuery.isFetching}
          >
            <RefreshCw
              className={ordersQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}
            />
            Refresh
          </Button>
        }
      />

      {/* ── Stat cards ─────────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Pending"
          value={ordersQuery.isLoading ? undefined : String(stats.pending)}
          icon={<Clock className="h-5 w-5" />}
          tone="amber"
          loading={ordersQuery.isLoading}
        />
        <StatCard
          label="In Production"
          value={ordersQuery.isLoading ? undefined : String(stats.inProduction)}
          icon={<Factory className="h-5 w-5" />}
          tone="sky"
          loading={ordersQuery.isLoading}
        />
        <StatCard
          label="Completed This Month"
          value={ordersQuery.isLoading ? undefined : String(stats.completedThisMonth)}
          icon={<CheckCircle2 className="h-5 w-5" />}
          tone="emerald"
          loading={ordersQuery.isLoading}
        />
        <StatCard
          label="Avg Turnaround Days"
          value={ordersQuery.isLoading ? undefined : String(stats.avgTurnaround)}
          icon={<Calendar className="h-5 w-5" />}
          tone="gray"
          loading={ordersQuery.isLoading}
        />
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search product, fabric SKU, or tailor…"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as ProductionStatus | 'all')}
        >
          <SelectTrigger className="w-full sm:w-48">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ── Table ──────────────────────────────────────────────────────────── */}
      {ordersQuery.isLoading ? (
        <Card>
          <CardContent className="p-3 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </CardContent>
        </Card>
      ) : ordersQuery.isError ? (
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">
              Couldn&apos;t load production orders. {getErrorMessage(ordersQuery.error)}
            </p>
            <Button variant="outline" onClick={() => ordersQuery.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <EmptyState hasOrders={orders.length > 0} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Stitched Variant</TableHead>
                    <TableHead>Fabric</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Assigned Tailor</TableHead>
                    <TableHead>Est. Completion</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((o) => {
                    const badge = STATUS_BADGE[o.status]
                    const isCancelled = o.status === 'cancelled'
                    const isDispatched = o.status === 'dispatched'
                    return (
                      <TableRow key={o.id}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium text-sm">{o.productTitle}</span>
                            <span className="text-xs text-muted-foreground font-mono">
                              {o.stitchedSku}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="text-xs font-mono">{o.fabricSku}</span>
                            <span className="text-xs text-muted-foreground">
                              from {o.fabricLocation}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{o.quantity}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={badge.className}>
                            {badge.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">
                          {o.assignedTailor ?? <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {formatDate(o.estimatedCompletionDate)}
                        </TableCell>
                        <TableCell className="text-right">
                          {canManage && !isCancelled && !isDispatched ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="sm" variant="ghost" aria-label="Actions">
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-48">
                                <DropdownMenuLabel>Update status</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                {o.status === 'fabric_reserved' && (
                                  <DropdownMenuItem
                                    onClick={() =>
                                      updateStatusMutation.mutate({ id: o.id, status: 'in_production' })
                                    }
                                  >
                                    <PlayCircle className="h-3.5 w-3.5 mr-2" />
                                    Start Production
                                  </DropdownMenuItem>
                                )}
                                {o.status === 'in_production' && (
                                  <DropdownMenuItem
                                    onClick={() =>
                                      updateStatusMutation.mutate({ id: o.id, status: 'completed' })
                                    }
                                  >
                                    <CheckCircle2 className="h-3.5 w-3.5 mr-2" />
                                    Mark Completed
                                  </DropdownMenuItem>
                                )}
                                {o.status === 'completed' && (
                                  <DropdownMenuItem
                                    onClick={() =>
                                      updateStatusMutation.mutate({ id: o.id, status: 'dispatched' })
                                    }
                                  >
                                    <Send className="h-3.5 w-3.5 mr-2" />
                                    Mark Dispatched
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-rose-600 focus:text-rose-700 focus:bg-rose-50"
                                  onClick={() => setCancelTarget(o)}
                                >
                                  <Ban className="h-3.5 w-3.5 mr-2" />
                                  Cancel Order
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground p-3">
              Showing {filtered.length} of {orders.length} production orders
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── Cancel dialog ──────────────────────────────────────────────────── */}
      <AlertDialog
        open={!!cancelTarget}
        onOpenChange={(open) => {
          if (!open) {
            setCancelTarget(null)
            setCancelReason('')
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel production order?</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelTarget && (
                <>
                  <strong>{cancelTarget.productTitle}</strong> ({cancelTarget.stitchedSku}) —
                  quantity {cancelTarget.quantity}. Fabric has already been consumed and cannot be
                  restored automatically.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5 py-2">
            <Label htmlFor="prod-cancel-reason">Reason (optional)</Label>
            <Textarea
              id="prod-cancel-reason"
              placeholder="e.g. Customer cancelled, defective fabric discovered…"
              rows={3}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelMutation.isPending}>Keep Order</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700"
              disabled={cancelMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (cancelTarget) {
                  cancelMutation.mutate({ id: cancelTarget.id, reason: cancelReason.trim() })
                }
              }}
            >
              {cancelMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Cancelling…
                </>
              ) : (
                <>
                  <Ban className="h-4 w-4" /> Cancel Order
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

type StatTone = 'emerald' | 'amber' | 'rose' | 'gray' | 'sky'

const STAT_TONE_CLASSES: Record<StatTone, string> = {
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  rose: 'bg-rose-50 text-rose-600',
  gray: 'bg-gray-100 text-gray-600',
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
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-lg ${STAT_TONE_CLASSES[tone]}`}
          >
            {icon}
          </div>
          {loading ? (
            <Skeleton className="h-7 w-16" />
          ) : (
            <span className="text-xl font-semibold tracking-tight">{value ?? '—'}</span>
          )}
        </div>
        <p className="mt-3 text-sm text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  )
}

function EmptyState({ hasOrders }: { hasOrders: boolean }) {
  return (
    <Card>
      <CardContent className="p-10 sm:p-14 text-center">
        <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <Scissors className="h-7 w-7 text-primary" />
        </div>
        <h3 className="text-lg font-semibold">
          {hasOrders ? 'No production orders match your filters' : 'No production orders yet'}
        </h3>
        <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
          {hasOrders
            ? 'Try a different search or status filter.'
            : 'Production orders are created automatically when made-to-order variants are fulfilled. Convert a made-to-order variant in the products catalog to see one here.'}
        </p>
      </CardContent>
    </Card>
  )
}
