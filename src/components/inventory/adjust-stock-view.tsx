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
  ArrowLeft,
  SlidersHorizontal,
  Search,
  Plus,
  Minus,
  AlertCircle,
  Loader2,
  Warehouse,
  Package,
  TrendingUp,
  TrendingDown,
  ArrowRight,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface InventoryLocation {
  id: string
  name: string
  locationType: string
  city: string
  isDefault: boolean
}

interface LocationsResponse {
  locations: InventoryLocation[]
}

interface DashboardResponse {
  stockTable: Array<{
    poolId: string
    variantId: string
    sku: string
    productTitle: string
    locationId: string
    location: string
    onHand: number
    avgCost: number
  }>
}

interface ProductsResponse {
  products: Array<{
    id: string
    title: string
    variants: Array<{
      id: string
      sku: string
      costPrice: number
      fulfillmentType: string
    }>
  }>
}

interface AdjustPayload {
  org_variant_id: string
  location_id: string
  quantity: number
  reason: string
  notes?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

type Direction = 'add' | 'remove'

const REASON_PRESETS = [
  'Cycle count correction',
  'Found extra stock not in system',
  'Damaged in storage',
  'Miscount on previous receipt',
  'Sample / display usage',
  'Quality check failure',
  'Other',
] as const

const PKR = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 })
function formatPKR(n: number): string {
  return `Rs. ${PKR.format(n)}`
}

