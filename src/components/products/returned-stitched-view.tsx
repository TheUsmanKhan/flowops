'use client'

import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, FetchError } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
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
  Loader2,
  RotateCcw,
  Package,
  AlertCircle,
  Check,
  X,
  DollarSign,
  TrendingDown,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types — match the API response contract
// ─────────────────────────────────────────────────────────────────────────────

type ReturnedCondition = 'perfect' | 'good' | 'open_box' | 'damaged'
type ReturnedStatus = 'available' | 'sold' | 'written_off'

interface VariantNested {
  id: string
  sku: string
  attributeValues: Record<string, string>
  product: { id: string; title: string; slug: string }
}

interface ReturnedItem {
  id: string
  variant: VariantNested
  quantity: number
  condition: ReturnedCondition
  totalCost: number
  suggestedResalePrice: number | null
  returnReason: string
  status: ReturnedStatus
  photos: string[]
  notes: string | null
  receivedAt: string
  soldAt: string | null
  writtenOffAt: string | null
  writeOffReason: string | null
}

interface ReturnedStats {
  availableCount: number
  totalValue: number
  writtenOffThisMonth: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants / Display maps
// ─────────────────────────────────────────────────────────────────────────────

type StatusFilter = 'all' | ReturnedStatus

const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'available', label: 'Available' },
  { value: 'sold', label: 'Sold' },
  { value: 'written_off', label: 'Written off' },
]

const STATUS_BADGE_STYLES: Record<ReturnedStatus, string> = {
  available: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  sold: 'bg-gray-100 text-gray-700 border-gray-200',
  written_off: 'bg-rose-50 text-rose-700 border-rose-200',
}

const STATUS_LABELS: Record<ReturnedStatus, string> = {
  available: 'Available',
  sold: 'Sold',
  written_off: 'Written off',
}

const CONDITION_BADGE_STYLES: Record<ReturnedCondition, string> = {
  perfect: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  good: 'bg-sky-50 text-sky-700 border-sky-200',
  open_box: 'bg-amber-50 text-amber-700 border-amber-200',
  damaged: 'bg-rose-50 text-rose-700 border-rose-200',
}

const CONDITION_LABELS: Record<ReturnedCondition, string> = {
  perfect: 'Perfect',
  good: 'Good',
  open_box: 'Open box',
  damaged: 'Damaged',
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatPrice(n: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(n)
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return '—'
  }
}

function formatAttributeValues(values: Record<string, string>): string {
  const entries = Object.entries(values || {})
  if (entries.length === 0) return ''
  return entries.map(([k, v]) => `${k}: ${v}`).join(' · ')
}

