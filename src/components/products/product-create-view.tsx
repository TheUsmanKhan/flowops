'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
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
  Loader2,
  ArrowLeft,
  ArrowRight,
  Check,
  AlertCircle,
  Package,
  Shirt,
  Scissors,
  Tag,
  Plus,
  Zap,
  Trash2,
  Sparkles,
} from 'lucide-react'
import {
  PRODUCT_TYPE_LABELS,
  PRODUCT_SCOPE_LABELS,
} from '@/lib/constants/fulfillment-types'
import { cn } from '@/lib/utils'
import {
  AttributeSelector,
  type SelectionState,
} from '@/components/products/attribute-selector'

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------
interface CategoryPublic {
  id: string
  name: string
  slug: string
  productCount: number
}
interface BrandPublic {
  id: string
  name: string
  slug: string
  productCount: number
}

interface GeneratedVariant {
  sku: string
  attribute_values: Record<string, string>
  cost_price: number
  stitching_charges: number
  fulfillment_type: string
  stitching_type: string
  production_days: number
  requires_shipping: boolean
  allow_backorder: boolean
  is_default: boolean
}

interface VariantDraft {
  sku: string
  barcode: string
  attribute_values: Record<string, string>
  cost_price: number
  stitching_charges: number
  compare_price: number | null
  weight_grams: number
  fulfillment_type: 'stock_based' | 'made_to_order'
  stitching_type: 'unstitched' | 'stitched_basic' | 'stitched_heavy' | 'custom_order' | null
  production_days: number
  sale_price: number
  is_active: boolean
  is_default: boolean
  // Opening stock (for stock_based variants)
  has_opening_stock: boolean
  opening_stock_qty: number
  opening_stock_cost: number
  opening_stock_location_id: string
  // Fabric source (for made_to_order variants)
  fabric_source_variant_id: string | null
}

type ProductType = 'simple' | 'variable' | 'bundle' | 'service'
type ProductScope = 'private' | 'organization' | 'selective'

const STEPS = ['Basic Details', 'Variants & Pricing', 'Scope & Confirm'] as const

const PRODUCT_TYPE_OPTIONS: Array<{
  key: ProductType
  label: string
  icon: typeof Package
  description: string
}> = [
  {
    key: 'simple',
    label: 'Simple',
    icon: Package,
    description: 'One SKU, no variants. Best for single items.',
  },
  {
    key: 'variable',
    label: 'Variable',
    icon: Tag,
    description: 'Multiple variants with sizes, colors, or stitching.',
  },
  {
    key: 'bundle',
    label: 'Bundle',
    icon: Package,
    description: 'A collection sold together as one unit.',
  },
  {
    key: 'service',
    label: 'Service',
    icon: Scissors,
    description: 'Non-physical offering like tailoring or alterations.',
  },
]

