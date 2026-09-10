'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, FetchError } from '@/lib/api-client'
import { useAppStore, useCan } from '@/stores/app-store'
import { PERMISSIONS } from '@/lib/permissions'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
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
  RefreshCw,
  Scissors,
  Factory,
  Warehouse,
  Calendar,
  Wallet,
  User,
  CheckCircle2,
  Send,
  Ban,
  PackageCheck,
  ClipboardList,
  Layers,
  Hash,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types — match GET /api/production-orders/{id}
// ─────────────────────────────────────────────────────────────────────────────

type ProductionStatus =
  | 'fabric_reserved'
  | 'in_production'
  | 'completed'
  | 'dispatched'
  | 'cancelled'

interface ProductionOrderDetail {
  id: string
  status: ProductionStatus
  quantity: number
  stitchingCost: number
  fabricCost: number
  totalCost: number
  assignedTailor: string | null
  estimatedCompletionDate: string | null
  actualCompletionDate: string | null
  referenceType: string
  referenceId: string | null
  createdAt: string
  cancelledAt: string | null
  cancellationReason: string | null
  stitchedVariant: {
    id: string
    sku: string
    product: { title: string }
  }
  fabricVariant: { id: string; sku: string }
  fabricLocation: { id: string; name: string }
  fabricTxn: {
    id: string
    quantity: number
    costPerUnit: number
  } | null
}

interface ProductionOrderDetailResponse {
  order: ProductionOrderDetail
}

// ─────────────────────────────────────────────────────────────────────────────
// Display maps
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<ProductionStatus, { label: string; className: string }> = {
  fabric_reserved: {
    label: 'Fabric Reserved',
    className: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  in_production: { label: 'In Production', className: 'bg-sky-50 text-sky-700 border-sky-200' },
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

const PKR = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 })
function formatPKR(n: number): string {
  return `Rs. ${PKR.format(n)}`
}

