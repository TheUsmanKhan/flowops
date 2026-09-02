'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api-client'
import { useAppStore, useCan } from '@/stores/app-store'
import { PERMISSIONS } from '@/lib/permissions'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Boxes,
  AlertTriangle,
  PackageX,
  Archive,
  PackagePlus,
  SlidersHorizontal,
  ArrowLeftRight,
  ShoppingCart,
  Search,
  ArrowDownRight,
  ArrowUpRight,
  RefreshCw,
  Loader2,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types — match GET /api/inventory/dashboard response shape
// ─────────────────────────────────────────────────────────────────────────────

interface DashboardStats {
  totalStockValue: number
  lowStockCount: number
  outOfStockCount: number
  deadStockValue: number
}

interface StockMovement {
  openingValue: number
  receivedUnits: number
  receivedValue: number
  soldUnits: number
  soldValue: number
  lossUnits: number
  lossValue: number
  closingValue: number
}

interface StockPoolRow {
  poolId: string
  variantId: string
  sku: string
  productTitle: string
  location: string
  locationId: string
  onHand: number
  reserved: number
  available: number
  avgCost: number
  stockValue: number
  incoming: number
  fulfillmentType: string
  status: 'healthy' | 'low' | 'out' | 'dead'
}

interface RecentTxn {
  id: string
  sku: string
  productTitle: string
  location: string
  transactionType: string
  quantity: number
  costPerUnit: number
  recordedAt: string
}

