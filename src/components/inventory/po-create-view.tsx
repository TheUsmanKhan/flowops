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
  ArrowLeft,
  Plus,
  Trash2,
  Search,
  AlertCircle,
  Loader2,
  ShoppingCart,
  Warehouse,
  Truck,
  Calendar,
  Wallet,
  Save,
  Send,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Supplier {
  id: string
  name: string
  contactPerson: string | null
  paymentTerms: string
}

interface SuppliersResponse {
  suppliers: Supplier[]
}

interface InventoryLocation {
  id: string
  name: string
  locationType: string
  city: string
  isOrgLevel: boolean
  isDefault: boolean
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

interface CreatePayload {
  supplier_id: string
  order_date?: string
  expected_delivery_date?: string
  delivery_location_id: string
  advance_payment: number
  payment_method?: string
  notes?: string
  items: Array<{
    org_variant_id: string
    ordered_quantity: number
    cost_per_unit: number
  }>
  status: 'draft' | 'ordered'
}

interface CreateResponse {
  id: string
  poNumber: string
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

function todayISO(): string {
  return new Date().toISOString().split('T')[0]
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function PoCreateView() {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const queryClient = useQueryClient()

  const canManage = can(PERMISSIONS.INVENTORY_MANAGE_PURCHASE_ORDERS)

  const [supplierId, setSupplierId] = useState('')
  const [deliveryLocationId, setDeliveryLocationId] = useState('')
  const [orderDate, setOrderDate] = useState(todayISO())
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState('')
  const [advancePayment, setAdvancePayment] = useState('0')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [notes, setNotes] = useState('')
  const [items, setItems] = useState<LineItem[]>([])
  const [variantSearch, setVariantSearch] = useState('')
  const [createSupplierOpen, setCreateSupplierOpen] = useState(false)

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

  const productsQuery = useQuery<ProductsResponse>({
    queryKey: ['products', 'for-po'],
    queryFn: () => api.get<ProductsResponse>('/api/products?pageSize=100'),
    staleTime: 60_000,
  })

  const variantOptions = useMemo(() => {
    const list: Array<{
      variantId: string
      sku: string
      productTitle: string
      costPrice: number
      fulfillmentType: string
    }> = []
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
        (v) => v.sku.toLowerCase().includes(q) || v.productTitle.toLowerCase().includes(q),
      )
      .slice(0, 8)
  }, [variantOptions, variantSearch])

  const totalUnits = useMemo(() => items.reduce((s, i) => s + i.quantity, 0), [items])
  const totalValue = useMemo(
    () => items.reduce((s, i) => s + i.quantity * i.costPerUnit, 0),
    [items],
  )
  const advance = parseCost(advancePayment)
  const balanceDue = Math.max(0, totalValue - advance)

  const selectedSupplier = suppliersQuery.data?.suppliers.find((s) => s.id === supplierId)
  const selectedLocation = locationsQuery.data?.locations.find((l) => l.id === deliveryLocationId)

  // Auto-select default location once.
  useEffect(() => {
    if (!deliveryLocationId && locationsQuery.data?.locations.length) {
      const def = locationsQuery.data.locations.find((l) => l.isDefault)
      setDeliveryLocationId(def?.id ?? locationsQuery.data.locations[0].id)
    }
  }, [deliveryLocationId, locationsQuery.data])

  // ── Mutation ─────────────────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: async (payload: CreatePayload) =>
      api.post<CreateResponse>('/api/purchase-orders', payload),
    onSuccess: (data, vars) => {
      toast.success(
        vars.status === 'ordered'
          ? `PO ${data.poNumber} confirmed and sent.`
          : `Draft PO ${data.poNumber} saved.`,
      )
      void queryClient.invalidateQueries({ queryKey: ['purchase-orders'] })
      void queryClient.invalidateQueries({ queryKey: ['inventory-dashboard'] })
      navigate({ name: 'inventory-po-detail', id: data.id })
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  // ── Item manipulation ────────────────────────────────────────────────────
  const addVariant = (variant: (typeof variantOptions)[number]) => {
    setItems((prev) => {
      if (prev.some((i) => i.variantId === variant.variantId)) {
        toast.info('That variant is already in the order.')
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
  const validate = (): string | null => {
    if (!supplierId) return 'Select a supplier.'
    if (!deliveryLocationId) return 'Select a delivery location.'
    if (items.length === 0) return 'Add at least one item to the order.'
    const invalid = items.find((i) => i.quantity <= 0 || i.costPerUnit < 0)
    if (invalid) return `Invalid quantity or cost for ${invalid.sku}.`
    if (advance > totalValue) return 'Advance payment cannot exceed total order value.'
    return null
  }

  const submit = (status: 'draft' | 'ordered') => {
    const err = validate()
    if (err) {
      toast.error(err)
      return
    }
    const payload: CreatePayload = {
      supplier_id: supplierId,
      order_date: orderDate || undefined,
      expected_delivery_date: expectedDeliveryDate || undefined,
      delivery_location_id: deliveryLocationId,
      advance_payment: advance,
      payment_method: paymentMethod.trim() || undefined,
      notes: notes.trim() || undefined,
      items: items.map((i) => ({
        org_variant_id: i.variantId,
        ordered_quantity: i.quantity,
        cost_per_unit: i.costPerUnit,
      })),
      status,
    }
    createMutation.mutate(payload)
  }

  const noSuppliers =
    !suppliersQuery.isLoading && (suppliersQuery.data?.suppliers.length ?? 0) === 0
  const noLocations =
    !locationsQuery.isLoading && (locationsQuery.data?.locations.length ?? 0) === 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Purchase Order"
        description="Order stock from a supplier. Confirm to send — drafts don't affect incoming stock."
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate({ name: 'inventory-purchase-orders' })}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        }
      />

      {(noSuppliers || noLocations) && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Before you create a PO</AlertTitle>
          <AlertDescription>
            You need at least one supplier and one inventory location.
            {noSuppliers && (
              <span className="block mt-1">
                <button
                  type="button"
                  className="font-medium underline underline-offset-4 hover:text-primary"
                  onClick={() => setCreateSupplierOpen(true)}
                >
                  Add a supplier
                </button>{' '}
                or visit the Suppliers page.
              </span>
            )}
            {noLocations && (
              <span className="block mt-1">
                <button
                  type="button"
                  className="font-medium underline underline-offset-4 hover:text-primary"
                  onClick={() => navigate({ name: 'inventory-locations' })}
                >
                  Create a location
                </button>{' '}
                first.
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}

      {!canManage && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Permission required</AlertTitle>
          <AlertDescription>
            You don&apos;t have permission to manage purchase orders. Save your work elsewhere.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ── Left: form + items ────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-4">
          {/* Header form */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <ShoppingCart className="h-4 w-4" /> Order details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="po-supplier">
                    <span className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5">
                        <Truck className="h-3.5 w-3.5" /> Supplier
                      </span>
                      <button
                        type="button"
                        className="text-[11px] text-primary hover:underline"
                        onClick={() => setCreateSupplierOpen(true)}
                      >
                        + Create new
                      </button>
                    </span>
                  </Label>
                  {suppliersQuery.isLoading ? (
                    <Skeleton className="h-9" />
                  ) : (
                    <Select value={supplierId} onValueChange={setSupplierId}>
                      <SelectTrigger id="po-supplier">
                        <SelectValue placeholder="Select supplier" />
                      </SelectTrigger>
                      <SelectContent>
                        {suppliersQuery.data?.suppliers.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                            {s.contactPerson ? ` · ${s.contactPerson}` : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {selectedSupplier && (
                    <p className="text-xs text-muted-foreground">
                      Payment terms: {selectedSupplier.paymentTerms}
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="po-location">
                    <span className="flex items-center gap-1.5">
                      <Warehouse className="h-3.5 w-3.5" /> Delivery location
                    </span>
                  </Label>
                  {locationsQuery.isLoading ? (
                    <Skeleton className="h-9" />
                  ) : (
                    <Select value={deliveryLocationId} onValueChange={setDeliveryLocationId}>
                      <SelectTrigger id="po-location">
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
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="po-order-date">
                    <span className="flex items-center gap-1.5">
                      <Calendar className="h-3.5 w-3.5" /> Order date
                    </span>
                  </Label>
                  <Input
                    id="po-order-date"
                    type="date"
                    value={orderDate}
                    onChange={(e) => setOrderDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="po-expected">
                    <span className="flex items-center gap-1.5">
                      <Calendar className="h-3.5 w-3.5" /> Expected delivery
                    </span>
                  </Label>
                  <Input
                    id="po-expected"
                    type="date"
                    value={expectedDeliveryDate}
                    onChange={(e) => setExpectedDeliveryDate(e.target.value)}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Search-to-add variants */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between">
                <span>Order items</span>
                <span className="text-xs text-muted-foreground font-normal">
                  {items.length} item{items.length === 1 ? '' : 's'} added
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by SKU or product title to add items…"
                  className="pl-9"
                  value={variantSearch}
                  onChange={(e) => setVariantSearch(e.target.value)}
                  disabled={productsQuery.isLoading}
                />
                {productsQuery.isLoading && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>

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

              <div className="rounded-md border overflow-x-auto">
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
                        <TableCell
                          colSpan={5}
                          className="text-center text-sm text-muted-foreground py-8"
                        >
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

          {/* Advance + notes */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Wallet className="h-4 w-4" /> Advance payment & notes
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="po-advance">Advance payment (Rs.)</Label>
                  <Input
                    id="po-advance"
                    type="number"
                    min="0"
                    step="0.01"
                    className="tabular-nums"
                    value={advancePayment}
                    onChange={(e) => setAdvancePayment(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="po-method">Payment method (optional)</Label>
                  <Input
                    id="po-method"
                    placeholder="e.g. Bank transfer, Cash, Cheque #123"
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="po-notes">Notes</Label>
                <Textarea
                  id="po-notes"
                  placeholder="Any internal notes for this PO…"
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ── Right: summary + submit ────────────────────────────────────── */}
        <div className="space-y-4">
          <Card className="lg:sticky lg:top-20">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2 text-sm">
                <SummaryRow label="Items" value={String(items.length)} />
                <SummaryRow label="Total units" value={String(totalUnits)} />
                <div className="pt-2 border-t">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Order value
                  </p>
                  <p className="text-xl font-semibold tabular-nums">{formatPKR(totalValue)}</p>
                </div>
                <SummaryRow label="Advance payment" value={formatPKR(advance)} />
                <div className="pt-2 border-t">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Balance due
                  </p>
                  <p className="text-lg font-semibold tabular-nums text-amber-700">
                    {formatPKR(balanceDue)}
                  </p>
                </div>
              </div>

              <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground space-y-1">
                {selectedSupplier && (
                  <p>
                    <span className="font-medium text-foreground">Supplier:</span>{' '}
                    {selectedSupplier.name}
                  </p>
                )}
                {selectedLocation && (
                  <p>
                    <span className="font-medium text-foreground">Deliver to:</span>{' '}
                    {selectedLocation.name}
                  </p>
                )}
                {expectedDeliveryDate && (
                  <p>
                    <span className="font-medium text-foreground">Expected:</span>{' '}
                    {new Date(expectedDeliveryDate).toLocaleDateString('en-PK', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => submit('draft')}
                  disabled={createMutation.isPending || !canManage}
                >
                  {createMutation.isPending && createMutation.variables?.status === 'draft' ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                    </>
                  ) : (
                    <>
                      <Save className="h-4 w-4" /> Save as Draft
                    </>
                  )}
                </Button>
                <Button
                  className="w-full"
                  onClick={() => submit('ordered')}
                  disabled={createMutation.isPending || !canManage}
                >
                  {createMutation.isPending && createMutation.variables?.status === 'ordered' ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Confirming…
                    </>
                  ) : (
                    <>
                      <Send className="h-4 w-4" /> Confirm &amp; Send Order
                    </>
                  )}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground text-center">
                <Badge variant="outline" className="text-[10px] mr-1">
                  Draft
                </Badge>
                doesn&apos;t reserve incoming stock.{' '}
                <Badge variant="outline" className="text-[10px] mx-1">
                  Ordered
                </Badge>
                increments incoming.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── Inline supplier create dialog ─────────────────────────────────── */}
      <QuickCreateSupplierDialog
        open={createSupplierOpen}
        onOpenChange={setCreateSupplierOpen}
        onCreated={(id) => {
          setSupplierId(id)
          void queryClient.invalidateQueries({ queryKey: ['suppliers'] })
        }}
      />
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

// ─────────────────────────────────────────────────────────────────────────────
// Quick supplier create dialog (inline)
// ─────────────────────────────────────────────────────────────────────────────

function QuickCreateSupplierDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: (id: string) => void
}) {
  const [name, setName] = useState('')
  const [contactPerson, setContactPerson] = useState('')
  const [phone, setPhone] = useState('')

  const createMutation = useMutation({
    mutationFn: async () =>
      api.post<{ id: string; name: string }>('/api/suppliers', {
        name: name.trim(),
        contactPerson: contactPerson.trim() || undefined,
        phone: phone.trim() || undefined,
        isOrgLevel: false,
      }),
    onSuccess: (data) => {
      toast.success(`Supplier "${data.name}" created.`)
      onCreated(data.id)
      setName('')
      setContactPerson('')
      setPhone('')
      onOpenChange(false)
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create new supplier</DialogTitle>
          <DialogDescription>
            Quick-add a supplier. You can fill in payment terms and more details from the
            Suppliers page later.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim().length < 2) {
              toast.error('Name must be at least 2 characters.')
              return
            }
            createMutation.mutate()
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="qs-name">Name</Label>
            <Input
              id="qs-name"
              autoFocus
              placeholder="e.g. ABC Fabrics"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="qs-contact">Contact person</Label>
              <Input
                id="qs-contact"
                placeholder="Optional"
                value={contactPerson}
                onChange={(e) => setContactPerson(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qs-phone">Phone</Label>
              <Input
                id="qs-phone"
                placeholder="Optional"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Creating…
                </>
              ) : (
                'Create supplier'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