const PKR4 = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 4 })
function formatPKR4(n: number): string {
  return `Rs. ${PKR4.format(n)}`
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

export function ProductionOrderDetailView({ productionOrderId }: { productionOrderId: string }) {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()

  const canManage = can(PERMISSIONS.INVENTORY_MANAGE_PRODUCTION)

  const detailQuery = useQuery<ProductionOrderDetailResponse>({
    queryKey: ['production-order', productionOrderId],
    queryFn: () =>
      api.get<ProductionOrderDetailResponse>(`/api/production-orders/${productionOrderId}`),
    staleTime: 10_000,
  })

  const order = detailQuery.data?.order

  // Compute timeline steps from the order's status + timestamps.
  // The API does not return a separate timeline array — we derive it from
  // the current status and the available timestamps (createdAt,
  // actualCompletionDate, cancelledAt).
  const timeline = useMemo(() => {
    if (!order) return [] as TimelineStep[]
    const steps: TimelineStep[] = []

    // Always show "Created" — the order row exists.
    steps.push({
      key: 'created',
      label: 'Order Created',
      icon: <ClipboardList className="h-4 w-4" />,
      timestamp: order.createdAt,
      completed: true,
      description: 'Production order created by checkAndFulfillMadeToOrderVariant().',
    })

    // fabric_reserved is the initial DB status when fabric is consumed
    // (current code creates the PO with status='fabric_reserved' and
    // immediately consumes fabric).
    steps.push({
      key: 'fabric_reserved',
      label: 'Fabric Reserved',
      icon: <Layers className="h-4 w-4" />,
      timestamp: order.createdAt, // same as creation since fabric is consumed inline
      completed:
        order.status === 'fabric_reserved' ||
        order.status === 'in_production' ||
        order.status === 'completed' ||
        order.status === 'dispatched',
      description:
        'Fabric consumed from source variant — cost recorded at current average cost.',
    })

    steps.push({
      key: 'in_production',
      label: 'In Production',
      icon: <Factory className="h-4 w-4" />,
      timestamp: null, // no explicit "started_at" timestamp in schema
      completed:
        order.status === 'in_production' ||
        order.status === 'completed' ||
        order.status === 'dispatched',
      description: 'Tailor is stitching the made-to-order variant.',
    })

    steps.push({
      key: 'completed',
      label: 'Stitching Completed',
      icon: <CheckCircle2 className="h-4 w-4" />,
      timestamp: order.actualCompletionDate,
      completed:
        order.status === 'completed' || order.status === 'dispatched',
      description:
        'Stitched stock added to inventory at fabric location. If linked to an order item, stock is reserved for that order.',
    })

    if (order.status === 'dispatched') {
      steps.push({
        key: 'dispatched',
        label: 'Dispatched',
        icon: <Send className="h-4 w-4" />,
        timestamp: null,
        completed: true,
        description: 'Stitched stock dispatched to customer.',
      })
    }

    if (order.status === 'cancelled') {
      steps.push({
        key: 'cancelled',
        label: 'Cancelled',
        icon: <Ban className="h-4 w-4" />,
        timestamp: order.cancelledAt,
        completed: true,
        description: order.cancellationReason
          ? `Reason: ${order.cancellationReason}. Consumed fabric was returned to inventory.`
          : 'Consumed fabric was returned to inventory.',
      })
    }

    return steps
  }, [order])

  if (detailQuery.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Production Order" />
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  if (detailQuery.isError || !order) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Production Order"
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate({ name: 'inventory-production-orders' })}
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
                : 'Production order not found.'}
            </p>
            <Button variant="outline" onClick={() => detailQuery.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const badge = STATUS_BADGE[order.status]

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Production Order ${order.id.slice(-8).toUpperCase()}`}
        description={`${order.stitchedVariant.product.title} · ${order.quantity} unit${order.quantity === 1 ? '' : 's'} · created ${formatDate(order.createdAt)}`}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate({ name: 'inventory-production-orders' })}
            >
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
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
          </div>
        }
      />

      {/* ── Status header ──────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Badge variant="outline" className={badge.className}>
                {badge.label}
              </Badge>
              {order.assignedTailor && (
                <Badge variant="outline" className="bg-gray-50 text-gray-700 border-gray-200">
                  <User className="h-3 w-3 mr-1" /> {order.assignedTailor}
                </Badge>
              )}
              <div className="text-sm text-muted-foreground">
                Quantity:{' '}
                <span className="font-medium text-foreground tabular-nums">{order.quantity}</span>{' '}
                · Total cost:{' '}
                <span className="font-medium text-foreground tabular-nums">
                  {formatPKR(order.totalCost)}
                </span>
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              PO ID: <span className="font-mono">{order.id}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ── Left: variant + fabric + cost details ──────────────────────── */}
        <div className="lg:col-span-2 space-y-4">
          {/* Stitched variant details */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Scissors className="h-4 w-4" /> Stitched Variant
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <SummaryRow
                icon={<Hash className="h-3.5 w-3.5" />}
                label="Product"
                value={order.stitchedVariant.product.title}
              />
              <SummaryRow label="SKU" value={order.stitchedVariant.sku} mono />
              <SummaryRow label="Variant ID" value={order.stitchedVariant.id} mono />
              <SummaryRow
                icon={<Hash className="h-3.5 w-3.5" />}
                label="Quantity produced"
                value={String(order.quantity)}
              />
            </CardContent>
          </Card>

          {/* Fabric variant + location + transaction */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Layers className="h-4 w-4" /> Fabric Source
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <SummaryRow
                icon={<Hash className="h-3.5 w-3.5" />}
                label="Fabric SKU"
                value={order.fabricVariant.sku}
                mono
              />
              <SummaryRow label="Fabric variant ID" value={order.fabricVariant.id} mono />
              <div className="border-t pt-3 space-y-2">
                <SummaryRow
                  icon={<Warehouse className="h-3.5 w-3.5" />}
                  label="Fabric location"
                  value={order.fabricLocation.name}
                />
                <SummaryRow label="Location ID" value={order.fabricLocation.id} mono />
              </div>
              <div className="border-t pt-3 space-y-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Fabric Consumption Transaction
                </h4>
                {order.fabricTxn ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Txn ID</TableHead>
                        <TableHead className="text-right">Qty consumed</TableHead>
                        <TableHead className="text-right">Cost / unit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow>
                        <TableCell className="font-mono text-xs">
                          {order.fabricTxn.id}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {Math.abs(order.fabricTxn.quantity)} units
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatPKR4(order.fabricTxn.costPerUnit)}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                ) : (
                  <p className="text-xs text-muted-foreground italic">
                    No fabric transaction linked. (Legacy order — fabric may
                    have been consumed before the fabricTxn link was added in
                    INV-004.)
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Status timeline */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <PackageCheck className="h-4 w-4" /> Status Timeline
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="relative border-l border-muted ml-3 space-y-6 py-2">
                {timeline.map((step) => (
                  <li key={step.key} className="ml-6">
                    <span
                      className={`absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full ring-4 ring-background ${
                        step.completed
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {step.icon}
                    </span>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <h4
                        className={`text-sm font-medium ${
                          step.completed ? 'text-foreground' : 'text-muted-foreground'
                        }`}
                      >
                        {step.label}
                      </h4>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatDateTime(step.timestamp)}
                      </span>
                    </div>
                    {step.description && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {step.description}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        {/* ── Right: cost summary + meta ──────────────────────────────────── */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Wallet className="h-4 w-4" /> Cost Breakdown
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <SummaryRow
                label="Stitching cost"
                value={formatPKR(order.stitchingCost)}
              />
              <SummaryRow
                label="Fabric cost"
                value={formatPKR(order.fabricCost)}
              />
              <div className="border-t pt-3 flex items-center justify-between gap-2">
                <span className="font-medium">Total production cost</span>
                <span className="font-semibold tabular-nums">
                  {formatPKR(order.totalCost)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Per unit:{' '}
                <span className="font-medium tabular-nums">
                  {formatPKR(order.quantity > 0 ? order.totalCost / order.quantity : 0)}
                </span>
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Calendar className="h-4 w-4" /> Dates & Assignment
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <SummaryRow
                icon={<Calendar className="h-3.5 w-3.5" />}
                label="Created"
                value={formatDateTime(order.createdAt)}
              />
              <SummaryRow
                icon={<User className="h-3.5 w-3.5" />}
                label="Assigned tailor"
                value={order.assignedTailor ?? '—'}
              />
              <SummaryRow
                icon={<Calendar className="h-3.5 w-3.5" />}
                label="Est. completion"
                value={formatDate(order.estimatedCompletionDate)}
              />
              <SummaryRow
                icon={<CheckCircle2 className="h-3.5 w-3.5" />}
                label="Actual completion"
                value={formatDate(order.actualCompletionDate)}
              />
              {order.cancelledAt && (
                <SummaryRow
                  icon={<Ban className="h-3.5 w-3.5" />}
                  label="Cancelled at"
                  value={formatDateTime(order.cancelledAt)}
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <ClipboardList className="h-4 w-4" /> References
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <SummaryRow
                label="Reference type"
                value={order.referenceType}
              />
              <SummaryRow
                label="Reference ID"
                value={order.referenceId ?? '—'}
                mono
              />
              {order.cancellationReason && (
                <div className="border-t pt-3 space-y-1">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Cancellation reason
                  </p>
                  <p className="text-xs italic text-foreground">
                    “{order.cancellationReason}”
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {!canManage && (
            <p className="text-xs text-muted-foreground text-center px-4">
              You need the <code className="font-mono">inventory.manage_production</code> permission
              to update this order&apos;s status. Use the dropdown actions on the production orders
              list to update status, or contact an admin.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

interface TimelineStep {
  key: string
  label: string
  icon: React.ReactNode
  timestamp: string | null
  completed: boolean
  description?: string
}

function SummaryRow({
  icon,
  label,
  value,
  mono,
}: {
  icon?: React.ReactNode
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground flex items-center gap-1.5">
        {icon}
        {label}
      </span>
      <span
        className={`font-medium text-right ${mono ? 'font-mono text-xs' : ''}`}
      >
        {value}
      </span>
    </div>
  )
}
