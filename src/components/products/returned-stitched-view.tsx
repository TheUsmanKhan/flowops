'use client'

import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useIdempotentMutation } from '@/hooks/use-idempotent-mutation'
import { z } from 'zod'
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
  Plus,
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

interface ProductsResponse {
  products: Array<{
    id: string
    title: string
    slug: string
    variants: Array<{
      id: string
      sku: string
      costPrice: number
      fulfillmentType: 'stock_based' | 'made_to_order'
      stitchingType: string | null
    }>
  }>
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

const CONDITION_OPTIONS: {
  value: ReturnedCondition
  label: string
  description: string
}[] = [
  { value: 'perfect', label: 'Perfect', description: 'Unused, tags on, no defects.' },
  { value: 'good', label: 'Good', description: 'Lightly used, minor signs of wear.' },
  { value: 'open_box', label: 'Open box', description: 'Packaging opened, item intact.' },
  { value: 'damaged', label: 'Damaged', description: 'Torn, stained, or otherwise unsellable.' },
]

const RETURN_REASON_OPTIONS = [
  { value: 'RTO', label: 'RTO (Return to Origin)' },
  { value: 'Refused at door', label: 'Refused at door' },
  { value: 'Size issue', label: 'Size issue' },
  { value: 'Wrong item', label: 'Wrong item' },
  { value: 'Other', label: 'Other' },
] as const

// ─────────────────────────────────────────────────────────────────────────────
// Zod schema for the "Record a Return" form
// ─────────────────────────────────────────────────────────────────────────────

const recordReturnSchema = z
  .object({
    org_variant_id: z.string().min(1, 'Select a variant'),
    quantity: z
      .number({ error: 'Enter a number' })
      .int('Quantity must be a whole number')
      .min(1, 'Quantity must be at least 1'),
    condition: z.enum(['perfect', 'good', 'open_box', 'damaged']),
    fabricStitchingCost: z
      .number({ error: 'Enter a number' })
      .min(0, 'Cannot be negative'),
    outgoingCourier: z
      .number({ error: 'Enter a number' })
      .min(0, 'Cannot be negative'),
    returnCourier: z
      .number({ error: 'Enter a number' })
      .min(0, 'Cannot be negative'),
    return_reason: z.enum([
      'RTO',
      'Refused at door',
      'Size issue',
      'Wrong item',
      'Other',
    ]),
    custom_reason: z.string().optional().or(z.literal('')),
    original_order_reference: z.string().optional().or(z.literal('')),
    notes: z
      .string()
      .max(1000, 'Notes must be 1000 characters or fewer')
      .optional()
      .or(z.literal('')),
  })
  .superRefine((data, ctx) => {
    const total = data.fabricStitchingCost + data.outgoingCourier + data.returnCourier
    if (total <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Total cost must be greater than 0',
        path: ['fabricStitchingCost'],
      })
    }
    if (data.return_reason === 'Other' && !data.custom_reason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Please specify the reason',
        path: ['custom_reason'],
      })
    }
  })

type RecordReturnForm = z.infer<typeof recordReturnSchema>

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

