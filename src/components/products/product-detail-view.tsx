'use client'

import { useRef, useState } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { useAppStore, useCan } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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
import { toast } from 'sonner'
import {
  AlertCircle,
  ArrowLeft,
  ArrowUpCircle,
  Check,
  ImageIcon,
  Loader2,
  Package,
  Pencil,
  Save,
  Shirt,
  Star,
  Store,
  Tag,
  Trash2,
  Upload,
  X,
  Warehouse,
  ArrowLeftRight,
  PackagePlus,
  SlidersHorizontal,
  TrendingUp,
} from 'lucide-react'
import {
  PRODUCT_SCOPE_LABELS,
  PRODUCT_TYPE_LABELS,
  STITCHING_LABELS,
} from '@/lib/constants/fulfillment-types'
import { FulfillmentTypeBadge } from '@/components/products/fulfillment-type-badge'
import { PERMISSIONS } from '@/lib/permissions'
import { ParentChildVariantTable } from '@/components/products/parent-child-variant-table'
import { cn } from '@/lib/utils'

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------
interface ProductImage {
  id: string
  publicUrl: string
  isPrimary: boolean
  displayOrder: number
  variantId: string | null
}

interface ProductVariant {
  id: string
  sku: string
  barcode: string | null
  attributeValues: Record<string, string>
  costPrice: number
  weightGrams: number
  weightKg?: number | null
  weightSyncedWithParent?: boolean
  fulfillmentType: string
  stitchingType: string | null
  stitchingCharges: number
  productionDays: number
  isTaxable: boolean
  requiresShipping: boolean
  inventoryPolicy: string
  isDefault: boolean
  isActive: boolean
  salePrice: number | null
  comparePrice: number | null
  pricingId: string | null
}

interface ProductDetail {
  id: string
  title: string
  slug: string
  description: string | null
  shortDescription: string | null
  productType: string
  productScope: string
  isStitchable: boolean
  hasSizeVariants: boolean
  stitchingBasePrice: number
  isActive: boolean
  isFeatured: boolean
  isOwner: boolean
  category: { id: string; name: string } | null
  brand: { id: string; name: string } | null
  images: ProductImage[]
  variants: ProductVariant[]
  subscription: { id: string; status: string; isActive: boolean } | null
}

/** Scope options available when promoting from private. */
const PROMOTE_SCOPE_OPTIONS: Array<{
  key: 'organization' | 'selective'
  label: string
  description: string
}> = [
  {
    key: 'organization',
    label: 'Organization',
    description: 'All companies in your organization can subscribe.',
  },
  {
    key: 'selective',
    label: 'Selective',
    description: 'Only specific companies you approve can access it.',
  },
]

