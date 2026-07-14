'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api-client'
import { useAppStore } from '@/stores/app-store'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
  ArrowLeft,
  Building2,
  Store,
  Star,
  MapPin,
  Phone,
  User,
  Search,
  Warehouse,
  Truck,
  AlertOctagon,
  Package,
  RefreshCw,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types — match GET /api/inventory-locations/{id}
// ─────────────────────────────────────────────────────────────────────────────

type LocationType = 'warehouse' | 'dispatch_hub' | 'retail_store' | 'transit' | 'damaged_hold'

interface LocationDetail {
  id: string
  name: string
  locationType: LocationType
  city: string
  province: string
  countryCode: string
  contactPerson: string | null
  contactPhone: string | null
  isDefault: boolean
  isActive: boolean
  isOrgLevel: boolean
}

interface LocationPool {
  id: string
  variantId: string
  sku: string
  productTitle: string
  onHand: number
  reserved: number
  available: number
  incoming: number
  avgCost: number
  stockValue: number
  reorderPoint: number
  lastReceivedAt: string | null
  lastSoldAt: string | null
}

interface LocationTxn {
  id: string
  sku: string
  productTitle: string
  transactionType: string
  quantity: number
  costPerUnit: number
  recordedAt: string
}

interface LocationDetailResponse {
  location: LocationDetail
  pools: LocationPool[]
  recentTransactions: LocationTxn[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Display maps
// ─────────────────────────────────────────────────────────────────────────────

const LOCATION_TYPE_LABEL: Record<LocationType, { label: string; icon: typeof Warehouse }> = {
  warehouse: { label: 'Warehouse', icon: Warehouse },
  dispatch_hub: { label: 'Dispatch hub', icon: Truck },
  retail_store: { label: 'Retail store', icon: Store },
  transit: { label: 'Transit', icon: Truck },
  damaged_hold: { label: 'Damaged hold', icon: AlertOctagon },
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
  opening_stock: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  purchase_received: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  transfer_in: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  return_resellable: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  return_stitched_received: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  cycle_count_adjust: 'bg-sky-50 text-sky-700 border-sky-200',
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

const PKR = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 })
function formatPKR(n: number): string {
  return `Rs. ${PKR.format(n)}`
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-PK', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return iso
  }
}