/** Parse a numeric input value, returning 0 for empty/invalid input. */
function parseNumberInput(v: string): number {
  if (v === '' || v === '-') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function ReturnedStitchedView() {
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [recordOpen, setRecordOpen] = useState(false)
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
  const receiveMutation = useIdempotentMutation<unknown, {
    org_variant_id: string
    quantity: number
    condition: ReturnedCondition
    total_cost: number
    return_reason: string
    original_order_reference?: string
    photos: string[]
    notes?: string
  }>({
    url: '/api/returned-stitched',
    mutationOptions: {
      onSuccess: (_data, vars) => {
        const msg =
          vars.condition === 'damaged'
            ? 'Damaged item recorded and written off.'
            : 'Return recorded — item is now available stock.'
        toast.success(msg)
        invalidateAll()
        setRecordOpen(false)
      },
      onError: (err) => toast.error(getErrorMessage(err)),
    },
  })

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
        description="Track stitched items that come back. Reuse, resell, or write them off cleanly."
        actions={
          <Button onClick={() => setRecordOpen(true)}>
            <Plus className="h-4 w-4" /> Record a Return
          </Button>
        }
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
                Record a return when a stitched item comes back.
              </p>
            </div>
            <Button onClick={() => setRecordOpen(true)}>
              <Plus className="h-4 w-4" /> Record a Return
            </Button>
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

      {/* ── Record a Return dialog ──────────────────────────── */}
      <RecordReturnDialog
        open={recordOpen}
        onOpenChange={(o) => {
          if (!receiveMutation.isPending) setRecordOpen(o)
        }}
        submitting={receiveMutation.isPending}
        onSubmit={(payload) => receiveMutation.mutate(payload)}
      />

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
// Record a Return dialog — full RHF + Zod form
// ─────────────────────────────────────────────────────────────────────────────

interface RecordReturnPayload {
  org_variant_id: string
  quantity: number
  condition: ReturnedCondition
  total_cost: number
  return_reason: string
  original_order_reference?: string
  photos: string[]
  notes?: string
}

function RecordReturnDialog({
  open,
  onOpenChange,
  submitting,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  submitting: boolean
  onSubmit: (payload: RecordReturnPayload) => void
}) {
  // ---- Fetch products to populate made_to_order variant dropdown ----
  const productsQuery = useQuery<ProductsResponse>({
    queryKey: ['products', { for_return_form: true }],
    queryFn: () => api.get<ProductsResponse>('/api/products?pageSize=100'),
    enabled: open,
    staleTime: 60_000,
  })

  // Flatten to made_to_order variants only (with product title for context)
  const mtoVariants = useMemo(() => {
    const prods = productsQuery.data?.products ?? []
    const list: {
      id: string
      sku: string
      costPrice: number
      productTitle: string
      productSlug: string
    }[] = []
    for (const p of prods) {
      for (const v of p.variants) {
        if (v.fulfillmentType === 'made_to_order') {
          list.push({
            id: v.id,
            sku: v.sku,
            costPrice: v.costPrice,
            productTitle: p.title,
            productSlug: p.slug,
          })
        }
      }
    }
    return list
  }, [productsQuery.data])

  // ---- RHF setup ----
  const form = useForm<RecordReturnForm>({
    resolver: zodResolver(recordReturnSchema),
    mode: 'onChange',
    defaultValues: {
      org_variant_id: '',
      quantity: 1,
      condition: 'perfect',
      fabricStitchingCost: 0,
      outgoingCourier: 0,
      returnCourier: 0,
      return_reason: 'RTO',
      custom_reason: '',
      original_order_reference: '',
      notes: '',
    },
  })

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors },
  } = form

  const selectedVariantId = watch('org_variant_id')
  const condition = watch('condition')
  const returnReason = watch('return_reason')
  const fabricStitchingCost = watch('fabricStitchingCost')
  const outgoingCourier = watch('outgoingCourier')
  const returnCourier = watch('returnCourier')
  const notesValue = watch('notes')

  const totalCost =
    (Number(fabricStitchingCost) || 0) +
    (Number(outgoingCourier) || 0) +
    (Number(returnCourier) || 0)

  // ---- Reset form when dialog opens ----
  useEffect(() => {
    if (open) {
      reset({
        org_variant_id: '',
        quantity: 1,
        condition: 'perfect',
        fabricStitchingCost: 0,
        outgoingCourier: 0,
        returnCourier: 0,
        return_reason: 'RTO',
        custom_reason: '',
        original_order_reference: '',
        notes: '',
      })
    }
  }, [open, reset])

  // ---- When a variant is selected, prefill fabric+stitching cost from variant costPrice ----
  useEffect(() => {
    if (!selectedVariantId) return
    const v = mtoVariants.find((x) => x.id === selectedVariantId)
    if (v) {
      setValue('fabricStitchingCost', v.costPrice, { shouldValidate: true })
    }
  }, [selectedVariantId, mtoVariants, setValue])

  // ---- Submit handler ----
  function onValid(values: RecordReturnForm) {
    const finalReason =
      values.return_reason === 'Other'
        ? values.custom_reason?.trim() || 'Other'
        : values.return_reason

    const payload: RecordReturnPayload = {
      org_variant_id: values.org_variant_id,
      quantity: values.quantity,
      condition: values.condition,
      total_cost: totalCost,
      return_reason: finalReason,
      original_order_reference:
        values.original_order_reference?.trim() || undefined,
      photos: [],
      notes: values.notes?.trim() || undefined,
    }
    onSubmit(payload)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record a returned stitched item</DialogTitle>
          <DialogDescription>
            Log an item that came back. Damaged items are written off automatically
            and will not appear as available stock.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onValid)} className="space-y-5">
          {/* ── Variant select ──────────────────────────────── */}
          <div className="space-y-2">
            <Label htmlFor="org_variant_id">
              Returned variant <span className="text-rose-600">*</span>
            </Label>
            <input type="hidden" {...register('org_variant_id')} />
            <Select
              value={selectedVariantId}
              onValueChange={(v) => setValue('org_variant_id', v, { shouldValidate: true })}
              disabled={productsQuery.isLoading}
            >
              <SelectTrigger id="org_variant_id" aria-label="Returned variant">
                <SelectValue
                  placeholder={
                    productsQuery.isLoading
                      ? 'Loading variants…'
                      : mtoVariants.length === 0
                        ? 'No made-to-order variants found'
                        : 'Select a made-to-order variant'
                  }
                />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {mtoVariants.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    <div className="flex flex-col">
                      <span className="text-sm">{v.productTitle}</span>
                      <span className="text-xs text-muted-foreground font-mono">
                        {v.sku} · Rs. {formatPrice(v.costPrice)}
                      </span>
                    </div>
                  </SelectItem>
                ))}
                {mtoVariants.length === 0 && !productsQuery.isLoading && (
                  <div className="px-2 py-3 text-xs text-muted-foreground text-center">
                    No made-to-order variants in your catalog.
                  </div>
                )}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Only made-to-order variants are eligible — these are the stitched items that can come back.
            </p>
            {errors.org_variant_id && (
              <p className="text-xs text-rose-600">{errors.org_variant_id.message}</p>
            )}
          </div>

          {/* ── Quantity ────────────────────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="quantity">
                Quantity <span className="text-rose-600">*</span>
              </Label>
              <Input
                id="quantity"
                type="number"
                min={1}
                step={1}
                {...register('quantity', {
                  setValueAs: (v) => {
                    if (v === '' || v === null || v === undefined) return undefined
                    const n = typeof v === 'number' ? v : Number(v)
                    return Number.isFinite(n) ? Math.floor(n) : undefined
                  },
                })}
              />
              {errors.quantity && (
                <p className="text-xs text-rose-600">{errors.quantity.message}</p>
              )}
            </div>
          </div>

          {/* ── Condition radio cards ───────────────────────── */}
          <div className="space-y-2">
            <Label>
              Condition <span className="text-rose-600">*</span>
            </Label>
            <input type="hidden" {...register('condition')} />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {CONDITION_OPTIONS.map((opt) => {
                const selected = condition === opt.value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setValue('condition', opt.value, { shouldValidate: true })}
                    aria-pressed={selected}
                    className={cn(
                      'flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors text-sm',
                      selected
                        ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                        : 'border-input hover:bg-muted/50',
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{opt.label}</span>
                      <span
                        className={cn(
                          'flex h-4 w-4 items-center justify-center rounded-full border',
                          selected ? 'border-primary' : 'border-muted-foreground/40',
                        )}
                      >
                        {selected && (
                          <span className="h-2 w-2 rounded-full bg-primary" />
                        )}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground leading-snug">
                      {opt.description}
                    </span>
                  </button>
                )
              })}
            </div>
            {errors.condition && (
              <p className="text-xs text-rose-600">{errors.condition.message}</p>
            )}

            {condition === 'damaged' && (
              <div className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <p>
                  Damaged items are written off immediately and will not appear as available stock.
                </p>
              </div>
            )}
          </div>

          {/* ── Total cost breakdown ────────────────────────── */}
          <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Total cost breakdown</p>
              <p className="text-xs text-muted-foreground">
                Total: <span className="font-semibold text-foreground">Rs. {formatPrice(totalCost)}</span>
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="fabricStitchingCost" className="text-xs">
                  Fabric + stitching
                </Label>
                <Input
                  id="fabricStitchingCost"
                  type="number"
                  min={0}
                  step="0.01"
                  {...register('fabricStitchingCost', {
                    setValueAs: (v) =>
                      v === '' || v === null || v === undefined
                        ? 0
                        : typeof v === 'number'
                          ? v
                          : parseNumberInput(String(v)),
                  })}
                />
                {errors.fabricStitchingCost && (
                  <p className="text-xs text-rose-600">
                    {errors.fabricStitchingCost.message}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="outgoingCourier" className="text-xs">
                  Outgoing courier
                </Label>
                <Input
                  id="outgoingCourier"
                  type="number"
                  min={0}
                  step="0.01"
                  {...register('outgoingCourier', {
                    setValueAs: (v) =>
                      v === '' || v === null || v === undefined
                        ? 0
                        : typeof v === 'number'
                          ? v
                          : parseNumberInput(String(v)),
                  })}
                />
                {errors.outgoingCourier && (
                  <p className="text-xs text-rose-600">
                    {errors.outgoingCourier.message}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="returnCourier" className="text-xs">
                  Return courier
                </Label>
                <Input
                  id="returnCourier"
                  type="number"
                  min={0}
                  step="0.01"
                  {...register('returnCourier', {
                    setValueAs: (v) =>
                      v === '' || v === null || v === undefined
                        ? 0
                        : typeof v === 'number'
                          ? v
                          : parseNumberInput(String(v)),
                  })}
                />
                {errors.returnCourier && (
                  <p className="text-xs text-rose-600">
                    {errors.returnCourier.message}
                  </p>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Total is computed as fabric+stitching + outgoing + return courier.
            </p>
          </div>

          {/* ── Return reason ───────────────────────────────── */}
          <div className="space-y-2">
            <Label>
              Return reason <span className="text-rose-600">*</span>
            </Label>
            <input type="hidden" {...register('return_reason')} />
            <Select
              value={returnReason}
              onValueChange={(v) =>
                setValue('return_reason', v as RecordReturnForm['return_reason'], {
                  shouldValidate: true,
                })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose a reason" />
              </SelectTrigger>
              <SelectContent>
                {RETURN_REASON_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.return_reason && (
              <p className="text-xs text-rose-600">{errors.return_reason.message}</p>
            )}

            {returnReason === 'Other' && (
              <div className="space-y-1.5 pt-1">
                <Label htmlFor="custom_reason" className="text-xs">
                  Specify reason <span className="text-rose-600">*</span>
                </Label>
                <Input
                  id="custom_reason"
                  placeholder="Describe the reason for return"
                  {...register('custom_reason')}
                />
                {errors.custom_reason && (
                  <p className="text-xs text-rose-600">
                    {errors.custom_reason.message}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* ── Original order reference ────────────────────── */}
          <div className="space-y-2">
            <Label htmlFor="original_order_reference" className="text-xs">
              Original order reference (optional)
            </Label>
            <Input
              id="original_order_reference"
              placeholder="e.g. ORD-2024-00123"
              {...register('original_order_reference')}
            />
          </div>

          {/* ── Notes ───────────────────────────────────────── */}
          <div className="space-y-2">
            <Label htmlFor="notes" className="text-xs">
              Notes (optional)
            </Label>
            <Textarea
              id="notes"
              rows={3}
              placeholder="Inspection notes, damage description, follow-up actions…"
              {...register('notes')}
            />
            <div className="flex items-center justify-between">
              {errors.notes ? (
                <p className="text-xs text-rose-600">{errors.notes.message}</p>
              ) : (
                <span />
              )}
              <p className="text-xs text-muted-foreground tabular-nums">
                {(notesValue ?? '').length} / 1000
              </p>
            </div>
          </div>

          {/* ── Footer ──────────────────────────────────────── */}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" />
                  Record Return
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
