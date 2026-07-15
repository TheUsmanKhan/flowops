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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
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
  ShieldAlert,
  PackageMinus,
  Truck,
  Building2,
  Droplets,
  Eye,
  CheckCircle2,
  Clock,
  Package,
  ShieldQuestion,
  Undo2,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types — match GET /api/stock-loss, /api/stock-loss/stats, /api/stock-loss/[id]
// ─────────────────────────────────────────────────────────────────────────────

type LossType = 'damaged' | 'theft' | 'missing' | 'transit_loss' | 'supplier_dispute'
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
type ResponsibleParty =
  | 'warehouse'
  | 'courier'
  | 'customer'
  | 'employee'
  | 'unknown'
  | 'supplier'

interface StockLossRow {
  id: string
  productTitle: string
  sku: string
  location: string
  lossType: LossType
  subType: SubType | null
  damageType: DamageType | null
  quantity: number
  costPerUnit: number
  totalLossValue: number
  investigationStatus: InvestigationStatus
  resolution: LossResolution | null
  responsibleParty: ResponsibleParty | null
  courierClaimStatus: 'not_filed' | 'filed' | 'accepted' | 'rejected' | null
  courierRecovered: number
  inventoryTxnId: string | null
  supplierReturnId: string | null
  supplierReturn: { id: string; supplierName: string } | null
  reportedBy: string
  createdAt: string
  resolvedAt: string | null
}

interface StockLossListResponse {
  records: StockLossRow[]
}

interface LossTypeStat {
  count: number
  value: number
  quantity: number
}

interface StockLossStatsResponse {
  stats: {
    damaged: LossTypeStat
    theft: LossTypeStat
    missing: LossTypeStat
    transit_loss: LossTypeStat
    supplier_dispute: LossTypeStat
  }
  activeInvestigations: number
  pendingCourierClaims: number
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
    reserved: number
    available: number
    avgCost: number
  }>
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload shapes — match /lib/validations/stock-loss.ts
// ─────────────────────────────────────────────────────────────────────────────

interface DamagedPayload {
  org_variant_id: string
  location_id: string
  quantity: number
  damage_type: DamageType
  responsible_party: 'warehouse' | 'courier' | 'customer' | 'employee'
  evidence_urls: string[]
  notes?: string
}

interface TheftPayload {
  org_variant_id: string
  location_id: string
  quantity: number
  sub_type: 'confirmed' | 'suspected'
  police_report_ref?: string
  evidence_urls: string[]
  notes?: string
}

interface TransitPayload {
  org_variant_id: string
  location_id: string
  quantity: number
  order_reference_id: string
  courier_claim_ref?: string
  notes?: string
}

interface ResolveTheftPayload {
  loss_id: string
  resolution: 'written_off' | 'recovered' | 'error_corrected'
  notes?: string
}

