'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
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
import { toast } from 'sonner'
import {
  Loader2,
  ArrowLeft,
  Package,
  Shirt,
  Tag,
  Save,
  ImageIcon,
  Store,
  Pencil,
  ArrowUpCircle,
  AlertCircle,
} from 'lucide-react'
import {
  FULFILLMENT_LABELS,
  PRODUCT_TYPE_LABELS,
  PRODUCT_SCOPE_LABELS,
  STITCHING_LABELS,
} from '@/lib/constants/fulfillment-types'
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
              <>
                <Button variant="outline" disabled title="Coming soon">
                  <Pencil className="h-4 w-4" /> Edit
                </Button>
                <Button onClick={() => setScopeDialogOpen(true)}>
                  <ArrowUpCircle className="h-4 w-4" /> Promote to Org
                </Button>
              </>
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
          {!product.isOwner && product.subscription && (
            <TabsTrigger value="pricing">Pricing</TabsTrigger>
          )}
        </TabsList>

        {/* Overview */}
        <TabsContent value="overview">
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">Description</CardTitle>
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
                  <>
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
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Variants */}
        <TabsContent value="variants">
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
                      <TableHead className="text-right">Sale</TableHead>
                      <TableHead className="text-right">Compare</TableHead>
                      <TableHead>Fulfillment</TableHead>
                      <TableHead>Stitching</TableHead>
                      <TableHead className="text-right">Days</TableHead>
                      <TableHead>Policy</TableHead>
                      <TableHead className="text-center">Active</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {product.variants.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={10} className="h-24 text-center text-muted-foreground text-sm">
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
                          <TableCell className="text-right text-xs font-medium">
                            {v.salePrice != null ? formatMoney(v.salePrice) : '—'}
                          </TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground">
                            {v.comparePrice != null ? formatMoney(v.comparePrice) : '—'}
                          </TableCell>
                          <TableCell>
                            <FulfillmentBadge type={v.fulfillmentType} />
                          </TableCell>
                          <TableCell className="text-xs">
                            {v.stitchingType
                              ? STITCHING_LABELS[v.stitchingType] ?? v.stitchingType
                              : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell className="text-right text-xs">
                            {v.productionDays > 0 ? v.productionDays : '—'}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-[10px] font-mono">
                              {v.inventoryPolicy}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-center">
                            <Switch checked={v.isActive} disabled />
                          </TableCell>
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
        </TabsContent>

        {/* Images */}
        <TabsContent value="images">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <ImageIcon className="h-4 w-4 text-primary" /> Images
              </CardTitle>
              <CardDescription>
                Product images used on the storefront and Shopify sync.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {product.images.length === 0 ? (
                <div className="text-center py-12 border border-dashed rounded-lg">
                  <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-3">
                    <ImageIcon className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium">No images yet</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Upload images via the edit screen (coming soon).
                  </p>
                </div>
              ) : (
                <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
                  {product.images.map((img) => (
                    <div
                      key={img.id}
                      className="relative aspect-square rounded-lg border overflow-hidden bg-muted"
                    >
                      <img
                        src={img.publicUrl}
                        alt={`${product.title} image ${img.displayOrder + 1}`}
                        className="h-full w-full object-cover"
                      />
                      {img.isPrimary && (
                        <div className="absolute top-2 left-2">
                          <Badge className="bg-background/90 backdrop-blur text-foreground border-transparent text-[10px]">
                            Primary
                          </Badge>
                        </div>
                      )}
                      {img.variantId && (
                        <div className="absolute bottom-2 right-2">
                          <Badge className="bg-background/90 backdrop-blur text-foreground border-transparent text-[10px]">
                            Variant
                          </Badge>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
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

        {/* Pricing (non-owner with subscription) */}
        {!product.isOwner && product.subscription && (
          <TabsContent value="pricing">
            <PricingTab
              productId={productId}
              variants={product.variants}
              onUpdate={() => {
                queryClient.invalidateQueries({ queryKey: ['product', productId] })
              }}
            />
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

function FulfillmentBadge({ type }: { type: string }) {
  const label = FULFILLMENT_LABELS[type] ?? type
  const isStock = type === 'stock_based'
  return (
    <Badge
      className={cn(
        'border-transparent text-[10px]',
        isStock
          ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100'
          : 'bg-sky-100 text-sky-700 hover:bg-sky-100',
      )}
    >
      {label}
    </Badge>
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
    setSaving(variantId)
    try {
      await api.patch(`/api/products/${productId}/variants/${variantId}/pricing`, {
        sale_price: draft.salePrice,
        compare_price: draft.comparePrice,
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
                        disabled={!dirty || saving === v.id}
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
// Utilities
// ----------------------------------------------------------------------------
function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n)
}
