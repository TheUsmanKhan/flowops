'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, FetchError } from '@/lib/api-client'
import { useAppStore, useCan } from '@/stores/app-store'
import { PERMISSIONS } from '@/lib/permissions'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  ShoppingCart,
  Plus,
  Search,
  RefreshCw,
  Clock,
  Wallet,
  AlertTriangle,
  Eye,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types — match GET /api/purchase-orders
// ─────────────────────────────────────────────────────────────────────────────

type POStatus = 'draft' | 'ordered' | 'partially_received' | 'received' | 'cancelled'

interface PurchaseOrderRow {
  id: string
  poNumber: string
  status: POStatus
  supplier: string
  deliveryLocation: string
  orderDate: string
  expectedDeliveryDate: string | null
  advancePayment: number
  itemCount: number
  totalItemsValue: number
  receivedValue: number
  balanceDue: number
}

interface PurchaseOrdersResponse {
  orders: PurchaseOrderRow[]
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

const STATUS_OPTIONS: { value: POStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'ordered', label: 'Ordered' },
  { value: 'partially_received', label: 'Partially Received' },
  { value: 'received', label: 'Received' },
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

function isOverdue(po: PurchaseOrderRow): boolean {
  if (!po.expectedDeliveryDate) return false
  if (po.status === 'received' || po.status === 'cancelled') return false
  return new Date(po.expectedDeliveryDate) < new Date()
}

function getErrorMessage(err: unknown): string {
  if (err instanceof FetchError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong. Please try again.'
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function PurchaseOrdersView() {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<POStatus | 'all'>('all')

  const canManage = can(PERMISSIONS.INVENTORY_MANAGE_PURCHASE_ORDERS)

  const ordersQuery = useQuery<PurchaseOrdersResponse>({
    queryKey: ['purchase-orders'],
    queryFn: () => api.get<PurchaseOrdersResponse>('/api/purchase-orders'),
    staleTime: 15_000,
  })

  const orders = ordersQuery.data?.orders ?? []

  const stats = useMemo(() => {
    const pending = orders.filter(
      (o) => o.status === 'ordered' || o.status === 'partially_received',
    ).length
    const committed = orders
      .filter((o) => o.status !== 'cancelled')
      .reduce((sum, o) => sum + o.totalItemsValue, 0)
    const overdue = orders.filter(isOverdue).length
    return { pending, committed, overdue }
  }, [orders])

  const filtered = useMemo(() => {
    return orders.filter((o) => {
      if (statusFilter !== 'all' && o.status !== statusFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return (
          o.poNumber.toLowerCase().includes(q) ||
          o.supplier.toLowerCase().includes(q) ||
          o.deliveryLocation.toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [orders, statusFilter, search])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Purchase Orders"
        description="Order stock from suppliers, track expected deliveries, and record receipts."
        actions={
          <div className="flex items-center gap-2">
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
            {canManage && (
              <Button onClick={() => navigate({ name: 'inventory-po-create' })}>
                <Plus className="h-4 w-4" /> New Purchase Order
              </Button>
            )}
          </div>
        }
      />

      {/* ── Stat cards ─────────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Pending POs"
          value={ordersQuery.isLoading ? undefined : String(stats.pending)}
          icon={<Clock className="h-5 w-5" />}
          tone="amber"
          loading={ordersQuery.isLoading}
        />
        <StatCard
          label="Total Committed Value"
          value={ordersQuery.isLoading ? undefined : formatPKR(stats.committed)}
          icon={<Wallet className="h-5 w-5" />}
          tone="emerald"
          loading={ordersQuery.isLoading}
        />
        <StatCard
          label="Overdue POs"
          value={ordersQuery.isLoading ? undefined : String(stats.overdue)}
          icon={<AlertTriangle className="h-5 w-5" />}
          tone={stats.overdue > 0 ? 'rose' : 'gray'}
          loading={ordersQuery.isLoading}
        />
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search PO number, supplier, or location…"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as POStatus | 'all')}
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
              Couldn&apos;t load purchase orders. {getErrorMessage(ordersQuery.error)}
            </p>
            <Button variant="outline" onClick={() => ordersQuery.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <EmptyState
          hasOrders={orders.length > 0}
          canManage={canManage}
          onCreate={() => navigate({ name: 'inventory-po-create' })}
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>PO Number</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Expected</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((po) => {
                    const badge = STATUS_BADGE[po.status]
                    const overdue = isOverdue(po)
                    return (
                      <TableRow
                        key={po.id}
                        className="cursor-pointer hover:bg-muted/40"
                        onClick={() => navigate({ name: 'inventory-po-detail', id: po.id })}
                      >
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium text-sm">{po.poNumber}</span>
                            <span className="text-xs text-muted-foreground">
                              {po.itemCount} item{po.itemCount === 1 ? '' : 's'} ·{' '}
                              {po.deliveryLocation}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{po.supplier}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex flex-col items-end">
                            <span className="text-sm font-medium tabular-nums">
                              {formatPKR(po.totalItemsValue)}
                            </span>
                            {po.advancePayment > 0 && (
                              <span className="text-[11px] text-muted-foreground tabular-nums">
                                Adv: {formatPKR(po.advancePayment)}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={badge.className}>
                            {badge.label}
                          </Badge>
                          {overdue && (
                            <Badge
                              variant="outline"
                              className="ml-1 bg-rose-50 text-rose-700 border-rose-200 text-[10px]"
                            >
                              Overdue
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`text-sm tabular-nums ${
                              overdue ? 'text-rose-600 font-medium' : 'text-muted-foreground'
                            }`}
                          >
                            {formatDate(po.expectedDeliveryDate)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation()
                                navigate({ name: 'inventory-po-detail', id: po.id })
                              }}
                              aria-label={`View ${po.poNumber}`}
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
            <p className="text-xs text-muted-foreground p-3">
              Showing {filtered.length} of {orders.length} purchase orders
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

type StatTone = 'emerald' | 'amber' | 'rose' | 'gray'

const STAT_TONE_CLASSES: Record<StatTone, string> = {
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  rose: 'bg-rose-50 text-rose-600',
  gray: 'bg-gray-100 text-gray-600',
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
            <Skeleton className="h-7 w-24" />
          ) : (
            <span className="text-xl font-semibold tracking-tight">{value ?? '—'}</span>
          )}
        </div>
        <p className="mt-3 text-sm text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  )
}

function EmptyState({
  hasOrders,
  canManage,
  onCreate,
}: {
  hasOrders: boolean
  canManage: boolean
  onCreate: () => void
}) {
  return (
    <Card>
      <CardContent className="p-10 sm:p-14 text-center">
        <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <ShoppingCart className="h-7 w-7 text-primary" />
        </div>
        <h3 className="text-lg font-semibold">
          {hasOrders ? 'No purchase orders match your filters' : 'No purchase orders yet'}
        </h3>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
          {hasOrders
            ? 'Try a different search or status filter.'
            : 'Create a purchase order to send to a supplier — items received against it will update your stock automatically.'}
        </p>
        {!hasOrders && canManage && (
          <Button className="mt-5" onClick={onCreate}>
            <Plus className="h-4 w-4" /> Create your first PO
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