// ----------------------------------------------------------------------------
// Main component
// ----------------------------------------------------------------------------
export function ProductDetailView({ productId }: { productId: string }) {
  const navigate = useAppStore((s) => s.navigate)
  const queryClient = useQueryClient()
  const can = useCan()
  const canEdit = can('products.edit')
  const [scopeDialogOpen, setScopeDialogOpen] = useState(false)
  const [changingScope, setChangingScope] = useState(false)

  const { data, isLoading, isError, refetch } = useQuery<{ product: ProductDetail }>({
    queryKey: ['product', productId],
    queryFn: () => api.get<{ product: ProductDetail }>(`/api/products/${productId}`),
    staleTime: 30_000,
  })

  const product = data?.product

  async function changeScope(scope: 'private' | 'organization' | 'selective') {
    if (!product) return
    setChangingScope(true)
    try {
      // PATCH endpoint: scope update is part of the owner-only product patch route.
      await api.patch(`/api/products/${productId}`, { product_scope: scope })
      queryClient.invalidateQueries({ queryKey: ['product', productId] })
      queryClient.invalidateQueries({ queryKey: ['products'] })
      toast.success(`Product scope set to ${PRODUCT_SCOPE_LABELS[scope]}.`)
      setScopeDialogOpen(false)
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to update scope.')
    } finally {
      setChangingScope(false)
    }
  }

  // ---- Render
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (isError || !product) {
    return (
      <div className="space-y-6">
        <button
          onClick={() => navigate({ name: 'products' })}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to products
        </button>
        <Card>
          <CardContent className="p-10 text-center">
            <AlertCircle className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground mb-4">
              This product couldn&apos;t be loaded. It may have been removed or you may not have access.
            </p>
            <Button variant="outline" onClick={() => refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <button
        onClick={() => navigate({ name: 'products' })}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to products
      </button>

      <PageHeader
        title={product.title}
        description={product.shortDescription ?? product.slug}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {product.isOwner && (
              <Button onClick={() => setScopeDialogOpen(true)}>
                <ArrowUpCircle className="h-4 w-4" /> Promote to Org
              </Button>
            )}
          </div>
        }
      />

      {/* Header badges */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">
          {PRODUCT_TYPE_LABELS[product.productType] ?? product.productType}
        </Badge>
        <Badge variant="outline">
          {PRODUCT_SCOPE_LABELS[product.productScope] ?? product.productScope}
        </Badge>
        {product.isStitchable && (
          <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 border-transparent gap-1">
            <Shirt className="h-3 w-3" /> Stitchable
          </Badge>
        )}
        {product.isActive ? (
          <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 border-transparent">
            Active
          </Badge>
        ) : (
          <Badge variant="outline">Inactive</Badge>
        )}
        {product.isFeatured && (
          <Badge className="bg-amber-500/90 hover:bg-amber-500 text-white border-transparent">
            Featured
          </Badge>
        )}
        {product.isOwner && (
          <Badge variant="outline" className="text-xs">You own this</Badge>
        )}
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="w-full sm:w-auto overflow-x-auto justify-start">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="variants">
            Variants ({product.variants.length})
          </TabsTrigger>
          <TabsTrigger value="images">
            Images ({product.images.length})
          </TabsTrigger>
          <TabsTrigger value="shopify">Shopify Sync</TabsTrigger>
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          {product.subscription && (
            <TabsTrigger value="pricing">Pricing</TabsTrigger>
          )}
        </TabsList>

        {/* Overview / Details (inline-edit) */}
        <TabsContent value="overview">
          <DetailsTab product={product} productId={productId} canEdit={canEdit} />
        </TabsContent>

        {/* Variants (parent-child grouped table) */}
        <TabsContent value="variants">
          <ParentChildVariantTable productId={productId} mode="cost" />
        </TabsContent>

        {/* Images (upload + delete) */}
        <TabsContent value="images">
          <ImagesTab product={product} productId={productId} canEdit={canEdit} />
        </TabsContent>

        {/* Shopify Sync */}
        <TabsContent value="shopify">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Store className="h-4 w-4 text-primary" /> Shopify Sync
              </CardTitle>
              <CardDescription>
                A summary of the payload that will be sent to Shopify when this product syncs.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border p-4 space-y-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">
                  Product payload
                </p>
                <pre className="text-xs bg-muted/50 rounded-md p-3 overflow-x-auto">
{JSON.stringify(
  {
    title: product.title,
    product_type: product.productType,
    vendor: product.brand?.name ?? null,
    status: product.isActive ? 'active' : 'draft',
    variants: product.variants.map((v) => ({
      sku: v.sku,
      barcode: v.barcode ?? null,
      price: v.salePrice,
      compare_at_price: v.comparePrice,
      grams: v.weightGrams,
      weight_kg: v.weightKg ?? null,
      requires_shipping: v.requiresShipping,
      taxable: v.isTaxable,
      inventory_management: v.fulfillmentType === 'stock_based' ? 'shopify' : null,
      inventory_policy: v.inventoryPolicy,
    })),
  },
  null,
  2,
)}
                </pre>
              </div>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
                <p className="font-medium">Sync notes</p>
                <ul className="mt-1 space-y-0.5 list-disc list-inside opacity-90">
                  <li>
                    <strong>stock_based</strong> variants track inventory in Shopify
                    (<code>inventory_management: shopify</code>).
                  </li>
                  <li>
                    <strong>made_to_order</strong> variants skip inventory tracking and
                    always allow oversells (<code>inventory_policy: continue</code>).
                  </li>
                  <li>Stitching charges are bundled into <code>cost_price</code> for accounting, not shown to customers.</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Inventory */}
        <TabsContent value="inventory">
          <InventoryTab productId={productId} variants={product.variants} isStitchable={product.isStitchable} />
        </TabsContent>

        {/* Pricing (parent-child grouped pricing table) */}
        {product.subscription && (
          <TabsContent value="pricing">
            <ParentChildVariantTable productId={productId} mode="pricing" />
          </TabsContent>
        )}
      </Tabs>

      {/* Promote-to-org dialog */}
      {scopeDialogOpen && (
        <PromoteDialog
          currentScope={product.productScope}
          loading={changingScope}
          onClose={() => setScopeDialogOpen(false)}
          onConfirm={(scope) => changeScope(scope)}
        />
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------------------
function DetailRow({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-medium text-right truncate max-w-[60%]">{value}</span>
    </div>
  )
}

function PromoteDialog({
  currentScope,
  loading,
  onClose,
  onConfirm,
}: {
  currentScope: string
  loading: boolean
  onClose: () => void
  onConfirm: (scope: 'private' | 'organization' | 'selective') => void
}) {
  const [scope, setScope] = useState<'organization' | 'selective'>('organization')
  const currentLabel = PRODUCT_SCOPE_LABELS[currentScope] ?? currentScope

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ArrowUpCircle className="h-5 w-5 text-primary" /> Promote to organization
          </CardTitle>
          <CardDescription>
            Currently: <span className="font-medium">{currentLabel}</span>. Choose the new scope.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            {PROMOTE_SCOPE_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setScope(opt.key)}
                className={cn(
                  'w-full rounded-lg border p-3 text-left transition-all',
                  scope === opt.key
                    ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
                    : 'border-border hover:border-primary/40 hover:bg-muted/40',
                )}
              >
                <p className="text-sm font-medium">{opt.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {opt.description}
                </p>
              </button>
            ))}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button onClick={() => onConfirm(scope)} disabled={loading}>
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowUpCircle className="h-4 w-4" />
              )}
              Promote
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function PricingTab({
  productId,
  variants,
  onUpdate,
}: {
  productId: string
  variants: ProductVariant[]
  onUpdate: () => void
}) {
  const [drafts, setDrafts] = useState<Record<string, { salePrice: number | null; comparePrice: number | null }>>(
    () =>
      Object.fromEntries(
        variants.map((v) => [
          v.id,
          { salePrice: v.salePrice, comparePrice: v.comparePrice },
        ]),
      ),
  )
  const [saving, setSaving] = useState<string | null>(null)

  function setDraft(
    variantId: string,
    field: 'salePrice' | 'comparePrice',
    value: number | null,
  ) {
    setDrafts((d) => ({
      ...d,
      [variantId]: { ...d[variantId], [field]: value },
    }))
  }

  async function save(variantId: string) {
    const draft = drafts[variantId]
    if (!draft) return
    if (draft.salePrice == null || draft.salePrice <= 0) {
      toast.error('Sale price must be a positive number.')
      return
    }
    setSaving(variantId)
    try {
      // POST /api/products/[id]/pricing expects { pricing: [{ org_variant_id, sale_price, compare_price? }] }
      await api.post(`/api/products/${productId}/pricing`, {
        pricing: [
          {
            org_variant_id: variantId,
            sale_price: draft.salePrice,
            ...(draft.comparePrice != null ? { compare_price: draft.comparePrice } : {}),
          },
        ],
      })
      toast.success('Pricing updated.')
      onUpdate()
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to update pricing.')
    } finally {
      setSaving(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Tag className="h-4 w-4 text-primary" /> Your company pricing
        </CardTitle>
        <CardDescription>
          Set the sale and compare-at prices for your storefront.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Sale price</TableHead>
                <TableHead>Compare price</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {variants.map((v) => {
                const draft = drafts[v.id] ?? { salePrice: v.salePrice, comparePrice: v.comparePrice }
                const dirty =
                  draft.salePrice !== v.salePrice ||
                  draft.comparePrice !== v.comparePrice
                const canSave =
                  dirty &&
                  draft.salePrice != null &&
                  draft.salePrice > 0 &&
                  (draft.comparePrice == null || draft.comparePrice > draft.salePrice)
                return (
                  <TableRow key={v.id}>
                    <TableCell className="font-mono text-xs">{v.sku}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {formatMoney(v.costPrice)}
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={draft.salePrice ?? ''}
                        onChange={(e) =>
                          setDraft(
                            v.id,
                            'salePrice',
                            e.target.value ? Number(e.target.value) : null,
                          )
                        }
                        className="h-8 w-32 text-xs"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={draft.comparePrice ?? ''}
                        onChange={(e) =>
                          setDraft(
                            v.id,
                            'comparePrice',
                            e.target.value ? Number(e.target.value) : null,
                          )
                        }
                        className="h-8 w-32 text-xs"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant={dirty ? 'default' : 'outline'}
                        disabled={!canSave || saving === v.id}
                        onClick={() => save(v.id)}
                      >
                        {saving === v.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Save className="h-3.5 w-3.5" />
                        )}
                        Save
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

// ----------------------------------------------------------------------------
// DetailsTab — inline edit mode for the Overview tab
// ----------------------------------------------------------------------------
function DetailsTab({
  product,
  productId,
  canEdit,
}: {
  product: ProductDetail
  productId: string
  canEdit: boolean
}) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(() => ({
    title: product.title,
    description: product.description ?? '',
    shortDescription: product.shortDescription ?? '',
    categoryId: product.category?.id ?? '',
    brandId: product.brand?.id ?? '',
    isFeatured: product.isFeatured,
    isActive: product.isActive,
    isStitchable: product.isStitchable,
    stitchingBasePrice: product.stitchingBasePrice,
    hasSizeVariants: product.hasSizeVariants,
  }))

  function resetForm() {
    setForm({
      title: product.title,
      description: product.description ?? '',
      shortDescription: product.shortDescription ?? '',
      categoryId: product.category?.id ?? '',
      brandId: product.brand?.id ?? '',
      isFeatured: product.isFeatured,
      isActive: product.isActive,
      isStitchable: product.isStitchable,
      stitchingBasePrice: product.stitchingBasePrice,
      hasSizeVariants: product.hasSizeVariants,
    })
  }

  // Lazy-load category/brand options only when entering edit mode.
  const { data: catData } = useQuery<{ categories: Array<{ id: string; name: string }> }>({
    queryKey: ['categories'],
    queryFn: () => api.get<{ categories: Array<{ id: string; name: string }> }>('/api/categories'),
    enabled: editing,
    staleTime: 60_000,
  })
  const { data: brandData } = useQuery<{ brands: Array<{ id: string; name: string }> }>({
    queryKey: ['brands'],
    queryFn: () => api.get<{ brands: Array<{ id: string; name: string }> }>('/api/brands'),
    enabled: editing,
    staleTime: 60_000,
  })

  const mutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.patch(`/api/products/${productId}`, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['product', productId] })
      queryClient.invalidateQueries({ queryKey: ['products'] })
      toast.success('Product updated.')
      setEditing(false)
    },
    onError: (err) => {
      // Stay in edit mode so the user can fix and retry.
      toast.error(err instanceof FetchError ? err.message : 'Failed to update product.')
    },
  })

  function startEdit() {
    resetForm()
    setEditing(true)
  }

  function cancelEdit() {
    setEditing(false)
  }

  function save() {
    const patch: Record<string, unknown> = {}
    if (form.title !== product.title) patch.title = form.title
    if (form.description !== (product.description ?? '')) patch.description = form.description
    if (form.shortDescription !== (product.shortDescription ?? '')) patch.short_description = form.shortDescription
    if (form.categoryId !== (product.category?.id ?? '')) patch.category_id = form.categoryId || null
    if (form.brandId !== (product.brand?.id ?? '')) patch.brand_id = form.brandId || null
    if (form.isFeatured !== product.isFeatured) patch.is_featured = form.isFeatured
    if (form.isActive !== product.isActive) patch.is_active = form.isActive
    if (form.isStitchable !== product.isStitchable) patch.is_stitchable = form.isStitchable
    if (form.stitchingBasePrice !== product.stitchingBasePrice) patch.stitching_base_price = form.stitchingBasePrice
    if (form.hasSizeVariants !== product.hasSizeVariants) patch.has_size_variants = form.hasSizeVariants

    if (Object.keys(patch).length === 0) {
      toast.info('No changes to save.')
      setEditing(false)
      return
    }
    mutation.mutate(patch)
  }

  // ---- Edit mode
  if (editing) {
    return (
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Edit product</CardTitle>
            <CardDescription>
              Update the storefront-visible details. Changes are live after save.
            </CardDescription>
            <CardAction>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={cancelEdit}
                  disabled={mutation.isPending}
                >
                  <X className="h-4 w-4" /> Cancel
                </Button>
                <Button size="sm" onClick={save} disabled={mutation.isPending}>
                  {mutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                  Save Changes
                </Button>
              </div>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="p-title">Title</Label>
              <Input
                id="p-title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Product title"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-short">Short description</Label>
              <Input
                id="p-short"
                value={form.shortDescription}
                onChange={(e) => setForm({ ...form, shortDescription: e.target.value })}
                placeholder="One-line summary (optional)"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-desc">Description</Label>
              <Textarea
                id="p-desc"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Full description"
                rows={6}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Attributes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select
                value={form.categoryId || '__none__'}
                onValueChange={(v) => setForm({ ...form, categoryId: v === '__none__' ? '' : v })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select category…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No category</SelectItem>
                  {(catData?.categories ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Brand</Label>
              <Select
                value={form.brandId || '__none__'}
                onValueChange={(v) => setForm({ ...form, brandId: v === '__none__' ? '' : v })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select brand…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No brand</SelectItem>
                  {(brandData?.brands ?? []).map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">Active</p>
                <p className="text-xs text-muted-foreground">Inactive products are hidden from storefronts.</p>
              </div>
              <Switch
                checked={form.isActive}
                onCheckedChange={(v) => setForm({ ...form, isActive: v })}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">Featured</p>
                <p className="text-xs text-muted-foreground">Shown in the featured section.</p>
              </div>
              <Switch
                checked={form.isFeatured}
                onCheckedChange={(v) => setForm({ ...form, isFeatured: v })}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">Stitchable</p>
                <p className="text-xs text-muted-foreground">Can be sent for stitching.</p>
              </div>
              <Switch
                checked={form.isStitchable}
                onCheckedChange={(v) => setForm({ ...form, isStitchable: v })}
              />
            </div>
            {form.isStitchable && (
              <div className="space-y-3 rounded-lg border p-3 bg-muted/30">
                <div className="space-y-1.5">
                  <Label htmlFor="p-stitch-base">Stitching base price</Label>
                  <Input
                    id="p-stitch-base"
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.stitchingBasePrice}
                    onChange={(e) => setForm({ ...form, stitchingBasePrice: Number(e.target.value) })}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Has size variants</p>
                    <p className="text-xs text-muted-foreground">Standard XS–XXXL size variants.</p>
                  </div>
                  <Switch
                    checked={form.hasSizeVariants}
                    onCheckedChange={(v) => setForm({ ...form, hasSizeVariants: v })}
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  // ---- View mode (plain text, not disabled inputs)
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Description</CardTitle>
          {canEdit && (
            <CardAction>
              <Button variant="outline" size="sm" onClick={startEdit}>
                <Pencil className="h-4 w-4" /> Edit
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {product.shortDescription && (
            <p className="text-sm font-medium">{product.shortDescription}</p>
          )}
          {product.description ? (
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">
              {product.description}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground italic">
              No description provided.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <DetailRow label="Category" value={product.category?.name ?? '—'} />
          <DetailRow label="Brand" value={product.brand?.name ?? '—'} />
          <DetailRow
            label="Variant count"
            value={String(product.variants.length)}
          />
          <DetailRow
            label="Slug"
            value={<code className="font-mono text-xs">{product.slug}</code>}
          />
          {product.isStitchable && (
            <div className="border-t pt-3 mt-3 space-y-3">
              <div className="flex items-center gap-2">
                <Shirt className="h-4 w-4 text-primary" />
                <p className="text-xs font-medium uppercase text-muted-foreground">
                  Stitching info
                </p>
              </div>
              <DetailRow
                label="Base price"
                value={formatMoney(product.stitchingBasePrice)}
              />
              <DetailRow
                label="Has size variants"
                value={product.hasSizeVariants ? 'Yes' : 'No'}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ----------------------------------------------------------------------------
// VariantsTab — interactive table + per-row edit dialog
// ----------------------------------------------------------------------------
function VariantsTab({
  product,
  productId,
  canEdit,
}: {
  product: ProductDetail
  productId: string
  canEdit: boolean
}) {
  const [editingVariant, setEditingVariant] = useState<ProductVariant | null>(null)

  // Fetch inventory summary for live avg cost + stock display
  const { data: invData } = useQuery<{ variants: InventorySummaryVariant[] }>({
    queryKey: ['product-inventory', productId],
    queryFn: () => api.get(`/api/inventory/summary?product_id=${productId}`),
    staleTime: 15_000,
  })

  function getInvInfo(variantId: string) {
    const v = invData?.variants?.find((x) => x.variantId === variantId)
    if (!v) return null
    return {
      avgCost: v.locations.length > 0 ? v.locations[0].avgCost : null,
      totalAvailable: v.totalAvailable,
      isMTO: v.fulfillmentType === 'made_to_order',
      hasStock: v.totalOnHand > 0,
    }
  }

  return (
    <>
      {/* Weight not set warning — non-blocking indicator for variants with NULL weightKg */}
      {product.variants.some((v) => v.weightKg == null) && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <div className="text-xs text-amber-800">
            <p className="font-medium">Weight not set for {product.variants.filter((v) => v.weightKg == null).length} variant(s)</p>
            <p className="mt-0.5">
              Courier booking (Overland vs Normal) requires weight. Set it per variant or via the parent-group bulk action in the Variants table below.
            </p>
          </div>
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Tag className="h-4 w-4 text-primary" /> Variants
          </CardTitle>
          <CardDescription>
            Each row is a Shopify variant with its own SKU, price, and inventory policy.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Attributes</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Live Avg</TableHead>
                  <TableHead className="text-right">Stock</TableHead>
                  <TableHead className="text-right">Sale</TableHead>
                  <TableHead className="text-right">Compare</TableHead>
                  <TableHead className="text-right">Weight (kg)</TableHead>
                  <TableHead>Fulfillment</TableHead>
                  <TableHead>Stitching</TableHead>
                  <TableHead className="text-right">Days</TableHead>
                  <TableHead>Policy</TableHead>
                  <TableHead className="text-center">Active</TableHead>
                  {canEdit && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {product.variants.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={canEdit ? 14 : 13} className="h-24 text-center text-muted-foreground text-sm">
                      No variants on this product.
                    </TableCell>
                  </TableRow>
                ) : (
                  product.variants.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="font-mono text-xs">
                        <div className="flex items-center gap-1.5">
                          {v.sku}
                          {v.isDefault && (
                            <Badge variant="secondary" className="text-[9px] py-0 px-1">DEFAULT</Badge>
                          )}
                        </div>
                        {v.barcode && (
                          <div className="text-[10px] text-muted-foreground">{v.barcode}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {Object.keys(v.attributeValues).length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <div className="space-y-0.5">
                            {Object.entries(v.attributeValues).map(([k, val]) => (
                              <div key={k}>
                                <span className="text-muted-foreground">{k}:</span>{' '}
                                <span className="font-medium">{val}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {formatMoney(v.costPrice)}
                        {v.stitchingCharges > 0 && (
                          <div className="text-[10px] text-muted-foreground">
                            +{formatMoney(v.stitchingCharges)} st.
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground" title="Live average cost from actual purchases — updates automatically when stock is received">
                        {(() => {
                          const inv = getInvInfo(v.id)
                          return inv?.avgCost != null ? `Rs. ${formatMoney(inv.avgCost)}` : '—'
                        })()}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {(() => {
                          const inv = getInvInfo(v.id)
                          if (!inv) return <span className="text-muted-foreground">—</span>
                          if (inv.isMTO && !inv.hasStock) {
                            return <Badge variant="outline" className="text-[9px] bg-purple-50 text-purple-700 border-purple-200">MTO</Badge>
                          }
                          if (inv.totalAvailable === 0) {
                            return <span className="text-destructive font-medium" title="Out of stock">0</span>
                          }
                          return <span className="font-medium">{inv.totalAvailable}</span>
                        })()}
                      </TableCell>
                      <TableCell className="text-right text-xs font-medium">
                        {v.salePrice != null ? formatMoney(v.salePrice) : '—'}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {v.weightKg != null ? (
                          <span>{v.weightKg}</span>
                        ) : (
                          <span className="text-amber-600 inline-flex items-center gap-0.5" title="Weight not set — courier booking will fall back to Overland">
                            <AlertCircle className="h-3 w-3" /> —
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <FulfillmentTypeBadge type={v.fulfillmentType} />
                      </TableCell>
                      <TableCell className="text-xs">
                        {v.fulfillmentType === 'made_to_order' ? (
                          v.stitchingType
                            ? STITCHING_LABELS[v.stitchingType] ?? v.stitchingType
                            : <span className="text-muted-foreground">—</span>
                        ) : (
                          <span className="text-muted-foreground text-[10px]">Stock tracked</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {v.fulfillmentType === 'made_to_order' && v.productionDays > 0
                          ? v.productionDays
                          : '—'}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px] font-mono">
                          {v.inventoryPolicy}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        <VariantActiveSwitch
                          productId={productId}
                          variantId={v.id}
                          isActive={v.isActive}
                          canEdit={canEdit}
                        />
                      </TableCell>
                      {canEdit && (
                        <TableCell className="text-right">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            onClick={() => setEditingVariant(v)}
                            aria-label={`Edit variant ${v.sku}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Shopify Sync Preview (also on Variants tab as requested) */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Store className="h-4 w-4 text-primary" /> Shopify Sync Preview
          </CardTitle>
          <CardDescription>
            What will be sent to Shopify per variant.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>inventory_management</TableHead>
                  <TableHead>inventory_policy</TableHead>
                  <TableHead className="text-right">price</TableHead>
                  <TableHead className="text-right">compare_at_price</TableHead>
                  <TableHead className="text-right">grams</TableHead>
                  <TableHead>requires_shipping</TableHead>
                  <TableHead>taxable</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {product.variants.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell className="font-mono text-xs">{v.sku}</TableCell>
                    <TableCell>
                      <code className="text-xs">
                        {v.fulfillmentType === 'stock_based' ? 'shopify' : 'null'}
                      </code>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[10px] font-mono',
                          v.inventoryPolicy === 'deny'
                            ? 'border-amber-300 text-amber-700'
                            : 'border-emerald-300 text-emerald-700',
                        )}
                      >
                        {v.inventoryPolicy}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {v.salePrice != null ? formatMoney(v.salePrice) : '—'}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {v.comparePrice != null ? formatMoney(v.comparePrice) : 'null'}
                    </TableCell>
                    <TableCell className="text-right text-xs">{v.weightGrams}</TableCell>
                    <TableCell>
                      <code className="text-xs">{v.requiresShipping ? 'true' : 'false'}</code>
                    </TableCell>
                    <TableCell>
                      <code className="text-xs">{v.isTaxable ? 'true' : 'false'}</code>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Variant edit dialog */}
      {editingVariant && (
        <VariantEditDialog
          product={product}
          variant={editingVariant}
          onClose={() => setEditingVariant(null)}
        />
      )}
    </>
  )
}

/** Interactive is_active switch with optimistic update + revert on error. */
function VariantActiveSwitch({
  productId,
  variantId,
  isActive,
  canEdit,
}: {
  productId: string
  variantId: string
  isActive: boolean
  canEdit: boolean
}) {
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: (newVal: boolean) =>
      api.post(`/api/products/${productId}/variants/${variantId}/toggle`, {
        is_active: newVal,
      }),
    onMutate: async (newVal) => {
      // Optimistic update — flip the cached variant's isActive immediately.
      await queryClient.cancelQueries({ queryKey: ['product', productId] })
      const prev = queryClient.getQueryData<{ product: ProductDetail }>(['product', productId])
      if (prev) {
        queryClient.setQueryData<{ product: ProductDetail }>(['product', productId], {
          product: {
            ...prev.product,
            variants: prev.product.variants.map((v) =>
              v.id === variantId ? { ...v, isActive: newVal } : v
            ),
          },
        })
      }
      return { prev }
    },
    onError: (err, _newVal, context) => {
      // Revert the optimistic update.
      if (context?.prev) {
        queryClient.setQueryData(['product', productId], context.prev)
      }
      toast.error(err instanceof FetchError ? err.message : 'Failed to toggle variant.')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['product', productId] })
      toast.success('Variant status updated.')
    },
  })

  return (
    <Switch
      checked={isActive}
      disabled={!canEdit || mutation.isPending}
      onCheckedChange={(v) => mutation.mutate(v)}
      aria-label="Toggle variant active"
    />
  )
}

/** Variant edit dialog with SKU-change confirmation step. */
function VariantEditDialog({
  product,
  variant,
  onClose,
}: {
  product: ProductDetail
  variant: ProductVariant
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [step, setStep] = useState<'edit' | 'confirm'>('edit')
  const [form, setForm] = useState({
    sku: variant.sku,
    barcode: variant.barcode ?? '',
    costPrice: variant.costPrice,
    weightGrams: variant.weightGrams,
    stitchingCharges: variant.stitchingCharges,
    productionDays: variant.productionDays,
    isTaxable: variant.isTaxable,
    requiresShipping: variant.requiresShipping,
  })

  const mutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.patch(`/api/products/${product.id}/variants/${variant.id}`, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['product', product.id] })
      toast.success('Variant updated.')
      onClose()
    },
    onError: (err) => {
      // Send the user back to the edit step so they can fix and retry.
      setStep('edit')
      toast.error(err instanceof FetchError ? err.message : 'Failed to update variant.')
    },
  })

  function buildPatch(): Record<string, unknown> {
    const patch: Record<string, unknown> = {}
    if (form.sku !== variant.sku) patch.sku = form.sku
    if (form.barcode !== (variant.barcode ?? '')) patch.barcode = form.barcode
    if (form.costPrice !== variant.costPrice) patch.cost_price = form.costPrice
    if (form.weightGrams !== variant.weightGrams) patch.weight_grams = form.weightGrams
    if (form.stitchingCharges !== variant.stitchingCharges) patch.stitching_charges = form.stitchingCharges
    if (form.productionDays !== variant.productionDays) patch.production_days = form.productionDays
    if (form.isTaxable !== variant.isTaxable) patch.is_taxable = form.isTaxable
    if (form.requiresShipping !== variant.requiresShipping) patch.requires_shipping = form.requiresShipping
    return patch
  }

  function trySave() {
    const patch = buildPatch()
    if (Object.keys(patch).length === 0) {
      toast.info('No changes to save.')
      onClose()
      return
    }
    if (patch.sku !== undefined) {
      // SKU is changing — show the confirmation step before saving.
      setStep('confirm')
    } else {
      mutation.mutate(patch)
    }
  }

  function confirmSave() {
    mutation.mutate(buildPatch())
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !mutation.isPending) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        {step === 'edit' ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Pencil className="h-4 w-4" /> Edit variant
              </DialogTitle>
              <DialogDescription>
                Update SKU, pricing, and physical attributes for this variant.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2 max-h-[60vh] overflow-y-auto pr-1">
              <div className="space-y-1.5">
                <Label htmlFor="v-sku">SKU</Label>
                <Input
                  id="v-sku"
                  value={form.sku}
                  onChange={(e) => setForm({ ...form, sku: e.target.value })}
                  className="font-mono"
                />
                {form.sku !== variant.sku && (
                  <p className="text-xs text-amber-600 flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" />
                    Changing SKU will require confirmation.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="v-barcode">Barcode</Label>
                <Input
                  id="v-barcode"
                  value={form.barcode}
                  onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="v-cost">Cost price</Label>
                  <Input
                    id="v-cost"
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.costPrice}
                    onChange={(e) => setForm({ ...form, costPrice: Number(e.target.value) })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="v-weight">Weight (g)</Label>
                  <Input
                    id="v-weight"
                    type="number"
                    min="0"
                    step="1"
                    value={form.weightGrams}
                    onChange={(e) => setForm({ ...form, weightGrams: Number(e.target.value) })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="v-stitch">Stitching charges</Label>
                  <Input
                    id="v-stitch"
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.stitchingCharges}
                    onChange={(e) => setForm({ ...form, stitchingCharges: Number(e.target.value) })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="v-days">Production days</Label>
                  <Input
                    id="v-days"
                    type="number"
                    min="0"
                    step="1"
                    value={form.productionDays}
                    onChange={(e) => setForm({ ...form, productionDays: Number(e.target.value) })}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <p className="text-sm font-medium">Taxable</p>
                  <p className="text-xs text-muted-foreground">Charge tax on this variant.</p>
                </div>
                <Switch
                  checked={form.isTaxable}
                  onCheckedChange={(v) => setForm({ ...form, isTaxable: v })}
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <p className="text-sm font-medium">Requires shipping</p>
                  <p className="text-xs text-muted-foreground">Variant is a physical product.</p>
                </div>
                <Switch
                  checked={form.requiresShipping}
                  onCheckedChange={(v) => setForm({ ...form, requiresShipping: v })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
                Cancel
              </Button>
              <Button onClick={trySave} disabled={mutation.isPending}>
                {mutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Save changes
              </Button>
            </DialogFooter>
          </>
        ) : (
          // ---- SKU change confirmation step
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-amber-500" /> Confirm SKU change
              </DialogTitle>
              <DialogDescription>
                Changing SKU won&apos;t affect history but may cause confusion with existing labels. Continue?
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-1">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Old SKU</span>
                <code className="font-mono">{variant.sku}</code>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">New SKU</span>
                <code className="font-mono font-medium">{form.sku}</code>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setStep('edit')} disabled={mutation.isPending}>
                Back
              </Button>
              <Button onClick={confirmSave} disabled={mutation.isPending}>
                {mutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                Continue
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ----------------------------------------------------------------------------
// ImagesTab — upload + delete + primary badge
// ----------------------------------------------------------------------------
function ImagesTab({
  product,
  productId,
  canEdit,
}: {
  product: ProductDetail
  productId: string
  canEdit: boolean
}) {
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // NOTE: The backend route `PATCH /api/products/[id]/images/[imageId]` for
  // setting is_primary does not exist yet. Upload already auto-sets the first
  // image as primary, so the manual primary toggle is intentionally skipped
  // for now. When that route lands, wire a "Set Primary" star button per
  // non-primary image here.

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      // Use raw fetch — multipart FormData must NOT have a JSON Content-Type.
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`/api/products/${productId}/images`, {
        method: 'POST',
        body: fd,
        credentials: 'include',
        cache: 'no-store',
      })
      const text = await res.text()
      let body: unknown = null
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
      }
      if (!res.ok) {
        const msg =
          body && typeof body === 'object' && 'error' in body
            ? String((body as { error: unknown }).error)
            : typeof body === 'string'
              ? body
              : 'Upload failed'
        throw new FetchError(res.status, msg)
      }
      return body as { image_id: string; public_url: string; is_primary: boolean }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['product', productId] })
      toast.success('Image uploaded.')
    },
    onError: (err) => {
      toast.error(err instanceof FetchError ? err.message : 'Failed to upload image.')
    },
    onSettled: () => {
      setUploading(false)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (imageId: string) =>
      api.delete(`/api/products/${productId}/images?image_id=${imageId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['product', productId] })
      toast.success('Image deleted.')
    },
    onError: (err) => {
      toast.error(err instanceof FetchError ? err.message : 'Failed to delete image.')
    },
    onSettled: () => {
      setDeletingId(null)
    },
  })

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    // Reset input so the same file can be picked again later.
    e.target.value = ''
    if (!file) return
    // Client-side size guard — backend also enforces 5 MB, but this avoids the
    // round-trip for obviously-too-large files.
    if (file.size > 5 * 1024 * 1024) {
      toast.error('File too large. Maximum 5 MB.')
      return
    }
    setUploading(true)
    uploadMutation.mutate(file)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ImageIcon className="h-4 w-4 text-primary" /> Images
        </CardTitle>
        <CardDescription>
          Product images used on the storefront and Shopify sync. First image becomes primary automatically.
        </CardDescription>
        {canEdit && (
          <CardAction>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={onPickFile}
              disabled={uploading}
            />
            <Button
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              Upload
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {product.images.length === 0 ? (
          <div className="text-center py-12 border border-dashed rounded-lg">
            <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-3">
              <ImageIcon className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">No images yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              {canEdit
                ? 'Upload images to showcase this product.'
                : 'No images have been uploaded yet.'}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
            {product.images.map((img) => (
              <div
                key={img.id}
                className="relative aspect-square rounded-lg border overflow-hidden bg-muted group"
              >
                <img
                  src={img.publicUrl}
                  alt={`${product.title} image ${img.displayOrder + 1}`}
                  className="h-full w-full object-cover"
                />
                {img.isPrimary && (
                  <div className="absolute top-2 left-2">
                    <Badge className="bg-background/90 backdrop-blur text-foreground border-transparent text-[10px] gap-1">
                      <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                      Primary
                    </Badge>
                  </div>
                )}
                {img.variantId && (
                  <div className="absolute bottom-2 left-2">
                    <Badge className="bg-background/90 backdrop-blur text-foreground border-transparent text-[10px]">
                      Variant
                    </Badge>
                  </div>
                )}
                {canEdit && (
                  <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <Button
                      size="icon"
                      variant="secondary"
                      className="h-7 w-7"
                      onClick={() => {
                        setDeletingId(img.id)
                        deleteMutation.mutate(img.id)
                      }}
                      disabled={deletingId === img.id || uploading}
                      aria-label="Delete image"
                      title="Delete image"
                    >
                      {deletingId === img.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ----------------------------------------------------------------------------
// Inventory Tab — per-variant stock summary, per-location breakdown, MTO banner
// ----------------------------------------------------------------------------
interface InventorySummaryVariant {
  variantId: string
  sku: string
  fulfillmentType: string
  trackInventory: boolean
  totalOnHand: number
  totalReserved: number
  totalAvailable: number
  totalValue: number
  locations: Array<{
    locationId: string
    locationName: string
    onHand: number
    reserved: number
    available: number
    avgCost: number
    incoming: number
  }>
}

function InventoryTab({
  productId,
  variants,
  isStitchable,
}: {
  productId: string
  variants: ProductVariant[]
  isStitchable: boolean
}) {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const { data, isLoading, isError, refetch } = useQuery<{ variants: InventorySummaryVariant[] }>({
    queryKey: ['product-inventory', productId],
    queryFn: () => api.get(`/api/inventory/summary?product_id=${productId}`),
    staleTime: 15_000,
  })

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 rounded bg-muted/50 animate-pulse" />
          ))}
        </CardContent>
      </Card>
    )
  }

  if (isError) {
    return (
      <Card>
        <CardContent className="p-6 text-center">
          <AlertCircle className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground mb-3">Failed to load inventory data.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
        </CardContent>
      </Card>
    )
  }

  if (!data || data.variants.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          No inventory data for this product yet.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {data.variants.map((v) => {
        const variantInfo = variants.find((vv) => vv.id === v.variantId)
        const isMTO = v.fulfillmentType === 'made_to_order'
        const hasReturnedStock = isMTO && v.totalOnHand > 0

        return (
          <Card key={v.variantId}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Tag className="h-4 w-4 text-muted-foreground" />
                    <span className="font-mono text-sm">{v.sku}</span>
                  </CardTitle>
                  {variantInfo && (
                    <div className="mt-1 flex items-center gap-2">
                      <FulfillmentTypeBadge type={v.fulfillmentType} />
                      {variantInfo.attributeValues && Object.keys(variantInfo.attributeValues).length > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {Object.entries(variantInfo.attributeValues).map(([k, val]) => `${k}: ${val}`).join(' · ')}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="flex gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">On Hand: </span>
                      <span className="font-medium">{v.totalOnHand}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Available: </span>
                      <span className="font-medium">{v.totalAvailable}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Value: </span>
                      <span className="font-medium">Rs. {formatMoney(v.totalValue)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* MTO returned stock banner */}
              {isMTO && !hasReturnedStock && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
                  <Package className="h-4 w-4 inline mr-2" />
                  No returned stock — next order triggers fresh production.
                </div>
              )}
              {isMTO && hasReturnedStock && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
                  <Package className="h-4 w-4 inline mr-2" />
                  {v.totalOnHand} returned piece(s) available (Rs. {formatMoney(v.totalValue)}) — next order uses this stock automatically.
                </div>
              )}

              {/* Per-location breakdown */}
              {v.locations.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Location</TableHead>
                      <TableHead className="text-right">On Hand</TableHead>
                      <TableHead className="text-right">Reserved</TableHead>
                      <TableHead className="text-right">Available</TableHead>
                      <TableHead className="text-right">Avg Cost</TableHead>
                      <TableHead className="text-right">Incoming</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {v.locations.map((loc) => (
                      <TableRow key={loc.locationId}>
                        <TableCell className="text-sm">{loc.locationName}</TableCell>
                        <TableCell className="text-right text-sm font-medium">{loc.onHand}</TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground">{loc.reserved}</TableCell>
                        <TableCell className="text-right text-sm font-medium">{loc.available}</TableCell>
                        <TableCell className="text-right text-sm">Rs. {formatMoney(loc.avgCost)}</TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground">{loc.incoming > 0 ? loc.incoming : '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-xs text-muted-foreground py-2">No stock at any location.</p>
              )}

              {/* Quick action buttons */}
              <div className="flex flex-wrap gap-2 pt-1">
                {can(PERMISSIONS.INVENTORY_RECEIVE) && (
                  <Button variant="outline" size="sm" onClick={() => navigate({ name: 'inventory-receive' })}>
                    <PackagePlus className="h-3.5 w-3.5" /> Receive Stock
                  </Button>
                )}
                {can(PERMISSIONS.INVENTORY_ADJUST) && (
                  <Button variant="outline" size="sm" onClick={() => navigate({ name: 'inventory-adjust' })}>
                    <SlidersHorizontal className="h-3.5 w-3.5" /> Adjust
                  </Button>
                )}
                {can(PERMISSIONS.INVENTORY_TRANSFER) && (
                  <Button variant="outline" size="sm" onClick={() => navigate({ name: 'inventory-transfer' })}>
                    <ArrowLeftRight className="h-3.5 w-3.5" /> Transfer
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => navigate({ name: 'inventory' })}>
                  <TrendingUp className="h-3.5 w-3.5" /> View Full History
                </Button>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

// ----------------------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------------------
function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n)
}