type PoolFilter = 'all' | 'in_stock' | 'low' | 'out'

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function LocationDetailView({ locationId }: { locationId: string }) {
  const navigate = useAppStore((s) => s.navigate)
  const [search, setSearch] = useState('')
  const [poolFilter, setPoolFilter] = useState<PoolFilter>('all')

  const { data, isLoading, isError, refetch, isFetching } = useQuery<LocationDetailResponse>({
    queryKey: ['location-detail', locationId],
    queryFn: () => api.get<LocationDetailResponse>(`/api/inventory-locations/${locationId}`),
    staleTime: 15_000,
    enabled: !!locationId,
  })

  const location = data?.location
  const pools = data?.pools ?? []
  const recentTxns = data?.recentTransactions ?? []

  const totalValue = useMemo(
    () => pools.reduce((s, p) => s + p.stockValue, 0),
    [pools],
  )
  const totalOnHand = useMemo(
    () => pools.reduce((s, p) => s + p.onHand, 0),
    [pools],
  )
  const totalReserved = useMemo(
    () => pools.reduce((s, p) => s + p.reserved, 0),
    [pools],
  )

  const filteredPools = useMemo(() => {
    return pools.filter((p) => {
      if (poolFilter === 'in_stock' && p.onHand <= 0) return false
      if (poolFilter === 'low' && !(p.reorderPoint > 0 && p.onHand <= p.reorderPoint && p.onHand > 0))
        return false
      if (poolFilter === 'out' && p.onHand !== 0) return false
      if (search) {
        const q = search.toLowerCase()
        return p.sku.toLowerCase().includes(q) || p.productTitle.toLowerCase().includes(q)
      }
      return true
    })
  }, [pools, search, poolFilter])

  const meta = location ? LOCATION_TYPE_LABEL[location.locationType] ?? LOCATION_TYPE_LABEL.warehouse : null
  const Icon = meta?.icon ?? Warehouse

  return (
    <div className="space-y-6">
      <PageHeader
        title={location?.name ?? 'Location'}
        description={
          location
            ? `${meta?.label ?? location.locationType} · ${location.city}, ${location.province}`
            : 'Loading location…'
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate({ name: 'inventory-locations' })}>
            <ArrowLeft className="h-4 w-4" /> Back to locations
          </Button>
        }
      />

      {/* ── Location info panel ──────────────────────────────────────────── */}
      {isLoading ? (
        <Skeleton className="h-32" />
      ) : isError || !location ? (
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">
              {isError ? 'Couldn&apos;t load this location. Please try again.' : 'Location not found.'}
            </p>
            <Button variant="outline" onClick={() => refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-5">
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <div className="lg:col-span-2 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-lg font-semibold leading-tight">{location.name}</h2>
                      {location.isDefault && (
                        <Badge className="bg-amber-100 text-amber-700 border-transparent text-[10px] gap-1">
                          <Star className="h-3 w-3" /> Default
                        </Badge>
                      )}
                      {!location.isActive && (
                        <Badge variant="outline" className="text-rose-700 border-rose-200 text-[10px]">
                          Inactive
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      <Badge variant="secondary" className="text-[10px]">
                        {meta?.label}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {location.isOrgLevel ? (
                          <span className="flex items-center gap-1">
                            <Building2 className="h-3 w-3" /> Org-level
                          </span>
                        ) : (
                          <span className="flex items-center gap-1">
                            <Store className="h-3 w-3" /> Company
                          </span>
                        )}
                      </Badge>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2 border-t">
                  <InfoRow icon={<MapPin className="h-3.5 w-3.5" />} label="City" value={`${location.city}, ${location.province}`} />
                  <InfoRow icon={<MapPin className="h-3.5 w-3.5" />} label="Country" value={location.countryCode || 'PK'} />
                  <InfoRow
                    icon={<User className="h-3.5 w-3.5" />}
                    label="Contact person"
                    value={location.contactPerson ?? '—'}
                  />
                  <InfoRow
                    icon={<Phone className="h-3.5 w-3.5" />}
                    label="Contact phone"
                    value={location.contactPhone ?? '—'}
                  />
                </div>
              </div>

              <SummaryStat
                label="Total stock value"
                value={formatPKR(totalValue)}
                icon={<Package className="h-4 w-4" />}
              />
              <div className="grid grid-cols-2 gap-3 lg:col-span-1">
                <MiniStat label="On hand" value={totalOnHand} tone="emerald" />
                <MiniStat label="Reserved" value={totalReserved} tone="amber" />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Stock table ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
            <span>Stock at this location</span>
            <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
              Refresh
            </Button>
          </CardTitle>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center mt-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search SKU or product…"
                className="pl-9 h-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select value={poolFilter} onValueChange={(v) => setPoolFilter(v as PoolFilter)}>
              <SelectTrigger className="w-full sm:w-44 h-9">
                <SelectValue placeholder="All stock" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stock</SelectItem>
                <SelectItem value="in_stock">In stock only</SelectItem>
                <SelectItem value="low">Low stock</SelectItem>
                <SelectItem value="out">Out of stock</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : filteredPools.length === 0 ? (
            <div className="text-center py-10">
              <Package className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">
                {pools.length === 0
                  ? 'No stock held at this location yet.'
                  : 'No pools match your filters.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Variant</TableHead>
                    <TableHead className="text-right">On hand</TableHead>
                    <TableHead className="text-right">Reserved</TableHead>
                    <TableHead className="text-right">Available</TableHead>
                    <TableHead className="text-right">Avg cost</TableHead>
                    <TableHead className="text-right">Stock value</TableHead>
                    <TableHead>Last received</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredPools.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium text-sm">{p.productTitle}</span>
                          <span className="text-xs text-muted-foreground font-mono">{p.sku}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {p.onHand}
                        {p.incoming > 0 && (
                          <span className="text-xs text-emerald-600 ml-1">+{p.incoming} in</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {p.reserved}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {p.available}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatPKR(p.avgCost)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {formatPKR(p.stockValue)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatDate(p.lastReceivedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="text-xs text-muted-foreground mt-3">
                Showing {filteredPools.length} of {pools.length} pools
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Recent transactions at this location ─────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent transactions here</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : recentTxns.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-muted-foreground">No transactions recorded at this location yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto max-h-96 overflow-y-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Variant</TableHead>
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

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        {icon}
        {label}
      </p>
      <p className="text-sm font-medium truncate">{value}</p>
    </div>
  )
}

function SummaryStat({
  label,
  value,
  icon,
}: {
  label: string
  value: string
  icon: React.ReactNode
}) {
  return (
    <div className="rounded-lg border bg-muted/30 p-4">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
        {icon}
        {label}
      </div>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function MiniStat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'emerald' | 'amber'
}) {
  const toneClass =
    tone === 'emerald'
      ? 'bg-emerald-50 text-emerald-700'
      : 'bg-amber-50 text-amber-700'
  return (
    <div className={`rounded-lg p-3 ${toneClass}`}>
      <p className="text-[10px] uppercase tracking-wide opacity-80">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  )
}
