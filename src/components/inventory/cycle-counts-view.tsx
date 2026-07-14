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
import { Progress } from '@/components/ui/progress'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  ClipboardList,
  Plus,
  Search,
  RefreshCw,
  Loader2,
  PlayCircle,
  CheckCircle2,
  XCircle,
  Send,
  AlertTriangle,
  ArrowLeft,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type CountType = 'full' | 'partial' | 'spot'
type CountStatus =
  | 'scheduled'
  | 'in_progress'
  | 'pending_review'
  | 'approved'
  | 'cancelled'

interface CycleCountRow {
  id: string
  countName: string
  countType: CountType
  status: CountStatus
  location: string
  scheduledAt: string
  startedAt: string | null
  completedAt: string | null
  approvedAt: string | null
  totalDiscrepancies: number
  totalVarianceValue: number
  itemCount: number
}

interface CycleCountsResponse {
  counts: CycleCountRow[]
}

interface CycleCountItemRow {
  id: string
  variant: {
    id: string
    sku: string
    productTitle: string
  }
  systemQuantity: number
  countedQuantity: number | null
  discrepancy: number | null
  discrepancyValue: number | null
  discrepancyReason: string | null
  adjustmentApproved: boolean
  notes: string | null
  countedAt: string | null
}

interface CycleCountDetail {
  id: string
  countName: string
  countType: CountType
  status: CountStatus
  location: { id: string; name: string }
  scheduledAt: string
  startedAt: string | null
  completedAt: string | null
  approvedAt: string | null
  totalDiscrepancies: number
  totalVarianceValue: number
  notes: string | null
  items: CycleCountItemRow[]
}

interface CycleCountDetailResponse {
  count: CycleCountDetail
}

interface InventoryLocation {
  id: string
  name: string
}
interface LocationsResponse {
  locations: InventoryLocation[]
}

interface CreatePayload {
  location_id: string
  count_name: string
  count_type: CountType
  scheduled_at?: string
  notes?: string
}

interface SubmitCountsPayload {
  action: 'submit_counts'
  counted_items: Array<{
    item_id: string
    counted_quantity: number
    discrepancy_reason?: string
    notes?: string
  }>
}

interface ActionPayload {
  action: 'start' | 'submit_counts' | 'approve' | 'cancel'
  counted_items?: SubmitCountsPayload['counted_items']
}