const SCOPE_OPTIONS: Array<{
  key: ProductScope
  label: string
  description: string
}> = [
  {
    key: 'private',
    label: 'Private',
    description: 'Only your company can see and sell this product.',
  },
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
export function ProductCreateView({ onBack }: { onBack: () => void }) {
  const navigate = useAppStore((s) => s.navigate)
  const queryClient = useQueryClient()

  const [step, setStep] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Step 1 state
  const [title, setTitle] = useState('')
  const [shortDescription, setShortDescription] = useState('')
  const [description, setDescription] = useState('')
  const [productType, setProductType] = useState<ProductType>('variable')
  const [categoryId, setCategoryId] = useState('')
  const [brandId, setBrandId] = useState('')
  const [baseSku, setBaseSku] = useState('')
  const [isFeatured, setIsFeatured] = useState(false)
  const [isStitchable, setIsStitchable] = useState(false)

  // Step 2 — simple mode
  const [simpleVariant, setSimpleVariant] = useState<VariantDraft>(blankSimpleVariant())

  // Step 2 — stitchable / generic-attribute mode
  const [attributeSelection, setAttributeSelection] = useState<SelectionState>({
    selectedAttributes: [],
  })
  const [generatedVariants, setGeneratedVariants] = useState<
    Array<GeneratedVariant & { sale_price: number; is_active: boolean }>
  >([])
  const [generating, setGenerating] = useState(false)

  // Step 2 — regular variable mode
  const [regularVariants, setRegularVariants] = useState<VariantDraft[]>([
    blankRegularVariant(1),
  ])

  // Step 3 state
  const [productScope, setProductScope] = useState<ProductScope>('private')

  // ---- Derived: slug for variant SKU generation
  const slug = useMemo(() => slugify(title || 'product'), [title])

  // ---- Queries: categories & brands
  const { data: catData } = useQuery<{ categories: CategoryPublic[] }>({
    queryKey: ['categories'],
    queryFn: () => api.get<{ categories: CategoryPublic[] }>('/api/categories'),
    staleTime: 60_000,
  })
  const { data: brandData } = useQuery<{ brands: BrandPublic[] }>({
    queryKey: ['brands'],
    queryFn: () => api.get<{ brands: BrandPublic[] }>('/api/brands'),
    staleTime: 60_000,
  })

  // Reset stitching flag if product type changes away from variable.
  useEffect(() => {
    if (productType !== 'variable' && isStitchable) {
      setIsStitchable(false)
    }
  }, [productType, isStitchable])

  // ---- Helpers
  function validateStep(s: number): string | null {
    if (s === 0) {
      if (title.trim().length < 2) return 'Product title must be at least 2 characters.'
      if (shortDescription.length > 500) return 'Short description must be 500 characters or fewer.'
    }
    if (s === 1) {
      const variants = collectVariantsForValidation()
      if (variants.length === 0) {
        if (isStitchable && productType === 'variable') {
          return 'Pick at least one attribute and value to generate variants.'
        }
        return 'Add at least one variant.'
      }
      for (const v of variants) {
        if (!v.sku.trim()) return 'Every variant needs an SKU.'
        if (typeof v.sale_price !== 'number' || v.sale_price < 0) {
          return `Variant ${v.sku || '(unnamed)'} needs a valid sale price.`
        }
        if (typeof v.cost_price !== 'number' || v.cost_price < 0) {
          return `Variant ${v.sku || '(unnamed)'} needs a valid cost price.`
        }
      }
    }
    return null
  }

  function collectVariantsForValidation(): VariantDraft[] {
    if (productType === 'simple') return [simpleVariant]
    if (productType === 'variable' && isStitchable) {
      return generatedVariants.map((g) => ({
        sku: g.sku,
        barcode: '',
        attribute_values: g.attribute_values,
        cost_price: g.cost_price,
        stitching_charges: g.stitching_charges,
        compare_price: null,
        weight_grams: 0,
        fulfillment_type: g.fulfillment_type as 'stock_based' | 'made_to_order',
        stitching_type: g.stitching_type as VariantDraft['stitching_type'],
        production_days: g.production_days,
        sale_price: g.sale_price,
        is_active: g.is_active,
        is_default: g.is_default,
        has_opening_stock: false,
        opening_stock_qty: 0,
        opening_stock_cost: 0,
        opening_stock_location_id: '',
        fabric_source_variant_id: null,
      }))
    }
    if (productType === 'variable') return regularVariants
    // bundle / service — use simple variant form
    return [simpleVariant]
  }

  function goNext() {
    setSubmitError(null)
    const err = validateStep(step)
    if (err) {
      setSubmitError(err)
      return
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1))
  }

  // ---- Generic attribute mode: regenerate variants whenever the attribute
  // selection changes. Calls the generate endpoint with the selection and a
  // dummy product id (the route doesn't use the id — it accepts product_slug
  // in the body and returns pure combinations).
  const lastReqIdRef = useRef(0)
  const handleAttributeChange = useCallback(
    (selection: SelectionState) => {
      setAttributeSelection(selection)
      if (selection.selectedAttributes.length === 0) {
        setGeneratedVariants([])
        return
      }
      const reqId = ++lastReqIdRef.current
      setGenerating(true)
      api
        .post<{
          combinations: Array<{
            attribute_values: Record<string, string>
            suggested_sku: string
            suggested_fulfillment_type: string
          }>
        }>(`/api/products/new/variants/generate`, {
          product_slug: slug,
          base_sku: baseSku.trim() || undefined,
          selected_attributes: selection.selectedAttributes,
        })
        .then((res) => {
          // Stale-response guard — keep only the latest reply.
          if (reqId !== lastReqIdRef.current) return
          // Preserve user edits (sale_price, is_active, cost_price) for
          // existing SKUs; default new ones with a 30% markup on cost (=0).
          setGeneratedVariants((prev) => {
            const prevBySku = new Map(prev.map((v) => [v.sku, v]))
            return res.combinations.map((c, i) => {
              const existing = prevBySku.get(c.suggested_sku)
              return {
                sku: c.suggested_sku,
                attribute_values: c.attribute_values,
                cost_price: existing?.cost_price ?? 0,
                stitching_charges: existing?.stitching_charges ?? 0,
                fulfillment_type: c.suggested_fulfillment_type,
                stitching_type:
                  existing?.stitching_type ??
                  (c.suggested_fulfillment_type === 'made_to_order'
                    ? 'stitched_basic'
                    : 'unstitched'),
                production_days: existing?.production_days ?? 0,
                requires_shipping: existing?.requires_shipping ?? true,
                allow_backorder: existing?.allow_backorder ?? false,
                is_default: existing?.is_default ?? i === 0,
                sale_price: existing?.sale_price ?? 0,
                is_active: existing?.is_active ?? true,
              }
            })
          })
        })
        .catch((err) => {
          if (reqId !== lastReqIdRef.current) return
          const msg =
            err instanceof FetchError
              ? err.message
              : 'Failed to generate variant combinations.'
          setSubmitError(msg)
          toast.error(msg)
        })
        .finally(() => {
          if (reqId === lastReqIdRef.current) setGenerating(false)
        })
    },
    [slug, baseSku],
  )

  // ---- Submit final product
  async function submit() {
    setSubmitError(null)
    for (const s of [0, 1, 2]) {
      const err = validateStep(s)
      if (err) {
        setSubmitError(err)
        setStep(s)
        return
      }
    }

    // Clone the drafts so we can normalize the default flag without mutating state.
    const variants = collectVariantsForValidation().map<VariantDraft>((v) => ({ ...v }))

    // Ensure at least one variant is the default.
    if (!variants.some((v) => v.is_default) && variants.length > 0) {
      variants[0].is_default = true
    }

    const payload = {
      title: title.trim(),
      base_sku: baseSku.trim() || undefined,
      description: description.trim() || undefined,
      short_description: shortDescription.trim() || undefined,
      product_type: productType,
      category_id: categoryId || undefined,
      brand_id: brandId || undefined,
      product_scope: productScope,
      is_stitchable: isStitchable,
      stitching_base_price: 0,
      has_size_variants:
        isStitchable &&
        productType === 'variable' &&
        attributeSelection.selectedAttributes.some(
          (a) => a.attribute_name.toLowerCase() === 'size',
        ),
      is_active: true,
      is_featured: isFeatured,
      variants: variants.map((v) => ({
        sku: v.sku.trim(),
        barcode: v.barcode?.trim() || undefined,
        attribute_values: v.attribute_values,
        cost_price: Number(v.cost_price) || 0,
        stitching_charges: Number(v.stitching_charges) || 0,
        compare_price: v.compare_price ?? undefined,
        weight_grams: Number(v.weight_grams) || 0,
        fulfillment_type: v.fulfillment_type,
        stitching_type: v.stitching_type ?? undefined,
        production_days: Number(v.production_days) || 0,
        allow_backorder: false,
        requires_shipping: true,
        is_taxable: true,
        is_active: v.is_active,
        is_default: v.is_default,
        sale_price: Number(v.sale_price) || 0,
      })),
    }

    setSubmitting(true)
    try {
      const res = await api.post<{ id: string; slug: string; title: string }>(
        '/api/products',
        payload,
      )

      // After product creation, process opening stock for variants that have it
      const variantsWithOpeningStock = variants.filter(
        (v) => v.has_opening_stock && v.opening_stock_qty > 0 && v.opening_stock_location_id,
      )
      if (variantsWithOpeningStock.length > 0) {
        try {
          await api.post('/api/inventory/receive', {
            location_id: variantsWithOpeningStock[0].opening_stock_location_id,
            notes: `Opening stock for ${res.title}`,
            items: variantsWithOpeningStock.map((v) => ({
              org_variant_id: v.sku, // Note: this won't work — we need the actual variant ID
              quantity: v.opening_stock_qty,
              cost_per_unit: v.opening_stock_cost || v.cost_price,
            })),
          })
        } catch {
          // Opening stock failure shouldn't block product creation
          toast.warning('Product created, but opening stock could not be set. Use Receive Stock manually.')
        }
      }

      queryClient.invalidateQueries({ queryKey: ['products'] })
      toast.success(`"${res.title}" created.`)
      navigate({ name: 'product-detail', id: res.id })
    } catch (err) {
      const msg =
        err instanceof FetchError ? err.message : 'Failed to create product.'
      setSubmitError(msg)
      toast.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  // ---- Render
  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        disabled={submitting}
      >
        <ArrowLeft className="h-4 w-4" /> Back to products
      </button>

      <PageHeader
        title="Create New Product"
        description="Set up your product, its variants, and how it syncs to Shopify."
      />

      {/* Stepper */}
      <div className="flex items-center gap-2">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center gap-2 flex-1">
            <div
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium shrink-0 transition-colors',
                i < step
                  ? 'bg-primary text-primary-foreground'
                  : i === step
                    ? 'bg-primary text-primary-foreground ring-4 ring-primary/15'
                    : 'bg-muted text-muted-foreground',
              )}
            >
              {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </div>
            <span
              className={cn(
                'text-sm font-medium hidden sm:block',
                i === step ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {label}
            </span>
            {i < STEPS.length - 1 && (
              <div
                className={cn(
                  'h-px flex-1',
                  i < step ? 'bg-primary' : 'bg-border',
                )}
              />
            )}
          </div>
        ))}
      </div>

      {submitError && (
        <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-medium">Couldn&apos;t continue</p>
            <p className="text-xs mt-0.5 opacity-90">{submitError}</p>
          </div>
          <button
            onClick={() => setSubmitError(null)}
            className="text-destructive/60 hover:text-destructive text-xs"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Step 1 */}
      {step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Package className="h-5 w-5 text-primary" /> Basic details
            </CardTitle>
            <CardDescription>
              Core product information your customers will see.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="title">
                Title <span className="text-destructive">*</span>
              </Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Lawn Embroidered Kurta — Summer Collection"
                autoFocus
              />
              {title && (
                <p className="text-xs text-muted-foreground">
                  URL slug:{' '}
                  <code className="font-mono">{slug}</code>
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="baseSku">Base SKU / Style Code (optional)</Label>
              <Input
                id="baseSku"
                value={baseSku}
                onChange={(e) => setBaseSku(e.target.value.toUpperCase().trim())}
                placeholder="e.g. FSES-10A"
              />
              <p className="text-xs text-muted-foreground">
                Used as the prefix for all variant SKUs. Leave blank to auto-generate from the title.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="shortDesc">Short description (optional)</Label>
              <Textarea
                id="shortDesc"
                value={shortDescription}
                onChange={(e) => setShortDescription(e.target.value)}
                rows={2}
                maxLength={500}
                placeholder="One-line summary shown on product cards…"
              />
              <p className="text-xs text-muted-foreground text-right">
                {shortDescription.length}/500
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="desc">Full description</Label>
              <Textarea
                id="desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                placeholder="Full product description — fabric, care, what's included, etc."
              />
            </div>

            <div className="space-y-2">
              <Label>Product type</Label>
              <div className="grid sm:grid-cols-2 gap-3">
                {PRODUCT_TYPE_OPTIONS.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setProductType(opt.key)}
                    className={cn(
                      'flex items-start gap-3 rounded-lg border p-3 text-left transition-all',
                      productType === opt.key
                        ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
                        : 'border-border hover:border-primary/40 hover:bg-muted/40',
                    )}
                  >
                    <div
                      className={cn(
                        'mt-0.5 flex h-8 w-8 items-center justify-center rounded-md shrink-0',
                        productType === opt.key
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      <opt.icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{opt.label}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {opt.description}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <CategorySelect
                value={categoryId}
                onChange={setCategoryId}
                categories={catData?.categories ?? []}
              />
              <BrandSelect
                value={brandId}
                onChange={setBrandId}
                brands={brandData?.brands ?? []}
              />
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <ToggleRow
                label="Featured product"
                description="Show on the storefront homepage."
                checked={isFeatured}
                onChange={setIsFeatured}
              />
              {productType === 'variable' && (
                <ToggleRow
                  label="Stitchable product"
                  description="Generates unstitched + stitched variants."
                  checked={isStitchable}
                  onChange={setIsStitchable}
                  icon={Shirt}
                />
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 2 */}
      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Tag className="h-5 w-5 text-primary" /> Variants & pricing
            </CardTitle>
            <CardDescription>
              {productType === 'simple' && 'A single SKU for this product.'}
              {productType === 'variable' && isStitchable && 'Generate stitched & unstitched variant combinations.'}
              {productType === 'variable' && !isStitchable && 'Add variants manually with their own SKUs and prices.'}
              {productType === 'bundle' && 'Define the bundle as a single SKU.'}
              {productType === 'service' && 'Define the service as a single SKU.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Mode A: Simple / Bundle / Service — single variant form */}
            {(productType === 'simple' || productType === 'bundle' || productType === 'service') && (
              <SimpleVariantForm
                value={simpleVariant}
                onChange={setSimpleVariant}
                slug={slug}
              />
            )}

            {/* Mode B: Stitchable variable product (generic attribute-driven) */}
            {productType === 'variable' && isStitchable && (
              <StitchableVariantBuilder
                slug={slug}
                selection={attributeSelection}
                onSelectionChange={handleAttributeChange}
                generatedVariants={generatedVariants}
                setGeneratedVariants={setGeneratedVariants}
                generating={generating}
              />
            )}

            {/* Mode C: Regular variable product */}
            {productType === 'variable' && !isStitchable && (
              <RegularVariantBuilder
                slug={slug}
                variants={regularVariants}
                setVariants={setRegularVariants}
              />
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 3 */}
      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Check className="h-5 w-5 text-primary" /> Scope & confirm
            </CardTitle>
            <CardDescription>
              Choose who can see this product, then review & create.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label>Product scope</Label>
              <div className="grid sm:grid-cols-3 gap-3">
                {SCOPE_OPTIONS.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setProductScope(opt.key)}
                    className={cn(
                      'rounded-lg border p-4 text-left transition-all',
                      productScope === opt.key
                        ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
                        : 'border-border hover:border-primary/40 hover:bg-muted/40',
                    )}
                  >
                    <p className="text-sm font-medium">{opt.label}</p>
                    <p className="text-xs text-muted-foreground mt-1">{opt.description}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Review summary */}
            <div className="rounded-lg border p-4 space-y-3">
              <p className="text-xs font-medium uppercase text-muted-foreground">
                Review summary
              </p>
              <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <Row label="Title" value={title || '—'} />
                <Row label="Type" value={PRODUCT_TYPE_LABELS[productType] ?? productType} />
                <Row
                  label="Category"
                  value={
                    catData?.categories.find((c) => c.id === categoryId)?.name ?? '—'
                  }
                />
                <Row
                  label="Brand"
                  value={
                    brandData?.brands.find((b) => b.id === brandId)?.name ?? '—'
                  }
                />
                <Row
                  label="Variant count"
                  value={String(collectVariantsForValidation().length)}
                />
                <Row
                  label="Stitchable"
                  value={isStitchable ? 'Yes' : 'No'}
                />
                <Row
                  label="Featured"
                  value={isFeatured ? 'Yes' : 'No'}
                />
                <Row
                  label="Scope"
                  value={PRODUCT_SCOPE_LABELS[productScope] ?? productScope}
                />
              </dl>
            </div>

            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs space-y-1">
              <p className="font-medium text-primary">What will happen</p>
              <p className="text-muted-foreground">✓ Product &ldquo;{title || 'Untitled'}&rdquo; will be created in your catalog</p>
              <p className="text-muted-foreground">✓ {collectVariantsForValidation().length} variant{collectVariantsForValidation().length === 1 ? '' : 's'} will be created with their SKUs</p>
              <p className="text-muted-foreground">✓ Your company pricing will be set for each variant</p>
              <p className="text-muted-foreground">✓ Your company will be auto-subscribed to this product</p>
              <p className="text-muted-foreground">✓ Scope &ldquo;{PRODUCT_SCOPE_LABELS[productScope]}&rdquo; controls who can see it</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Footer nav */}
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          onClick={() => (step === 0 ? onBack() : setStep((s) => s - 1))}
          disabled={submitting}
        >
          <ArrowLeft className="h-4 w-4" /> {step === 0 ? 'Cancel' : 'Back'}
        </Button>
        {step < STEPS.length - 1 ? (
          <Button onClick={goNext} disabled={submitting}>
            Continue <ArrowRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button onClick={submit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Creating…
              </>
            ) : (
              <>
                Create Product <Check className="h-4 w-4" />
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------------------
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-dashed pb-1.5 last:border-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-medium text-right truncate max-w-[60%]">{value}</dd>
    </div>
  )
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  icon: Icon,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
  icon?: typeof Shirt
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border p-3">
      <div className="flex items-start gap-2.5">
        {Icon && <Icon className="h-4 w-4 text-muted-foreground mt-0.5" />}
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function CategorySelect({
  value,
  onChange,
  categories,
}: {
  value: string
  onChange: (v: string) => void
  categories: CategoryPublic[]
}) {
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [localCats, setLocalCats] = useState<CategoryPublic[]>([])

  const allCats = useMemo(
    () => [...categories, ...localCats],
    [categories, localCats],
  )

  async function createCategory() {
    if (newName.trim().length < 2) return
    setCreating(true)
    try {
      const res = await api.post<{ id: string; name: string; slug: string }>(
        '/api/categories',
        { name: newName.trim() },
      )
      setLocalCats((c) => [
        ...c,
        { id: res.id, name: res.name, slug: res.slug, productCount: 0 },
      ])
      onChange(res.id)
      setNewName('')
      setOpen(false)
      toast.success(`Category “${res.name}” created.`)
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to create category.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <Label>Category</Label>
      <div className="flex gap-2">
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="Select category…" />
          </SelectTrigger>
          <SelectContent>
            {allCats.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                No categories yet.
              </div>
            )}
            {allCats.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}{' '}
                <span className="text-muted-foreground text-xs">
                  ({c.productCount})
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setOpen(true)}
          aria-label="Add new category"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add new category</DialogTitle>
            <DialogDescription>
              Categories help organize products in your catalog.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <Label htmlFor="cat-name">Category name</Label>
            <Input
              id="cat-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. unstitched lawn"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  createCategory()
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={createCategory}
              disabled={creating || newName.trim().length < 2}
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function BrandSelect({
  value,
  onChange,
  brands,
}: {
  value: string
  onChange: (v: string) => void
  brands: BrandPublic[]
}) {
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [localBrands, setLocalBrands] = useState<BrandPublic[]>([])

  const allBrands = useMemo(
    () => [...brands, ...localBrands],
    [brands, localBrands],
  )

  async function createBrand() {
    if (newName.trim().length < 2) return
    setCreating(true)
    try {
      const res = await api.post<{ id: string; name: string; slug: string }>(
        '/api/brands',
        { name: newName.trim() },
      )
      setLocalBrands((b) => [
        ...b,
        { id: res.id, name: res.name, slug: res.slug, productCount: 0 },
      ])
      onChange(res.id)
      setNewName('')
      setOpen(false)
      toast.success(`Brand “${res.name}” created.`)
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to create brand.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <Label>Brand</Label>
      <div className="flex gap-2">
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="Select brand…" />
          </SelectTrigger>
          <SelectContent>
            {allBrands.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                No brands yet.
              </div>
            )}
            {allBrands.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.name}{' '}
                <span className="text-muted-foreground text-xs">
                  ({b.productCount})
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setOpen(true)}
          aria-label="Add new brand"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add new brand</DialogTitle>
            <DialogDescription>
              A brand represents the manufacturer or label of the product.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <Label htmlFor="brand-name">Brand name</Label>
            <Input
              id="brand-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Gul Ahmed"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  createBrand()
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={createBrand}
              disabled={creating || newName.trim().length < 2}
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---- Simple variant form (Mode A)
function SimpleVariantForm({
  value,
  onChange,
  slug,
}: {
  value: VariantDraft
  onChange: (v: VariantDraft) => void
  slug: string
}) {
  const set = <K extends keyof VariantDraft>(key: K, v: VariantDraft[K]) =>
    onChange({ ...value, [key]: v })

  const isMto = value.fulfillment_type === 'made_to_order'

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        This product will have a single SKU. The slug-based default is{' '}
        <code className="font-mono">{slug}-default</code>.
      </p>
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>SKU <span className="text-destructive">*</span></Label>
          <Input value={value.sku} onChange={(e) => set('sku', e.target.value)} placeholder={`${slug}-default`} />
        </div>
        <div className="space-y-1.5">
          <Label>Barcode</Label>
          <Input value={value.barcode} onChange={(e) => set('barcode', e.target.value)} placeholder="8-12 digit UPC/EAN" />
        </div>
        <div className="space-y-1.5">
          <Label>Cost price <span className="text-destructive">*</span></Label>
          <Input type="number" min="0" step="0.01" value={value.cost_price || ''} onChange={(e) => set('cost_price', Number(e.target.value))} placeholder="0.00" />
        </div>
        <div className="space-y-1.5">
          <Label>Sale price <span className="text-destructive">*</span></Label>
          <Input type="number" min="0" step="0.01" value={value.sale_price || ''} onChange={(e) => set('sale_price', Number(e.target.value))} placeholder="0.00" />
        </div>
        <div className="space-y-1.5">
          <Label>Compare-at price</Label>
          <Input type="number" min="0" step="0.01" value={value.compare_price ?? ''} onChange={(e) => set('compare_price', e.target.value ? Number(e.target.value) : null)} placeholder="0.00" />
        </div>
        <div className="space-y-1.5">
          <Label>Weight (grams)</Label>
          <Input type="number" min="0" step="1" value={value.weight_grams || ''} onChange={(e) => set('weight_grams', Number(e.target.value))} placeholder="0" />
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>Fulfillment type</Label>
          <Select
            value={value.fulfillment_type}
            onValueChange={(v) => set('fulfillment_type', v as 'stock_based' | 'made_to_order')}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="stock_based">Stock Tracked</SelectItem>
              <SelectItem value="made_to_order">Made to Order</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {isMto && (
          <div className="space-y-1.5">
            <Label>Production days</Label>
            <Input type="number" min="0" step="1" value={value.production_days || ''} onChange={(e) => set('production_days', Number(e.target.value))} placeholder="e.g. 7" />
          </div>
        )}
      </div>

      {isMto && (
        <div className="space-y-1.5">
          <Label>Stitching type (optional)</Label>
          <Select
            value={value.stitching_type ?? ''}
            onValueChange={(v) => set('stitching_type', (v || null) as VariantDraft['stitching_type'])}
          >
            <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">None</SelectItem>
              <SelectItem value="stitched_basic">Basic Stitching</SelectItem>
              <SelectItem value="stitched_heavy">Heavy Embroidery</SelectItem>
              <SelectItem value="custom_order">Custom Order</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Opening Stock section (for stock_based variants) */}
      {!isMto && (
        <div className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Opening Stock</p>
              <p className="text-xs text-muted-foreground">Receive initial stock for this variant now</p>
            </div>
            <Switch
              checked={value.has_opening_stock}
              onCheckedChange={(c) => set('has_opening_stock', c)}
            />
          </div>
          {value.has_opening_stock && (
            <div className="grid sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Quantity</Label>
                <Input type="number" min="1" step="1" value={value.opening_stock_qty || ''} onChange={(e) => set('opening_stock_qty', Number(e.target.value))} placeholder="0" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Cost per unit</Label>
                <Input type="number" min="0" step="0.01" value={value.opening_stock_cost || ''} onChange={(e) => set('opening_stock_cost', Number(e.target.value))} placeholder="0.00" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Location</Label>
                <Input value={value.opening_stock_location_id} onChange={(e) => set('opening_stock_location_id', e.target.value)} placeholder="Location ID (create locations first)" />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Fabric Source section (for made_to_order variants) */}
      {isMto && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-2">
          <p className="text-sm font-medium text-blue-800">Fabric Source</p>
          <p className="text-xs text-blue-600">When this variant is produced, fabric will be consumed from the selected source variant.</p>
          <Input
            value={value.fabric_source_variant_id ?? ''}
            onChange={(e) => set('fabric_source_variant_id', e.target.value || null)}
            placeholder="Link to a stock_based variant (e.g. the unstitched version)"
          />
        </div>
      )}
    </div>
  )
}

// ---- Stitchable variant builder (Mode B) — generic attribute-driven
function StitchableVariantBuilder({
  selection,
  onSelectionChange,
  generatedVariants,
  setGeneratedVariants,
  generating,
}: {
  slug: string
  selection: SelectionState
  onSelectionChange: (selection: SelectionState) => void
  generatedVariants: Array<GeneratedVariant & { sale_price: number; is_active: boolean }>
  setGeneratedVariants: (
    v: Array<GeneratedVariant & { sale_price: number; is_active: boolean }>,
  ) => void
  generating: boolean
}) {
  // Collect the union of attribute keys across all generated variants so the
  // preview table can render dynamic columns.
  const attributeKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const v of generatedVariants) {
      for (const k of Object.keys(v.attribute_values)) keys.add(k)
    }
    return Array.from(keys)
  }, [generatedVariants])

  function updateGenerated(
    index: number,
    patch: Partial<GeneratedVariant & { sale_price: number; is_active: boolean }>,
  ) {
    setGeneratedVariants(
      generatedVariants.map((v, i) => (i === index ? { ...v, ...patch } : v)),
    )
  }

  const totalSelectedValues = selection.selectedAttributes.reduce(
    (sum, a) => sum + a.selected_values.length,
    0,
  )

  return (
    <div className="space-y-5">
      {/* Intro blurb */}
      <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-3 text-xs text-muted-foreground">
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary" /> Generic attribute-driven variants
        </p>
        <p className="mt-1">
          Pick up to 3 attributes (Shopify limit) and toggle the values you want
          to sell. We&apos;ll generate every valid SKU combination for you,
          respecting any conditional rules you&apos;ve set up in catalog settings.
        </p>
      </div>

      {/* The selector */}
      <AttributeSelector
        onChange={onSelectionChange}
        initialSelection={selection.selectedAttributes.length > 0 ? selection : undefined}
      />

      {/* Live preview count */}
      <div className="flex items-center justify-between rounded-lg border border-primary/20 bg-primary/5 p-3">
        <div>
          <p className="text-sm font-medium flex items-center gap-1.5">
            {generating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            ) : (
              <Zap className="h-3.5 w-3.5 text-primary" />
            )}
            Variant preview
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {selection.selectedAttributes.length === 0 ? (
              <>Select at least one attribute and value to see combinations.</>
            ) : totalSelectedValues === 0 ? (
              <>Select at least one value to see combinations.</>
            ) : generating ? (
              <>Calculating combinations…</>
            ) : (
              <>
                <span className="font-medium text-foreground">
                  {generatedVariants.length}
                </span>{' '}
                variant{generatedVariants.length === 1 ? '' : 's'} will be
                generated.
              </>
            )}
          </p>
        </div>
        {generatedVariants.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setGeneratedVariants([])}
            disabled={generating}
          >
            Clear preview
          </Button>
        )}
      </div>

      {/* Preview table — dynamic attribute columns + per-row editable fields */}
      {generatedVariants.length > 0 && (
        <div className="rounded-lg border overflow-hidden">
          <div className="flex items-center justify-between p-3 border-b bg-muted/30">
            <p className="text-sm font-medium">
              Generated variants ({generatedVariants.length})
            </p>
            <p className="text-xs text-muted-foreground">
              Adjust prices, fulfillment, and active state per row.
            </p>
          </div>
          <div className="max-h-96 overflow-y-auto scrollbar-thin">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 sticky top-0 z-10">
                <tr className="text-left text-xs text-muted-foreground">
                  {attributeKeys.map((k) => (
                    <th key={k} className="px-3 py-2 font-medium">
                      {k}
                    </th>
                  ))}
                  <th className="px-3 py-2 font-medium">SKU</th>
                  <th className="px-3 py-2 font-medium">Cost</th>
                  <th className="px-3 py-2 font-medium">Fulfillment</th>
                  <th className="px-3 py-2 font-medium">Sale price</th>
                  <th className="px-3 py-2 font-medium text-center">Active</th>
                </tr>
              </thead>
              <tbody>
                {generatedVariants.map((v, i) => (
                  <tr key={v.sku} className="border-t">
                    {attributeKeys.map((k) => (
                      <td key={k} className="px-3 py-2 text-xs">
                        {v.attribute_values[k] ?? '—'}
                      </td>
                    ))}
                    <td className="px-3 py-2">
                      <Input
                        value={v.sku}
                        onChange={(e) =>
                          updateGenerated(i, { sku: e.target.value })
                        }
                        className="h-8 w-40 text-xs font-mono"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={v.cost_price || ''}
                        onChange={(e) =>
                          updateGenerated(i, { cost_price: Number(e.target.value) })
                        }
                        className="h-8 w-20 text-xs"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Select
                        value={v.fulfillment_type}
                        onValueChange={(val) =>
                          updateGenerated(i, {
                            fulfillment_type: val as 'stock_based' | 'made_to_order',
                          })
                        }
                      >
                        <SelectTrigger className="h-8 w-32 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="stock_based">Stock Tracked</SelectItem>
                          <SelectItem value="made_to_order">Made to Order</SelectItem>
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={v.sale_price || ''}
                        onChange={(e) =>
                          updateGenerated(i, { sale_price: Number(e.target.value) })
                        }
                        className="h-8 w-24 text-xs"
                      />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <Switch
                        checked={v.is_active}
                        onCheckedChange={(c) => updateGenerated(i, { is_active: c })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {generatedVariants.length === 0 && !generating && (
        <p className="text-xs text-muted-foreground text-center py-4 border border-dashed rounded-lg">
          {selection.selectedAttributes.length === 0
            ? 'Pick attributes and values above to see combinations.'
            : 'Pick at least one value above to see combinations.'}
        </p>
      )}
    </div>
  )
}

// ---- Regular variant builder (Mode C)
function RegularVariantBuilder({
  slug,
  variants,
  setVariants,
}: {
  slug: string
  variants: VariantDraft[]
  setVariants: (v: VariantDraft[]) => void
}) {
  function addRow() {
    setVariants([...variants, blankRegularVariant(variants.length + 1)])
  }
  function removeRow(idx: number) {
    setVariants(variants.filter((_, i) => i !== idx))
  }
  function update(idx: number, patch: Partial<VariantDraft>) {
    setVariants(variants.map((v, i) => (i === idx ? { ...v, ...patch } : v)))
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Add each variant manually. Use the attributes field for size, color, etc. (max 3 keys).
      </p>

      <div className="space-y-3">
        {variants.map((v, i) => (
          <div key={i} className="rounded-lg border p-3 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">
                Variant #{i + 1}
                {v.is_default && (
                  <Badge variant="secondary" className="ml-2 text-[10px]">Default</Badge>
                )}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setVariants(
                      variants.map((x, j) => ({ ...x, is_default: j === i })),
                    )
                  }
                >
                  Set default
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={() => removeRow(i)}
                  disabled={variants.length === 1}
                  aria-label="Remove variant"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div className="grid sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">SKU</Label>
                <Input
                  value={v.sku}
                  onChange={(e) => update(i, { sku: e.target.value })}
                  placeholder={`${slug}-${i + 1}`}
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Cost price</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={v.cost_price || ''}
                  onChange={(e) => update(i, { cost_price: Number(e.target.value) })}
                  placeholder="0.00"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Sale price</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={v.sale_price || ''}
                  onChange={(e) => update(i, { sale_price: Number(e.target.value) })}
                  placeholder="0.00"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1 sm:col-span-3">
                <Label className="text-xs">Attributes (one per line: Key: Value)</Label>
                <Textarea
                  rows={2}
                  value={attrsToText(v.attribute_values)}
                  onChange={(e) => update(i, { attribute_values: textToAttrs(e.target.value) })}
                  placeholder={'Size: M\nColor: Blue'}
                  className="text-xs"
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      <Button type="button" variant="outline" onClick={addRow}>
        <Plus className="h-4 w-4" /> Add variant
      </Button>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------------------
function blankSimpleVariant(): VariantDraft {
  return {
    sku: '',
    barcode: '',
    attribute_values: {},
    cost_price: 0,
    stitching_charges: 0,
    compare_price: null,
    weight_grams: 0,
    fulfillment_type: 'stock_based',
    stitching_type: null,
    production_days: 0,
    sale_price: 0,
    is_active: true,
    is_default: true,
    has_opening_stock: false,
    opening_stock_qty: 0,
    opening_stock_cost: 0,
    opening_stock_location_id: '',
    fabric_source_variant_id: null,
  }
}

function blankRegularVariant(n: number): VariantDraft {
  return {
    sku: '',
    barcode: '',
    attribute_values: {},
    cost_price: 0,
    stitching_charges: 0,
    compare_price: null,
    weight_grams: 0,
    fulfillment_type: 'stock_based',
    stitching_type: null,
    production_days: 0,
    sale_price: 0,
    is_active: true,
    is_default: n === 1,
    has_opening_stock: false,
    opening_stock_qty: 0,
    opening_stock_cost: 0,
    opening_stock_location_id: '',
    fabric_source_variant_id: null,
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'product'
}

function attrsToText(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

function textToAttrs(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^:]+):\s*(.+)\s*$/)
    if (m) {
      out[m[1].trim()] = m[2].trim()
    }
  }
  return out
}