function getErrorMessage(err: unknown): string {
  if (err instanceof FetchError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong. Please try again.'
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────
//
// NOTE (MERGE-RETURNED-STITCHED-INTO-RTO): The "Record a Return" / Add form
// was removed from this view — returned-stitched register rows are now
// created automatically by restockOrderForRto() when a made_to_order item
// is restocked from an RTO. This view now manages the existing pool only:
// list, filter, mark as sold, write off.

export function ReturnedStitchedView() {
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [soldTarget, setSoldTarget] = useState<string | null>(null)
  const [writeOffTarget, setWriteOffTarget] = useState<string | null>(null)

  // ---- Stats query ----
  const statsQuery = useQuery<ReturnedStats>({
    queryKey: ['returned-stitched-stats'],
    queryFn: () => api.get<ReturnedStats>('/api/returned-stitched/stats'),
    staleTime: 30_000,
  })

  // ---- Items query (depends on status filter) ----
  const itemsQuery = useQuery<{ items: ReturnedItem[] }>({
    queryKey: ['returned-stitched', { status: statusFilter }],
    queryFn: () => {
      const qs = statusFilter === 'all' ? '' : `?status=${statusFilter}`
      return api.get<{ items: ReturnedItem[] }>(`/api/returned-stitched${qs}`)
    },
    staleTime: 15_000,
  })

  // ---- Invalidation helper ----
  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['returned-stitched'] })
    void queryClient.invalidateQueries({ queryKey: ['returned-stitched-stats'] })
  }

  // ---- Mutations ----
  const markSoldMutation = useMutation({
    mutationFn: async ({ id, reference }: { id: string; reference: string }) =>
      api.post(`/api/returned-stitched/${id}`, {
        action: 'sold',
        sold_order_reference: reference,
      }),
    onSuccess: () => {
      toast.success('Item marked as sold.')
      invalidateAll()
      setSoldTarget(null)
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const writeOffMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) =>
      api.post(`/api/returned-stitched/${id}`, {
        action: 'write_off',
        reason,
      }),
    onSuccess: () => {
      toast.success('Item written off.')
      invalidateAll()
      setWriteOffTarget(null)
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const items = itemsQuery.data?.items ?? []
  const stats = statsQuery.data

  return (
    <div className="space-y-6">
      <PageHeader
        title="Returned Stitched Inventory"
        description="Returned made-to-order pieces — automatically registered on RTO. Mark as sold, write off, or reuse for future MTO orders."
      />

      {/* ── Stats row ───────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Available pieces"
          value={stats ? `${stats.availableCount}` : null}
          icon={<Package className="h-5 w-5" />}
          iconClassName="bg-emerald-100 text-emerald-700"
          loading={statsQuery.isLoading}
        />
        <StatCard
          label="Total value (available)"
          value={stats ? `Rs. ${formatPrice(stats.totalValue)}` : null}
          icon={<DollarSign className="h-5 w-5" />}
          iconClassName="bg-sky-100 text-sky-700"
          loading={statsQuery.isLoading}
        />
        <StatCard
          label="Written off this month"
          value={stats ? `${stats.writtenOffThisMonth}` : null}
          icon={<TrendingDown className="h-5 w-5" />}
          iconClassName="bg-rose-100 text-rose-700"
          loading={statsQuery.isLoading}
        />
      </div>

      {/* ── Filter ──────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <RotateCcw className="h-4 w-4" />
          {itemsQuery.isFetching
            ? 'Refreshing…'
            : `${items.length} item${items.length === 1 ? '' : 's'}${
                statusFilter === 'all'
                  ? ''
                  : ` · ${STATUS_FILTER_OPTIONS.find((o) => o.value === statusFilter)?.label ?? ''}`
              }`}
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as StatusFilter)}
        >
          <SelectTrigger className="w-full sm:w-48">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTER_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ── Table / states ──────────────────────────────────── */}
      {itemsQuery.isLoading ? (
        <TableSkeleton />
      ) : itemsQuery.isError ? (
        <Card>
          <CardContent className="p-10 text-center space-y-4">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-rose-50 text-rose-600">
              <AlertCircle className="h-5 w-5" />
            </div>
            <p className="text-sm text-muted-foreground">
              Couldn&apos;t load returned items. The server may have restarted.
            </p>
            <Button variant="outline" onClick={() => itemsQuery.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center space-y-4">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <RotateCcw className="h-6 w-6" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">No returned items yet.</p>
              <p className="text-sm text-muted-foreground">
                Made-to-order items will appear here automatically when their
                orders come back as RTOs.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Variant</TableHead>
                  <TableHead className="w-[60px] text-center">Qty</TableHead>
                  <TableHead className="w-[110px]">Condition</TableHead>
                  <TableHead className="w-[110px] text-right">Cost</TableHead>
                  <TableHead className="w-[120px]">Status</TableHead>
                  <TableHead className="w-[120px]">Received</TableHead>
                  <TableHead className="w-[160px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <ReturnedRow
                    key={item.id}
                    item={item}
                    onMarkSold={(id) => setSoldTarget(id)}
                    onWriteOff={(id) => setWriteOffTarget(id)}
                  />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* ── Mark Sold / Write-off dialogs ───────────────────── */}
      <MarkSoldDialog
        open={soldTarget !== null}
        onOpenChange={(o) => {
          if (!markSoldMutation.isPending) setSoldTarget(o ? soldTarget : null)
        }}
        submitting={markSoldMutation.isPending}
        onSubmit={(reference) => {
          if (soldTarget) {
            markSoldMutation.mutate({ id: soldTarget, reference })
          }
        }}
      />

      <WriteOffDialog
        open={writeOffTarget !== null}
        onOpenChange={(o) => {
          if (!writeOffMutation.isPending) setWriteOffTarget(o ? writeOffTarget : null)
        }}
        submitting={writeOffMutation.isPending}
        onSubmit={(reason) => {
          if (writeOffTarget) {
            writeOffMutation.mutate({ id: writeOffTarget, reason })
          }
        }}
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Stat card
// ─────────────────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon,
  iconClassName,
  loading,
}: {
  label: string
  value: string | null
  icon: React.ReactNode
  iconClassName: string
  loading: boolean
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <p className="text-xs font-medium text-muted-foreground truncate">{label}</p>
            {loading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <p className="text-2xl font-semibold tracking-tight truncate">{value ?? '—'}</p>
            )}
          </div>
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
              iconClassName,
            )}
          >
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Table skeleton
// ─────────────────────────────────────────────────────────────────────────────

function TableSkeleton() {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="space-y-0">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-4 border-b px-4 py-4 last:border-b-0"
            >
              <Skeleton className="h-4 w-[200px]" />
              <Skeleton className="h-4 w-[40px]" />
              <Skeleton className="h-5 w-[80px] rounded-full" />
              <Skeleton className="h-4 w-[60px] ml-auto" />
              <Skeleton className="h-5 w-[80px] rounded-full" />
              <Skeleton className="h-4 w-[80px]" />
              <Skeleton className="h-8 w-[100px]" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Table row
// ─────────────────────────────────────────────────────────────────────────────

function ReturnedRow({
  item,
  onMarkSold,
  onWriteOff,
}: {
  item: ReturnedItem
  onMarkSold: (id: string) => void
  onWriteOff: (id: string) => void
}) {
  const attrs = formatAttributeValues(item.variant.attributeValues)
  const isAvailable = item.status === 'available'

  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col gap-0.5 min-w-[180px]">
          <span className="text-sm font-medium leading-tight line-clamp-1">
            {item.variant.product.title}
          </span>
          <span className="text-xs text-muted-foreground font-mono">
            {item.variant.sku}
          </span>
          {attrs && (
            <span className="text-xs text-muted-foreground line-clamp-1">{attrs}</span>
          )}
        </div>
      </TableCell>
      <TableCell className="text-center text-sm tabular-nums">{item.quantity}</TableCell>
      <TableCell>
        <Badge
          variant="outline"
          className={cn('text-xs', CONDITION_BADGE_STYLES[item.condition])}
        >
          {CONDITION_LABELS[item.condition]}
        </Badge>
      </TableCell>
      <TableCell className="text-right text-sm tabular-nums">
        Rs. {formatPrice(item.totalCost)}
      </TableCell>
      <TableCell>
        <Badge
          variant="outline"
          className={cn('text-xs', STATUS_BADGE_STYLES[item.status])}
        >
          {STATUS_LABELS[item.status]}
        </Badge>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {formatDate(item.receivedAt)}
      </TableCell>
      <TableCell className="text-right">
        {isAvailable ? (
          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => onMarkSold(item.id)}
            >
              <Check className="h-3.5 w-3.5" /> Mark Sold
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-rose-600 hover:text-rose-700 hover:bg-rose-50"
              onClick={() => onWriteOff(item.id)}
            >
              <X className="h-3.5 w-3.5" /> Write Off
            </Button>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Mark Sold dialog
// ─────────────────────────────────────────────────────────────────────────────

function MarkSoldDialog({
  open,
  onOpenChange,
  submitting,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  submitting: boolean
  onSubmit: (reference: string) => void
}) {
  const [reference, setReference] = useState('')

  // Reset on close
  useEffect(() => {
    if (!open) setReference('')
  }, [open])

  const trimmed = reference.trim()
  const canSubmit = trimmed.length > 0 && !submitting

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark item as sold</DialogTitle>
          <DialogDescription>
            Enter the order reference for this resale. The item will move from
            &ldquo;available&rdquo; to &ldquo;sold&rdquo;.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) onSubmit(trimmed)
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="sold_reference">
              Sold order reference <span className="text-rose-600">*</span>
            </Label>
            <Input
              id="sold_reference"
              autoFocus
              placeholder="e.g. ORD-2024-00456"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              disabled={submitting}
            />
            {trimmed.length === 0 && reference.length > 0 && (
              <p className="text-xs text-rose-600">Reference is required.</p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" />
                  Mark Sold
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Write-off dialog
// ─────────────────────────────────────────────────────────────────────────────

function WriteOffDialog({
  open,
  onOpenChange,
  submitting,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  submitting: boolean
  onSubmit: (reason: string) => void
}) {
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (!open) setReason('')
  }, [open])

  const trimmed = reason.trim()
  const canSubmit = trimmed.length >= 3 && !submitting

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Write off this item</DialogTitle>
          <DialogDescription>
            Writing off permanently removes the item from available stock. This
            cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) onSubmit(trimmed)
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="writeoff_reason">
              Reason <span className="text-rose-600">*</span>
            </Label>
            <Textarea
              id="writeoff_reason"
              autoFocus
              rows={3}
              placeholder="Why is this item being written off?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
            />
            <p className="text-xs text-muted-foreground">
              Must be at least 3 characters.
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={!canSubmit}
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Writing off…
                </>
              ) : (
                <>
                  <X className="h-4 w-4" />
                  Write Off
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
