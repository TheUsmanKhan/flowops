'use client'

import { useEffect, useState } from 'react'
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
  ArrowLeft,
  RefreshCw,
  Loader2,
  AlertTriangle,
  ShieldAlert,
  PackageMinus,
  Truck,
  Building2,
  Droplets,
  CheckCircle2,
  Clock,
  ShieldQuestion,
  Undo2,
  FileText,
  Calendar,
  MapPin,
  User,
  Package,
  Banknote,
  Gavel,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types — match GET /api/stock-loss/[id]
// ─────────────────────────────────────────────────────────────────────────────

type LossType = 'damaged' | 'theft' | 'missing' | 'transit_loss' | 'supplier_dispute'
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
type CourierClaimStatus = 'not_filed' | 'filed' | 'accepted' | 'rejected'

interface LossDetail {
  id: string
  lossType: LossType
  subType: string | null
  damageType: string | null
  quantity: number
  costPerUnit: number
  totalLossValue: number
  investigationStatus: InvestigationStatus
  resolution: LossResolution | null
  responsibleParty: ResponsibleParty | null
  policeReportRef: string | null
  insuranceClaimRef: string | null
  insuranceRecovered: number
  courierClaimRef: string | null
  courierClaimStatus: CourierClaimStatus | null
  courierRecovered: number
  evidenceUrls: string[]
  notes: string | null
  orderReferenceId: string | null
  supplierReturnId: string | null
  variant: { id: string; sku: string; productTitle: string }
  location: { id: string; name: string }
  reportedBy: string
  resolvedBy: string | null
  inventoryTxn: {
    id: string
    quantity: number
    costPerUnit: number
    recordedAt: string
  } | null
  supplierReturn: {
    id: string
    supplierName: string
    reason: string
    status: string
    quantity: number
    costPerUnit: number
  } | null
  createdAt: string
  resolvedAt: string | null
}

interface LossDetailResponse {
  record: LossDetail
}

// ─────────────────────────────────────────────────────────────────────────────
// Display maps
// ─────────────────────────────────────────────────────────────────────────────

const LOSS_TYPE_BADGE: Record<LossType, { label: string; className: string }> = {
  damaged: { label: 'Damaged', className: 'bg-orange-50 text-orange-700 border-orange-200' },
  theft: { label: 'Theft', className: 'bg-rose-50 text-rose-700 border-rose-200' },
  missing: { label: 'Missing', className: 'bg-amber-50 text-amber-700 border-amber-200' },
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

const INVESTIGATION_BADGE: Record<InvestigationStatus, { label: string; className: string }> = {
  none: { label: 'No Investigation', className: 'bg-gray-100 text-gray-700 border-gray-200' },
  open: { label: 'Open', className: 'bg-sky-50 text-sky-700 border-sky-200' },
  closed: { label: 'Closed', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
}

const RESPONSIBLE_PARTY_LABEL: Record<ResponsibleParty, string> = {
  warehouse: 'Warehouse',
  courier: 'Courier',
  customer: 'Customer',
  employee: 'Employee',
  unknown: 'Unknown',
  supplier: 'Supplier',
}

const DAMAGE_TYPE_LABEL: Record<string, string> = {
  water_moisture: 'Water / Moisture',
  physical_impact: 'Physical Impact',
  manufacturing_defect: 'Manufacturing Defect',
  transit_damage: 'Transit Damage',
  storage_damage: 'Storage Damage',
  other: 'Other',
}

const SUB_TYPE_LABEL: Record<string, string> = {
  confirmed: 'Confirmed',
  suspected: 'Suspected',
  admin_error: 'Admin Error',
  manufacturing: 'Manufacturing',
}

const COURIER_CLAIM_LABEL: Record<CourierClaimStatus, string> = {
  not_filed: 'Not Filed',
  filed: 'Filed',
  accepted: 'Accepted',
  rejected: 'Rejected',
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-PK', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
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

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function LossDetailView({ lossId }: { lossId: string }) {
  const navigate = useAppStore((s) => s.navigate)
  const queryClient = useQueryClient()

  const detailQuery = useQuery<LossDetailResponse>({
    queryKey: ['stock-loss', lossId],
    queryFn: () => api.get<LossDetailResponse>(`/api/stock-loss/${lossId}`),
    staleTime: 10_000,
  })

  const record = detailQuery.data?.record

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['stock-loss', lossId] })
    void queryClient.invalidateQueries({ queryKey: ['stock-losses'] })
    void queryClient.invalidateQueries({ queryKey: ['inventory-dashboard'] })
  }

  if (detailQuery.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Stock Loss"
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate({ name: 'inventory-losses' })}
            >
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
          }
        />
        <div className="grid lg:grid-cols-2 gap-6">
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
        </div>
      </div>
    )
  }

  if (detailQuery.isError || !record) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Stock Loss"
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate({ name: 'inventory-losses' })}
            >
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
          }
        />
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">
              {detailQuery.isError
                ? getErrorMessage(detailQuery.error)
                : 'Stock loss record not found.'}
            </p>
            <Button variant="outline" onClick={() => detailQuery.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const typeBadge = LOSS_TYPE_BADGE[record.lossType]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock Loss"
        description={`${typeBadge.label} · ${record.variant.productTitle} · ${record.variant.sku}`}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => detailQuery.refetch()}
              disabled={detailQuery.isFetching}
            >
              <RefreshCw
                className={detailQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}
              />
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate({ name: 'inventory-losses' })}
            >
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
          </div>
        }
      />

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <LossDetailsCard record={record} />
        <RightColumn record={record} onResolved={invalidateAll} />
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// LEFT — loss details card
// ─────────────────────────────────────────────────────────────────────────────