function getErrorMessage(err: unknown): string {
  if (err instanceof FetchError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong. Please try again.'
}

function parseQty(v: string): number {
  if (v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function AdjustStockView() {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const queryClient = useQueryClient()

  const [variantSearch, setVariantSearch] = useState('')
  const [selectedVariantId, setSelectedVariantId] = useState<string>('')
  const [locationId, setLocationId] = useState<string>('')
  const [direction, setDirection] = useState<Direction>('add')
  const [quantity, setQuantity] = useState<number>(1)
  const [reason, setReason] = useState<string>('')
  const [notes, setNotes] = useState('')

  const canAdjust = can(PERMISSIONS.INVENTORY_ADJUST)

  // ── Data queries ─────────────────────────────────────────────────────────
  const locationsQuery = useQuery<LocationsResponse>({
    queryKey: ['locations'],
    queryFn: () => api.get<LocationsResponse>('/api/inventory-locations'),
    staleTime: 30_000,
  })

  const productsQuery = useQuery<ProductsResponse>({
    queryKey: ['products', 'for-adjust'],
    queryFn: () => api.get<ProductsResponse>('/api/products?pageSize=100'),
    staleTime: 60_000,
  })

  const dashboardQuery = useQuery<DashboardResponse>({
    queryKey: ['inventory-dashboard'],
    queryFn: () => api.get<DashboardResponse>('/api/inventory/dashboard'),
    staleTime: 15_000,
  })

  // Auto-select default location once.
  useEffect(() => {
    if (!locationId && locationsQuery.data?.locations.length) {
      const def = locationsQuery.data.locations.find((l) => l.isDefault)
      setLocationId(def?.id ?? locationsQuery.data.locations[0].id)
    }
  }, [locationId, locationsQuery.data])

  // Flatten variants for search.
  const variantOptions = useMemo(() => {
    const list: Array<{
      variantId: string
      sku: string
      productTitle: string
      costPrice: number
    }> = []
    for (const p of productsQuery.data?.products ?? []) {
      for (const v of p.variants) {
        list.push({
          variantId: v.id,
          sku: v.sku,
          productTitle: p.title,
          costPrice: v.costPrice,
        })
      }
    }
    return list
  }, [productsQuery.data])

  const variantSearchResults = useMemo(() => {
    if (!variantSearch.trim()) return []
    const q = variantSearch.toLowerCase()
    return variantOptions
      .filter(
        (v) =>
          v.sku.toLowerCase().includes(q) || v.productTitle.toLowerCase().includes(q),
      )
      .slice(0, 8)
  }, [variantOptions, variantSearch])

  // Look up the current pool for the selected variant + location.
  const currentPool = useMemo(() => {
    if (!selectedVariantId || !locationId) return null
    return (
      dashboardQuery.data?.stockTable.find(
        (p) => p.variantId === selectedVariantId && p.locationId === locationId,
      ) ?? null
    )
  }, [dashboardQuery.data, selectedVariantId, locationId])

  const selectedVariant = variantOptions.find((v) => v.variantId === selectedVariantId)
  const selectedLocation = locationsQuery.data?.locations.find((l) => l.id === locationId)

  const effectiveDelta = direction === 'add' ? Math.abs(quantity) : -Math.abs(quantity)
  const projectedOnHand = currentPool ? currentPool.onHand + effectiveDelta : null

  // ── Mutation ─────────────────────────────────────────────────────────────
  const adjustMutation = useMutation({
    mutationFn: async (payload: AdjustPayload) =>
      api.post('/api/inventory/adjust', payload),
    onSuccess: (_data, vars) => {
      const verb = vars.quantity > 0 ? 'added' : 'removed'
      toast.success(`Stock ${verb}: ${Math.abs(vars.quantity)} unit${Math.abs(vars.quantity) === 1 ? '' : 's'}.`)
      void queryClient.invalidateQueries({ queryKey: ['inventory-dashboard'] })
      void queryClient.invalidateQueries({ queryKey: ['location-detail'] })
      navigate({ name: 'inventory' })
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  // ── Submit ───────────────────────────────────────────────────────────────
  const handleSubmit = () => {
    if (!selectedVariantId) {
      toast.error('Select a variant to adjust.')
      return
    }
    if (!locationId) {
      toast.error('Select a location.')
      return
    }
    if (quantity <= 0) {
      toast.error('Quantity must be greater than zero.')
      return
    }
    const finalReason = reason === 'Other' ? notes.trim() : reason
    if (!finalReason || finalReason.length < 3) {
      toast.error('Provide a reason (at least 3 characters).')
      return
    }
    if (direction === 'remove' && currentPool && Math.abs(quantity) > currentPool.onHand) {
      toast.error(
        `Cannot remove ${Math.abs(quantity)} units — only ${currentPool.onHand} on hand.`,
      )
      return
    }
    const payload: AdjustPayload = {
      org_variant_id: selectedVariantId,
      location_id: locationId,
      quantity: effectiveDelta,
      reason: finalReason,
      notes: notes.trim() || undefined,
    }
    adjustMutation.mutate(payload)
  }

  const noLocations = !locationsQuery.isLoading && (locationsQuery.data?.locations.length ?? 0) === 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="Adjust Stock"
        description="Manually add or remove stock to correct counts, record damage, or fix discrepancies."
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate({ name: 'inventory' })}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        }
      />

      {noLocations && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>No locations yet</AlertTitle>
          <AlertDescription>
            You need at least one inventory location before you can adjust stock.{' '}
            <button
              type="button"
              className="font-medium underline underline-offset-4 hover:text-primary"
              onClick={() => navigate({ name: 'inventory-locations' })}
            >
              Create a location
            </button>{' '}
            first.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ── Left: form ────────────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Adjustment details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Location */}
              <div className="space-y-1.5">
                <Label htmlFor="adj-location">
                  <span className="flex items-center gap-1.5">
                    <Warehouse className="h-3.5 w-3.5" /> Location
                  </span>
                </Label>
                {locationsQuery.isLoading ? (
                  <Skeleton className="h-9" />
                ) : (
                  <Select value={locationId} onValueChange={setLocationId}>
                    <SelectTrigger id="adj-location">
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

              {/* Variant search */}
              <div className="space-y-1.5">
                <Label htmlFor="adj-variant">
                  <span className="flex items-center gap-1.5">
                    <Package className="h-3.5 w-3.5" /> Variant
                  </span>
                </Label>
                {selectedVariant ? (
                  <div className="flex items-center justify-between gap-2 rounded-md border p-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {selectedVariant.productTitle}
                      </p>
                      <p className="text-xs text-muted-foreground font-mono">
                        {selectedVariant.sku}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setSelectedVariantId('')
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
                        id="adj-variant"
                        placeholder="Search by SKU or product title…"
                        className="pl-9"
                        value={variantSearch}
                        onChange={(e) => setVariantSearch(e.target.value)}
                        disabled={productsQuery.isLoading || !locationId}
                      />
                      {productsQuery.isLoading && (
                        <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                      )}
                    </div>
                    {variantSearch.trim() && (
                      <div className="rounded-md border bg-popover shadow-sm max-h-56 overflow-y-auto scrollbar-thin">
                        {variantSearchResults.length === 0 ? (
                          <div className="p-3 text-sm text-muted-foreground">
                            No variants match your search.
                          </div>
                        ) : (
                          <ul className="divide-y">
                            {variantSearchResults.map((v) => (
                              <li key={v.variantId}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedVariantId(v.variantId)
                                    setVariantSearch('')
                                  }}
                                  className="w-full text-left px-3 py-2 hover:bg-muted/60 transition-colors"
                                >
                                  <p className="text-sm font-medium truncate">
                                    {v.productTitle}
                                  </p>
                                  <p className="text-xs text-muted-foreground font-mono">
                                    {v.sku}
                                  </p>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                    {!locationId && (
                      <p className="text-xs text-muted-foreground">
                        Select a location first to enable variant search.
                      </p>
                    )}
                  </>
                )}
              </div>

              {/* Direction + Quantity */}
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Direction</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <DirectionButton
                      active={direction === 'add'}
                      onClick={() => setDirection('add')}
                      icon={<Plus className="h-4 w-4" />}
                      label="Add"
                      tone="emerald"
                    />
                    <DirectionButton
                      active={direction === 'remove'}
                      onClick={() => setDirection('remove')}
                      icon={<Minus className="h-4 w-4" />}
                      label="Remove"
                      tone="rose"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="adj-qty">Quantity</Label>
                  <Input
                    id="adj-qty"
                    type="number"
                    min="1"
                    step="1"
                    className="tabular-nums"
                    value={quantity}
                    onChange={(e) => setQuantity(parseQty(e.target.value))}
                  />
                </div>
              </div>

              {/* Reason */}
              <div className="space-y-1.5">
                <Label htmlFor="adj-reason">Reason</Label>
                <Select value={reason} onValueChange={setReason}>
                  <SelectTrigger id="adj-reason">
                    <SelectValue placeholder="Select a reason" />
                  </SelectTrigger>
                  <SelectContent>
                    {REASON_PRESETS.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {reason === 'Other' && (
                  <Input
                    placeholder="Briefly describe the reason (min 3 chars)…"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="mt-2"
                  />
                )}
              </div>

              {/* Notes */}
              <div className="space-y-1.5">
                <Label htmlFor="adj-notes">Notes (optional)</Label>
                <Textarea
                  id="adj-notes"
                  placeholder="Any additional context for this adjustment…"
                  rows={3}
                  value={reason === 'Other' ? '' : notes}
                  onChange={(e) => setNotes(e.target.value)}
                  disabled={reason === 'Other'}
                />
                <p className="text-xs text-muted-foreground">
                  {reason === 'Other'
                    ? 'Reason is captured from the field above.'
                    : `${notes.length}/1000 characters`}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ── Right: live preview + submit ──────────────────────────────── */}
        <div className="space-y-4">
          <Card className="lg:sticky lg:top-20">
            <CardContent className="p-5 space-y-4">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
                  Live preview
                </p>
                <div className="rounded-md border bg-muted/30 p-4 space-y-3">
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Current on hand</p>
                    <p className="text-xl font-semibold tabular-nums">
                      {dashboardQuery.isLoading
                        ? '—'
                        : currentPool
                          ? currentPool.onHand
                          : 'No stock here yet'}
                    </p>
                    {currentPool && (
                      <p className="text-xs text-muted-foreground">
                        Avg cost {formatPKR(currentPool.avgCost)}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 text-sm">
                    <span
                      className={`px-2 py-0.5 rounded font-medium ${
                        effectiveDelta >= 0
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-rose-100 text-rose-700'
                      }`}
                    >
                      {effectiveDelta >= 0 ? '+' : '−'}
                      {Math.abs(effectiveDelta)}
                    </span>
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">adjustment</span>
                  </div>

                  <div className="pt-2 border-t space-y-1">
                    <p className="text-xs text-muted-foreground">Projected on hand</p>
                    <p
                      className={`text-2xl font-semibold tabular-nums ${
                        projectedOnHand !== null && projectedOnHand < 0
                          ? 'text-rose-600'
                          : ''
                      }`}
                    >
                      {projectedOnHand ?? '—'}
                    </p>
                    {projectedOnHand !== null && projectedOnHand < 0 && (
                      <p className="text-xs text-rose-600 flex items-center gap-1">
                        <AlertCircle className="h-3 w-3" /> Cannot go below zero.
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground space-y-1">
                <p className="flex items-center gap-1.5 font-medium text-foreground">
                  {direction === 'add' ? (
                    <TrendingUp className="h-3.5 w-3.5 text-emerald-600" />
                  ) : (
                    <TrendingDown className="h-3.5 w-3.5 text-rose-600" />
                  )}{' '}
                  {direction === 'add' ? 'Adding' : 'Removing'} {quantity} unit
                  {quantity === 1 ? '' : 's'}
                </p>
                <p>
                  {selectedVariant ? selectedVariant.productTitle : 'No variant selected'} ·{' '}
                  {selectedLocation ? selectedLocation.name : 'No location selected'}
                </p>
                {reason && reason !== 'Other' && (
                  <Badge variant="outline" className="text-[10px] mt-1">
                    {reason}
                  </Badge>
                )}
              </div>

              <Button
                className="w-full"
                size="lg"
                onClick={handleSubmit}
                disabled={
                  adjustMutation.isPending ||
                  !selectedVariantId ||
                  !locationId ||
                  quantity <= 0 ||
                  !reason ||
                  (reason === 'Other' && notes.trim().length < 3) ||
                  (projectedOnHand !== null && projectedOnHand < 0) ||
                  noLocations ||
                  !canAdjust
                }
              >
                {adjustMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Adjusting…
                  </>
                ) : (
                  <>
                    <SlidersHorizontal className="h-4 w-4" /> Apply adjustment
                  </>
                )}
              </Button>

              {!canAdjust && (
                <p className="text-xs text-rose-600 text-center">
                  You don&apos;t have permission to adjust stock.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function DirectionButton({
  active,
  onClick,
  icon,
  label,
  tone,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  tone: 'emerald' | 'rose'
}) {
  const activeClass =
    tone === 'emerald'
      ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
      : 'border-rose-500 bg-rose-50 text-rose-700'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center justify-center gap-1.5 rounded-md border py-2 text-sm font-medium transition-colors ${
        active
          ? activeClass
          : 'border-input bg-background hover:bg-muted/40 text-muted-foreground'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}
