'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAppStore } from '@/stores/app-store'
import { api } from '@/lib/api-client'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Loader2,
  Package,
  Plus,
  Search,
  Shirt,
  Tag,
  ChevronRight,
} from 'lucide-react'
import {
  FULFILLMENT_LABELS,
  PRODUCT_TYPE_LABELS,
  PRODUCT_SCOPE_LABELS,
} from '@/lib/constants/fulfillment-types'
import { cn } from '@/lib/utils'

interface ProductVariant {
  id: string
  sku: string
  costPrice: number
  fulfillmentType: string
  stitchingType: string | null
  isDefault: boolean
  salePrice: number | null
  comparePrice: number | null
}

interface ProductPublic {
  id: string
  title: string
  slug: string
  productType: string
  productScope: string
  isStitchable: boolean
  isFeatured: boolean
  isActive: boolean
  category: { id: string; name: string } | null
  brand: { id: string; name: string } | null
  primaryImage: string | null
  variantCount: number
  variants: ProductVariant[]
  isOwner: boolean
}

type FilterType = 'all' | 'simple' | 'variable' | 'bundle' | 'service'

/** Compute the price range (min sale price → max sale price) across variants. */
function priceRange(variants: ProductVariant[]): { min: number; max: number } | null {
  const prices = variants
    .map((v) => v.salePrice)
    .filter((p): p is number => typeof p === 'number' && p > 0)
  if (prices.length === 0) return null
  return { min: Math.min(...prices), max: Math.max(...prices) }
}

function formatPrice(n: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n)
}