function LossDetailsCard({ record }: { record: LossDetail }) {
  const typeBadge = LOSS_TYPE_BADGE[record.lossType]
  const invBadge =
    INVESTIGATION_BADGE[record.investigationStatus] ?? INVESTIGATION_BADGE.none
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className={`flex h-11 w-11 items-center justify-center rounded-lg ${LOSS_TYPE_TONE[record.lossType]}`}
            >
              {LOSS_TYPE_ICON[record.lossType]}
            </div>
            <div>
              <CardTitle className="text-base">{record.variant.productTitle}</CardTitle>
              <p className="text-xs text-muted-foreground font-mono mt-0.5">
                {record.variant.sku}
              </p>
            </div>
          </div>
          <Badge variant="outline" className={typeBadge.className}>
            {typeBadge.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Big value display */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">Quantity</p>
            <p className="text-2xl font-semibold tabular-nums mt-0.5">{record.quantity}</p>
          </div>
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">Loss Value</p>
            <p className="text-2xl font-semibold tabular-nums mt-0.5">
              {formatPKR(record.totalLossValue)}
            </p>
          </div>
        </div>

        <DetailRow icon={<MapPin className="h-4 w-4" />} label="Location">
          {record.location.name}
        </DetailRow>

        {record.responsibleParty && (
          <DetailRow icon={<User className="h-4 w-4" />} label="Responsible party">
            {RESPONSIBLE_PARTY_LABEL[record.responsibleParty]}
          </DetailRow>
        )}

        {record.subType && (
          <DetailRow icon={<AlertTriangle className="h-4 w-4" />} label="Sub-type">
            {SUB_TYPE_LABEL[record.subType] ?? record.subType}
          </DetailRow>
        )}

        {record.damageType && (
          <DetailRow icon={<Droplets className="h-4 w-4" />} label="Damage type">
            {DAMAGE_TYPE_LABEL[record.damageType] ?? record.damageType}
          </DetailRow>
        )}

        <DetailRow icon={<Calendar className="h-4 w-4" />} label="Reported">
          <div className="flex flex-col">
            <span>{formatDate(record.createdAt)}</span>
            <span className="text-xs text-muted-foreground">by {record.reportedBy}</span>
          </div>
        </DetailRow>

        {record.investigationStatus !== 'none' && (
          <DetailRow icon={<ShieldQuestion className="h-4 w-4" />} label="Investigation">
            <Badge variant="outline" className={invBadge.className}>
              {invBadge.label}
            </Badge>
          </DetailRow>
        )}

        {record.policeReportRef && (
          <DetailRow icon={<FileText className="h-4 w-4" />} label="Police report ref">
            <span className="font-mono text-sm">{record.policeReportRef}</span>
          </DetailRow>
        )}

        {record.courierClaimRef && (
          <DetailRow icon={<Truck className="h-4 w-4" />} label="Courier claim ref">
            <div className="flex flex-col">
              <span className="font-mono text-sm">{record.courierClaimRef}</span>
              {record.courierClaimStatus && (
                <Badge
                  variant="outline"
                  className="mt-1 w-fit text-xs bg-muted/40"
                >
                  {COURIER_CLAIM_LABEL[record.courierClaimStatus] ?? record.courierClaimStatus}
                </Badge>
              )}
            </div>
          </DetailRow>
        )}

        {record.orderReferenceId && (
          <DetailRow icon={<Package className="h-4 w-4" />} label="Order reference">
            <span className="font-mono text-sm">{record.orderReferenceId}</span>
          </DetailRow>
        )}

        {record.insuranceClaimRef && (
          <DetailRow icon={<Banknote className="h-4 w-4" />} label="Insurance claim ref">
            <div className="flex flex-col">
              <span className="font-mono text-sm">{record.insuranceClaimRef}</span>
              {record.insuranceRecovered > 0 && (
                <span className="text-xs text-emerald-700 mt-0.5">
                  Recovered: {formatPKR(record.insuranceRecovered)}
                </span>
              )}
            </div>
          </DetailRow>
        )}

        {record.notes && (
          <div className="pt-2 border-t">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
              Notes
            </p>
            <p className="text-sm whitespace-pre-wrap leading-relaxed">{record.notes}</p>
          </div>
        )}

        {record.evidenceUrls && record.evidenceUrls.length > 0 && (
          <div className="pt-2 border-t">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Evidence ({record.evidenceUrls.length})
            </p>
            <div className="grid grid-cols-3 gap-2">
              {record.evidenceUrls.map((url, i) => (
                <a
                  key={i}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="aspect-square rounded-md overflow-hidden border bg-muted/30 block hover:opacity-90"
                >
                  { }
                  <img
                    src={url}
                    alt={`Evidence ${i + 1}`}
                    className="w-full h-full object-cover"
                  />
                </a>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function DetailRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground min-w-0">
        <span className="text-muted-foreground/80 shrink-0">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="text-sm text-right min-w-0">{children}</div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// RIGHT — varies by loss_type
// ─────────────────────────────────────────────────────────────────────────────

function RightColumn({
  record,
  onResolved,
}: {
  record: LossDetail
  onResolved: () => void
}) {
  if (record.lossType === 'damaged') return <DamagedStatusCard record={record} />
  if (record.lossType === 'supplier_dispute') return <SupplierDisputeCard record={record} />
  if (record.lossType === 'transit_loss') return <TransitClaimCard record={record} onResolved={onResolved} />
  // theft or missing
  return <TheftInvestigationCard record={record} onResolved={onResolved} />
}

// ── Damaged: written off, no further action ─────────────────────────────────

function DamagedStatusCard({ record }: { record: LossDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" /> Resolution
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-emerald-200 bg-emerald-50/60 p-4">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            <p className="text-sm font-semibold text-emerald-900">
              ✅ Written Off
            </p>
          </div>
          <p className="text-xs text-emerald-800 mt-1.5 leading-relaxed">
            This damaged stock was written off when it was reported. A{' '}
            <code className="font-mono">damage_writeoff</code> transaction was recorded against
            inventory, and the financial loss of{' '}
            <strong>{formatPKR(record.totalLossValue)}</strong> is recognized.
          </p>
        </div>

        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Linked inventory transaction
          </p>
          {record.inventoryTxn ? (
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Transaction ID</span>
                <span className="font-mono text-xs">{record.inventoryTxn.id}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Quantity removed</span>
                <span className="tabular-nums">{record.inventoryTxn.quantity}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Cost per unit</span>
                <span className="tabular-nums">{formatPKR(record.inventoryTxn.costPerUnit)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Finalized at</span>
                <span>{formatDateTime(record.inventoryTxn.recordedAt)}</span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">
              Linked transaction not available.
            </p>
          )}
        </div>

        <Alert>
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription className="text-sm">
            No further action is required for this loss record.
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  )
}

// ── Supplier Dispute: read-only, link to original return ─────────────────────

function SupplierDisputeCard({ record }: { record: LossDetail }) {
  const navigate = useAppStore((s) => s.navigate)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Building2 className="h-4 w-4 text-slate-600" /> Supplier Dispute
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert className="border-slate-300 bg-slate-50/60 text-slate-900">
          <Undo2 className="h-4 w-4" />
          <AlertDescription className="text-sm">
            This loss was automatically recorded because the related supplier return was{' '}
            <strong>rejected</strong>. Stock was not removed from inventory — the loss is tracked
            here for financial reporting only.
          </AlertDescription>
        </Alert>

        {record.supplierReturn && (
          <div className="rounded-md border bg-muted/30 p-4 space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Original supplier return
            </p>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Supplier</span>
              <span className="font-medium">{record.supplierReturn.supplierName}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Quantity</span>
              <span className="tabular-nums">{record.supplierReturn.quantity}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Cost per unit</span>
              <span className="tabular-nums">
                {formatPKR(record.supplierReturn.costPerUnit)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Reason</span>
              <span className="capitalize">
                {record.supplierReturn.reason.replace('_', ' ')}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Return status</span>
              <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200 capitalize">
                {record.supplierReturn.status.replace('_', ' ')}
              </Badge>
            </div>
          </div>
        )}

        <Button
          variant="outline"
          className="w-full"
          onClick={() => navigate({ name: 'inventory-supplier-returns' })}
        >
          <Undo2 className="h-4 w-4" /> View Original Supplier Return →
        </Button>

        <p className="text-xs text-muted-foreground text-center">
          No further action is available on this record — resolve the underlying supplier return to
          correct the dispute.
        </p>
      </CardContent>
    </Card>
  )
}

// ── Transit Loss: courier claim section + resolve form ───────────────────────

function TransitClaimCard({
  record,
  onResolved,
}: {
  record: LossDetail
  onResolved: () => void
}) {
  const can = useCan()
  const canManage = can(PERMISSIONS.INVENTORY_MANAGE_LOSS)
  const isResolved = record.resolution !== null

  if (isResolved) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Truck className="h-4 w-4 text-purple-600" /> Courier Claim — Resolved
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {record.resolution && (
            <div
              className={`rounded-md border p-4 ${
                record.resolution === 'claim_accepted'
                  ? 'border-emerald-200 bg-emerald-50/60'
                  : 'border-slate-300 bg-slate-50/60'
              }`}
            >
              <div className="flex items-center gap-2">
                {record.resolution === 'claim_accepted' ? (
                  <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                ) : (
                  <AlertTriangle className="h-5 w-5 text-slate-600" />
                )}
                <p className="text-sm font-semibold">
                  {record.resolution === 'claim_accepted'
                    ? 'Claim Accepted'
                    : 'Claim Rejected'}
                </p>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                {record.resolution === 'claim_accepted'
                  ? 'Courier accepted liability and reimbursed the recovered amount below.'
                  : 'Courier denied the claim. The full loss value has been recognized.'}
              </p>
            </div>
          )}

          {record.resolution === 'claim_accepted' && (
            <div className="rounded-md border bg-muted/30 p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Original loss value</span>
                <span className="tabular-nums">{formatPKR(record.totalLossValue)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Amount recovered from courier</span>
                <span className="tabular-nums font-medium text-emerald-700">
                  {formatPKR(record.courierRecovered)}
                </span>
              </div>
              <div className="flex justify-between text-sm border-t pt-2 mt-2">
                <span className="text-muted-foreground">Net shortfall</span>
                <span className="tabular-nums font-semibold text-rose-700">
                  {formatPKR(Math.max(0, record.totalLossValue - record.courierRecovered))}
                </span>
              </div>
            </div>
          )}

          <ResolvedByFooter record={record} />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Truck className="h-4 w-4 text-purple-600" /> Courier Claim
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border bg-purple-50/40 border-purple-200 p-3">
          <div className="flex items-center gap-2 text-purple-900">
            <Clock className="h-4 w-4" />
            <p className="text-sm font-medium">Claim pending</p>
          </div>
          <p className="text-xs text-purple-800 mt-1">
            This transit loss has no resolution yet. Resolve the claim once the courier accepts or
            rejects liability.
          </p>
        </div>

        {record.courierClaimRef && (
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Courier claim ref</span>
            <span className="font-mono text-xs">{record.courierClaimRef}</span>
          </div>
        )}

        {canManage ? (
          <ResolveTransitForm record={record} onResolved={onResolved} />
        ) : (
          <Alert>
            <ShieldQuestion className="h-4 w-4" />
            <AlertDescription className="text-sm">
              You don&apos;t have permission to resolve courier claims. Contact an inventory
              manager.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}

// ── Theft / Missing: investigation card ─────────────────────────────────────

function TheftInvestigationCard({
  record,
  onResolved,
}: {
  record: LossDetail
  onResolved: () => void
}) {
  const can = useCan()
  const canManage = can(PERMISSIONS.INVENTORY_MANAGE_LOSS)
  const isClosed = record.investigationStatus === 'closed'

  if (isClosed) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            {record.lossType === 'theft' ? (
              <ShieldAlert className="h-4 w-4 text-rose-600" />
            ) : (
              <PackageMinus className="h-4 w-4 text-amber-600" />
            )}{' '}
            Investigation — Closed
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {record.resolution && (
            <div
              className={`rounded-md border p-4 ${
                record.resolution === 'written_off'
                  ? 'border-rose-200 bg-rose-50/60'
                  : record.resolution === 'recovered'
                    ? 'border-emerald-200 bg-emerald-50/60'
                    : 'border-sky-200 bg-sky-50/60'
              }`}
            >
              <div className="flex items-center gap-2">
                {record.resolution === 'written_off' ? (
                  <AlertTriangle className="h-5 w-5 text-rose-600" />
                ) : (
                  <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                )}
                <p className="text-sm font-semibold">
                  {RESOLUTION_LABEL[record.resolution]}
                </p>
                <Badge variant="outline" className={RESOLUTION_BADGE[record.resolution]}>
                  {INVESTIGATION_BADGE.closed.label}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                {record.resolution === 'written_off' &&
                  'Stock was permanently written off. The quarantined units were removed from inventory and a write-off transaction was recorded.'}
                {record.resolution === 'recovered' &&
                  'Stock was found or returned. Quarantine was released and the units are sellable again.'}
                {record.resolution === 'error_corrected' &&
                  'The original report was an admin error. Quarantine was released with no financial impact.'}
              </p>
            </div>
          )}

          {record.resolution === 'written_off' && record.inventoryTxn && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Linked write-off transaction
              </p>
              <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Transaction ID</span>
                  <span className="font-mono text-xs">{record.inventoryTxn.id}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Quantity</span>
                  <span className="tabular-nums">{record.inventoryTxn.quantity}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Cost per unit</span>
                  <span className="tabular-nums">
                    {formatPKR(record.inventoryTxn.costPerUnit)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Finalized at</span>
                  <span>{formatDateTime(record.inventoryTxn.recordedAt)}</span>
                </div>
              </div>
            </div>
          )}

          <ResolvedByFooter record={record} />
        </CardContent>
      </Card>
    )
  }

  // Investigation is OPEN
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          {record.lossType === 'theft' ? (
            <ShieldAlert className="h-4 w-4 text-rose-600" />
          ) : (
            <PackageMinus className="h-4 w-4 text-amber-600" />
          )}{' '}
          Investigation
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border bg-sky-50/60 border-sky-200 p-4">
          <div className="flex items-center gap-2 text-sky-900">
            <Clock className="h-4 w-4" />
            <p className="text-sm font-medium">Investigation Open</p>
            <Badge variant="outline" className={INVESTIGATION_BADGE.open.className}>
              {INVESTIGATION_BADGE.open.label}
            </Badge>
          </div>
          <p className="text-xs text-sky-800 mt-1.5">
            {record.quantity} unit{record.quantity === 1 ? '' : 's'} of{' '}
            <strong>{record.variant.sku}</strong> are quarantined (not sellable) while the{' '}
            {record.lossType === 'theft' ? 'theft' : 'discrepancy'} is investigated. No financial
            loss has been recorded yet.
          </p>
        </div>

        {record.policeReportRef && (
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Police report ref</span>
            <span className="font-mono text-xs">{record.policeReportRef}</span>
          </div>
        )}

        {canManage ? (
          <ResolveTheftForm record={record} onResolved={onResolved} />
        ) : (
          <Alert>
            <ShieldQuestion className="h-4 w-4" />
            <AlertDescription className="text-sm">
              You don&apos;t have permission to resolve investigations. Contact an inventory
              manager to close this case.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}

function ResolvedByFooter({ record }: { record: LossDetail }) {
  if (!record.resolvedAt && !record.resolvedBy) return null
  return (
    <div className="pt-3 border-t flex items-center gap-2 text-xs text-muted-foreground">
      <Gavel className="h-3.5 w-3.5" />
      <span>
        Resolved{record.resolvedBy ? ` by ${record.resolvedBy}` : ''}
        {record.resolvedAt ? ` on ${formatDateTime(record.resolvedAt)}` : ''}.
      </span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline resolution forms (used in the right column)
// ─────────────────────────────────────────────────────────────────────────────

const THEFT_RESOLUTIONS: {
  value: 'written_off' | 'recovered' | 'error_corrected'
  label: string
  description: string
}[] = [
  {
    value: 'written_off',
    label: 'Written Off',
    description:
      'Permanently remove the quarantined stock and record a write-off transaction for the full loss value.',
  },
  {
    value: 'recovered',
    label: 'Recovered',
    description:
      'Stock was found or returned. Release the quarantine — units become sellable again. No financial impact.',
  },
  {
    value: 'error_corrected',
    label: 'Error Corrected',
    description:
      'Original report was an admin error. Release the quarantine with no financial transaction.',
  },
]

function ResolveTheftForm({
  record,
  onResolved,
}: {
  record: LossDetail
  onResolved: () => void
}) {
  const [resolution, setResolution] = useState<
    'written_off' | 'recovered' | 'error_corrected'
  >('written_off')
  const [notes, setNotes] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => {
    setResolution('written_off')
    setNotes('')
    setConfirmOpen(false)
  }, [record.id])

  const mutation = useMutation({
    mutationFn: async () =>
      api.post('/api/stock-loss/resolve', {
        loss_id: record.id,
        resolution,
        notes: notes.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('Investigation resolved.')
      setConfirmOpen(false)
      onResolved()
    },
    onError: (err) => {
      toast.error(getErrorMessage(err))
      setConfirmOpen(false)
    },
  })

  return (
    <div className="space-y-3 pt-2 border-t">
      <div>
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">
          Resolution
        </Label>
        <RadioGroup
          value={resolution}
          onValueChange={(v) =>
            setResolution(v as 'written_off' | 'recovered' | 'error_corrected')
          }
          className="gap-2 mt-2"
        >
          {THEFT_RESOLUTIONS.map((r) => (
            <label
              key={r.value}
              htmlFor={`det-res-${r.value}`}
              className={`rounded-md border p-3 cursor-pointer transition-colors block ${
                resolution === r.value
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-muted/50'
              }`}
            >
              <div className="flex items-start gap-2">
                <RadioGroupItem
                  id={`det-res-${r.value}`}
                  value={r.value}
                  className="mt-0.5"
                />
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
        <Label htmlFor="det-res-notes">Notes (optional)</Label>
        <Textarea
          id="det-res-notes"
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
            <strong>{formatPKR(record.totalLossValue)}</strong> and remove{' '}
            <strong>{record.quantity}</strong> unit{record.quantity === 1 ? '' : 's'} from
            inventory.
          </AlertDescription>
        </Alert>
      )}

      <Button
        className="w-full"
        onClick={() => setConfirmOpen(true)}
        disabled={mutation.isPending}
        variant={
          resolution === 'written_off'
            ? 'destructive'
            : resolution === 'recovered'
              ? 'default'
              : 'default'
        }
      >
        <CheckCircle2 className="h-4 w-4" /> Resolve Investigation
      </Button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm resolution</AlertDialogTitle>
            <AlertDialogDescription>
              {resolution === 'written_off' && (
                <>
                  This will permanently write off{' '}
                  <strong>{formatPKR(record.totalLossValue)}</strong> and close the investigation.
                  This action cannot be undone.
                </>
              )}
              {resolution === 'recovered' && (
                <>
                  This will release the quarantine on {record.quantity} unit
                  {record.quantity === 1 ? '' : 's'} and close the investigation.
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
                mutation.mutate()
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
    </div>
  )
}

function ResolveTransitForm({
  record,
  onResolved,
}: {
  record: LossDetail
  onResolved: () => void
}) {
  const [resolution, setResolution] = useState<'claim_accepted' | 'claim_rejected'>(
    'claim_accepted',
  )
  const [recovered, setRecovered] = useState(String(record.totalLossValue))
  const [notes, setNotes] = useState('')

  useEffect(() => {
    setResolution('claim_accepted')
    setRecovered(String(record.totalLossValue))
    setNotes('')
  }, [record.id])

  const mutation = useMutation({
    mutationFn: async () =>
      api.post('/api/stock-loss/resolve', {
        loss_id: record.id,
        resolution,
        courier_recovered: resolution === 'claim_accepted' ? parseFloat(recovered) || 0 : 0,
        notes: notes.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('Courier claim resolved.')
      onResolved()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const recoveredAmount = parseFloat(recovered) || 0
  const shortfall = Math.max(0, record.totalLossValue - recoveredAmount)

  return (
    <div className="space-y-3 pt-2 border-t">
      <div>
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">
          Courier claim outcome
        </Label>
        <RadioGroup
          value={resolution}
          onValueChange={(v) =>
            setResolution(v as 'claim_accepted' | 'claim_rejected')
          }
          className="gap-2 mt-2"
        >
          <label
            htmlFor="det-tr-accepted"
            className={`rounded-md border p-3 cursor-pointer transition-colors block ${
              resolution === 'claim_accepted'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-muted/50'
            }`}
          >
            <div className="flex items-start gap-2">
              <RadioGroupItem
                id="det-tr-accepted"
                value="claim_accepted"
                className="mt-0.5"
              />
              <div>
                <p className="text-sm font-medium">Claim Accepted</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Courier accepted liability. Enter the amount recovered below.
                </p>
              </div>
            </div>
          </label>
          <label
            htmlFor="det-tr-rejected"
            className={`rounded-md border p-3 cursor-pointer transition-colors block ${
              resolution === 'claim_rejected'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-muted/50'
            }`}
          >
            <div className="flex items-start gap-2">
              <RadioGroupItem
                id="det-tr-rejected"
                value="claim_rejected"
                className="mt-0.5"
              />
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
          <Label htmlFor="det-tr-recovered">Amount recovered from courier (Rs.)</Label>
          <Input
            id="det-tr-recovered"
            type="number"
            min="0"
            step="0.01"
            className="tabular-nums"
            value={recovered}
            onChange={(e) => setRecovered(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Loss value: {formatPKR(record.totalLossValue)} · Net shortfall after recovery:{' '}
            <strong className="text-rose-700">{formatPKR(shortfall)}</strong>
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="det-tr-notes">Notes (optional)</Label>
        <Textarea
          id="det-tr-notes"
          placeholder="Resolution notes — claim response, payout reference, next steps…"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <Button
        className="w-full"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        variant={resolution === 'claim_accepted' ? 'default' : 'secondary'}
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
    </div>
  )
}
