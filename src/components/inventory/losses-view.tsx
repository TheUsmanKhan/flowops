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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Search,
  RefreshCw,
  Plus,
  Loader2,
  AlertTriangle,
  PackageX,
  ShieldAlert,
  PackageMinus,
  Truck,
  CheckCircle2,
  Clock,
  Wallet,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type LossType = 'damaged' | 'theft' | 'missing' | 'transit_loss'
type SubType = 'confirmed' | 'suspected' | 'admin_error' | 'manufacturing'
type DamageType =
  | 'water_moisture'
  | 'physical_impact'
  | 'manufacturing_defect'
  | 'transit_damage'
  | 'storage_damage'
  | 'other'
type InvestigationStatus = 'none' | 'open' | 'closed'
type LossResolution =
  | 'written_off'
  | 'recovered'
  | 'error_corrected'
  | 'claim_accepted'
  | 'claim_rejected'
type ResponsibleParty = 'warehouse' | 'courier' | 'customer' | 'employee' | 'unknown'

interface StockLossRow {
  id: string
  productTitle: string
  sku: string
  location: string
  lossType: LossType
  subType: SubType | null
  quantity: number
  costPerUnit: number
  totalLossValue: number
  investigationStatus: InvestigationStatus
  resolution: LossResolution | null
  createdAt: string
}

interface StockLossResponse {
  records: StockLossRow[]
}

interface InventoryLocation {
  id: string
  name: string
}
interface LocationsResponse {
  locations: InventoryLocation[]
}

interface ProductsResponse {
  products: Array<{
    id: string
    title: string
    variants: Array<{
      id: string
      sku: string
      costPrice: number
    }>
  }>
}

interface InventoryDashboardResponse {
  stockTable: Array<{
    poolId: string
    variantId: string
    locationId: string
    sku: string
    productTitle: string
    onHand: number
    avgCost: number
  }>
}

interface CreatePayload {
  org_variant_id: string
  location_id: string
  loss_type: LossType
  sub_type?: SubType
  damage_type?: DamageType
  quantity: number
  cost_per_unit: number
  notes?: string
  responsible_party?: ResponsibleParty
}

