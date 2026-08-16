'use client'

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useIdempotentMutation } from '@/hooks/use-idempotent-mutation'
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
  ArrowLeftRight,
  Search,
  AlertCircle,
  Loader2,
  Warehouse,
  Package,
  ArrowRight,
  Truck,
  Info,
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
    reserved: number
    available: number
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

interface TransferPayload {
  org_variant_id: string
  from_location_id: string
  to_location_id: string
  quantity: number
  logistics_cost?: number
  notes?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

function parseCost(v: string): number {
  if (v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function TransferStockView() {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const queryClient = useQueryClient()

  const [fromLocationId, setFromLocationId] = useState<string>('')
  const [toLocationId, setToLocationId] = useState<string>('')
  const [variantSearch, setVariantSearch] = useState('')
  const [selectedVariantId, setSelectedVariantId] = useState<string>('')
  const [quantity, setQuantity] = useState<number>(1)
  const [logisticsCost, setLogisticsCost] = useState<number>(0)
  const [notes, setNotes] = useState('')

  const canTransfer = can(PERMISSIONS.INVENTORY_TRANSFER)

  // ── Data queries ─────────────────────────────────────────────────────────
  const locationsQuery = useQuery<LocationsResponse>({
    queryKey: ['locations'],
    queryFn: () => api.get<LocationsResponse>('/api/inventory-locations'),
    staleTime: 30_000,
  })

  const productsQuery = useQuery<ProductsResponse>({
    queryKey: ['products', 'for-transfer'],
    queryFn: () => api.get<ProductsResponse>('/api/products?pageSize=100'),
    staleTime: 60_000,
  })

  const dashboardQuery = useQuery<DashboardResponse>({
    queryKey: ['inventory-dashboard'],
    queryFn: () => api.get<DashboardResponse>('/api/inventory/dashboard'),
    staleTime: 15_000,
  })

  // Build the variant options list — but only those that actually have stock
  // at the selected source location (so we don't suggest impossible transfers).
  const variantOptions = useMemo(() => {
    const variantsWithStock = new Set(
      (dashboardQuery.data?.stockTable ?? [])
        .filter((p) => !fromLocationId || p.locationId === fromLocationId)
        .filter((p) => p.onHand > 0)
        .map((p) => p.variantId),
    )
    const list: Array<{
      variantId: string
      sku: string
      productTitle: string
      costPrice: number
    }> = []
    for (const p of productsQuery.data?.products ?? []) {
      for (const v of p.variants) {
        if (variantsWithStock.has(v.id)) {
          list.push({
            variantId: v.id,
            sku: v.sku,
            productTitle: p.title,
            costPrice: v.costPrice,
          })
        }
      }
    }
    return list
  }, [productsQuery.data, dashboardQuery.data, fromLocationId])

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

  const sourcePool = useMemo(() => {
    if (!selectedVariantId || !fromLocationId) return null
    return (
      dashboardQuery.data?.stockTable.find(
        (p) => p.variantId === selectedVariantId && p.locationId === fromLocationId,
      ) ?? null
    )
  }, [dashboardQuery.data, selectedVariantId, fromLocationId])

  const destinationPool = useMemo(() => {
    if (!selectedVariantId || !toLocationId) return null
    return (
      dashboardQuery.data?.stockTable.find(
        (p) => p.variantId === selectedVariantId && p.locationId === toLocationId,
      ) ?? null
    )
  }, [dashboardQuery.data, selectedVariantId, toLocationId])

  const selectedVariant = variantOptions.find((v) => v.variantId === selectedVariantId)
  const fromLocation = locationsQuery.data?.locations.find((l) => l.id === fromLocationId)
  const toLocation = locationsQuery.data?.locations.find((l) => l.id === toLocationId)

  const locationsDiffer = !!fromLocationId && !!toLocationId && fromLocationId !== toLocationId
  const transferCostPerUnit = sourcePool?.avgCost ?? selectedVariant?.costPrice ?? 0
  const transferStockValue = transferCostPerUnit * quantity

  const sourceAfterQty = sourcePool ? sourcePool.onHand - quantity : null
  const destBeforeQty = destinationPool ? destinationPool.onHand : 0
  const destAfterQty = destinationPool ? destinationPool.onHand + quantity : quantity

  // ── Mutation ─────────────────────────────────────────────────────────────
  const transferMutation = useIdempotentMutation<unknown, TransferPayload>({
    url: '/api/inventory/transfers',
    mutationOptions: {
      onSuccess: () => {
        toast.success(`Transferred ${quantity} unit${quantity === 1 ? '' : 's'} successfully.`)
        void queryClient.invalidateQueries({ queryKey: ['inventory-dashboard'] })
        void queryClient.invalidateQueries({ queryKey: ['location-detail'] })
        void queryClient.invalidateQueries({ queryKey: ['locations'] })
        navigate({ name: 'inventory' })
      },
      onError: (err) => toast.error(getErrorMessage(err)),
    },
  })

  // ── Submit ───────────────────────────────────────────────────────────────
  const handleSubmit = () => {
    if (!fromLocationId) {
      toast.error('Select a source location.')
      return
    }
    if (!toLocationId) {
      toast.error('Select a destination location.')
      return
    }
    if (fromLocationId === toLocationId) {
      toast.error('Source and destination must be different.')
      return
    }
    if (!selectedVariantId) {
      toast.error('Select a variant to transfer.')
      return
    }
    if (quantity <= 0) {
      toast.error('Quantity must be greater than zero.')
      return
    }
    if (sourcePool && quantity > sourcePool.available) {
      toast.error(
        `Insufficient available stock. Available: ${sourcePool.available}, requested: ${quantity}.`,
      )
      return
    }
    const payload: TransferPayload = {
      org_variant_id: selectedVariantId,
      from_location_id: fromLocationId,
      to_location_id: toLocationId,
      quantity,
      logistics_cost: logisticsCost,
      notes: notes.trim() || undefined,
    }
    transferMutation.mutate(payload)
  }

  const noLocations = !locationsQuery.isLoading && (locationsQuery.data?.locations.length ?? 0) === 0
  const insufficientLocations =
    !locationsQuery.isLoading && (locationsQuery.data?.locations.length ?? 0) < 2

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transfer Stock"
        description="Move stock between two locations. The item's average cost transfers unchanged — logistics costs are tracked separately."
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
            You need at least one inventory location before you can transfer stock.{' '}
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

      {insufficientLocations && !noLocations && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Need at least two locations</AlertTitle>
          <AlertDescription>
            Transferring stock requires at least two locations.{' '}
            <button
              type="button"
              className="font-medium underline underline-offset-4 hover:text-primary"
              onClick={() => navigate({ name: 'inventory-locations' })}
            >
              Add another location
            </button>{' '}
            to enable transfers.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ── Left: form ────────────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Transfer details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* From / To */}
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="tf-from">
                    <span className="flex items-center gap-1.5">
                      <Warehouse className="h-3.5 w-3.5" /> From location
                    </span>
                  </Label>
                  {locationsQuery.isLoading ? (
                    <Skeleton className="h-9" />
                  ) : (
                    <Select
                      value={fromLocationId}
                      onValueChange={(v) => {
                        setFromLocationId(v)
                        setSelectedVariantId('')
                      }}
                    >
                      <SelectTrigger id="tf-from">
                        <SelectValue placeholder="Select source" />
                      </SelectTrigger>
                      <SelectContent>
                        {locationsQuery.data?.locations.map((l) => (
                          <SelectItem key={l.id} value={l.id} disabled={l.id === toLocationId}>
                            {l.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tf-to">
                    <span className="flex items-center gap-1.5">
                      <Warehouse className="h-3.5 w-3.5" /> To location
                    </span>
                  </Label>
                  {locationsQuery.isLoading ? (
                    <Skeleton className="h-9" />
                  ) : (
                    <Select
                      value={toLocationId}
                      onValueChange={setToLocationId}
                    >
                      <SelectTrigger id="tf-to">
                        <SelectValue placeholder="Select destination" />
                      </SelectTrigger>
                      <SelectContent>
                        {locationsQuery.data?.locations.map((l) => (
                          <SelectItem key={l.id} value={l.id} disabled={l.id === fromLocationId}>
                            {l.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </div>

              {fromLocationId && toLocationId && !locationsDiffer && (
                <p className="text-xs text-rose-600 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" /> Source and destination must be different.
                </p>
              )}

              {/* Variant search */}
              <div className="space-y-1.5">
                <Label htmlFor="tf-variant">
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
                        id="tf-variant"
                        placeholder={
                          fromLocationId
                            ? 'Search by SKU or product title…'
                            : 'Select a source location first'
                        }
                        className="pl-9"
                        value={variantSearch}
                        onChange={(e) => setVariantSearch(e.target.value)}
                        disabled={productsQuery.isLoading || !fromLocationId}
                      />
                      {productsQuery.isLoading && (
                        <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                      )}
                    </div>
                    {variantSearch.trim() && (
                      <div className="rounded-md border bg-popover shadow-sm max-h-56 overflow-y-auto scrollbar-thin">
                        {variantSearchResults.length === 0 ? (
                          <div className="p-3 text-sm text-muted-foreground">
                            {fromLocationId
                              ? 'No variants with stock at this source match your search.'
                              : 'Select a source location first.'}
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
                  </>
                )}
              </div>

              {/* Quantity + logistics cost */}
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="tf-qty">Quantity</Label>
                  <Input
                    id="tf-qty"
                    type="number"
                    min="1"
                    step="1"
                    className="tabular-nums"
                    value={quantity}
                    onChange={(e) => setQuantity(parseQty(e.target.value))}
                  />
                  {sourcePool && (
                    <p className="text-xs text-muted-foreground">
                      Available at source: {sourcePool.available} (reserved: {sourcePool.reserved})
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tf-logistics">
                    <span className="flex items-center gap-1.5">
                      <Truck className="h-3.5 w-3.5" /> Logistics cost
                    </span>
                  </Label>
                  <Input
                    id="tf-logistics"
                    type="number"
                    min="0"
                    step="0.01"
                    className="tabular-nums"
                    value={logisticsCost}
                    onChange={(e) => setLogisticsCost(parseCost(e.target.value))}
                  />
                </div>
              </div>

              <Alert className="border-sky-200 bg-sky-50/50">
                <Info className="h-4 w-4 text-sky-600" />
                <AlertDescription className="text-sky-800">
                  This cost is tracked separately and does not affect the item&apos;s average cost at
                  the destination.
                </AlertDescription>
              </Alert>

              {/* Notes */}
              <div className="space-y-1.5">
                <Label htmlFor="tf-notes">Notes (optional)</Label>
                <Textarea
                  id="tf-notes"
                  placeholder="Any context for this transfer…"
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">{notes.length}/1000 characters</p>
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
                  {/* Source row */}
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Warehouse className="h-3 w-3" /> Leaving source
                    </p>
                    <p className="text-sm font-medium truncate">
                      {fromLocation?.name ?? 'No source selected'}
                    </p>
                    {sourcePool ? (
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                          {sourcePool.onHand} →{' '}
                          <span
                            className={`font-medium ${
                              sourceAfterQty !== null && sourceAfterQty < 0
                                ? 'text-rose-600'
                                : 'text-foreground'
                            }`}
                          >
                            {sourceAfterQty}
                          </span>
                        </span>
                        <span className="text-muted-foreground">
                          @ {formatPKR(sourcePool.avgCost)}
                        </span>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        No stock here yet for this variant.
                      </p>
                    )}
                  </div>

                  {/* Arrow */}
                  <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                    <span className="font-mono">{quantity}</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                    <span className="font-mono">{formatPKR(transferCostPerUnit)}/unit</span>
                  </div>

                  {/* Destination row */}
                  <div className="space-y-1 pt-2 border-t">
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Warehouse className="h-3 w-3" /> Arriving at destination
                    </p>
                    <p className="text-sm font-medium truncate">
                      {toLocation?.name ?? 'No destination selected'}
                    </p>
                    {destinationPool ? (
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                          {destBeforeQty} →{' '}
                          <span className="font-medium text-foreground">{destAfterQty}</span>
                        </span>
                        <span className="text-muted-foreground">
                          @ {formatPKR(transferCostPerUnit)} (unchanged)
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                          new pool →{' '}
                          <span className="font-medium text-foreground">{destAfterQty}</span>
                        </span>
                        <span className="text-muted-foreground">
                          @ {formatPKR(transferCostPerUnit)} (unchanged)
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Stock value moving */}
                  <div className="pt-2 border-t">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Stock value moving</span>
                      <span className="font-medium tabular-nums">
                        {formatPKR(transferStockValue)}
                      </span>
                    </div>
                    {logisticsCost > 0 && (
                      <div className="flex items-center justify-between text-xs mt-1">
                        <span className="text-muted-foreground">Logistics cost (separate)</span>
                        <span className="font-medium tabular-nums text-amber-700">
                          {formatPKR(logisticsCost)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {sourcePool && quantity > sourcePool.available && (
                <p className="text-xs text-rose-600 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" /> Insufficient available stock at source.
                </p>
              )}

              <Button
                className="w-full"
                size="lg"
                onClick={handleSubmit}
                disabled={
                  transferMutation.isPending ||
                  !selectedVariantId ||
                  !locationsDiffer ||
                  quantity <= 0 ||
                  (!!sourcePool && quantity > sourcePool.available) ||
                  noLocations ||
                  insufficientLocations ||
                  !canTransfer
                }
              >
                {transferMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Transferring…
                  </>
                ) : (
                  <>
                    <ArrowLeftRight className="h-4 w-4" /> Transfer Stock
                  </>
                )}
              </Button>

              {!canTransfer && (
                <p className="text-xs text-rose-600 text-center">
                  You don&apos;t have permission to transfer stock.
                </p>
              )}

              {selectedVariant && (
                <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground space-y-1">
                  <p className="font-medium text-foreground">{selectedVariant.productTitle}</p>
                  <p className="font-mono">{selectedVariant.sku}</p>
                  <div className="flex items-center gap-1 pt-1">
                    <Badge variant="outline" className="text-[10px]">
                      {fromLocation?.name ?? '—'}
                    </Badge>
                    <ArrowRight className="h-3 w-3" />
                    <Badge variant="outline" className="text-[10px]">
                      {toLocation?.name ?? '—'}
                    </Badge>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