interface ResolveTransitPayload {
  loss_id: string
  resolution: 'claim_accepted' | 'claim_rejected'
  courier_recovered?: number
  notes?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Display maps
// ─────────────────────────────────────────────────────────────────────────────

const LOSS_TYPE_BADGE: Record<LossType, { label: string; className: string }> = {
  damaged: {
    label: 'Damaged',
    className: 'bg-orange-50 text-orange-700 border-orange-200',
  },
  theft: { label: 'Theft', className: 'bg-rose-50 text-rose-700 border-rose-200' },
  missing: {
    label: 'Missing',
    className: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  transit_loss: {
    label: 'Transit Loss',
    className: 'bg-purple-50 text-purple-700 border-purple-200',
  },
  supplier_dispute: {
    label: 'Supplier Dispute',
    className: 'bg-slate-100 text-slate-700 border-slate-300',
  },
}

const LOSS_TYPE_ICON: Record<LossType, React.ReactNode> = {
  damaged: <Droplets className="h-5 w-5" />,
  theft: <ShieldAlert className="h-5 w-5" />,
  missing: <PackageMinus className="h-5 w-5" />,
  transit_loss: <Truck className="h-5 w-5" />,
  supplier_dispute: <Building2 className="h-5 w-5" />,
}

const LOSS_TYPE_TONE: Record<LossType, string> = {
  damaged: 'bg-orange-50 text-orange-600',
  theft: 'bg-rose-50 text-rose-600',
  missing: 'bg-amber-50 text-amber-600',
  transit_loss: 'bg-purple-50 text-purple-600',
  supplier_dispute: 'bg-slate-100 text-slate-600',
}

const RESOLUTION_LABEL: Record<LossResolution, string> = {
  written_off: 'Written Off',
  recovered: 'Recovered',
  error_corrected: 'Error Corrected',
  claim_accepted: 'Claim Accepted',
  claim_rejected: 'Claim Rejected',
}

const RESOLUTION_BADGE: Record<LossResolution, string> = {
  written_off: 'bg-rose-50 text-rose-700 border-rose-200',
  recovered: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  error_corrected: 'bg-sky-50 text-sky-700 border-sky-200',
  claim_accepted: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  claim_rejected: 'bg-slate-100 text-slate-700 border-slate-300',
}

const DAMAGE_TYPE_OPTIONS: { value: DamageType; label: string }[] = [
  { value: 'water_moisture', label: 'Water / Moisture' },
  { value: 'physical_impact', label: 'Physical Impact' },
  { value: 'manufacturing_defect', label: 'Manufacturing Defect' },
  { value: 'transit_damage', label: 'Transit Damage' },
  { value: 'storage_damage', label: 'Storage Damage' },
  { value: 'other', label: 'Other' },
]

const RESPONSIBLE_PARTY_OPTIONS: {
  value: 'warehouse' | 'courier' | 'customer' | 'employee'
  label: string
}[] = [
  { value: 'warehouse', label: 'Warehouse' },
  { value: 'courier', label: 'Courier' },
  { value: 'customer', label: 'Customer' },
  { value: 'employee', label: 'Employee' },
]

const RESPONSIBLE_PARTY_LABEL: Record<ResponsibleParty, string> = {
  warehouse: 'Warehouse',
  courier: 'Courier',
  customer: 'Customer',
  employee: 'Employee',
  unknown: 'Unknown',
  supplier: 'Supplier',
}

const INVESTIGATION_BADGE: Record<InvestigationStatus, { label: string; className: string }> = {
  none: { label: 'No Investigation', className: 'bg-gray-100 text-gray-700 border-gray-200' },
  open: { label: 'Open', className: 'bg-sky-50 text-sky-700 border-sky-200' },
  closed: { label: 'Closed', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
}

const LOSS_TYPE_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All Types' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'theft', label: 'Theft' },
  { value: 'missing', label: 'Missing' },
  { value: 'transit_loss', label: 'Transit Loss' },
  { value: 'supplier_dispute', label: 'Supplier Dispute' },
]

const STATUS_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All Statuses' },
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
]

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

/** Can the user resolve this loss row from the list? */
function canResolveRow(r: StockLossRow): boolean {
  if (r.lossType === 'supplier_dispute') return false
  if (r.lossType === 'damaged') return false
  if (r.lossType === 'theft' || r.lossType === 'missing') {
    return r.investigationStatus === 'open'
  }
  if (r.lossType === 'transit_loss') {
    return r.resolution === null
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function LossesView() {
  const can = useCan()
  const queryClient = useQueryClient()
  const navigate = useAppStore((s) => s.navigate)

  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [reportOpen, setReportOpen] = useState(false)
  const [resolveTarget, setResolveTarget] = useState<StockLossRow | null>(null)

  const canReport = can(PERMISSIONS.INVENTORY_REPORT_LOSS)
  const canManage = can(PERMISSIONS.INVENTORY_MANAGE_LOSS)

  const lossesQuery = useQuery<StockLossListResponse>({
    queryKey: ['stock-losses', typeFilter, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams()
      if (typeFilter !== 'all') params.set('loss_type', typeFilter)
      if (statusFilter !== 'all') params.set('investigation_status', statusFilter)
      const qs = params.toString()
      return api.get<StockLossListResponse>(`/api/stock-loss${qs ? `?${qs}` : ''}`)
    },
    staleTime: 15_000,
  })

  const statsQuery = useQuery<StockLossStatsResponse>({
    queryKey: ['stock-losses', 'stats'],
    queryFn: () => api.get<StockLossStatsResponse>('/api/stock-loss/stats'),
    staleTime: 30_000,
  })

  const records = lossesQuery.data?.records ?? []
  const stats = statsQuery.data

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['stock-losses'] })
    void queryClient.invalidateQueries({ queryKey: ['inventory-dashboard'] })
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock Losses"
        description="Report damaged, stolen, or transit-lost inventory. Investigate thefts, file courier claims, and resolve open cases."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void lossesQuery.refetch()
                void statsQuery.refetch()
              }}
              disabled={lossesQuery.isFetching || statsQuery.isFetching}
            >
              <RefreshCw
                className={
                  lossesQuery.isFetching || statsQuery.isFetching
                    ? 'h-4 w-4 animate-spin'
                    : 'h-4 w-4'
                }
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

      {/* ── Stat cards: 5 loss types this month ──────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          label="Damaged this month"
          count={stats?.stats.damaged.count}
          value={stats?.stats.damaged.value}
          quantity={stats?.stats.damaged.quantity}
          icon={LOSS_TYPE_ICON.damaged}
          tone="damaged"
          loading={statsQuery.isLoading}
        />
        <StatCard
          label="Theft this month"
          count={stats?.stats.theft.count}
          value={stats?.stats.theft.value}
          quantity={stats?.stats.theft.quantity}
          icon={LOSS_TYPE_ICON.theft}
          tone="theft"
          loading={statsQuery.isLoading}
        />
        <StatCard
          label="Missing this month"
          count={stats?.stats.missing.count}
          value={stats?.stats.missing.value}
          quantity={stats?.stats.missing.quantity}
          icon={LOSS_TYPE_ICON.missing}
          tone="missing"
          loading={statsQuery.isLoading}
        />
        <StatCard
          label="Transit Loss this month"
          count={stats?.stats.transit_loss.count}
          value={stats?.stats.transit_loss.value}
          quantity={stats?.stats.transit_loss.quantity}
          icon={LOSS_TYPE_ICON.transit_loss}
          tone="transit_loss"
          loading={statsQuery.isLoading}
        />
        <StatCard
          label="Supplier Disputes this month"
          count={stats?.stats.supplier_dispute.count}
          value={stats?.stats.supplier_dispute.value}
          quantity={stats?.stats.supplier_dispute.quantity}
          icon={LOSS_TYPE_ICON.supplier_dispute}
          tone="supplier_dispute"
          loading={statsQuery.isLoading}
        />
      </div>

      {/* ── Count badges: active investigations + pending courier claims ── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <CountCard
          label="Active Investigations"
          count={stats?.activeInvestigations}
          icon={<ShieldQuestion className="h-4 w-4" />}
          tone="sky"
          loading={statsQuery.isLoading}
          description="Open theft / missing cases awaiting resolution"
        />
        <CountCard
          label="Pending Courier Claims"
          count={stats?.pendingCourierClaims}
          icon={<Truck className="h-4 w-4" />}
          tone="purple"
          loading={statsQuery.isLoading}
          description="Transit losses with unresolved courier claims"
        />
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-full sm:w-56">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            {LOSS_TYPE_FILTER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ── Table ──────────────────────────────────────────────────────── */}
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
      ) : records.length === 0 ? (
        <EmptyState hasRecords={false} canReport={canReport} onReport={() => setReportOpen(true)} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product / Variant</TableHead>
                    <TableHead>Loss Type</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead>Responsible</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Reported By</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.map((r) => {
                    const typeBadge = LOSS_TYPE_BADGE[r.lossType]
                    const invBadge =
                      INVESTIGATION_BADGE[r.investigationStatus] ?? INVESTIGATION_BADGE.none
                    const showResolve = canResolveRow(r) && canManage
                    const isSupplierDispute = r.lossType === 'supplier_dispute'
                    return (
                      <TableRow key={r.id}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium text-sm">{r.productTitle}</span>
                            <span className="text-xs text-muted-foreground font-mono">{r.sku}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={typeBadge.className}>
                            {typeBadge.label}
                          </Badge>
                          {r.subType && (
                            <span className="ml-1 text-[10px] text-muted-foreground capitalize">
                              · {r.subType.replace('_', ' ')}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{r.quantity}</TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {formatPKR(r.totalLossValue)}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {r.responsibleParty
                            ? RESPONSIBLE_PARTY_LABEL[r.responsibleParty]
                            : '—'}
                        </TableCell>
                        <TableCell>
                          {r.resolution ? (
                            <Badge variant="outline" className={RESOLUTION_BADGE[r.resolution]}>
                              {RESOLUTION_LABEL[r.resolution]}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className={invBadge.className}>
                              {invBadge.label}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {r.reportedBy}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {formatDate(r.createdAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                navigate({ name: 'inventory-loss-detail', id: r.id })
                              }
                            >
                              <Eye className="h-3.5 w-3.5" /> View
                            </Button>
                            {isSupplierDispute ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  navigate({ name: 'inventory-supplier-returns' })
                                }
                              >
                                <Undo2 className="h-3.5 w-3.5" /> View Return
                              </Button>
                            ) : showResolve ? (
                              <Button size="sm" onClick={() => setResolveTarget(r)}>
                                Resolve
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground p-3">
              Showing {records.length} stock loss record{records.length === 1 ? '' : 's'}.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── Report Loss dialog ─────────────────────────────────────────── */}
      {canReport && (
        <ReportLossDialog
          open={reportOpen}
          onOpenChange={setReportOpen}
          onSuccess={invalidateAll}
        />
      )}

      {/* ── Resolve dialog ─────────────────────────────────────────────── */}
      {resolveTarget && canManage && (
        <ResolveDialog
          target={resolveTarget}
          open={!!resolveTarget}
          onOpenChange={(open) => {
            if (!open) setResolveTarget(null)
          }}
          onSuccess={() => {
            invalidateAll()
            setResolveTarget(null)
          }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components: StatCard, CountCard, EmptyState
// ─────────────────────────────────────────────────────────────────────────────

function StatCard({
  label,
  count,
  value,
  quantity,
  icon,
  tone,
  loading,
}: {
  label: string
  count?: number
  value?: number
  quantity?: number
  icon: React.ReactNode
  tone: LossType
  loading?: boolean
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-lg ${LOSS_TYPE_TONE[tone]}`}
          >
            {icon}
          </div>
          {loading ? (
            <Skeleton className="h-7 w-16" />
          ) : (
            <span className="text-2xl font-semibold tracking-tight tabular-nums">
              {count ?? 0}
            </span>
          )}
        </div>
        <p className="mt-3 text-sm font-medium">{label}</p>
        {loading ? (
          <Skeleton className="mt-1.5 h-3.5 w-28" />
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            {formatPKR(value ?? 0)} · {quantity ?? 0} unit{quantity === 1 ? '' : 's'}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

const COUNT_TONE_CLASSES: Record<'sky' | 'purple', { wrap: string; value: string }> = {
  sky: { wrap: 'bg-sky-50 text-sky-600', value: 'text-sky-700' },
  purple: { wrap: 'bg-purple-50 text-purple-600', value: 'text-purple-700' },
}

function CountCard({
  label,
  count,
  icon,
  tone,
  loading,
  description,
}: {
  label: string
  count?: number
  icon: React.ReactNode
  tone: 'sky' | 'purple'
  loading?: boolean
  description: string
}) {
  const tones = COUNT_TONE_CLASSES[tone]
  return (
    <Card>
      <CardContent className="p-5 flex items-center gap-4">
        <div
          className={`flex h-12 w-12 items-center justify-center rounded-lg shrink-0 ${tones.wrap}`}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={`text-2xl font-semibold tabular-nums ${tones.value}`}>
              {loading ? '—' : count ?? 0}
            </span>
            <span className="text-sm font-medium text-foreground">{label}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
      </CardContent>
    </Card>
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
            ? 'Try a different type or status filter.'
            : 'When stock is damaged, stolen, or lost in transit, report it here to keep your inventory accurate.'}
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
// Variant picker — shared by Damaged/Theft/Transit forms
// ─────────────────────────────────────────────────────────────────────────────

interface VariantOption {
  variantId: string
  sku: string
  productTitle: string
  onHand: number
  reserved: number
  available: number
  avgCost: number
}

function useVariantAndLocationData() {
  const locationsQuery = useQuery<LocationsResponse>({
    queryKey: ['inventory-locations'],
    queryFn: () => api.get<LocationsResponse>('/api/inventory-locations'),
    staleTime: 60_000,
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

  const variantOptions = useMemo<VariantOption[]>(() => {
    const stockByVariant = new Map<string, VariantOption>()
    for (const row of dashboardQuery.data?.stockTable ?? []) {
      const existing = stockByVariant.get(row.variantId)
      if (existing) {
        existing.onHand += row.onHand
        existing.reserved += row.reserved
        existing.available += row.available
        // avgCost: keep the max (most recently updated) for display
        if (row.avgCost > existing.avgCost) existing.avgCost = row.avgCost
      } else {
        stockByVariant.set(row.variantId, {
          variantId: row.variantId,
          sku: row.sku,
          productTitle: row.productTitle,
          onHand: row.onHand,
          reserved: row.reserved,
          available: row.available,
          avgCost: row.avgCost,
        })
      }
    }
    const list: VariantOption[] = []
    for (const p of productsQuery.data?.products ?? []) {
      for (const v of p.variants) {
        const stock = stockByVariant.get(v.id)
        // Include all variants, even with no stock — but mark onHand=0
        list.push({
          variantId: v.id,
          sku: v.sku,
          productTitle: p.title,
          onHand: stock?.onHand ?? 0,
          reserved: stock?.reserved ?? 0,
          available: stock?.available ?? 0,
          avgCost: stock?.avgCost ?? v.costPrice,
        })
      }
    }
    return list
  }, [productsQuery.data, dashboardQuery.data])

  /** Locations where a variant has stock — used for Damaged/Theft. */
  const locationsForVariant = useMemo(() => {
    const map = new Map<string, { locationId: string; onHand: number; available: number }[]>()
    for (const row of dashboardQuery.data?.stockTable ?? []) {
      if (row.onHand <= 0) continue
      const list = map.get(row.variantId) ?? []
      list.push({
        locationId: row.locationId,
        onHand: row.onHand,
        available: row.available,
      })
      map.set(row.variantId, list)
    }
    return map
  }, [dashboardQuery.data])

  /** Per-pool stock (variantId+locationId) for validation. */
  const poolMap = useMemo(() => {
    const map = new Map<string, { onHand: number; available: number; avgCost: number }>()
    for (const row of dashboardQuery.data?.stockTable ?? []) {
      map.set(`${row.variantId}|${row.locationId}`, {
        onHand: row.onHand,
        available: row.available,
        avgCost: row.avgCost,
      })
    }
    return map
  }, [dashboardQuery.data])

  return {
    locations: locationsQuery.data?.locations ?? [],
    variantOptions,
    locationsForVariant,
    poolMap,
    isLoading:
      locationsQuery.isLoading || productsQuery.isLoading || dashboardQuery.isLoading,
  }
}

function VariantPicker({
  variantId,
  onSelect,
  variantOptions,
  disabled,
}: {
  variantId: string
  onSelect: (id: string) => void
  variantOptions: VariantOption[]
  disabled?: boolean
}) {
  const [search, setSearch] = useState('')
  const selected = variantOptions.find((v) => v.variantId === variantId)

  const results = useMemo(() => {
    if (!search.trim()) return []
    const q = search.toLowerCase()
    return variantOptions
      .filter((v) => v.sku.toLowerCase().includes(q) || v.productTitle.toLowerCase().includes(q))
      .slice(0, 8)
  }, [search, variantOptions])

  if (selected) {
    return (
      <div className="rounded-md border p-2.5 flex items-center justify-between bg-muted/30 gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{selected.productTitle}</p>
          <p className="text-xs text-muted-foreground font-mono">
            {selected.sku} · on hand: {selected.onHand}
            {selected.reserved > 0 && ` · reserved: ${selected.reserved}`}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onSelect('')
            setSearch('')
          }}
          disabled={disabled}
        >
          Change
        </Button>
      </div>
    )
  }

  return (
    <>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search variants by SKU or product name…"
          className="pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={disabled}
        />
      </div>
      {search.trim() && (
        <div className="rounded-md border bg-popover shadow-sm max-h-56 overflow-y-auto scrollbar-thin">
          {results.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No variants match.</p>
          ) : (
            <ul className="divide-y">
              {results.map((v) => (
                <li key={v.variantId}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(v.variantId)
                      setSearch('')
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
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Report Loss dialog — type picker + 3 forms
// ─────────────────────────────────────────────────────────────────────────────

type ReportStage = 'select' | 'damaged' | 'theft' | 'transit'

const REPORT_TYPE_CARDS: {
  stage: Exclude<ReportStage, 'select'>
  emoji: string
  label: string
  description: string
}[] = [
  {
    stage: 'damaged',
    emoji: '💧',
    label: 'Damaged',
    description: 'Product was physically damaged',
  },
  {
    stage: 'theft',
    emoji: '🚨',
    label: 'Theft',
    description: 'Stock was stolen',
  },
  {
    stage: 'transit',
    emoji: '📦',
    label: 'Transit Loss',
    description: 'Courier lost the shipment',
  },
]

function ReportLossDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSuccess: () => void
}) {
  const [stage, setStage] = useState<ReportStage>('select')

  useEffect(() => {
    if (!open) {
      // Reset to picker when dialog closes (after a small delay so users see the success animation)
      const t = setTimeout(() => setStage('select'), 200)
      return () => clearTimeout(t)
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[92vh] overflow-y-auto scrollbar-thin">
        {stage === 'select' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" /> Report a stock loss
              </DialogTitle>
              <DialogDescription>
                Choose the type of loss you need to record. Each type has different inventory and
                financial impact.
              </DialogDescription>
            </DialogHeader>

            <div className="grid sm:grid-cols-3 gap-3 pt-2">
              {REPORT_TYPE_CARDS.map((c) => (
                <button
                  key={c.stage}
                  type="button"
                  onClick={() => setStage(c.stage)}
                  className="rounded-lg border border-border p-4 text-left transition-colors hover:border-primary hover:bg-primary/5 focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <div className="text-3xl mb-2">{c.emoji}</div>
                  <p className="text-sm font-semibold">{c.label}</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-snug">{c.description}</p>
                </button>
              ))}
            </div>

            <Alert className="bg-amber-50/50 border-amber-200 text-amber-900">
              <Package className="h-4 w-4" />
              <AlertDescription className="text-xs">
                Missing stock is reported through <strong>Cycle Counts</strong>, not here. Run a
                count, submit discrepancies, and any unexplained shortage will be flagged for
                investigation.
              </AlertDescription>
            </Alert>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        )}

        {stage === 'damaged' && (
          <DamagedForm
            onBack={() => setStage('select')}
            onSuccess={() => {
              onSuccess()
              onOpenChange(false)
            }}
          />
        )}
        {stage === 'theft' && (
          <TheftForm
            onBack={() => setStage('select')}
            onSuccess={() => {
              onSuccess()
              onOpenChange(false)
            }}
          />
        )}
        {stage === 'transit' && (
          <TransitForm
            onBack={() => setStage('select')}
            onSuccess={() => {
              onSuccess()
              onOpenChange(false)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// DAMAGED form — single-stage instant write-off
// ─────────────────────────────────────────────────────────────────────────────

function DamagedForm({ onBack, onSuccess }: { onBack: () => void; onSuccess: () => void }) {
  const data = useVariantAndLocationData()

  const [variantId, setVariantId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [damageType, setDamageType] = useState<DamageType | ''>('')
  const [responsibleParty, setResponsibleParty] = useState<
    'warehouse' | 'courier' | 'customer' | 'employee' | ''
  >('')
  const [notes, setNotes] = useState('')

  const selectedVariant = data.variantOptions.find((v) => v.variantId === variantId)
  const pool = variantId && locationId ? data.poolMap.get(`${variantId}|${locationId}`) : null

  // Reset location when variant changes
  useEffect(() => {
    setLocationId('')
  }, [variantId])

  const qty = parseInt(quantity, 10) || 0
  const writeOffValue = qty * (pool?.avgCost ?? selectedVariant?.avgCost ?? 0)
  const availableAtPool = pool?.available ?? 0
  const insufficient = pool !== null && qty > availableAtPool

  const mutation = useMutation({
    mutationFn: async (payload: DamagedPayload) =>
      api.post('/api/stock-loss/report-damaged', payload),
    onSuccess: () => {
      toast.success('Damaged stock written off. Available inventory reduced.')
      onSuccess()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const handleSubmit = () => {
    if (!variantId) return toast.error('Select a variant.')
    if (!locationId) return toast.error('Select a location.')
    if (qty <= 0) return toast.error('Quantity must be positive.')
    if (!damageType) return toast.error('Select a damage type.')
    if (!responsibleParty) return toast.error('Select a responsible party.')
    if (insufficient)
      return toast.error(
        `Only ${availableAtPool} units available at this location.`,
      )
    mutation.mutate({
      org_variant_id: variantId,
      location_id: locationId,
      quantity: qty,
      damage_type: damageType,
      responsible_party: responsibleParty,
      evidence_urls: [],
      notes: notes.trim() || undefined,
    })
  }

  const availableLocations = variantId
    ? (data.locationsForVariant.get(variantId) ?? []).filter((l) => l.onHand > 0)
    : []

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span className="text-xl">💧</span> Report Damaged Stock
        </DialogTitle>
        <DialogDescription>
          The damaged quantity will be removed from inventory immediately as a write-off.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label>Variant</Label>
          <VariantPicker
            variantId={variantId}
            onSelect={setVariantId}
            variantOptions={data.variantOptions}
          />
        </div>

        <div className="grid sm:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="dmg-location">Location</Label>
            <Select
              value={locationId}
              onValueChange={setLocationId}
              disabled={!variantId}
            >
              <SelectTrigger id="dmg-location">
                <SelectValue placeholder="Select location" />
              </SelectTrigger>
              <SelectContent>
                {availableLocations.length === 0 ? (
                  <SelectItem value="_none" disabled>
                    No stock at any location
                  </SelectItem>
                ) : (
                  availableLocations.map((l) => {
                    const loc = data.locations.find((x) => x.id === l.locationId)
                    return (
                      <SelectItem key={l.locationId} value={l.locationId}>
                        {loc?.name ?? l.locationId} · {l.available} available
                      </SelectItem>
                    )
                  })
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dmg-qty">Quantity</Label>
            <Input
              id="dmg-qty"
              type="number"
              min="1"
              step="1"
              className="tabular-nums"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Available</Label>
            <div className="h-9 flex items-center px-3 rounded-md border bg-muted/30 text-sm text-muted-foreground tabular-nums">
              {pool ? `${pool.available} units` : '—'}
            </div>
          </div>
        </div>

        {insufficient && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Insufficient available stock</AlertTitle>
            <AlertDescription>
              Only {availableAtPool} units are available at this location (reserved stock cannot be
              written off).
            </AlertDescription>
          </Alert>
        )}

        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="dmg-type">Damage type</Label>
            <Select value={damageType} onValueChange={(v) => setDamageType(v as DamageType)}>
              <SelectTrigger id="dmg-type">
                <SelectValue placeholder="Select damage type" />
              </SelectTrigger>
              <SelectContent>
                {DAMAGE_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dmg-party">Responsible party</Label>
            <Select
              value={responsibleParty}
              onValueChange={(v) =>
                setResponsibleParty(v as 'warehouse' | 'courier' | 'customer' | 'employee')
              }
            >
              <SelectTrigger id="dmg-party">
                <SelectValue placeholder="Select responsible party" />
              </SelectTrigger>
              <SelectContent>
                {RESPONSIBLE_PARTY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="dmg-notes">Notes (optional)</Label>
          <Textarea
            id="dmg-notes"
            placeholder="Describe what happened…"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <Alert className="border-orange-200 bg-orange-50/50 text-orange-900">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="text-sm">
            This will immediately reduce your available stock by{' '}
            <strong>{qty || 0}</strong> and write off{' '}
            <strong>{formatPKR(writeOffValue)}</strong>.
          </AlertDescription>
        </Alert>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button
          onClick={handleSubmit}
          disabled={mutation.isPending}
          className="bg-orange-600 hover:bg-orange-700"
        >
          {mutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Recording…
            </>
          ) : (
            <>
              <AlertTriangle className="h-4 w-4" /> Report Damage
            </>
          )}
        </Button>
      </DialogFooter>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// THEFT form — quarantine at report, resolve later
// ─────────────────────────────────────────────────────────────────────────────

function TheftForm({ onBack, onSuccess }: { onBack: () => void; onSuccess: () => void }) {
  const data = useVariantAndLocationData()

  const [variantId, setVariantId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [subType, setSubType] = useState<'confirmed' | 'suspected'>('suspected')
  const [policeReportRef, setPoliceReportRef] = useState('')
  const [notes, setNotes] = useState('')

  const pool = variantId && locationId ? data.poolMap.get(`${variantId}|${locationId}`) : null

  useEffect(() => {
    setLocationId('')
  }, [variantId])

  const qty = parseInt(quantity, 10) || 0
  const availableAtPool = pool?.available ?? 0
  const insufficient = pool !== null && qty > availableAtPool

  const mutation = useMutation({
    mutationFn: async (payload: TheftPayload) =>
      api.post('/api/stock-loss/report-theft', payload),
    onSuccess: () => {
      toast.success('Theft reported. Stock quarantined while you investigate.')
      onSuccess()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const handleSubmit = () => {
    if (!variantId) return toast.error('Select a variant.')
    if (!locationId) return toast.error('Select a location.')
    if (qty <= 0) return toast.error('Quantity must be positive.')
    if (insufficient) return toast.error(`Only ${availableAtPool} units available.`)
    if (subType === 'confirmed' && !policeReportRef.trim())
      return toast.error('Police report reference is required for confirmed thefts.')
    mutation.mutate({
      org_variant_id: variantId,
      location_id: locationId,
      quantity: qty,
      sub_type: subType,
      police_report_ref: subType === 'confirmed' ? policeReportRef.trim() : undefined,
      evidence_urls: [],
      notes: notes.trim() || undefined,
    })
  }

  const availableLocations = variantId
    ? (data.locationsForVariant.get(variantId) ?? []).filter((l) => l.onHand > 0)
    : []

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span className="text-xl">🚨</span> Report Theft
        </DialogTitle>
        <DialogDescription>
          Quarantines the missing stock while you investigate. No financial loss is recorded until
          you resolve the investigation.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label>Variant</Label>
          <VariantPicker
            variantId={variantId}
            onSelect={setVariantId}
            variantOptions={data.variantOptions}
          />
        </div>

        <div className="grid sm:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="thf-location">Location</Label>
            <Select
              value={locationId}
              onValueChange={setLocationId}
              disabled={!variantId}
            >
              <SelectTrigger id="thf-location">
                <SelectValue placeholder="Select location" />
              </SelectTrigger>
              <SelectContent>
                {availableLocations.length === 0 ? (
                  <SelectItem value="_none" disabled>
                    No stock at any location
                  </SelectItem>
                ) : (
                  availableLocations.map((l) => {
                    const loc = data.locations.find((x) => x.id === l.locationId)
                    return (
                      <SelectItem key={l.locationId} value={l.locationId}>
                        {loc?.name ?? l.locationId} · {l.available} available
                      </SelectItem>
                    )
                  })
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="thf-qty">Quantity</Label>
            <Input
              id="thf-qty"
              type="number"
              min="1"
              step="1"
              className="tabular-nums"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Available</Label>
            <div className="h-9 flex items-center px-3 rounded-md border bg-muted/30 text-sm text-muted-foreground tabular-nums">
              {pool ? `${pool.available} units` : '—'}
            </div>
          </div>
        </div>

        {insufficient && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Insufficient available stock</AlertTitle>
            <AlertDescription>
              Only {availableAtPool} units are available to quarantine at this location.
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <Label>Theft sub-type</Label>
          <RadioGroup
            value={subType}
            onValueChange={(v) => setSubType(v as 'confirmed' | 'suspected')}
            className="grid sm:grid-cols-2 gap-2"
          >
            <label
              htmlFor="sub-suspected"
              className={`rounded-md border p-3 cursor-pointer transition-colors ${
                subType === 'suspected'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-muted/50'
              }`}
            >
              <div className="flex items-start gap-2">
                <RadioGroupItem id="sub-suspected" value="suspected" className="mt-0.5" />
                <div>
                  <p className="text-sm font-medium">Suspected</p>
                  <p className="text-xs text-muted-foreground">
                    Stock is unaccounted for but no police report filed yet.
                  </p>
                </div>
              </div>
            </label>
            <label
              htmlFor="sub-confirmed"
              className={`rounded-md border p-3 cursor-pointer transition-colors ${
                subType === 'confirmed'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-muted/50'
              }`}
            >
              <div className="flex items-start gap-2">
                <RadioGroupItem id="sub-confirmed" value="confirmed" className="mt-0.5" />
                <div>
                  <p className="text-sm font-medium">Confirmed</p>
                  <p className="text-xs text-muted-foreground">
                    Theft verified — a police report reference is required.
                  </p>
                </div>
              </div>
            </label>
          </RadioGroup>
        </div>

        {subType === 'confirmed' && (
          <div className="space-y-1.5">
            <Label htmlFor="thf-police">Police report reference</Label>
            <Input
              id="thf-police"
              placeholder="e.g. FIR #1234 / 2024"
              value={policeReportRef}
              onChange={(e) => setPoliceReportRef(e.target.value)}
            />
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="thf-notes">Notes (optional)</Label>
          <Textarea
            id="thf-notes"
            placeholder="Describe what happened, when it was noticed, who was involved…"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <Alert className="border-rose-200 bg-rose-50/50 text-rose-900">
          <ShieldAlert className="h-4 w-4" />
          <AlertDescription className="text-sm">
            This will quarantine <strong>{qty || 0}</strong> piece{qty === 1 ? '' : 's'} (they&apos;ll
            no longer be sellable) while you investigate. No financial loss is recorded until you
            resolve this investigation.
          </AlertDescription>
        </Alert>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button
          onClick={handleSubmit}
          disabled={mutation.isPending}
          className="bg-rose-600 hover:bg-rose-700"
        >
          {mutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Reporting…
            </>
          ) : (
            <>
              <ShieldAlert className="h-4 w-4" /> Report Theft
            </>
          )}
        </Button>
      </DialogFooter>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSIT LOSS form — no inventory transaction; tracks courier claim
// ─────────────────────────────────────────────────────────────────────────────

function TransitForm({ onBack, onSuccess }: { onBack: () => void; onSuccess: () => void }) {
  const data = useVariantAndLocationData()

  const [orderRef, setOrderRef] = useState('')
  const [variantId, setVariantId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [courierClaimRef, setCourierClaimRef] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    setLocationId('')
  }, [variantId])

  const qty = parseInt(quantity, 10) || 0

  const mutation = useMutation({
    mutationFn: async (payload: TransitPayload) =>
      api.post('/api/stock-loss/report-transit', payload),
    onSuccess: () => {
      toast.success('Transit loss recorded. Courier claim is now being tracked.')
      onSuccess()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const handleSubmit = () => {
    if (!orderRef.trim()) return toast.error('Order reference is required.')
    if (!variantId) return toast.error('Select a variant.')
    if (!locationId) return toast.error('Select a dispatch location.')
    if (qty <= 0) return toast.error('Quantity must be positive.')
    mutation.mutate({
      org_variant_id: variantId,
      location_id: locationId,
      quantity: qty,
      order_reference_id: orderRef.trim(),
      courier_claim_ref: courierClaimRef.trim() || undefined,
      notes: notes.trim() || undefined,
    })
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span className="text-xl">📦</span> Report Transit Loss
        </DialogTitle>
        <DialogDescription>
          Use this when a courier lost a dispatched shipment. This report only tracks the claim —
          stock was already removed from inventory at dispatch time.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="tr-order">Order reference</Label>
          <Input
            id="tr-order"
            placeholder="e.g. ORD-2024-00982 / dispatch #DSP-5532"
            value={orderRef}
            onChange={(e) => setOrderRef(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Any reference that links this loss to the dispatched order.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>Variant</Label>
          <VariantPicker
            variantId={variantId}
            onSelect={setVariantId}
            variantOptions={data.variantOptions}
          />
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="tr-location">Dispatch location</Label>
            <Select value={locationId} onValueChange={setLocationId} disabled={!variantId}>
              <SelectTrigger id="tr-location">
                <SelectValue placeholder="Select dispatch location" />
              </SelectTrigger>
              <SelectContent>
                {data.locations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tr-qty">Quantity lost in transit</Label>
            <Input
              id="tr-qty"
              type="number"
              min="1"
              step="1"
              className="tabular-nums"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="tr-claim">Courier claim reference (optional)</Label>
          <Input
            id="tr-claim"
            placeholder="e.g. TCS-CLAIM-9999 / Leopold-CLM-22041"
            value={courierClaimRef}
            onChange={(e) => setCourierClaimRef(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            If you&apos;ve already filed a claim with the courier, enter the reference. You can also
            add it later when resolving.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="tr-notes">Notes (optional)</Label>
          <Textarea
            id="tr-notes"
            placeholder="Dispatcher, tracking number, recipient, what happened…"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <Alert className="border-purple-200 bg-purple-50/50 text-purple-900">
          <Truck className="h-4 w-4" />
          <AlertDescription className="text-sm">
            This stock was already removed from inventory when it was dispatched. This report only
            tracks the courier claim.
          </AlertDescription>
        </Alert>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button
          onClick={handleSubmit}
          disabled={mutation.isPending}
          className="bg-purple-600 hover:bg-purple-700"
        >
          {mutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Reporting…
            </>
          ) : (
            <>
              <Truck className="h-4 w-4" /> Report Transit Loss
            </>
          )}
        </Button>
      </DialogFooter>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve dialog — for theft/missing + transit_loss (from list view)
// ─────────────────────────────────────────────────────────────────────────────

function ResolveDialog({
  target,
  open,
  onOpenChange,
  onSuccess,
}: {
  target: StockLossRow
  open: boolean
  onOpenChange: (v: boolean) => void
  onSuccess: () => void
}) {
  if (target.lossType === 'transit_loss') {
    return (
      <ResolveTransitDialog
        target={target}
        open={open}
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
      />
    )
  }
  return (
    <ResolveTheftDialog
      target={target}
      open={open}
      onOpenChange={onOpenChange}
      onSuccess={onSuccess}
    />
  )
}

const THEFT_RESOLUTIONS: {
  value: 'written_off' | 'recovered' | 'error_corrected'
  label: string
  description: string
}[] = [
  {
    value: 'written_off',
    label: 'Written Off',
    description:
      'Stock is permanently lost. A write-off transaction will be recorded, reducing inventory and recognizing the financial loss.',
  },
  {
    value: 'recovered',
    label: 'Recovered',
    description:
      'Stock was found or returned. Quarantine is released and the items become sellable again. No financial impact.',
  },
  {
    value: 'error_corrected',
    label: 'Error Corrected',
    description:
      'The original report was an admin error (e.g. miscount). Quarantine is released with no financial impact.',
  },
]

function ResolveTheftDialog({
  target,
  open,
  onOpenChange,
  onSuccess,
}: {
  target: StockLossRow
  open: boolean
  onOpenChange: (v: boolean) => void
  onSuccess: () => void
}) {
  const [resolution, setResolution] = useState<
    'written_off' | 'recovered' | 'error_corrected'
  >('written_off')
  const [notes, setNotes] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => {
    if (open) {
      setResolution('written_off')
      setNotes('')
      setConfirmOpen(false)
    }
  }, [open, target.id])

  const mutation = useMutation({
    mutationFn: async (payload: ResolveTheftPayload) =>
      api.post('/api/stock-loss/resolve', payload),
    onSuccess: () => {
      toast.success('Investigation resolved.')
      onSuccess()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const handleSubmit = () => {
    mutation.mutate({
      loss_id: target.id,
      resolution,
      notes: notes.trim() || undefined,
    })
  }

  const writeOffValue = target.totalLossValue

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-xl max-h-[92vh] overflow-y-auto scrollbar-thin">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldQuestion className="h-4 w-4" /> Resolve investigation
            </DialogTitle>
            <DialogDescription>
              {target.productTitle} · {target.sku} ·{' '}
              <span className="font-medium">
                {target.quantity} unit{target.quantity === 1 ? '' : 's'} quarantined
              </span>{' '}
              ({formatPKR(target.totalLossValue)})
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Resolution</Label>
              <RadioGroup
                value={resolution}
                onValueChange={(v) =>
                  setResolution(v as 'written_off' | 'recovered' | 'error_corrected')
                }
                className="gap-2"
              >
                {THEFT_RESOLUTIONS.map((r) => (
                  <label
                    key={r.value}
                    htmlFor={`res-${r.value}`}
                    className={`rounded-md border p-3 cursor-pointer transition-colors block ${
                      resolution === r.value
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-muted/50'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <RadioGroupItem id={`res-${r.value}`} value={r.value} className="mt-0.5" />
                      <div>
                        <p className="text-sm font-medium">{r.label}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{r.description}</p>
                      </div>
                    </div>
                  </label>
                ))}
              </RadioGroup>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="res-notes">Notes (optional)</Label>
              <Textarea
                id="res-notes"
                placeholder="Resolution notes — what was decided and why…"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            {resolution === 'written_off' && (
              <Alert className="border-rose-200 bg-rose-50/50 text-rose-900">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Financial impact</AlertTitle>
                <AlertDescription className="text-sm">
                  Writing off will record a permanent loss of{' '}
                  <strong>{formatPKR(writeOffValue)}</strong> and remove{' '}
                  <strong>{target.quantity}</strong> unit{target.quantity === 1 ? '' : 's'} from
                  inventory.
                </AlertDescription>
              </Alert>
            )}
            {resolution === 'recovered' && (
              <Alert className="border-emerald-200 bg-emerald-50/50 text-emerald-900">
                <CheckCircle2 className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  Quarantine will be released. The {target.quantity} unit
                  {target.quantity === 1 ? '' : 's'} will return to sellable stock with no financial
                  impact.
                </AlertDescription>
              </Alert>
            )}
            {resolution === 'error_corrected' && (
              <Alert className="border-sky-200 bg-sky-50/50 text-sky-900">
                <CheckCircle2 className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  Quarantine will be released and no financial transaction will be recorded. Use
                  this only if the original report was a mistake.
                </AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={mutation.isPending}
              className={
                resolution === 'written_off'
                  ? 'bg-rose-600 hover:bg-rose-700'
                  : resolution === 'recovered'
                    ? 'bg-emerald-600 hover:bg-emerald-700'
                    : 'bg-sky-600 hover:bg-sky-700'
              }
            >
              <CheckCircle2 className="h-4 w-4" /> Resolve Investigation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm resolution</AlertDialogTitle>
            <AlertDialogDescription>
              {resolution === 'written_off' && (
                <>
                  This will permanently write off{' '}
                  <strong>{formatPKR(writeOffValue)}</strong> and close the investigation. This
                  action cannot be undone.
                </>
              )}
              {resolution === 'recovered' && (
                <>
                  This will release the quarantine on {target.quantity} unit
                  {target.quantity === 1 ? '' : 's'} and close the investigation.
                </>
              )}
              {resolution === 'error_corrected' && (
                <>
                  This will release the quarantine and mark the original report as an admin error.
                  The investigation will be closed.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleSubmit()
              }}
              disabled={mutation.isPending}
              className={
                resolution === 'written_off'
                  ? 'bg-rose-600 hover:bg-rose-700'
                  : resolution === 'recovered'
                    ? 'bg-emerald-600 hover:bg-emerald-700'
                    : 'bg-sky-600 hover:bg-sky-700'
              }
            >
              {mutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Resolving…
                </>
              ) : (
                'Confirm & Resolve'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function ResolveTransitDialog({
  target,
  open,
  onOpenChange,
  onSuccess,
}: {
  target: StockLossRow
  open: boolean
  onOpenChange: (v: boolean) => void
  onSuccess: () => void
}) {
  const [resolution, setResolution] = useState<'claim_accepted' | 'claim_rejected'>(
    'claim_accepted',
  )
  const [recovered, setRecovered] = useState(String(target.totalLossValue))
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (open) {
      setResolution('claim_accepted')
      setRecovered(String(target.totalLossValue))
      setNotes('')
    }
  }, [open, target.id])

  const mutation = useMutation({
    mutationFn: async (payload: ResolveTransitPayload) =>
      api.post('/api/stock-loss/resolve', payload),
    onSuccess: () => {
      toast.success('Courier claim resolved.')
      onSuccess()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const recoveredAmount = parseFloat(recovered) || 0
  const lossValue = target.totalLossValue
  const shortfall = Math.max(0, lossValue - recoveredAmount)

  const handleSubmit = () => {
    if (resolution === 'claim_accepted' && recoveredAmount < 0)
      return toast.error('Recovered amount cannot be negative.')
    mutation.mutate({
      loss_id: target.id,
      resolution,
      courier_recovered: resolution === 'claim_accepted' ? recoveredAmount : 0,
      notes: notes.trim() || undefined,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[92vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="h-4 w-4" /> Resolve courier claim
          </DialogTitle>
          <DialogDescription>
            {target.productTitle} · {target.sku} ·{' '}
            <span className="font-medium">{target.quantity} unit{target.quantity === 1 ? '' : 's'}</span>{' '}
            in transit ({formatPKR(target.totalLossValue)})
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Courier claim outcome</Label>
            <RadioGroup
              value={resolution}
              onValueChange={(v) =>
                setResolution(v as 'claim_accepted' | 'claim_rejected')
              }
              className="gap-2"
            >
              <label
                htmlFor="tr-accepted"
                className={`rounded-md border p-3 cursor-pointer transition-colors block ${
                  resolution === 'claim_accepted'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/50'
                }`}
              >
                <div className="flex items-start gap-2">
                  <RadioGroupItem id="tr-accepted" value="claim_accepted" className="mt-0.5" />
                  <div>
                    <p className="text-sm font-medium">Claim Accepted</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Courier accepted liability. Enter the amount recovered below.
                    </p>
                  </div>
                </div>
              </label>
              <label
                htmlFor="tr-rejected"
                className={`rounded-md border p-3 cursor-pointer transition-colors block ${
                  resolution === 'claim_rejected'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/50'
                }`}
              >
                <div className="flex items-start gap-2">
                  <RadioGroupItem id="tr-rejected" value="claim_rejected" className="mt-0.5" />
                  <div>
                    <p className="text-sm font-medium">Claim Rejected</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Courier denied the claim. The full loss value will be recognized.
                    </p>
                  </div>
                </div>
              </label>
            </RadioGroup>
          </div>

          {resolution === 'claim_accepted' && (
            <div className="space-y-1.5">
              <Label htmlFor="tr-recovered">Amount recovered from courier (Rs.)</Label>
              <Input
                id="tr-recovered"
                type="number"
                min="0"
                step="0.01"
                className="tabular-nums"
                value={recovered}
                onChange={(e) => setRecovered(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Loss value: {formatPKR(lossValue)} · Net shortfall after recovery:{' '}
                <strong className="text-rose-700">{formatPKR(shortfall)}</strong>
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="tr-res-notes">Notes (optional)</Label>
            <Textarea
              id="tr-res-notes"
              placeholder="Resolution notes — claim response, payout reference, next steps…"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={mutation.isPending}
            className={
              resolution === 'claim_accepted'
                ? 'bg-emerald-600 hover:bg-emerald-700'
                : 'bg-slate-600 hover:bg-slate-700'
            }
          >
            {mutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Resolving…
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4" /> Resolve Claim
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