export function ProductsView() {
  const navigate = useAppStore((s) => s.navigate)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<FilterType>('all')

  const { data, isLoading, isError, refetch, isFetching } = useQuery<{
    products: ProductPublic[]
  }>({
    queryKey: ['products'],
    queryFn: () => api.get<{ products: ProductPublic[] }>('/api/products'),
    staleTime: 30_000,
  })

  const products = data?.products ?? []

  const filtered = useMemo(() => {
    return products.filter((p) => {
      if (typeFilter !== 'all' && p.productType !== typeFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return (
          p.title.toLowerCase().includes(q) ||
          p.slug.toLowerCase().includes(q) ||
          (p.category?.name.toLowerCase().includes(q) ?? false) ||
          (p.brand?.name.toLowerCase().includes(q) ?? false)
        )
      }
      return true
    })
  }, [products, search, typeFilter])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Products"
        description="Manage your product catalog, variants, and stitching options."
        actions={
          <Button onClick={() => navigate({ name: 'product-create' })}>
            <Plus className="h-4 w-4" /> New Product
          </Button>
        }
      />

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by title, category, brand…"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select
          value={typeFilter}
          onValueChange={(v) => setTypeFilter(v as FilterType)}
        >
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue placeholder="Product type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="simple">Simple</SelectItem>
            <SelectItem value="variable">Variable</SelectItem>
            <SelectItem value="bundle">Bundle</SelectItem>
            <SelectItem value="service">Service</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* States */}
      {isLoading ? (
        <ProductsGridSkeleton />
      ) : isError ? (
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">
              Couldn&apos;t load products. The server may have restarted.
            </p>
            <Button variant="outline" onClick={() => refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <EmptyState
          hasProducts={products.length > 0}
          onCreate={() => navigate({ name: 'product-create' })}
        />
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {isFetching ? 'Refreshing…' : `${filtered.length} of ${products.length} products`}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((p) => (
              <ProductCard key={p.id} product={p} onClick={() => navigate({ name: 'product-detail', id: p.id })} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function ProductCard({
  product,
  onClick,
}: {
  product: ProductPublic
  onClick: () => void
}) {
  const range = priceRange(product.variants)

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className="group cursor-pointer overflow-hidden py-0 gap-0 transition-all hover:shadow-md hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* Image / placeholder */}
      <div className="relative aspect-[4/3] bg-muted overflow-hidden">
        {product.primaryImage ? (
          <img
            src={product.primaryImage}
            alt={product.title}
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
          />
        ) : (
          <div className="h-full w-full flex flex-col items-center justify-center text-muted-foreground">
            <Package className="h-10 w-10 mb-1.5 opacity-50" />
            <span className="text-xs">No image</span>
          </div>
        )}
        {/* Top-left badges */}
        <div className="absolute top-2 left-2 flex flex-wrap gap-1.5 max-w-[calc(100%-1rem)]">
          {product.isFeatured && (
            <Badge className="bg-amber-500/90 hover:bg-amber-500 text-white border-transparent">
              Featured
            </Badge>
          )}
          {product.isStitchable && (
            <Badge className="bg-emerald-600/90 hover:bg-emerald-600 text-white border-transparent gap-1">
              <Shirt className="h-3 w-3" /> Stitchable
            </Badge>
          )}
        </div>
        {/* Top-right owner badge */}
        {product.isOwner && (
          <div className="absolute top-2 right-2">
            <Badge variant="outline" className="bg-background/90 backdrop-blur text-xs">
              Owner
            </Badge>
          </div>
        )}
      </div>

      <CardContent className="p-4 space-y-3">
        {/* Title */}
        <div className="space-y-1">
          <h3 className="font-medium text-sm leading-snug line-clamp-2 group-hover:text-primary transition-colors">
            {product.title}
          </h3>
          <p className="text-xs text-muted-foreground font-mono truncate">{product.slug}</p>
        </div>

        {/* Type + scope + variant count */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary" className="text-[10px]">
            {PRODUCT_TYPE_LABELS[product.productType] ?? product.productType}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {PRODUCT_SCOPE_LABELS[product.productScope] ?? product.productScope}
          </Badge>
          <Badge variant="outline" className="text-[10px] gap-1">
            <Package className="h-3 w-3" /> {product.variantCount} variant
            {product.variantCount === 1 ? '' : 's'}
          </Badge>
        </div>

        {/* Category + brand */}
        {(product.category || product.brand) && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {product.category && (
              <span className="inline-flex items-center gap-1">
                <Tag className="h-3 w-3" />
                {product.category.name}
              </span>
            )}
            {product.category && product.brand && <span>·</span>}
            {product.brand && <span>{product.brand.name}</span>}
          </div>
        )}

        {/* Price range + chevron */}
        <div className="flex items-end justify-between pt-1 border-t">
          <div>
            <p className="text-[10px] uppercase text-muted-foreground tracking-wide">
              Price range
            </p>
            <p className="text-sm font-semibold">
              {range ? (
                range.min === range.max ? (
                  formatPrice(range.min)
                ) : (
                  <>
                    {formatPrice(range.min)}
                    <span className="text-muted-foreground mx-1">–</span>
                    {formatPrice(range.max)}
                  </>
                )
              ) : (
                <span className="text-muted-foreground font-normal">—</span>
              )}
            </p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
        </div>
      </CardContent>
    </Card>
  )
}

function ProductsGridSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <Card key={i} className="overflow-hidden py-0 gap-0">
          <Skeleton className="aspect-[4/3] rounded-none" />
          <CardContent className="p-4 space-y-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
            <div className="flex gap-1.5">
              <Skeleton className="h-4 w-14 rounded-full" />
              <Skeleton className="h-4 w-14 rounded-full" />
            </div>
            <Skeleton className="h-4 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function EmptyState({
  hasProducts,
  onCreate,
}: {
  hasProducts: boolean
  onCreate: () => void
}) {
  return (
    <Card>
      <CardContent className="p-10 sm:p-14 text-center">
        <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <Package className="h-7 w-7 text-primary" />
        </div>
        <h3 className="text-lg font-semibold">
          {hasProducts ? 'No products match your filters' : 'No products yet'}
        </h3>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
          {hasProducts
            ? 'Try adjusting your search or product type filter.'
            : 'Create your first product to start managing your catalog, variants, and stitching options.'}
        </p>
        {!hasProducts && (
          <Button className="mt-5" onClick={onCreate}>
            <Plus className="h-4 w-4" /> Create your first product
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

// Re-export for the variant badge styling (used elsewhere)
export function FulfillmentBadge({ type }: { type: string }) {
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