interface InventoryDashboardData {
  stats: DashboardStats
  movement: StockMovement
  stockTable: StockPoolRow[]
  recentTransactions: RecentTxn[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Display maps
// ─────────────────────────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'healthy' | 'low' | 'out' | 'dead'

const STATUS_BADGE: Record<StockPoolRow['status'], { label: string; className: string }> = {
  healthy: { label: 'Healthy', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  low: { label: 'Low', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  out: { label: 'Out', className: 'bg-rose-50 text-rose-700 border-rose-200' },
  dead: { label: 'Dead', className: 'bg-gray-100 text-gray-600 border-gray-200' },
}

const TXN_LABELS: Record<string, string> = {
  opening_stock: 'Opening',
  purchase_received: 'Received',
  transfer_in: 'Transfer In',
  transfer_out: 'Transfer Out',
  return_resellable: 'Return (resellable)',
  return_stitched_received: 'Stitched Return',
  sale_dispatched: 'Sale',
  damage_writeoff: 'Damage',
  theft_writeoff: 'Theft',
  missing_writeoff: 'Missing',
  transit_loss: 'Transit loss',
  supplier_return: 'Supplier return',
  cycle_count_adjust: 'Cycle count',
}

const TXN_BADGE_CLASS: Record<string, string> = {
  // inbound (positive)
  opening_stock: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  purchase_received: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  transfer_in: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  return_resellable: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  return_stitched_received: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  cycle_count_adjust: 'bg-sky-50 text-sky-700 border-sky-200',
  // outbound (negative)
  sale_dispatched: 'bg-sky-50 text-sky-700 border-sky-200',
  transfer_out: 'bg-amber-50 text-amber-700 border-amber-200',
  damage_writeoff: 'bg-rose-50 text-rose-700 border-rose-200',
  theft_writeoff: 'bg-rose-50 text-rose-700 border-rose-200',
  missing_writeoff: 'bg-rose-50 text-rose-700 border-rose-200',
  transit_loss: 'bg-rose-50 text-rose-700 border-rose-200',
  supplier_return: 'bg-rose-50 text-rose-700 border-rose-200',
}

const INBOUND_TXN_TYPES = new Set([
  'opening_stock',
  'purchase_received',
  'transfer_in',
  'return_resellable',
  'return_stitched_received',
])

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const PKR = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 })

function formatPKR(n: number): string {
  return `Rs. ${PKR.format(n)}`
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-PK', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function InventoryDashboardView() {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()

  const [search, setSearch] = useState('')
  const [locationFilter, setLocationFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const { data, isLoading, isError, refetch, isFetching } = useQuery<InventoryDashboardData>({
    queryKey: ['inventory-dashboard'],
    queryFn: () => api.get<InventoryDashboardData>('/api/inventory/dashboard'),
    staleTime: 15_000,
  })

  const stats = data?.stats
  const movement = data?.movement
  const stockTable = data?.stockTable ?? []
  const recentTxns = data?.recentTransactions ?? []

  // Build the location filter dropdown from the stock table.
  const locationOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const row of stockTable) {
      if (!map.has(row.locationId)) map.set(row.locationId, row.location)
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }))
  }, [stockTable])

  const filteredStock = useMemo(() => {
    return stockTable.filter((row) => {
      if (locationFilter !== 'all' && row.locationId !== locationFilter) return false
      if (statusFilter !== 'all' && row.status !== statusFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return (
          row.sku.toLowerCase().includes(q) ||
          row.productTitle.toLowerCase().includes(q) ||
          row.location.toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [stockTable, locationFilter, statusFilter, search])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory"
        description="Stock value, movement, and recent activity across all your locations."
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            Refresh
          </Button>
        }
      />

      {/* ── Stat cards ───────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total stock value"
          value={stats ? formatPKR(stats.totalStockValue) : undefined}
          icon={<Boxes className="h-5 w-5" />}
          tone="emerald"
          loading={isLoading}
        />
        <StatCard
          label="Low stock items"
          value={stats ? String(stats.lowStockCount) : undefined}
          icon={<AlertTriangle className="h-5 w-5" />}
          tone="amber"
          loading={isLoading}
        />
        <StatCard
          label="Out of stock"
          value={stats ? String(stats.outOfStockCount) : undefined}
          icon={<PackageX className="h-5 w-5" />}
          tone="rose"
          loading={isLoading}
        />
        <StatCard
          label="Dead stock value"
          value={stats ? formatPKR(stats.deadStockValue) : undefined}
          icon={<Archive className="h-5 w-5" />}
          tone="gray"
          loading={isLoading}
        />
      </div>

      {/* ── Stock movement (this month) ─────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stock movement this month</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading || !movement ? (
            <div className="grid gap-3 sm:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-20" />
              ))}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-5">
              <MovementBlock
                label="Opening"
                value={formatPKR(movement.openingValue)}
                sub="Start of month"
                tone="muted"
              />
              <MovementBlock
                label="Received"
                value={`+${movement.receivedUnits} units`}
                sub={formatPKR(movement.receivedValue)}
                tone="positive"
                icon={<ArrowDownRight className="h-3.5 w-3.5" />}
              />
              <MovementBlock
                label="Sold"
                value={`-${movement.soldUnits} units`}
                sub={formatPKR(movement.soldValue)}
                tone="info"
                icon={<ArrowUpRight className="h-3.5 w-3.5" />}
              />
              <MovementBlock
                label="Losses"
                value={`-${movement.lossUnits} units`}
                sub={formatPKR(movement.lossValue)}
                tone="negative"
                icon={<ArrowUpRight className="h-3.5 w-3.5" />}
              />
              <MovementBlock
                label="Closing"
                value={formatPKR(movement.closingValue)}
                sub="Current value"
                tone="emerald"
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Quick links ─────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <QuickLink
          disabled={!can(PERMISSIONS.INVENTORY_RECEIVE)}
          onClick={() => navigate({ name: 'inventory-receive' })}
          icon={<PackagePlus className="h-5 w-5" />}
          label="Receive Stock"
          description="Record incoming inventory"
        />
        <QuickLink
          disabled={!can(PERMISSIONS.INVENTORY_ADJUST)}
          onClick={() => navigate({ name: 'inventory-adjust' })}
          icon={<SlidersHorizontal className="h-5 w-5" />}
          label="Adjust"
          description="Manual +/- adjustment"
        />
        <QuickLink
          disabled={!can(PERMISSIONS.INVENTORY_TRANSFER)}
          onClick={() => navigate({ name: 'inventory-transfer' })}
          icon={<ArrowLeftRight className="h-5 w-5" />}
          label="Transfer"
          description="Move stock between locations"
        />
        <QuickLink
          disabled={!can(PERMISSIONS.INVENTORY_MANAGE_PURCHASE_ORDERS)}
          onClick={() => navigate({ name: 'inventory-purchase-orders' })}
          icon={<ShoppingCart className="h-5 w-5" />}
          label="Purchase Orders"
          description="Order from suppliers"
        />
      </div>

      {/* ── Full stock table ────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">All stock</CardTitle>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center mt-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search SKU, product, or location…"
                className="pl-9 h-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select value={locationFilter} onValueChange={setLocationFilter}>
              <SelectTrigger className="w-full sm:w-44 h-9">
                <SelectValue placeholder="All locations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All locations</SelectItem>
                {locationOptions.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as StatusFilter)}
            >
              <SelectTrigger className="w-full sm:w-40 h-9">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="healthy">Healthy</SelectItem>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="out">Out of stock</SelectItem>
                <SelectItem value="dead">Dead stock</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <StockTableSkeleton />
          ) : isError ? (
            <div className="text-center py-10">
              <p className="text-sm text-muted-foreground mb-4">
                Couldn&apos;t load stock data. The server may have restarted.
              </p>
              <Button variant="outline" onClick={() => refetch()}>
                Try again
              </Button>
            </div>
          ) : filteredStock.length === 0 ? (
            <div className="text-center py-10">
              <Boxes className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">
                {stockTable.length === 0
                  ? 'No stock recorded yet. Click "Receive Stock" to add your first items.'
                  : 'No stock matches your filters.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU / Product</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead className="text-right">On hand</TableHead>
                    <TableHead className="text-right">Reserved</TableHead>
                    <TableHead className="text-right">Available</TableHead>
                    <TableHead className="text-right">Avg cost</TableHead>
                    <TableHead className="text-right">Stock value</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredStock.map((row) => {
                    const badge = STATUS_BADGE[row.status]
                    return (
                      <TableRow key={row.poolId}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium text-sm">{row.productTitle}</span>
                            <span className="text-xs text-muted-foreground font-mono">
                              {row.sku}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{row.location}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.onHand}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {row.reserved}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {row.available}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatPKR(row.avgCost)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {formatPKR(row.stockValue)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={badge.className}>
                            {badge.label}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
              <p className="text-xs text-muted-foreground mt-3">
                Showing {filteredStock.length} of {stockTable.length} pools
                {rowHasIncoming(filteredStock) ? ' · some rows have incoming stock' : ''}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Recent transactions ─────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent transactions</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <TxnTableSkeleton />
          ) : recentTxns.length === 0 ? (
            <div className="text-center py-8">
              <RefreshCw className="h-8 w-8 mx-auto text-muted-foreground/40 mb-2" />
              <p className="text-sm text-muted-foreground">No transactions yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto max-h-96 overflow-y-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>SKU / Product</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Cost / unit</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentTxns.map((t) => {
                    const isInbound = INBOUND_TXN_TYPES.has(t.transactionType)
                    const label = TXN_LABELS[t.transactionType] ?? t.transactionType
                    const badgeClass =
                      TXN_BADGE_CLASS[t.transactionType] ?? 'bg-gray-100 text-gray-700 border-gray-200'
                    return (
                      <TableRow key={t.id}>
                        <TableCell>
                          <Badge variant="outline" className={badgeClass}>
                            {label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium text-sm">{t.productTitle}</span>
                            <span className="text-xs text-muted-foreground font-mono">{t.sku}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{t.location}</TableCell>
                        <TableCell
                          className={`text-right tabular-nums font-medium ${
                            isInbound ? 'text-emerald-600' : 'text-rose-600'
                          }`}
                        >
                          {isInbound ? '+' : '−'}
                          {Math.abs(t.quantity)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatPKR(t.costPerUnit)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatDate(t.recordedAt)}
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
    </div>
  )
}

function rowHasIncoming(rows: StockPoolRow[]): boolean {
  return rows.some((r) => r.incoming > 0)
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
          <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${STAT_TONE_CLASSES[tone]}`}>
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

type MovementTone = 'muted' | 'positive' | 'info' | 'negative' | 'emerald'

const MOVEMENT_TONE: Record<MovementTone, string> = {
  muted: 'bg-muted/40 border-border',
  positive: 'bg-emerald-50/50 border-emerald-200',
  info: 'bg-sky-50/50 border-sky-200',
  negative: 'bg-rose-50/50 border-rose-200',
  emerald: 'bg-emerald-50 border-emerald-200',
}

function MovementBlock({
  label,
  value,
  sub,
  tone,
  icon,
}: {
  label: string
  value: string
  sub: string
  tone: MovementTone
  icon?: React.ReactNode
}) {
  return (
    <div className={`rounded-lg border p-3 ${MOVEMENT_TONE[tone]}`}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
        {icon}
      </div>
      <p className="font-semibold text-sm tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground tabular-nums">{sub}</p>
    </div>
  )
}

function QuickLink({
  icon,
  label,
  description,
  onClick,
  disabled,
}: {
  icon: React.ReactNode
  label: string
  description: string
  onClick: () => void
  disabled?: boolean
}) {
  const inner = (
    <Button
      variant="outline"
      className="h-auto justify-start py-4 px-4 text-left"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
    >
      <div className="flex items-start gap-3 w-full">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="font-medium text-sm">{label}</p>
          <p className="text-xs text-muted-foreground line-clamp-1">{description}</p>
        </div>
      </div>
    </Button>
  )
  if (disabled) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{inner}</TooltipTrigger>
          <TooltipContent>You don&apos;t have permission for this action</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }
  return inner
}

function StockTableSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-12" />
      ))}
    </div>
  )
}

function TxnTableSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-10" />
      ))}
      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
    </div>
  )
}
