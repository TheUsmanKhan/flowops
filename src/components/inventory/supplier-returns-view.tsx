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
  Plus,
  Search,
  RefreshCw,
  Undo2,
  AlertTriangle,
  Loader2,
  Clock,
  Wallet,
  Truck,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ReturnStatus =
  | 'pending'
  | 'sent_to_supplier'
  | 'refunded'
  | 'replaced'
  | 'credit_note'
  | 'disputed'
  | 'rejected'

type ReturnReason = 'defective' | 'wrong_item' | 'quality_issue' | 'excess_quantity' | 'other'

interface SupplierReturnRow {
  id: string
  supplier: string
  productTitle: string
  sku: string
  location: string
  quantity: number
  costPerUnit: number
  totalValue: number
  reason: ReturnReason
  status: ReturnStatus
  resolutionType: string | null
  resolutionAmount: number | null
  createdAt: string
  resolvedAt: string | null
}

interface SupplierReturnsResponse {
  records: SupplierReturnRow[]
}

interface Supplier {
  id: string
  name: string
}
interface SuppliersResponse {
  suppliers: Supplier[]
}

interface InventoryLocation {
  id: string
  name: string
}
interface LocationsResponse {
  locations: InventoryLocation[]
}

interface PurchaseOrderOption {
  id: string
  poNumber: string
  supplier: string
  status: string
}
interface PurchaseOrdersResponse {
  orders: PurchaseOrderOption[]
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
  purchase_order_id?: string
  supplier_id: string
  org_variant_id: string
  location_id: string
  quantity: number
  cost_per_unit: number
  reason: ReturnReason
  notes?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Display maps
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<ReturnStatus, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  sent_to_supplier: {
    label: 'Sent to Supplier',
    className: 'bg-sky-50 text-sky-700 border-sky-200',
  },
  refunded: { label: 'Refunded', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  replaced: { label: 'Replaced', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  credit_note: {
    label: 'Credit Note',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  disputed: { label: 'Disputed', className: 'bg-rose-50 text-rose-700 border-rose-200' },
  rejected: { label: 'Rejected', className: 'bg-rose-50 text-rose-700 border-rose-200' },
}

const REASON_LABELS: Record<ReturnReason, string> = {
  defective: 'Defective',
  wrong_item: 'Wrong Item',
  quality_issue: 'Quality Issue',
  excess_quantity: 'Excess Quantity',
  other: 'Other',
}

const REASON_OPTIONS: { value: ReturnReason; label: string }[] = [
  { value: 'defective', label: 'Defective' },
  { value: 'wrong_item', label: 'Wrong item' },
  { value: 'quality_issue', label: 'Quality issue' },
  { value: 'excess_quantity', label: 'Excess quantity' },
  { value: 'other', label: 'Other' },
]

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

export function SupplierReturnsView() {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [createOpen, setCreateOpen] = useState(false)

  const canManage = can(PERMISSIONS.INVENTORY_MANAGE_SUPPLIER_RETURNS)

  const returnsQuery = useQuery<SupplierReturnsResponse>({
    queryKey: ['supplier-returns'],
    queryFn: () => api.get<SupplierReturnsResponse>('/api/supplier-returns'),
    staleTime: 15_000,
  })

  const records = returnsQuery.data?.records ?? []

  const stats = useMemo(() => {
    const pending = records.filter((r) => r.status === 'pending' || r.status === 'sent_to_supplier').length
    const monthValue = records
      .filter((r) => isThisMonth(r.createdAt) && r.status !== 'rejected')
      .reduce((s, r) => s + r.totalValue, 0)
    return { pending, monthValue }
  }, [records])

  const filtered = useMemo(() => {
    return records.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return (
          r.productTitle.toLowerCase().includes(q) ||
          r.sku.toLowerCase().includes(q) ||
          r.supplier.toLowerCase().includes(q) ||
          r.location.toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [records, statusFilter, search])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Supplier Returns"
        description="Send defective or excess stock back to suppliers and track refunds, replacements, and credit notes."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => returnsQuery.refetch()}
              disabled={returnsQuery.isFetching}
            >
              <RefreshCw
                className={returnsQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}
              />
              Refresh
            </Button>
            {canManage && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" /> New Return
              </Button>
            )}
          </div>
        }
      />

      {/* ── Stat cards ─────────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
                <Clock className="h-5 w-5" />
              </div>
              <span className="text-xl font-semibold tracking-tight">
                {returnsQuery.isLoading ? <Skeleton className="h-7 w-12" /> : stats.pending}
              </span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">Pending returns</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                <Wallet className="h-5 w-5" />
              </div>
              <span className="text-xl font-semibold tracking-tight tabular-nums">
                {returnsQuery.isLoading ? <Skeleton className="h-7 w-24" /> : formatPKR(stats.monthValue)}
              </span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">Total value this month</p>
          </CardContent>
        </Card>
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by product, SKU, supplier, or location…"
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
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="sent_to_supplier">Sent to Supplier</SelectItem>
            <SelectItem value="refunded">Refunded</SelectItem>
            <SelectItem value="replaced">Replaced</SelectItem>
            <SelectItem value="credit_note">Credit Note</SelectItem>
            <SelectItem value="disputed">Disputed</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* ── Table ──────────────────────────────────────────────────────────── */}
      {returnsQuery.isLoading ? (
        <Card>
          <CardContent className="p-3 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </CardContent>
        </Card>
      ) : returnsQuery.isError ? (
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">
              Couldn&apos;t load supplier returns. {getErrorMessage(returnsQuery.error)}
            </p>
            <Button variant="outline" onClick={() => returnsQuery.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <EmptyState hasRecords={records.length > 0} canManage={canManage} onCreate={() => setCreateOpen(true)} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r) => {
                    const badge = STATUS_BADGE[r.status]
                    return (
                      <TableRow key={r.id}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium text-sm">{r.productTitle}</span>
                            <span className="text-xs text-muted-foreground font-mono">{r.sku}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{r.supplier}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{r.location}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">
                            {REASON_LABELS[r.reason]}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{r.quantity}</TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {formatPKR(r.totalValue)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={badge.className}>
                            {badge.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatDate(r.createdAt)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground p-3">
              Showing {filtered.length} of {records.length} supplier returns
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── Create dialog ─────────────────────────────────────────────────── */}
      {canManage && (
        <CreateReturnDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onSuccess={() => {
            void queryClient.invalidateQueries({ queryKey: ['supplier-returns'] })
            void queryClient.invalidateQueries({ queryKey: ['inventory-dashboard'] })
            setCreateOpen(false)
          }}
        />
      )}
    </div>
  )
}

function EmptyState({
  hasRecords,
  canManage,
  onCreate,
}: {
  hasRecords: boolean
  canManage: boolean
  onCreate: () => void
}) {
  return (
    <Card>
      <CardContent className="p-10 sm:p-14 text-center">
        <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <Undo2 className="h-7 w-7 text-primary" />
        </div>
        <h3 className="text-lg font-semibold">
          {hasRecords ? 'No returns match your filters' : 'No supplier returns yet'}
        </h3>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
          {hasRecords
            ? 'Try a different search or status filter.'
            : 'Record a return to send defective or excess stock back to a supplier. The stock will be removed from your inventory immediately.'}
        </p>
        {!hasRecords && canManage && (
          <Button className="mt-5" onClick={onCreate}>
            <Plus className="h-4 w-4" /> Report a return
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Create return dialog
// ─────────────────────────────────────────────────────────────────────────────

function CreateReturnDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSuccess: () => void
}) {
  const [purchaseOrderId, setPurchaseOrderId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [variantId, setVariantId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [costPerUnit, setCostPerUnit] = useState('0')
  const [reason, setReason] = useState<ReturnReason>('defective')
  const [notes, setNotes] = useState('')
  const [variantSearch, setVariantSearch] = useState('')

  // ── Data queries ─────────────────────────────────────────────────────────
  const suppliersQuery = useQuery<SuppliersResponse>({
    queryKey: ['suppliers'],
    queryFn: () => api.get<SuppliersResponse>('/api/suppliers'),
    staleTime: 30_000,
  })
  const locationsQuery = useQuery<LocationsResponse>({
    queryKey: ['locations'],
    queryFn: () => api.get<LocationsResponse>('/api/inventory-locations'),
    staleTime: 30_000,
  })
  const posQuery = useQuery<PurchaseOrdersResponse>({
    queryKey: ['purchase-orders'],
    queryFn: () => api.get<PurchaseOrdersResponse>('/api/purchase-orders'),
    staleTime: 30_000,
  })
  const productsQuery = useQuery<ProductsResponse>({
    queryKey: ['products', 'for-return'],
    queryFn: () => api.get<ProductsResponse>('/api/products?pageSize=100'),
    staleTime: 60_000,
  })
  const dashboardQuery = useQuery<InventoryDashboardResponse>({
    queryKey: ['inventory-dashboard'],
    queryFn: () => api.get<InventoryDashboardResponse>('/api/inventory/dashboard'),
    staleTime: 30_000,
  })

  // Build a flat searchable variant list (only variants that have stock at some location).
  const variantOptions = useMemo(() => {
    const stockByVariant = new Map<
      string,
      { onHand: number; avgCost: number; locations: Map<string, string> }
    >()
    for (const row of dashboardQuery.data?.stockTable ?? []) {
      if (row.onHand <= 0) continue
      const existing = stockByVariant.get(row.variantId)
      if (existing) {
        existing.onHand += row.onHand
        existing.locations.set(row.locationId, row.productTitle)
      } else {
        stockByVariant.set(row.variantId, {
          onHand: row.onHand,
          avgCost: row.avgCost,
          locations: new Map([[row.locationId, row.productTitle]]),
        })
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

  // When variant changes, look up its avg_cost pre-fill + available locations.
  const selectedVariant = variantOptions.find((v) => v.variantId === variantId)
  const availableLocationsForVariant = useMemo(() => {
    if (!variantId) return []
    const set = new Set<string>()
    for (const row of dashboardQuery.data?.stockTable ?? []) {
      if (row.variantId === variantId && row.onHand > 0) set.add(row.locationId)
    }
    return (locationsQuery.data?.locations ?? []).filter((l) => set.has(l.id))
  }, [variantId, dashboardQuery.data, locationsQuery.data])

  const pool = useMemo(() => {
    if (!variantId || !locationId) return null
    return (
      dashboardQuery.data?.stockTable.find(
        (r) => r.variantId === variantId && r.locationId === locationId,
      ) ?? null
    )
  }, [variantId, locationId, dashboardQuery.data])

  // Reset on close.
  useEffect(() => {
    if (!open) {
      setPurchaseOrderId('')
      setSupplierId('')
      setVariantId('')
      setLocationId('')
      setQuantity('1')
      setCostPerUnit('0')
      setReason('defective')
      setNotes('')
      setVariantSearch('')
    }
  }, [open])

  // Pre-fill cost_per_unit from pool avg_cost when variant or location changes.
  useEffect(() => {
    if (pool && pool.avgCost > 0) {
      setCostPerUnit(String(pool.avgCost))
    } else if (selectedVariant && selectedVariant.avgCost > 0) {
      setCostPerUnit(String(selectedVariant.avgCost))
    }
  }, [pool, selectedVariant])

  const qty = parseInt(quantity, 10) || 0
  const cpu = parseFloat(costPerUnit) || 0
  const totalValue = qty * cpu
  const insufficientStock = pool ? qty > pool.onHand : false

  const createMutation = useMutation({
    mutationFn: async (payload: CreatePayload) =>
      api.post('/api/supplier-returns', payload),
    onSuccess: () => {
      toast.success('Supplier return recorded. Stock reduced immediately.')
      onSuccess()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const handleSubmit = () => {
    if (!supplierId) return toast.error('Select a supplier.')
    if (!variantId) return toast.error('Select a variant to return.')
    if (!locationId) return toast.error('Select a location.')
    if (qty <= 0) return toast.error('Quantity must be positive.')
    if (cpu < 0) return toast.error('Cost per unit cannot be negative.')
    if (insufficientStock) return toast.error(`Only ${pool?.onHand ?? 0} units on hand at this location.`)
    createMutation.mutate({
      purchase_order_id: purchaseOrderId || undefined,
      supplier_id: supplierId,
      org_variant_id: variantId,
      location_id: locationId,
      quantity: qty,
      cost_per_unit: cpu,
      reason,
      notes: notes.trim() || undefined,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Undo2 className="h-4 w-4" /> New supplier return
          </DialogTitle>
          <DialogDescription>
            Stock will be removed from the selected location immediately on submit.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* ── PO + Supplier row ─────────────────────────────────────────── */}
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="sr-po">Linked PO (optional)</Label>
              <Select value={purchaseOrderId} onValueChange={setPurchaseOrderId}>
                <SelectTrigger id="sr-po">
                  <SelectValue placeholder="No linked PO" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">No linked PO</SelectItem>
                  {posQuery.data?.orders
                    .filter((o) => o.status !== 'cancelled')
                    .map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.poNumber} · {o.supplier}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sr-supplier">
                <span className="flex items-center gap-1.5">
                  <Truck className="h-3.5 w-3.5" /> Supplier
                </span>
              </Label>
              <Select value={supplierId} onValueChange={setSupplierId}>
                <SelectTrigger id="sr-supplier">
                  <SelectValue placeholder="Select supplier" />
                </SelectTrigger>
                <SelectContent>
                  {suppliersQuery.data?.suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* ── Variant search ────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <Label htmlFor="sr-variant-search">Variant</Label>
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
                    id="sr-variant-search"
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

          {/* ── Location + Qty + Cost ─────────────────────────────────────── */}
          <div className="grid sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="sr-location">Location</Label>
              <Select
                value={locationId}
                onValueChange={setLocationId}
                disabled={!variantId}
              >
                <SelectTrigger id="sr-location">
                  <SelectValue placeholder="Select location" />
                </SelectTrigger>
                <SelectContent>
                  {(availableLocationsForVariant.length > 0
                    ? availableLocationsForVariant
                    : locationsQuery.data?.locations ?? []
                  ).map((l) => (
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
              <Label htmlFor="sr-qty">Quantity</Label>
              <Input
                id="sr-qty"
                type="number"
                min="1"
                step="1"
                className="tabular-nums"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sr-cost">Cost / unit</Label>
              <Input
                id="sr-cost"
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

          {/* ── Reason ─────────────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <Label htmlFor="sr-reason">Reason</Label>
            <Select value={reason} onValueChange={(v) => setReason(v as ReturnReason)}>
              <SelectTrigger id="sr-reason">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASON_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sr-notes">Notes (optional)</Label>
            <Textarea
              id="sr-notes"
              placeholder="Any context about this return…"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {/* ── Stock reduction summary ───────────────────────────────────── */}
          <div className="rounded-md border bg-amber-50/50 border-amber-200 p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-medium text-amber-800">
              <AlertTriangle className="h-3.5 w-3.5" /> Immediate stock reduction
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-amber-900">
              <span>Variant:</span>
              <span className="font-mono">{selectedVariant?.sku ?? '—'}</span>
              <span>Location:</span>
              <span>
                {locationsQuery.data?.locations.find((l) => l.id === locationId)?.name ?? '—'}
              </span>
              <span>Quantity removed:</span>
              <span className="font-semibold">{qty} units</span>
              <span>Value debited:</span>
              <span className="font-semibold tabular-nums">{formatPKR(totalValue)}</span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Recording…
              </>
            ) : (
              <>
                <Undo2 className="h-4 w-4" /> Submit Return
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