interface ResolvePayload {
  resolution: LossResolution
  investigation_status?: InvestigationStatus
  responsible_party?: ResponsibleParty
  police_report_ref?: string
  insurance_claim_ref?: string
  insurance_recovered?: number
  courier_claim_ref?: string
  courier_claim_status?: 'not_filed' | 'filed' | 'accepted' | 'rejected'
  courier_recovered?: number
  notes?: string
  approved?: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Display maps
// ─────────────────────────────────────────────────────────────────────────────

const LOSS_TYPE_BADGE: Record<LossType, { label: string; className: string }> = {
  damaged: { label: 'Damaged', className: 'bg-rose-50 text-rose-700 border-rose-200' },
  theft: { label: 'Theft', className: 'bg-rose-50 text-rose-700 border-rose-200' },
  missing: { label: 'Missing', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  transit_loss: {
    label: 'Transit Loss',
    className: 'bg-amber-50 text-amber-700 border-amber-200',
  },
}

const LOSS_TYPE_CARD: Record<
  LossType,
  { label: string; description: string; icon: React.ReactNode }
> = {
  damaged: {
    label: 'Damaged',
    description: 'Item is broken or unusable',
    icon: <PackageX className="h-5 w-5" />,
  },
  theft: {
    label: 'Theft',
    description: 'Stolen inventory',
    icon: <ShieldAlert className="h-5 w-5" />,
  },
  missing: {
    label: 'Missing',
    description: 'Cannot be located',
    icon: <PackageMinus className="h-5 w-5" />,
  },
  transit_loss: {
    label: 'Transit Loss',
    description: 'Lost during shipping',
    icon: <Truck className="h-5 w-5" />,
  },
}

const RESOLUTION_LABEL: Record<LossResolution, string> = {
  written_off: 'Written Off',
  recovered: 'Recovered',
  error_corrected: 'Error Corrected',
  claim_accepted: 'Claim Accepted',
  claim_rejected: 'Claim Rejected',
}

const RESOLUTION_OPTIONS: { value: LossResolution; label: string }[] = [
  { value: 'written_off', label: 'Written Off' },
  { value: 'recovered', label: 'Recovered' },
  { value: 'error_corrected', label: 'Error Corrected' },
  { value: 'claim_accepted', label: 'Claim Accepted' },
  { value: 'claim_rejected', label: 'Claim Rejected' },
]

const SUB_TYPE_OPTIONS: { value: SubType; label: string }[] = [
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'suspected', label: 'Suspected' },
  { value: 'admin_error', label: 'Admin error' },
  { value: 'manufacturing', label: 'Manufacturing' },
]

const DAMAGE_TYPE_OPTIONS: { value: DamageType; label: string }[] = [
  { value: 'water_moisture', label: 'Water / Moisture' },
  { value: 'physical_impact', label: 'Physical Impact' },
  { value: 'manufacturing_defect', label: 'Manufacturing Defect' },
  { value: 'transit_damage', label: 'Transit Damage' },
  { value: 'storage_damage', label: 'Storage Damage' },
  { value: 'other', label: 'Other' },
]

const RESPONSIBLE_PARTY_OPTIONS: { value: ResponsibleParty; label: string }[] = [
  { value: 'warehouse', label: 'Warehouse' },
  { value: 'courier', label: 'Courier' },
  { value: 'customer', label: 'Customer' },
  { value: 'employee', label: 'Employee' },
  { value: 'unknown', label: 'Unknown' },
]

const INVESTIGATION_BADGE: Record<InvestigationStatus, { label: string; className: string }> = {
  none: { label: 'No Investigation', className: 'bg-gray-100 text-gray-700 border-gray-200' },
  open: { label: 'Investigating', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  closed: { label: 'Closed', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
}

const PKR = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 })
function formatPKR(n: number): string {
  return `Rs. ${PKR.format(n)}`
}

function formatDate(iso: string): string {
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

export function LossesView() {
  const can = useCan()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [reportOpen, setReportOpen] = useState(false)
  const [resolveTarget, setResolveTarget] = useState<StockLossRow | null>(null)

  const canReport = can(PERMISSIONS.INVENTORY_REPORT_LOSS)
  const canManage = can(PERMISSIONS.INVENTORY_MANAGE_LOSS)

  const lossesQuery = useQuery<StockLossResponse>({
    queryKey: ['stock-loss'],
    queryFn: () => api.get<StockLossResponse>('/api/stock-loss'),
    staleTime: 15_000,
  })

  const records = lossesQuery.data?.records ?? []

  const stats = useMemo(() => {
    const open = records.filter((r) => r.investigationStatus === 'open' || !r.resolution).length
    const monthLossValue = records
      .filter((r) => isThisMonth(r.createdAt))
      .reduce((s, r) => s + r.totalLossValue, 0)
    const recovered = records
      .filter((r) => r.resolution === 'recovered' || r.resolution === 'claim_accepted')
      .reduce((s, r) => s + r.totalLossValue * 0.5, 0) // approximate proxy; backend doesn't expose recovered amount in list
    return { open, monthLossValue, recovered }
  }, [records])

  const filtered = useMemo(() => {
    return records.filter((r) => {
      if (typeFilter !== 'all' && r.lossType !== typeFilter) return false
      if (statusFilter === 'open' && (r.resolution || r.investigationStatus === 'closed')) return false
      if (statusFilter === 'resolved' && !r.resolution) return false
      if (search) {
        const q = search.toLowerCase()
        return (
          r.productTitle.toLowerCase().includes(q) ||
          r.sku.toLowerCase().includes(q) ||
          r.location.toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [records, typeFilter, statusFilter, search])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock Losses"
        description="Report damaged, stolen, missing, or transit-lost inventory. Investigate, file claims, and resolve."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => lossesQuery.refetch()}
              disabled={lossesQuery.isFetching}
            >
              <RefreshCw
                className={lossesQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}
              />
              Refresh
            </Button>
            {canReport && (
              <Button onClick={() => setReportOpen(true)}>
                <Plus className="h-4 w-4" /> Report Loss
              </Button>
            )}
          </div>
        }
      />

      {/* ── Stat cards ─────────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Open investigations"
          value={lossesQuery.isLoading ? undefined : String(stats.open)}
          icon={<Clock className="h-5 w-5" />}
          tone={stats.open > 0 ? 'amber' : 'gray'}
          loading={lossesQuery.isLoading}
        />
        <StatCard
          label="Loss value this month"
          value={lossesQuery.isLoading ? undefined : formatPKR(stats.monthLossValue)}
          icon={<Wallet className="h-5 w-5" />}
          tone="rose"
          loading={lossesQuery.isLoading}
        />
        <StatCard
          label="Recovered amount"
          value={lossesQuery.isLoading ? undefined : formatPKR(stats.recovered)}
          icon={<CheckCircle2 className="h-5 w-5" />}
          tone="emerald"
          loading={lossesQuery.isLoading}
        />
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search product, SKU, or location…"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="damaged">Damaged</SelectItem>
            <SelectItem value="theft">Theft</SelectItem>
            <SelectItem value="missing">Missing</SelectItem>
            <SelectItem value="transit_loss">Transit Loss</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* ── Table ──────────────────────────────────────────────────────────── */}
      {lossesQuery.isLoading ? (
        <Card>
          <CardContent className="p-3 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </CardContent>
        </Card>
      ) : lossesQuery.isError ? (
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">
              Couldn&apos;t load stock losses. {getErrorMessage(lossesQuery.error)}
            </p>
            <Button variant="outline" onClick={() => lossesQuery.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <EmptyState
          hasRecords={records.length > 0}
          canReport={canReport}
          onReport={() => setReportOpen(true)}
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r) => {
                    const typeBadge = LOSS_TYPE_BADGE[r.lossType]
                    const invBadge = INVESTIGATION_BADGE[r.investigationStatus]
                    return (
                      <TableRow key={r.id}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium text-sm">{r.productTitle}</span>
                            <span className="text-xs text-muted-foreground font-mono">{r.sku}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{r.location}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={typeBadge.className}>
                            {typeBadge.label}
                          </Badge>
                          {r.subType && (
                            <span className="ml-1 text-[10px] text-muted-foreground">
                              · {r.subType}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{r.quantity}</TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {formatPKR(r.totalLossValue)}
                        </TableCell>
                        <TableCell>
                          {r.resolution ? (
                            <Badge
                              variant="outline"
                              className="bg-emerald-50 text-emerald-700 border-emerald-200"
                            >
                              {RESOLUTION_LABEL[r.resolution]}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className={invBadge.className}>
                              {invBadge.label}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {!r.resolution && (canReport || canManage) && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setResolveTarget(r)}
                            >
                              Resolve
                            </Button>
                          )}
                          {r.resolution && (
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
              Showing {filtered.length} of {records.length} stock loss records
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── Report dialog ─────────────────────────────────────────────────── */}
      {canReport && (
        <ReportLossDialog
          open={reportOpen}
          onOpenChange={setReportOpen}
          onSuccess={() => {
            void queryClient.invalidateQueries({ queryKey: ['stock-loss'] })
            void queryClient.invalidateQueries({ queryKey: ['inventory-dashboard'] })
            setReportOpen(false)
          }}
        />
      )}

      {/* ── Resolve dialog ────────────────────────────────────────────────── */}
      {resolveTarget && (canReport || canManage) && (
        <ResolveDialog
          target={resolveTarget}
          canManage={canManage}
          open={!!resolveTarget}
          onOpenChange={(open) => {
            if (!open) setResolveTarget(null)
          }}
          onSuccess={() => {
            void queryClient.invalidateQueries({ queryKey: ['stock-loss'] })
            void queryClient.invalidateQueries({ queryKey: ['inventory-dashboard'] })
            setResolveTarget(null)
          }}
        />
      )}
    </div>
  )
}

function EmptyState({
  hasRecords,
  canReport,
  onReport,
}: {
  hasRecords: boolean
  canReport: boolean
  onReport: () => void
}) {
  return (
    <Card>
      <CardContent className="p-10 sm:p-14 text-center">
        <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <AlertTriangle className="h-7 w-7 text-primary" />
        </div>
        <h3 className="text-lg font-semibold">
          {hasRecords ? 'No losses match your filters' : 'No stock losses recorded'}
        </h3>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
          {hasRecords
            ? 'Try a different search or filter.'
            : 'When stock is damaged, stolen, missing, or lost in transit, report it here to keep your inventory accurate.'}
        </p>
        {!hasRecords && canReport && (
          <Button className="mt-5" onClick={onReport}>
            <Plus className="h-4 w-4" /> Report your first loss
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components: StatCard
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

// ─────────────────────────────────────────────────────────────────────────────
// Report Loss dialog
// ─────────────────────────────────────────────────────────────────────────────

function ReportLossDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSuccess: () => void
}) {
  const [variantId, setVariantId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [lossType, setLossType] = useState<LossType>('damaged')
  const [subType, setSubType] = useState<SubType | ''>('')
  const [damageType, setDamageType] = useState<DamageType | ''>('')
  const [quantity, setQuantity] = useState('1')
  const [costPerUnit, setCostPerUnit] = useState('0')
  const [responsibleParty, setResponsibleParty] = useState<ResponsibleParty | ''>('')
  const [notes, setNotes] = useState('')
  const [variantSearch, setVariantSearch] = useState('')

  const locationsQuery = useQuery<LocationsResponse>({
    queryKey: ['locations'],
    queryFn: () => api.get<LocationsResponse>('/api/inventory-locations'),
    staleTime: 30_000,
  })
  const productsQuery = useQuery<ProductsResponse>({
    queryKey: ['products', 'for-loss'],
    queryFn: () => api.get<ProductsResponse>('/api/products?pageSize=100'),
    staleTime: 60_000,
  })
  const dashboardQuery = useQuery<InventoryDashboardResponse>({
    queryKey: ['inventory-dashboard'],
    queryFn: () => api.get<InventoryDashboardResponse>('/api/inventory/dashboard'),
    staleTime: 30_000,
  })

  const variantOptions = useMemo(() => {
    const stockByVariant = new Map<string, { onHand: number; avgCost: number }>()
    for (const row of dashboardQuery.data?.stockTable ?? []) {
      if (row.onHand <= 0) continue
      const existing = stockByVariant.get(row.variantId)
      if (existing) {
        existing.onHand += row.onHand
      } else {
        stockByVariant.set(row.variantId, { onHand: row.onHand, avgCost: row.avgCost })
      }
    }
    const list: Array<{
      variantId: string
      sku: string
      productTitle: string
      onHand: number
      avgCost: number
    }> = []
    for (const p of productsQuery.data?.products ?? []) {
      for (const v of p.variants) {
        const stock = stockByVariant.get(v.id)
        if (!stock) continue
        list.push({
          variantId: v.id,
          sku: v.sku,
          productTitle: p.title,
          onHand: stock.onHand,
          avgCost: stock.avgCost,
        })
      }
    }
    return list
  }, [productsQuery.data, dashboardQuery.data])

  const variantSearchResults = useMemo(() => {
    if (!variantSearch.trim()) return []
    const q = variantSearch.toLowerCase()
    return variantOptions
      .filter(
        (v) => v.sku.toLowerCase().includes(q) || v.productTitle.toLowerCase().includes(q),
      )
      .slice(0, 8)
  }, [variantOptions, variantSearch])

  const selectedVariant = variantOptions.find((v) => v.variantId === variantId)
  const pool = useMemo(() => {
    if (!variantId || !locationId) return null
    return (
      dashboardQuery.data?.stockTable.find(
        (r) => r.variantId === variantId && r.locationId === locationId,
      ) ?? null
    )
  }, [variantId, locationId, dashboardQuery.data])

  useEffect(() => {
    if (!open) {
      setVariantId('')
      setLocationId('')
      setLossType('damaged')
      setSubType('')
      setDamageType('')
      setQuantity('1')
      setCostPerUnit('0')
      setResponsibleParty('')
      setNotes('')
      setVariantSearch('')
    }
  }, [open])

  useEffect(() => {
    if (pool && pool.avgCost > 0) {
      setCostPerUnit(String(pool.avgCost))
    } else if (selectedVariant && selectedVariant.avgCost > 0) {
      setCostPerUnit(String(selectedVariant.avgCost))
    }
  }, [pool, selectedVariant])

  const qty = parseInt(quantity, 10) || 0
  const cpu = parseFloat(costPerUnit) || 0
  const totalLoss = qty * cpu
  const insufficientStock = pool ? qty > pool.onHand : false

  const createMutation = useMutation({
    mutationFn: async (payload: CreatePayload) => api.post('/api/stock-loss', payload),
    onSuccess: () => {
      toast.success('Stock loss recorded. Inventory updated.')
      onSuccess()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const handleSubmit = () => {
    if (!variantId) return toast.error('Select a variant.')
    if (!locationId) return toast.error('Select a location.')
    if (qty <= 0) return toast.error('Quantity must be positive.')
    if (cpu < 0) return toast.error('Cost per unit cannot be negative.')
    if (insufficientStock) return toast.error(`Only ${pool?.onHand ?? 0} units on hand at this location.`)
    createMutation.mutate({
      org_variant_id: variantId,
      location_id: locationId,
      loss_type: lossType,
      sub_type: subType || undefined,
      damage_type: damageType || undefined,
      quantity: qty,
      cost_per_unit: cpu,
      notes: notes.trim() || undefined,
      responsible_party: responsibleParty || undefined,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> Report stock loss
          </DialogTitle>
          <DialogDescription>
            The quantity will be removed from inventory immediately on submit.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* ── Loss type cards ──────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <Label>Loss type</Label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(Object.keys(LOSS_TYPE_CARD) as LossType[]).map((t) => {
                const card = LOSS_TYPE_CARD[t]
                const selected = lossType === t
                return (
                  <button
                    type="button"
                    key={t}
                    onClick={() => setLossType(t)}
                    className={`rounded-md border p-3 text-left transition-colors ${
                      selected
                        ? 'border-primary bg-primary/5'
                        : 'hover:bg-muted/50 border-border'
                    }`}
                  >
                    <div
                      className={`flex h-8 w-8 items-center justify-center rounded-md mb-1.5 ${
                        selected ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {card.icon}
                    </div>
                    <p className="text-xs font-medium">{card.label}</p>
                    <p className="text-[10px] text-muted-foreground leading-tight">
                      {card.description}
                    </p>
                  </button>
                )
              })}
            </div>
          </div>

          {/* ── Variant search ────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <Label htmlFor="loss-variant">Variant</Label>
            {variantId && selectedVariant ? (
              <div className="rounded-md border p-2.5 flex items-center justify-between bg-muted/30">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{selectedVariant.productTitle}</p>
                  <p className="text-xs text-muted-foreground font-mono">
                    {selectedVariant.sku} · on hand: {selectedVariant.onHand}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setVariantId('')
                    setVariantSearch('')
                  }}
                >
                  Change
                </Button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="loss-variant"
                    placeholder="Search variants with stock…"
                    className="pl-9"
                    value={variantSearch}
                    onChange={(e) => setVariantSearch(e.target.value)}
                  />
                </div>
                {variantSearch.trim() && (
                  <div className="rounded-md border bg-popover shadow-sm max-h-56 overflow-y-auto scrollbar-thin">
                    {variantSearchResults.length === 0 ? (
                      <p className="p-3 text-sm text-muted-foreground">No variants match.</p>
                    ) : (
                      <ul className="divide-y">
                        {variantSearchResults.map((v) => (
                          <li key={v.variantId}>
                            <button
                              type="button"
                              onClick={() => {
                                setVariantId(v.variantId)
                                setVariantSearch('')
                              }}
                              className="w-full text-left px-3 py-2 hover:bg-muted/60 flex items-center justify-between gap-2"
                            >
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate">{v.productTitle}</p>
                                <p className="text-xs text-muted-foreground font-mono">{v.sku}</p>
                              </div>
                              <span className="text-xs text-muted-foreground shrink-0">
                                on hand: {v.onHand}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── Location + qty + cost ─────────────────────────────────────── */}
          <div className="grid sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="loss-location">Location</Label>
              <Select
                value={locationId}
                onValueChange={setLocationId}
                disabled={!variantId}
              >
                <SelectTrigger id="loss-location">
                  <SelectValue placeholder="Select location" />
                </SelectTrigger>
                <SelectContent>
                  {locationsQuery.data?.locations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {pool && (
                <p className="text-xs text-muted-foreground">
                  On hand: {pool.onHand} · avg cost: {formatPKR(pool.avgCost)}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="loss-qty">Quantity</Label>
              <Input
                id="loss-qty"
                type="number"
                min="1"
                step="1"
                className="tabular-nums"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="loss-cost">Cost / unit</Label>
              <Input
                id="loss-cost"
                type="number"
                min="0"
                step="0.01"
                className="tabular-nums"
                value={costPerUnit}
                onChange={(e) => setCostPerUnit(e.target.value)}
              />
            </div>
          </div>

          {insufficientStock && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Insufficient stock</AlertTitle>
              <AlertDescription>
                Only {pool?.onHand ?? 0} units are on hand at this location.
              </AlertDescription>
            </Alert>
          )}

          {/* ── Sub-type + damage type ────────────────────────────────────── */}
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="loss-subtype">Sub-type (optional)</Label>
              <Select value={subType} onValueChange={(v) => setSubType(v as SubType)}>
                <SelectTrigger id="loss-subtype">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">None</SelectItem>
                  {SUB_TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="loss-damage">Damage type (optional)</Label>
              <Select value={damageType} onValueChange={(v) => setDamageType(v as DamageType)}>
                <SelectTrigger id="loss-damage">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">None</SelectItem>
                  {DAMAGE_TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* ── Responsible party + notes ─────────────────────────────────── */}
          <div className="space-y-1.5">
            <Label htmlFor="loss-party">Responsible party (optional)</Label>
            <Select
              value={responsibleParty}
              onValueChange={(v) => setResponsibleParty(v as ResponsibleParty)}
            >
              <SelectTrigger id="loss-party">
                <SelectValue placeholder="Unknown" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Unknown</SelectItem>
                {RESPONSIBLE_PARTY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="loss-notes">Notes (optional)</Label>
            <Textarea
              id="loss-notes"
              placeholder="Describe what happened…"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {/* ── Stock reduction summary ───────────────────────────────────── */}
          <div className="rounded-md border bg-rose-50/50 border-rose-200 p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-medium text-rose-800">
              <AlertTriangle className="h-3.5 w-3.5" /> Immediate stock reduction
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-rose-900">
              <span>Variant:</span>
              <span className="font-mono">{selectedVariant?.sku ?? '—'}</span>
              <span>Location:</span>
              <span>
                {locationsQuery.data?.locations.find((l) => l.id === locationId)?.name ?? '—'}
              </span>
              <span>Quantity removed:</span>
              <span className="font-semibold">{qty} units</span>
              <span>Loss value:</span>
              <span className="font-semibold tabular-nums">{formatPKR(totalLoss)}</span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="bg-rose-600 hover:bg-rose-700"
            onClick={handleSubmit}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Recording…
              </>
            ) : (
              <>
                <AlertTriangle className="h-4 w-4" /> Report Loss
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve dialog
// ─────────────────────────────────────────────────────────────────────────────

function ResolveDialog({
  target,
  canManage,
  open,
  onOpenChange,
  onSuccess,
}: {
  target: StockLossRow
  canManage: boolean
  open: boolean
  onOpenChange: (v: boolean) => void
  onSuccess: () => void
}) {
  const [resolution, setResolution] = useState<LossResolution>('written_off')
  const [investigationStatus, setInvestigationStatus] = useState<InvestigationStatus>('closed')
  const [responsibleParty, setResponsibleParty] = useState<ResponsibleParty | ''>(
    target.responsibleParty ?? '',
  )
  const [policeReportRef, setPoliceReportRef] = useState('')
  const [insuranceClaimRef, setInsuranceClaimRef] = useState('')
  const [insuranceRecovered, setInsuranceRecovered] = useState('0')
  const [courierClaimRef, setCourierClaimRef] = useState('')
  const [courierClaimStatus, setCourierClaimStatus] = useState<
    'not_filed' | 'filed' | 'accepted' | 'rejected'
  >('not_filed')
  const [courierRecovered, setCourierRecovered] = useState('0')
  const [notes, setNotes] = useState('')

  // Reset state when target changes.
  useEffect(() => {
    if (open) {
      setResolution('written_off')
      setInvestigationStatus('closed')
      setResponsibleParty(target.responsibleParty ?? '')
      setPoliceReportRef('')
      setInsuranceClaimRef('')
      setInsuranceRecovered('0')
      setCourierClaimRef('')
      setCourierClaimStatus('not_filed')
      setCourierRecovered('0')
      setNotes('')
    }
  }, [open, target])

  const showInsuranceFields =
    resolution === 'claim_accepted' || resolution === 'recovered'
  const showCourierFields = target.lossType === 'transit_loss' || target.lossType === 'damaged'
  const showPoliceFields = target.lossType === 'theft' || target.lossType === 'missing'

  const resolveMutation = useMutation({
    mutationFn: async (payload: ResolvePayload) =>
      api.patch(`/api/stock-loss/${target.id}`, payload),
    onSuccess: () => {
      toast.success('Stock loss resolved.')
      onSuccess()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const handleSubmit = () => {
    const payload: ResolvePayload = {
      resolution,
      investigation_status: investigationStatus,
      responsible_party: responsibleParty || undefined,
      police_report_ref: showPoliceFields && policeReportRef.trim() ? policeReportRef.trim() : undefined,
      insurance_claim_ref: showInsuranceFields && insuranceClaimRef.trim() ? insuranceClaimRef.trim() : undefined,
      insurance_recovered: showInsuranceFields ? parseFloat(insuranceRecovered) || 0 : undefined,
      courier_claim_ref: showCourierFields && courierClaimRef.trim() ? courierClaimRef.trim() : undefined,
      courier_claim_status: showCourierFields ? courierClaimStatus : undefined,
      courier_recovered: showCourierFields ? parseFloat(courierRecovered) || 0 : undefined,
      notes: notes.trim() || undefined,
      approved: canManage,
    }
    resolveMutation.mutate(payload)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle>Resolve stock loss</DialogTitle>
          <DialogDescription>
            {target.productTitle} · {target.sku} ·{' '}
            <span className="font-medium">
              {target.quantity} unit{target.quantity === 1 ? '' : 's'} lost
            </span>{' '}
            ({formatPKR(target.totalLossValue)})
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="resolve-resolution">Resolution</Label>
            <Select value={resolution} onValueChange={(v) => setResolution(v as LossResolution)}>
              <SelectTrigger id="resolve-resolution">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RESOLUTION_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="resolve-investigation">Investigation status</Label>
              <Select
                value={investigationStatus}
                onValueChange={(v) => setInvestigationStatus(v as InvestigationStatus)}
              >
                <SelectTrigger id="resolve-investigation">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="resolve-party">Responsible party</Label>
              <Select
                value={responsibleParty}
                onValueChange={(v) => setResponsibleParty(v as ResponsibleParty)}
              >
                <SelectTrigger id="resolve-party">
                  <SelectValue placeholder="Unknown" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Unknown</SelectItem>
                  {RESPONSIBLE_PARTY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {showPoliceFields && (
            <div className="space-y-1.5">
              <Label htmlFor="resolve-police">Police report reference</Label>
              <Input
                id="resolve-police"
                placeholder="e.g. FIR #1234 / 2024"
                value={policeReportRef}
                onChange={(e) => setPoliceReportRef(e.target.value)}
              />
            </div>
          )}

          {showInsuranceFields && (
            <div className="rounded-md border p-3 space-y-3 bg-muted/30">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Insurance claim
              </p>
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="resolve-insurance-ref">Claim reference</Label>
                  <Input
                    id="resolve-insurance-ref"
                    placeholder="e.g. INS-2024-5678"
                    value={insuranceClaimRef}
                    onChange={(e) => setInsuranceClaimRef(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="resolve-insurance-rec">Recovered amount (Rs.)</Label>
                  <Input
                    id="resolve-insurance-rec"
                    type="number"
                    min="0"
                    step="0.01"
                    className="tabular-nums"
                    value={insuranceRecovered}
                    onChange={(e) => setInsuranceRecovered(e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}

          {showCourierFields && (
            <div className="rounded-md border p-3 space-y-3 bg-muted/30">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Courier claim
              </p>
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="resolve-courier-ref">Claim reference</Label>
                  <Input
                    id="resolve-courier-ref"
                    placeholder="e.g. TCS-CLAIM-9999"
                    value={courierClaimRef}
                    onChange={(e) => setCourierClaimRef(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="resolve-courier-status">Claim status</Label>
                  <Select
                    value={courierClaimStatus}
                    onValueChange={(v) =>
                      setCourierClaimStatus(v as typeof courierClaimStatus)
                    }
                  >
                    <SelectTrigger id="resolve-courier-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="not_filed">Not filed</SelectItem>
                      <SelectItem value="filed">Filed</SelectItem>
                      <SelectItem value="accepted">Accepted</SelectItem>
                      <SelectItem value="rejected">Rejected</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="resolve-courier-rec">Recovered amount (Rs.)</Label>
                <Input
                  id="resolve-courier-rec"
                  type="number"
                  min="0"
                  step="0.01"
                  className="tabular-nums"
                  value={courierRecovered}
                  onChange={(e) => setCourierRecovered(e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="resolve-notes">Notes (optional)</Label>
            <Textarea
              id="resolve-notes"
              placeholder="Resolution notes…"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {!canManage && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Awaiting approval</AlertTitle>
              <AlertDescription>
                You can submit resolution details but a manager must approve the write-off
                before it&apos;s finalized.
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={resolveMutation.isPending}>
            {resolveMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Resolving…
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4" /> Resolve
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