// ─────────────────────────────────────────────────────────────────────────────
// Display maps
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<CountStatus, { label: string; className: string }> = {
  scheduled: { label: 'Scheduled', className: 'bg-gray-100 text-gray-700 border-gray-200' },
  in_progress: {
    label: 'In Progress',
    className: 'bg-sky-50 text-sky-700 border-sky-200',
  },
  pending_review: {
    label: 'Pending Review',
    className: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  approved: {
    label: 'Approved',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  cancelled: { label: 'Cancelled', className: 'bg-rose-50 text-rose-700 border-rose-200' },
}

const COUNT_TYPE_LABEL: Record<CountType, string> = {
  full: 'Full Count',
  partial: 'Partial',
  spot: 'Spot Check',
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function CycleCountsView() {
  const can = useCan()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [cancelTarget, setCancelTarget] = useState<CycleCountRow | null>(null)

  const canManage = can(PERMISSIONS.INVENTORY_CYCLE_COUNT)

  const countsQuery = useQuery<CycleCountsResponse>({
    queryKey: ['cycle-counts'],
    queryFn: () => api.get<CycleCountsResponse>('/api/cycle-counts'),
    staleTime: 15_000,
  })

  const counts = countsQuery.data?.counts ?? []

  const filtered = useMemo(() => {
    return counts.filter((c) => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return (
          c.countName.toLowerCase().includes(q) ||
          c.location.toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [counts, statusFilter, search])

  const invalidateAll = (id?: string) => {
    void queryClient.invalidateQueries({ queryKey: ['cycle-counts'] })
    if (id) {
      void queryClient.invalidateQueries({ queryKey: ['cycle-count', id] })
    }
    void queryClient.invalidateQueries({ queryKey: ['inventory-dashboard'] })
  }

  // ── Action mutations ─────────────────────────────────────────────────────
  const startMutation = useMutation({
    mutationFn: async (id: string) =>
      api.patch(`/api/cycle-counts/${id}`, { action: 'start' }),
    onSuccess: () => {
      toast.success('Count started. Inventory snapshot captured.')
      if (selectedId) invalidateAll(selectedId)
      else invalidateAll()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const approveMutation = useMutation({
    mutationFn: async (id: string) =>
      api.patch(`/api/cycle-counts/${id}`, { action: 'approve' }),
    onSuccess: () => {
      toast.success('Count approved. Adjustments applied to inventory.')
      if (selectedId) invalidateAll(selectedId)
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const cancelMutation = useMutation({
    mutationFn: async (id: string) =>
      api.patch(`/api/cycle-counts/${id}`, { action: 'cancel' }),
    onSuccess: () => {
      toast.success('Count cancelled.')
      setCancelTarget(null)
      if (selectedId) invalidateAll(selectedId)
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cycle Counts"
        description="Reconcile system stock against physical counts. Discrepancies become inventory adjustments on approval."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => countsQuery.refetch()}
              disabled={countsQuery.isFetching}
            >
              <RefreshCw
                className={countsQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}
              />
              Refresh
            </Button>
            {canManage && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" /> New Cycle Count
              </Button>
            )}
          </div>
        }
      />

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search count name or location…"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-48">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="scheduled">Scheduled</SelectItem>
            <SelectItem value="in_progress">In Progress</SelectItem>
            <SelectItem value="pending_review">Pending Review</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        {/* ── Left: counts list ─────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-3">
          {countsQuery.isLoading ? (
            <Card>
              <CardContent className="p-3 space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-16" />
                ))}
              </CardContent>
            </Card>
          ) : countsQuery.isError ? (
            <Card>
              <CardContent className="p-10 text-center">
                <p className="text-sm text-muted-foreground mb-4">
                  Couldn&apos;t load cycle counts. {getErrorMessage(countsQuery.error)}
                </p>
                <Button variant="outline" onClick={() => countsQuery.refetch()}>
                  Try again
                </Button>
              </CardContent>
            </Card>
          ) : filtered.length === 0 ? (
            <EmptyState
              hasCounts={counts.length > 0}
              canManage={canManage}
              onCreate={() => setCreateOpen(true)}
            />
          ) : (
            <div className="space-y-2 max-h-[70vh] overflow-y-auto scrollbar-thin pr-1">
              {filtered.map((c) => {
                const badge = STATUS_BADGE[c.status]
                const isSelected = c.id === selectedId
                return (
                  <button
                    type="button"
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className={`w-full text-left rounded-md border p-3 transition-colors ${
                      isSelected
                        ? 'border-primary bg-primary/5'
                        : 'hover:bg-muted/50 border-border'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">{c.countName}</p>
                        <p className="text-xs text-muted-foreground">{c.location}</p>
                      </div>
                      <Badge variant="outline" className={badge.className}>
                        {badge.label}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground mt-2">
                      <span>
                        {c.itemCount} item{c.itemCount === 1 ? '' : 's'} ·{' '}
                        {COUNT_TYPE_LABEL[c.countType]}
                      </span>
                      {c.status === 'approved' || c.status === 'pending_review' ? (
                        <span
                          className={`tabular-nums font-medium ${
                            c.totalDiscrepancies > 0
                              ? 'text-amber-700'
                              : 'text-emerald-700'
                          }`}
                        >
                          {c.totalDiscrepancies} discrepancies · {formatPKR(c.totalVarianceValue)}
                        </span>
                      ) : (
                        <span className="whitespace-nowrap">{formatDate(c.scheduledAt)}</span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* ── Right: detail or empty ────────────────────────────────────── */}
        <div className="lg:col-span-3">
          {selectedId ? (
            <CycleCountDetailPanel
              countId={selectedId}
              onBack={() => setSelectedId(null)}
              onStart={() => startMutation.mutate(selectedId)}
              onApprove={() => approveMutation.mutate(selectedId)}
              onCancel={() => {
                const target = counts.find((c) => c.id === selectedId)
                if (target) setCancelTarget(target)
              }}
              starting={startMutation.isPending}
              approving={approveMutation.isPending}
              canManage={canManage}
            />
          ) : (
            <Card>
              <CardContent className="p-10 text-center">
                <ClipboardList className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
                <p className="text-sm text-muted-foreground">
                  Select a cycle count on the left to see its items and take action.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* ── Create dialog ─────────────────────────────────────────────────── */}
      {canManage && (
        <CreateCountDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onSuccess={() => {
            void queryClient.invalidateQueries({ queryKey: ['cycle-counts'] })
            setCreateOpen(false)
          }}
        />
      )}

      {/* ── Cancel dialog ─────────────────────────────────────────────────── */}
      <AlertDialog
        open={!!cancelTarget}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject for recount?</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelTarget && (
                <>
                  <strong>{cancelTarget.countName}</strong> will be cancelled. You can create a new
                  count if you need to recount this location.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelMutation.isPending}>Keep</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700"
              disabled={cancelMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (cancelTarget) cancelMutation.mutate(cancelTarget.id)
              }}
            >
              {cancelMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Cancelling…
                </>
              ) : (
                <>
                  <XCircle className="h-4 w-4" /> Reject &amp; Cancel
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
// Cycle count detail panel
// ─────────────────────────────────────────────────────────────────────────────

function CycleCountDetailPanel({
  countId,
  onBack,
  onStart,
  onApprove,
  onCancel,
  starting,
  approving,
  canManage,
}: {
  countId: string
  onBack: () => void
  onStart: () => void
  onApprove: () => void
  onCancel: () => void
  starting: boolean
  approving: boolean
  canManage: boolean
}) {
  const detailQuery = useQuery<CycleCountDetailResponse>({
    queryKey: ['cycle-count', countId],
    queryFn: () => api.get<CycleCountDetailResponse>(`/api/cycle-counts/${countId}`),
    staleTime: 10_000,
  })

  const count = detailQuery.data?.count

  if (detailQuery.isLoading) {
    return (
      <Card>
        <CardContent className="p-5 space-y-3">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-32" />
        </CardContent>
      </Card>
    )
  }

  if (detailQuery.isError || !count) {
    return (
      <Card>
        <CardContent className="p-10 text-center">
          <p className="text-sm text-muted-foreground mb-4">
            {detailQuery.isError ? getErrorMessage(detailQuery.error) : 'Count not found.'}
          </p>
          <Button variant="outline" onClick={() => detailQuery.refetch()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    )
  }

  const badge = STATUS_BADGE[count.status]
  const showActionButtons = canManage && count.status !== 'cancelled' && count.status !== 'approved'

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={onBack} className="lg:hidden -ml-2">
                <ArrowLeft className="h-4 w-4" />
              </Button>
              {count.countName}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              {count.location.name} · {COUNT_TYPE_LABEL[count.countType]}
            </p>
          </div>
          <Badge variant="outline" className={badge.className}>
            {badge.label}
          </Badge>
        </div>
        {(count.status === 'approved' || count.status === 'pending_review') && (
          <div className="grid grid-cols-2 gap-3 mt-3">
            <div className="rounded-md bg-muted/40 p-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Discrepancies
              </p>
              <p
                className={`text-lg font-semibold tabular-nums ${
                  count.totalDiscrepancies > 0 ? 'text-amber-700' : 'text-emerald-700'
                }`}
              >
                {count.totalDiscrepancies}
              </p>
            </div>
            <div className="rounded-md bg-muted/40 p-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Variance value
              </p>
              <p
                className={`text-lg font-semibold tabular-nums ${
                  count.totalVarianceValue < 0 ? 'text-rose-700' : 'text-amber-700'
                }`}
              >
                {formatPKR(count.totalVarianceValue)}
              </p>
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ── Status-aware actions ────────────────────────────────────────── */}
        {showActionButtons && (
          <div className="flex flex-wrap items-center gap-2">
            {count.status === 'scheduled' && (
              <Button onClick={onStart} disabled={starting}>
                {starting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Starting…
                  </>
                ) : (
                  <>
                    <PlayCircle className="h-4 w-4" /> Start Count
                  </>
                )}
              </Button>
            )}
            {count.status === 'in_progress' && (
              <SubmitCountsButton countId={count.id} items={count.items} />
            )}
            {count.status === 'pending_review' && (
              <>
                <Button onClick={onApprove} disabled={approving}>
                  {approving ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Approving…
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4" /> Approve &amp; Apply Adjustments
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  className="text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                  onClick={onCancel}
                >
                  <XCircle className="h-4 w-4" /> Reject for Recount
                </Button>
              </>
            )}
          </div>
        )}

        {/* ── Items table ──────────────────────────────────────────────────── */}
        {count.items.length === 0 ? (
          <div className="text-center py-8">
            <ClipboardList className="h-8 w-8 mx-auto text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">
              {count.status === 'scheduled'
                ? 'No items yet. Start the count to capture a snapshot of current stock.'
                : 'No items in this count.'}
            </p>
          </div>
        ) : (
          <div className="rounded-md border overflow-x-auto max-h-[60vh] overflow-y-auto scrollbar-thin">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>Variant</TableHead>
                  <TableHead className="text-right">System</TableHead>
                  <TableHead className="text-right">Counted</TableHead>
                  <TableHead className="text-right">Discrepancy</TableHead>
                  {count.status === 'pending_review' && <TableHead>Status</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {count.items.map((item) => {
                  const disc = item.discrepancy
                  return (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">{item.variant.productTitle}</span>
                          <span className="text-xs text-muted-foreground font-mono">
                            {item.variant.sku}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {item.systemQuantity}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {item.countedQuantity === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          item.countedQuantity
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {disc === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : disc === 0 ? (
                          <span className="text-emerald-600 font-medium">0</span>
                        ) : (
                          <span
                            className={`font-medium ${disc > 0 ? 'text-emerald-600' : 'text-rose-600'}`}
                          >
                            {disc > 0 ? '+' : ''}
                            {disc}
                          </span>
                        )}
                      </TableCell>
                      {count.status === 'pending_review' && (
                        <TableCell>
                          {disc !== null && disc !== 0 ? (
                            <Badge
                              variant="outline"
                              className="text-[10px] bg-amber-50 text-amber-700 border-amber-200"
                            >
                              Pending
                            </Badge>
                          ) : disc === 0 ? (
                            <Badge
                              variant="outline"
                              className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200"
                            >
                              Match
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {count.notes && (
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Notes</p>
            <p className="text-xs text-foreground whitespace-pre-wrap">{count.notes}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Submit counts button (in_progress → pending_review)
// Opens an inline dialog where each item's counted qty can be entered
// ─────────────────────────────────────────────────────────────────────────────

function SubmitCountsButton({
  countId,
  items,
}: {
  countId: string
  items: CycleCountItemRow[]
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [counts, setCounts] = useState<Record<string, string>>({})

  useEffect(() => {
    if (open) {
      const init: Record<string, string> = {}
      for (const i of items) {
        init[i.id] = i.countedQuantity === null ? String(i.systemQuantity) : String(i.countedQuantity)
      }
      setCounts(init)
    }
  }, [open, items])

  const submitMutation = useMutation({
    mutationFn: async (payload: SubmitCountsPayload) =>
      api.patch(`/api/cycle-counts/${countId}`, payload),
    onSuccess: (_data, vars) => {
      const totalDisc = vars.counted_items.reduce((s, i) => s + i.counted_quantity, 0)
      toast.success(`Submitted ${totalDisc} units counted. Awaiting review.`)
      void queryClient.invalidateQueries({ queryKey: ['cycle-count', countId] })
      void queryClient.invalidateQueries({ queryKey: ['cycle-counts'] })
      setOpen(false)
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const totalDiscrepancies = items.filter((i) => {
    const c = parseInt(counts[i.id] ?? '0', 10) || 0
    return c !== i.systemQuantity
  }).length

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Send className="h-4 w-4" /> Submit for Review
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto scrollbar-thin">
          <DialogHeader>
            <DialogTitle>Submit counted quantities</DialogTitle>
            <DialogDescription>
              Enter the actual counted quantity for each item. Discrepancies will be highlighted.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border max-h-[55vh] overflow-y-auto scrollbar-thin">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>Variant</TableHead>
                  <TableHead className="text-right">System</TableHead>
                  <TableHead className="w-28">Counted</TableHead>
                  <TableHead className="text-right">Diff</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((i) => {
                  const c = parseInt(counts[i.id] ?? '0', 10) || 0
                  const diff = c - i.systemQuantity
                  return (
                    <TableRow key={i.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">{i.variant.productTitle}</span>
                          <span className="text-xs text-muted-foreground font-mono">
                            {i.variant.sku}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {i.systemQuantity}
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          min="0"
                          step="1"
                          className="h-8 tabular-nums"
                          value={counts[i.id] ?? ''}
                          onChange={(e) =>
                            setCounts((prev) => ({ ...prev, [i.id]: e.target.value }))
                          }
                        />
                      </TableCell>
                      <TableCell
                        className={`text-right tabular-nums font-medium ${
                          diff === 0
                            ? 'text-emerald-600'
                            : diff > 0
                              ? 'text-emerald-600'
                              : 'text-rose-600'
                        }`}
                      >
                        {diff > 0 ? '+' : ''}
                        {diff}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
          {totalDiscrepancies > 0 && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>{totalDiscrepancies} item{totalDiscrepancies === 1 ? '' : 's'} with discrepancies</AlertTitle>
              <AlertDescription>
                On approval, these will be applied as cycle count adjustments to your inventory.
              </AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const counted_items = items.map((i) => ({
                  item_id: i.id,
                  counted_quantity: parseInt(counts[i.id] ?? '0', 10) || 0,
                }))
                submitMutation.mutate({ action: 'submit_counts', counted_items })
              }}
              disabled={submitMutation.isPending}
            >
              {submitMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Submitting…
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" /> Submit Counts
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty state + create dialog
// ─────────────────────────────────────────────────────────────────────────────

function EmptyState({
  hasCounts,
  canManage,
  onCreate,
}: {
  hasCounts: boolean
  canManage: boolean
  onCreate: () => void
}) {
  return (
    <Card>
      <CardContent className="p-10 sm:p-14 text-center">
        <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <ClipboardList className="h-7 w-7 text-primary" />
        </div>
        <h3 className="text-lg font-semibold">
          {hasCounts ? 'No counts match your filters' : 'No cycle counts yet'}
        </h3>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
          {hasCounts
            ? 'Try a different search or status filter.'
            : 'Schedule a cycle count to reconcile physical stock against your system inventory. Discrepancies become adjustments on approval.'}
        </p>
        {!hasCounts && canManage && (
          <Button className="mt-5" onClick={onCreate}>
            <Plus className="h-4 w-4" /> Schedule a count
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

function CreateCountDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSuccess: () => void
}) {
  const [locationId, setLocationId] = useState('')
  const [countName, setCountName] = useState('')
  const [countType, setCountType] = useState<CountType>('full')
  const [scheduledAt, setScheduledAt] = useState('')
  const [notes, setNotes] = useState('')

  const locationsQuery = useQuery<LocationsResponse>({
    queryKey: ['locations'],
    queryFn: () => api.get<LocationsResponse>('/api/inventory-locations'),
    staleTime: 30_000,
  })

  useEffect(() => {
    if (!open) {
      setLocationId('')
      setCountName('')
      setCountType('full')
      setScheduledAt('')
      setNotes('')
    }
  }, [open])

  useEffect(() => {
    if (!locationId && locationsQuery.data?.locations.length) {
      const def = locationsQuery.data.locations.find((l) => l.isDefault)
      setLocationId(def?.id ?? locationsQuery.data.locations[0].id)
    }
  }, [locationId, locationsQuery.data])

  const createMutation = useMutation({
    mutationFn: async (payload: CreatePayload) => api.post('/api/cycle-counts', payload),
    onSuccess: () => {
      toast.success('Cycle count scheduled.')
      onSuccess()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const handleSubmit = () => {
    if (!locationId) return toast.error('Select a location.')
    if (countName.trim().length < 2) return toast.error('Count name is required.')
    createMutation.mutate({
      location_id: locationId,
      count_name: countName.trim(),
      count_type: countType,
      scheduled_at: scheduledAt || undefined,
      notes: notes.trim() || undefined,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4" /> New cycle count
          </DialogTitle>
          <DialogDescription>
            Schedule a count for a single location. After starting, the system captures a snapshot
            of current stock.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cc-name">Count name</Label>
            <Input
              id="cc-name"
              placeholder="e.g. Monthly warehouse count — Oct 2024"
              value={countName}
              onChange={(e) => setCountName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cc-location">Location</Label>
            {locationsQuery.isLoading ? (
              <Skeleton className="h-9" />
            ) : (
              <Select value={locationId} onValueChange={setLocationId}>
                <SelectTrigger id="cc-location">
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
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cc-type">Count type</Label>
              <Select value={countType} onValueChange={(v) => setCountType(v as CountType)}>
                <SelectTrigger id="cc-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="full">Full Count</SelectItem>
                  <SelectItem value="partial">Partial</SelectItem>
                  <SelectItem value="spot">Spot Check</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cc-scheduled">Scheduled for (optional)</Label>
              <Input
                id="cc-scheduled"
                type="date"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cc-notes">Notes (optional)</Label>
            <Textarea
              id="cc-notes"
              placeholder="Any context for this count…"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={createMutation.isPending}>
            {createMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Scheduling…
              </>
            ) : (
              <>
                <Plus className="h-4 w-4" /> Schedule Count
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
