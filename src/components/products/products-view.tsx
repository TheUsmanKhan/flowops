'use client'

import { memo, useMemo, useState } from 'react'
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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

/** Maximum number of tag chips to show before "+N more". */
const MAX_TAGS = 3

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

/** Format the price range as a compact string (used by both desktop + mobile). */
function formatPriceRange(range: { min: number; max: number } | null): string {
  if (!range) return '—'
  if (range.min === range.max) return formatPrice(range.min)
  return `${formatPrice(range.min)} – ${formatPrice(range.max)}`
}

/** Build the list of tag labels (category + brand) for a product. */
function productTags(product: ProductPublic): string[] {
  const tags: string[] = []
  if (product.category) tags.push(product.category.name)
  if (product.brand) tags.push(product.brand.name)
  return tags
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

  const navigateToProduct = useMemo(
    () => (id: string) => navigate({ name: 'product-detail', id }),
    [navigate],
  )

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
        <ProductsTableSkeleton />
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

          {/* Desktop table (md and up) */}
          <div className="hidden md:block rounded-md border">
            <ProductsTable products={filtered} onNavigate={navigateToProduct} />
          </div>

          {/* Mobile stacked list (below md) */}
          <div className="block md:hidden space-y-3">
            {filtered.map((p) => (
              <ProductMobileCard key={p.id} product={p} onClick={() => navigateToProduct(p.id)} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ─── Desktop table ─────────────────────────────────────────────────

const ProductsTable = memo(function ProductsTable({
  products,
  onNavigate,
}: {
  products: ProductPublic[]
  onNavigate: (id: string) => void
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[52px]">Img</TableHead>
          <TableHead className="min-w-[200px]">Product</TableHead>
          <TableHead className="hidden lg:table-cell">Type</TableHead>
          <TableHead className="hidden xl:table-cell">Status</TableHead>
          <TableHead className="hidden lg:table-cell text-center">Variants</TableHead>
          <TableHead className="hidden xl:table-cell">Tags</TableHead>
          <TableHead className="text-right">Price Range</TableHead>
          <TableHead className="w-8" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {products.map((p) => (
          <ProductTableRow key={p.id} product={p} onClick={() => onNavigate(p.id)} />
        ))}
      </TableBody>
    </Table>
  )
})

const ProductTableRow = memo(function ProductTableRow({
  product,
  onClick,
}: {
  product: ProductPublic
  onClick: () => void
}) {
  const range = priceRange(product.variants)
  const tags = productTags(product)
  const visibleTags = tags.slice(0, MAX_TAGS)
  const remainingTags = tags.length - visibleTags.length

  return (
    <TableRow
      className="cursor-pointer hover:bg-muted/50 group"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      tabIndex={0}
    >
      {/* Thumbnail */}
      <TableCell className="py-2">
        <div className="h-10 w-10 rounded-md overflow-hidden bg-muted flex items-center justify-center shrink-0">
          {product.primaryImage ? (
            <img
              src={product.primaryImage}
              alt={product.title}
              className="h-full w-full object-cover"
            />
          ) : (
            <Package className="h-5 w-5 text-muted-foreground opacity-50" />
          )}
        </div>
      </TableCell>

      {/* Product name + slug */}
      <TableCell className="min-w-[200px]">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate group-hover:text-primary transition-colors">
            {product.title}
          </p>
          <p className="text-xs text-muted-foreground font-mono truncate">{product.slug}</p>
        </div>
      </TableCell>

      {/* Type (hidden below lg) */}
      <TableCell className="hidden lg:table-cell">
        <div className="flex flex-wrap gap-1">
          <Badge variant="secondary" className="text-[10px]">
            {PRODUCT_TYPE_LABELS[product.productType] ?? product.productType}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {PRODUCT_SCOPE_LABELS[product.productScope] ?? product.productScope}
          </Badge>
        </div>
      </TableCell>

      {/* Status (hidden below xl) */}
      <TableCell className="hidden xl:table-cell">
        <div className="flex flex-wrap gap-1">
          {product.isFeatured && (
            <Badge className="bg-amber-500/90 hover:bg-amber-500 text-white border-transparent text-[10px]">
              Featured
            </Badge>
          )}
          {product.isStitchable && (
            <Badge className="bg-emerald-600/90 hover:bg-emerald-600 text-white border-transparent text-[10px] gap-1">
              <Shirt className="h-2.5 w-2.5" /> Stitchable
            </Badge>
          )}
          {product.isOwner && (
            <Badge variant="outline" className="text-[10px]">
              Owner
            </Badge>
          )}
          {!product.isFeatured && !product.isStitchable && !product.isOwner && (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </div>
      </TableCell>

      {/* Variants (hidden below lg) */}
      <TableCell className="hidden lg:table-cell text-center text-sm text-muted-foreground">
        {product.variantCount}
      </TableCell>

      {/* Tags (hidden below xl) */}
      <TableCell className="hidden xl:table-cell">
        {tags.length === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-wrap gap-1 items-center">
            {visibleTags.map((t) => (
              <Badge key={t} variant="outline" className="text-[10px] gap-1">
                <Tag className="h-2.5 w-2.5" />
                {t}
              </Badge>
            ))}
            {remainingTags > 0 && (
              <span className="text-[10px] text-muted-foreground">+{remainingTags} more</span>
            )}
          </div>
        )}
      </TableCell>

      {/* Price range (right-aligned) */}
      <TableCell className="text-right font-semibold text-sm whitespace-nowrap">
        {range ? (
          formatPriceRange(range)
        ) : (
          <span className="text-muted-foreground font-normal">—</span>
        )}
      </TableCell>

      {/* Actions */}
      <TableCell>
        <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
      </TableCell>
    </TableRow>
  )
})

// ─── Mobile stacked list ───────────────────────────────────────────

const ProductMobileCard = memo(function ProductMobileCard({
  product,
  onClick,
}: {
  product: ProductPublic
  onClick: () => void
}) {
  const range = priceRange(product.variants)
  const tags = productTags(product)

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
      className="group cursor-pointer transition-all hover:shadow-md hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <CardContent className="p-3 flex gap-3 items-start">
        {/* Thumbnail (left) */}
        <div className="h-14 w-14 rounded-md overflow-hidden bg-muted flex items-center justify-center shrink-0">
          {product.primaryImage ? (
            <img
              src={product.primaryImage}
              alt={product.title}
              className="h-full w-full object-cover"
            />
          ) : (
            <Package className="h-6 w-6 text-muted-foreground opacity-50" />
          )}
        </div>

        {/* Content (right) */}
        <div className="flex-1 min-w-0 space-y-1.5">
          {/* Name + slug */}
          <div className="min-w-0">
            <p className="text-sm font-medium leading-snug truncate group-hover:text-primary transition-colors">
              {product.title}
            </p>
            <p className="text-xs text-muted-foreground font-mono truncate">{product.slug}</p>
          </div>

          {/* Badges (wrap naturally) */}
          <div className="flex flex-wrap gap-1">
            <Badge variant="secondary" className="text-[10px]">
              {PRODUCT_TYPE_LABELS[product.productType] ?? product.productType}
            </Badge>
            {product.isFeatured && (
              <Badge className="bg-amber-500/90 hover:bg-amber-500 text-white border-transparent text-[10px]">
                Featured
              </Badge>
            )}
            {product.isStitchable && (
              <Badge className="bg-emerald-600/90 hover:bg-emerald-600 text-white border-transparent text-[10px] gap-1">
                <Shirt className="h-2.5 w-2.5" /> Stitchable
              </Badge>
            )}
            {product.isOwner && (
              <Badge variant="outline" className="text-[10px]">
                Owner
              </Badge>
            )}
          </div>

          {/* Bottom row: tags + price */}
          <div className="flex items-center justify-between gap-2 pt-1">
            {/* Tags / variant summary */}
            <div className="min-w-0 flex-1">
              {tags.length > 0 ? (
                <p className="text-xs text-muted-foreground truncate">
                  {tags.join(' · ')}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {product.variantCount} variant{product.variantCount === 1 ? '' : 's'}
                </p>
              )}
            </div>
            {/* Price */}
            <p className="text-sm font-semibold whitespace-nowrap">
              {range ? (
                formatPriceRange(range)
              ) : (
                <span className="text-muted-foreground font-normal">—</span>
              )}
            </p>
          </div>
        </div>

        {/* Chevron (far right) */}
        <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary shrink-0 mt-1" />
      </CardContent>
    </Card>
  )
})

// ─── Skeleton + empty state ────────────────────────────────────────

function ProductsTableSkeleton() {
  return (
    <>
      {/* Desktop skeleton */}
      <div className="hidden md:block rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[52px]">Img</TableHead>
              <TableHead>Product</TableHead>
              <TableHead className="hidden lg:table-cell">Type</TableHead>
              <TableHead className="hidden xl:table-cell">Status</TableHead>
              <TableHead className="hidden lg:table-cell text-center">Variants</TableHead>
              <TableHead className="hidden xl:table-cell">Tags</TableHead>
              <TableHead className="text-right">Price Range</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 8 }).map((_, i) => (
              <TableRow key={i}>
                <TableCell><Skeleton className="h-10 w-10 rounded-md" /></TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-3/4 mb-1" />
                  <Skeleton className="h-3 w-1/2" />
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <div className="flex gap-1">
                    <Skeleton className="h-4 w-14 rounded-full" />
                    <Skeleton className="h-4 w-14 rounded-full" />
                  </div>
                </TableCell>
                <TableCell className="hidden xl:table-cell">
                  <Skeleton className="h-4 w-16 rounded-full" />
                </TableCell>
                <TableCell className="hidden lg:table-cell"><Skeleton className="h-4 w-4 mx-auto" /></TableCell>
                <TableCell className="hidden xl:table-cell"><Skeleton className="h-4 w-24" /></TableCell>
                <TableCell className="text-right"><Skeleton className="h-4 w-20 ml-auto" /></TableCell>
                <TableCell><Skeleton className="h-4 w-4" /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile skeleton */}
      <div className="block md:hidden space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-3 flex gap-3">
              <Skeleton className="h-14 w-14 rounded-md shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
                <div className="flex gap-1">
                  <Skeleton className="h-4 w-14 rounded-full" />
                  <Skeleton className="h-4 w-14 rounded-full" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
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
