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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  ArrowLeft,
  PackagePlus,
  Plus,
  Trash2,
  Search,
  AlertCircle,
  Loader2,
  ShoppingCart,
  Warehouse,
  MapPin,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface InventoryLocation {
  id: string
  name: string
  locationType: string
  city: string
  isOrgLevel: boolean
  isDefault: boolean
}

interface VariantOption {
  variantId: string
  sku: string
  productTitle: string
  costPrice: number
  fulfillmentType: string
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

interface LineItem {
  variantId: string
  sku: string
  productTitle: string
  costPrice: number
  quantity: number
  costPerUnit: number
}

interface LocationsResponse {
  locations: InventoryLocation[]
}

interface ReceivePayload {
  location_id: string
  supplier_name?: string
  po_reference?: string
  notes?: string
  items: Array<{ org_variant_id: string; quantity: number; cost_per_unit: number }>
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

export function ReceiveStockView() {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const queryClient = useQueryClient()

  const [locationId, setLocationId] = useState<string>('')
  const [supplierName, setSupplierName] = useState('')
  const [poReference, setPoReference] = useState('')
  const [notes, setNotes] = useState('')
  const [items, setItems] = useState<LineItem[]>([])
  const [variantSearch, setVariantSearch] = useState('')

  const canReceive = can(PERMISSIONS.INVENTORY_RECEIVE)

  // ── Data queries ─────────────────────────────────────────────────────────
  const locationsQuery = useQuery<LocationsResponse>({
    queryKey: ['locations'],
    queryFn: () => api.get<LocationsResponse>('/api/inventory-locations'),
    staleTime: 30_000,
  })

  const productsQuery = useQuery<ProductsResponse>({
    queryKey: ['products', 'for-receive'],
    queryFn: () => api.get<ProductsResponse>('/api/products?pageSize=100'),
    staleTime: 60_000,
  })

  // Flatten all variants into a searchable list.
  const variantOptions: VariantOption[] = useMemo(() => {
    const list: VariantOption[] = []
    for (const p of productsQuery.data?.products ?? []) {
      for (const v of p.variants) {
        list.push({
          variantId: v.id,
          sku: v.sku,
          productTitle: p.title,
          costPrice: v.costPrice,
          fulfillmentType: v.fulfillmentType,
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

  const totalUnits = useMemo(
    () => items.reduce((s, i) => s + i.quantity, 0),
    [items],
  )
  const totalValue = useMemo(
    () => items.reduce((s, i) => s + i.quantity * i.costPerUnit, 0),
    [items],
  )

  const selectedLocation = locationsQuery.data?.locations.find((l) => l.id === locationId)

  // Auto-select the default location once.
  useEffect(() => {
    if (!locationId && locationsQuery.data?.locations.length) {
      const def = locationsQuery.data.locations.find((l) => l.isDefault)
      setLocationId(def?.id ?? locationsQuery.data.locations[0].id)
    }
  }, [locationId, locationsQuery.data])

  // ── Mutation ─────────────────────────────────────────────────────────────
  const receiveMutation = useMutation({
    mutationFn: async (payload: ReceivePayload) =>
      api.post('/api/inventory/receive', payload),
    onSuccess: (_data, vars) => {
      const unitCount = vars.items.reduce((s, i) => s + i.quantity, 0)
      toast.success(`Received ${unitCount} unit${unitCount === 1 ? '' : 's'} across ${vars.items.length} item${vars.items.length === 1 ? '' : 's'}.`)
      void queryClient.invalidateQueries({ queryKey: ['inventory-dashboard'] })
      void queryClient.invalidateQueries({ queryKey: ['locations'] })
      navigate({ name: 'inventory' })
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  // ── Item manipulation ────────────────────────────────────────────────────
  const addVariant = (variant: VariantOption) => {
    setItems((prev) => {
      if (prev.some((i) => i.variantId === variant.variantId)) {
        toast.info('That variant is already in the list.')
        return prev
      }
      return [
        ...prev,
        {
          variantId: variant.variantId,
          sku: variant.sku,
          productTitle: variant.productTitle,
          costPrice: variant.costPrice,
          quantity: 1,
          costPerUnit: variant.costPrice,
        },
      ]
    })
    setVariantSearch('')
  }

  const removeItem = (variantId: string) => {
    setItems((prev) => prev.filter((i) => i.variantId !== variantId))
  }

  const updateItem = (variantId: string, patch: Partial<LineItem>) => {
    setItems((prev) =>
      prev.map((i) => (i.variantId === variantId ? { ...i, ...patch } : i)),
    )
  }

  // ── Submit ───────────────────────────────────────────────────────────────
  const handleSubmit = () => {
    if (!locationId) {
      toast.error('Select a location.')
      return
    }
    if (items.length === 0) {
      toast.error('Add at least one variant to receive.')
      return
    }
    const invalid = items.find((i) => i.quantity <= 0 || i.costPerUnit < 0)
    if (invalid) {
      toast.error(`Invalid quantity or cost for ${invalid.sku}.`)
      return
    }
    const payload: ReceivePayload = {
      location_id: locationId,
      supplier_name: supplierName.trim() || undefined,
      po_reference: poReference.trim() || undefined,
      notes: notes.trim() || undefined,
      items: items.map((i) => ({
        org_variant_id: i.variantId,
        quantity: i.quantity,
        cost_per_unit: i.costPerUnit,
      })),
    }
    receiveMutation.mutate(payload)
  }

  const noLocations = !locationsQuery.isLoading && (locationsQuery.data?.locations.length ?? 0) === 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="Receive Stock"
        description="Record incoming inventory directly into a location. Use this for opening stock or non-PO receipts."
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate({ name: 'inventory' })}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        }
      />

      {/* ── No locations banner ──────────────────────────────────────────── */}
      {noLocations && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>No locations yet</AlertTitle>
          <AlertDescription>
            You need at least one inventory location before you can receive stock.{' '}
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
        {/* ── Left: form + items ────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-4">
          {/* Header form */}
          <Card>
            <CardContent className="p-5 space-y-4">
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="recv-location">
                    <span className="flex items-center gap-1.5">
                      <Warehouse className="h-3.5 w-3.5" /> Receive into
                    </span>
                  </Label>
                  {locationsQuery.isLoading ? (
                    <Skeleton className="h-9" />
                  ) : (
                    <Select value={locationId} onValueChange={setLocationId}>
                      <SelectTrigger id="recv-location">
                        <SelectValue placeholder="Select location" />
                      </SelectTrigger>
                      <SelectContent>
                        {locationsQuery.data?.locations.map((l) => (
                          <SelectItem key={l.id} value={l.id}>
                            {l.name} {l.isDefault && '(default)'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {selectedLocation && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      {selectedLocation.city} · {selectedLocation.locationType}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="recv-supplier">
                    <span className="flex items-center gap-1.5">
                      <ShoppingCart className="h-3.5 w-3.5" /> Supplier name (optional)
                    </span>
                  </Label>
                  <Input
                    id="recv-supplier"
                    placeholder="e.g. ABC Fabrics"
                    value={supplierName}
                    onChange={(e) => setSupplierName(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="recv-po">PO reference (optional)</Label>
                  <Input
                    id="recv-po"
                    placeholder="e.g. PO-2024-001"
                    value={poReference}
                    onChange={(e) => setPoReference(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="recv-notes">Notes (optional)</Label>
                  <Input
                    id="recv-notes"
                    placeholder="Any context for this receipt"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Search-to-add variants */}
          <Card>
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="recv-search">Add items</Label>
                <span className="text-xs text-muted-foreground">
                  {items.length} item{items.length === 1 ? '' : 's'} added
                </span>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="recv-search"
                  placeholder="Search by SKU or product title…"
                  className="pl-9"
                  value={variantSearch}
                  onChange={(e) => setVariantSearch(e.target.value)}
                  disabled={productsQuery.isLoading || noLocations}
                />
                {productsQuery.isLoading && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>

              {/* Search results dropdown */}
              {variantSearch.trim() && (
                <div className="rounded-md border bg-popover shadow-sm max-h-64 overflow-y-auto scrollbar-thin">
                  {variantSearchResults.length === 0 ? (
                    <div className="p-3 text-sm text-muted-foreground">
                      {productsQuery.isLoading
                        ? 'Loading variants…'
                        : 'No variants match your search.'}
                    </div>
                  ) : (
                    <ul className="divide-y">
                      {variantSearchResults.map((v) => (
                        <li key={v.variantId}>
                          <button
                            type="button"
                            onClick={() => addVariant(v)}
                            className="w-full text-left px-3 py-2 hover:bg-muted/60 transition-colors flex items-center justify-between gap-2"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">{v.productTitle}</p>
                              <p className="text-xs text-muted-foreground font-mono">{v.sku}</p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-xs text-muted-foreground">
                                {formatPKR(v.costPrice)}
                              </span>
                              <Plus className="h-3.5 w-3.5 text-primary" />
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* Items table */}
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Variant</TableHead>
                      <TableHead className="w-24">Qty</TableHead>
                      <TableHead className="w-32">Cost / unit</TableHead>
                      <TableHead className="text-right w-28">Line total</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                          No items added yet. Search above to add variants.
                        </TableCell>
                      </TableRow>
                    ) : (
                      items.map((item) => (
                        <TableRow key={item.variantId}>
                          <TableCell>
                            <div className="flex flex-col">
                              <span className="text-sm font-medium">{item.productTitle}</span>
                              <span className="text-xs text-muted-foreground font-mono">
                                {item.sku}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min="1"
                              step="1"
                              className="h-8 tabular-nums"
                              value={item.quantity}
                              onChange={(e) =>
                                updateItem(item.variantId, {
                                  quantity: parseQty(e.target.value),
                                })
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min="0"
                              step="0.01"
                              className="h-8 tabular-nums"
                              value={item.costPerUnit}
                              onChange={(e) =>
                                updateItem(item.variantId, {
                                  costPerUnit: parseCost(e.target.value),
                                })
                              }
                            />
                          </TableCell>
                          <TableCell className="text-right tabular-nums font-medium">
                            {formatPKR(item.quantity * item.costPerUnit)}
                          </TableCell>
                          <TableCell>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-rose-600 hover:bg-rose-50"
                              onClick={() => removeItem(item.variantId)}
                              aria-label={`Remove ${item.sku}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ── Right: summary + submit ────────────────────────────────────── */}
        <div className="space-y-4">
          <Card className="lg:sticky lg:top-20">
            <CardContent className="p-5 space-y-4">
              <div className="space-y-3">
                <SummaryRow label="Items" value={String(items.length)} />
                <SummaryRow label="Total units" value={String(totalUnits)} />
                <div className="pt-3 border-t space-y-1">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Total stock value
                  </p>
                  <p className="text-2xl font-semibold tabular-nums">{formatPKR(totalValue)}</p>
                </div>
              </div>

              <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground space-y-1">
                <p className="flex items-center gap-1.5 font-medium text-foreground">
                  <Warehouse className="h-3.5 w-3.5" /> Receiving into
                </p>
                <p>{selectedLocation?.name ?? 'No location selected'}</p>
                {selectedLocation && (
                  <Badge variant="outline" className="text-[10px] mt-1">
                    {selectedLocation.isOrgLevel ? 'Org-level' : 'Company'}
                  </Badge>
                )}
              </div>

              <Button
                className="w-full"
                size="lg"
                onClick={handleSubmit}
                disabled={
                  receiveMutation.isPending ||
                  items.length === 0 ||
                  !locationId ||
                  noLocations ||
                  !canReceive
                }
              >
                {receiveMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Receiving…
                  </>
                ) : (
                  <>
                    <PackagePlus className="h-4 w-4" /> Receive Stock
                  </>
                )}
              </Button>

              {!canReceive && (
                <p className="text-xs text-rose-600 text-center">
                  You don&apos;t have permission to receive stock.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  )
}
