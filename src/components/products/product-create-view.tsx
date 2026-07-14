'use client'

import { useEffect, useMemo, useState } from 'react'
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
import { Checkbox } from '@/components/ui/checkbox'
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
} from 'lucide-react'
import {
  FULFILLMENT_LABELS,
  PRODUCT_TYPE_LABELS,
  PRODUCT_SCOPE_LABELS,
  STITCHING_LABELS,
  STANDARD_SIZES,
  DEFAULT_PRODUCTION_DAYS,
} from '@/lib/constants/fulfillment-types'
import { cn } from '@/lib/utils'

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
}

type ProductType = 'simple' | 'variable' | 'bundle' | 'service'
type ProductScope = 'private' | 'organization' | 'selective'

const STEPS = ['Basic Details', 'Variants & Pricing', 'Scope & Confirm'] as const

const STITCHING_OPTIONS: Array<{
  key: 'stitched_basic' | 'stitched_heavy' | 'custom_order'
  label: string
  icon: typeof Scissors
  description: string
}> = [
  {
    key: 'stitched_basic',
    label: 'Basic Stitching',
    icon: Scissors,
    description: 'Standard fit & finish for everyday wear.',
  },
  {
    key: 'stitched_heavy',
    label: 'Heavy Embroidery',
    icon: Shirt,
    description: 'Intricate embroidery work for formal pieces.',
  },
  {
    key: 'custom_order',
    label: 'Custom Order',
    icon: Package,
    description: 'Bespoke tailoring with measurements on file.',
  },
]

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

  // Step 2 — stitchable mode
  const [includeUnstitched, setIncludeUnstitched] = useState(true)
  const [baseFabricCost, setBaseFabricCost] = useState<number>(0)
  const [includeSizes, setIncludeSizes] = useState(false)
  const [selectedSizes, setSelectedSizes] = useState<string[]>([])
  const [customSizes, setCustomSizes] = useState<string[]>([])
  const [customSizeInput, setCustomSizeInput] = useState('')
  const [stitchingTypes, setStitchingTypes] = useState<
    Array<{
      type: 'stitched_basic' | 'stitched_heavy' | 'custom_order'
      enabled: boolean
      charge: number
      productionDays: number
    }>
  >([
    { type: 'stitched_basic', enabled: true, charge: 0, productionDays: DEFAULT_PRODUCTION_DAYS.stitched_basic },
    { type: 'stitched_heavy', enabled: false, charge: 0, productionDays: DEFAULT_PRODUCTION_DAYS.stitched_heavy },
    { type: 'custom_order', enabled: false, charge: 0, productionDays: DEFAULT_PRODUCTION_DAYS.custom_order },
  ])
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
          return 'Generate at least one variant using the “Generate Variants” button.'
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
      if (isStitchable && productType === 'variable') {
        if (stitchingTypes.every((s2) => !s2.enabled)) {
          return 'Enable at least one stitching type.'
        }
        if (includeUnstitched && (!baseFabricCost || baseFabricCost < 0)) {
          return 'Enter the unstitched fabric cost.'
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

  // ---- Stitchable: generate variants via API
  async function generateVariants() {
    setSubmitError(null)
    const enabledTypes = stitchingTypes.filter((s) => s.enabled).map((s) => s.type)
    if (enabledTypes.length === 0) {
      setSubmitError('Enable at least one stitching type.')
      return
    }
    if (includeUnstitched && (!baseFabricCost || baseFabricCost < 0)) {
      setSubmitError('Enter the unstitched fabric cost.')
      return
    }
    setGenerating(true)
    try {
      const sizes = includeSizes ? [...selectedSizes, ...customSizes] : []
      const res = await api.post<{ variants: GeneratedVariant[] }>(
        '/api/products/generate-stitched',
        {
          product_slug: slug,
          base_sku: baseSku.trim() || undefined,
          sizes,
          stitching_types: enabledTypes,
          base_fabric_cost: Number(baseFabricCost) || 0,
          base_stitching: stitchingTypes.find((s) => s.type === 'stitched_basic')?.charge ?? 0,
          heavy_stitching: stitchingTypes.find((s) => s.type === 'stitched_heavy')?.charge ?? 0,
          custom_stitching: stitchingTypes.find((s) => s.type === 'custom_order')?.charge ?? 0,
          include_unstitched: includeUnstitched,
        },
      )
      // Default sale price = cost + 30% markup so the user has a starting point
      setGeneratedVariants(
        res.variants.map((v) => ({
          ...v,
          sale_price: Math.ceil((v.cost_price * 1.3) * 100) / 100,
          is_active: true,
        })),
      )
      toast.success(`${res.variants.length} variants generated.`)
    } catch (err) {
      const msg =
        err instanceof FetchError ? err.message : 'Failed to generate variants.'
      setSubmitError(msg)
      toast.error(msg)
    } finally {
      setGenerating(false)
    }
  }

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
      stitching_base_price:
        isStitchable && productType === 'variable' ? Number(baseFabricCost) || 0 : 0,
      has_size_variants:
        isStitchable && productType === 'variable'
          ? includeSizes && (selectedSizes.length + customSizes.length) > 0
          : false,
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
      queryClient.invalidateQueries({ queryKey: ['products'] })
      toast.success(`“${res.title}” created.`)
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

            {/* Mode B: Stitchable variable product */}
            {productType === 'variable' && isStitchable && (
              <StitchableVariantBuilder
                slug={slug}
                includeUnstitched={includeUnstitched}
                setIncludeUnstitched={setIncludeUnstitched}
                baseFabricCost={baseFabricCost}
                setBaseFabricCost={setBaseFabricCost}
                includeSizes={includeSizes}
                setIncludeSizes={setIncludeSizes}
                selectedSizes={selectedSizes}
                setSelectedSizes={setSelectedSizes}
                customSizes={customSizes}
                setCustomSizes={setCustomSizes}
                customSizeInput={customSizeInput}
                setCustomSizeInput={setCustomSizeInput}
                stitchingTypes={stitchingTypes}
                setStitchingTypes={setStitchingTypes}
                generatedVariants={generatedVariants}
                setGeneratedVariants={setGeneratedVariants}
                generating={generating}
                onGenerate={generateVariants}
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
    </div>
  )
}

// ---- Stitchable variant builder (Mode B)
function StitchableVariantBuilder({
  slug,
  includeUnstitched,
  setIncludeUnstitched,
  baseFabricCost,
  setBaseFabricCost,
  includeSizes,
  setIncludeSizes,
  selectedSizes,
  setSelectedSizes,
  customSizes,
  setCustomSizes,
  customSizeInput,
  setCustomSizeInput,
  stitchingTypes,
  setStitchingTypes,
  generatedVariants,
  setGeneratedVariants,
  generating,
  onGenerate,
}: {
  slug: string
  includeUnstitched: boolean
  setIncludeUnstitched: (v: boolean) => void
  baseFabricCost: number
  setBaseFabricCost: (v: number) => void
  includeSizes: boolean
  setIncludeSizes: (v: boolean) => void
  selectedSizes: string[]
  setSelectedSizes: (v: string[]) => void
  customSizes: string[]
  setCustomSizes: (v: string[]) => void
  customSizeInput: string
  setCustomSizeInput: (v: string) => void
  stitchingTypes: Array<{
    type: 'stitched_basic' | 'stitched_heavy' | 'custom_order'
    enabled: boolean
    charge: number
    productionDays: number
  }>
  setStitchingTypes: (v: StitchableVariantBuilderPropsArg) => void
  generatedVariants: Array<GeneratedVariant & { sale_price: number; is_active: boolean }>
  setGeneratedVariants: (v: Array<GeneratedVariant & { sale_price: number; is_active: boolean }>) => void
  generating: boolean
  onGenerate: () => void
}) {
  function toggleSize(size: string) {
    if (selectedSizes.includes(size)) {
      setSelectedSizes(selectedSizes.filter((s) => s !== size))
    } else {
      setSelectedSizes([...selectedSizes, size])
    }
  }
  function addCustomSize() {
    const s = customSizeInput.trim().toUpperCase()
    if (!s) return
    if ([...STANDARD_SIZES, ...customSizes].includes(s)) {
      setCustomSizeInput('')
      return
    }
    setCustomSizes([...customSizes, s])
    setCustomSizeInput('')
  }
  function toggleStitchingType(t: 'stitched_basic' | 'stitched_heavy' | 'custom_order') {
    setStitchingTypes(
      stitchingTypes.map((s) =>
        s.type === t ? { ...s, enabled: !s.enabled } : s,
      ),
    )
  }
  function setStitchingCharge(t: 'stitched_basic' | 'stitched_heavy' | 'custom_order', charge: number) {
    setStitchingTypes(
      stitchingTypes.map((s) => (s.type === t ? { ...s, charge } : s)),
    )
  }
  function setStitchingDays(t: 'stitched_basic' | 'stitched_heavy' | 'custom_order', days: number) {
    setStitchingTypes(
      stitchingTypes.map((s) => (s.type === t ? { ...s, productionDays: days } : s)),
    )
  }

  function updateGenerated(
    index: number,
    patch: Partial<GeneratedVariant & { sale_price: number; is_active: boolean }>,
  ) {
    setGeneratedVariants(
      generatedVariants.map((v, i) => (i === index ? { ...v, ...patch } : v)),
    )
  }

  return (
    <div className="space-y-5">
      {/* Top toggles */}
      <div className="grid sm:grid-cols-2 gap-4">
        <ToggleRow
          label="Include unstitched option?"
          description="A standalone fabric SKU with no stitching."
          checked={includeUnstitched}
          onChange={setIncludeUnstitched}
          icon={Shirt}
        />
        <div className={cn('rounded-lg border p-3 space-y-2', !includeUnstitched && 'opacity-50 pointer-events-none')}>
          <Label>Unstitched fabric cost</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={baseFabricCost || ''}
            onChange={(e) => setBaseFabricCost(Number(e.target.value))}
            placeholder="0.00"
          />
          <p className="text-xs text-muted-foreground">Base cost used for all generated variants.</p>
        </div>
      </div>

      <ToggleRow
        label="Include size variants?"
        description="Generate size-specific SKUs (S, M, L, etc)."
        checked={includeSizes}
        onChange={setIncludeSizes}
        icon={Tag}
      />

      {includeSizes && (
        <div className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Sizes</p>
            <p className="text-xs text-muted-foreground">
              {selectedSizes.length + customSizes.length} selected
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {STANDARD_SIZES.map((s) => {
              const active = selectedSizes.includes(s)
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleSize(s)}
                  className={cn(
                    'h-9 min-w-9 px-3 rounded-md border text-sm font-medium transition-colors',
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border hover:border-primary/40 hover:bg-muted/40',
                  )}
                >
                  {s}
                </button>
              )
            })}
            {customSizes.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setCustomSizes(customSizes.filter((x) => x !== s))}
                className="h-9 px-3 rounded-md border border-primary bg-primary text-primary-foreground text-sm font-medium inline-flex items-center gap-1.5"
              >
                {s}
                <span className="text-primary-foreground/70">×</span>
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              value={customSizeInput}
              onChange={(e) => setCustomSizeInput(e.target.value)}
              placeholder="Custom size (e.g. 38, M-Tall)"
              className="max-w-xs"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addCustomSize()
                }
              }}
            />
            <Button type="button" variant="outline" onClick={addCustomSize}>
              <Plus className="h-4 w-4" /> Add size
            </Button>
          </div>
        </div>
      )}

      {/* Stitching types */}
      <div className="rounded-lg border p-4 space-y-3">
        <p className="text-sm font-medium">Stitching types</p>
        <p className="text-xs text-muted-foreground">
          Pick the stitching options customers can choose from. Each gets its own SKU(s).
        </p>
        <div className="space-y-3">
          {STITCHING_OPTIONS.map((opt) => {
            const cfg = stitchingTypes.find((s) => s.type === opt.key)!
            return (
              <div
                key={opt.key}
                className={cn(
                  'rounded-md border p-3 transition-colors',
                  cfg.enabled ? 'border-primary/40 bg-primary/5' : 'border-border',
                )}
              >
                <div className="flex items-start gap-3">
                  <Checkbox
                    checked={cfg.enabled}
                    onCheckedChange={() => toggleStitchingType(opt.key)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <opt.icon className="h-4 w-4 text-muted-foreground" />
                      <p className="text-sm font-medium">{opt.label}</p>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {opt.description}
                    </p>
                    {cfg.enabled && (
                      <div className="grid sm:grid-cols-2 gap-3 mt-3">
                        <div className="space-y-1">
                          <Label className="text-xs">Stitching charge</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={cfg.charge || ''}
                            onChange={(e) => setStitchingCharge(opt.key, Number(e.target.value))}
                            placeholder="0.00"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Production days</Label>
                          <Input
                            type="number"
                            min="0"
                            step="1"
                            value={cfg.productionDays || ''}
                            onChange={(e) => setStitchingDays(opt.key, Number(e.target.value))}
                            placeholder="e.g. 7"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Generate */}
      <div className="flex items-center justify-between rounded-lg border border-primary/20 bg-primary/5 p-3">
        <div>
          <p className="text-sm font-medium">Generate variants</p>
          <p className="text-xs text-muted-foreground">
            Creates SKU combinations from your selections.
          </p>
        </div>
        <Button onClick={onGenerate} disabled={generating}>
          {generating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Zap className="h-4 w-4" />
          )}
          Generate Variants
        </Button>
      </div>

      {/* Preview table */}
      {generatedVariants.length > 0 && (
        <div className="rounded-lg border overflow-hidden">
          <div className="flex items-center justify-between p-3 border-b bg-muted/30">
            <p className="text-sm font-medium">
              Generated variants ({generatedVariants.length})
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setGeneratedVariants([])}
            >
              Clear
            </Button>
          </div>
          <div className="max-h-96 overflow-y-auto scrollbar-thin">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 sticky top-0 z-10">
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Piece type</th>
                  <th className="px-3 py-2 font-medium">Size</th>
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
                    <td className="px-3 py-2 text-xs">
                      {v.attribute_values['Piece Type'] ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {v.attribute_values['Size'] ?? '—'}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{v.sku}</td>
                    <td className="px-3 py-2 text-xs">
                      <div>{formatMoney(v.cost_price)}</div>
                      <div className="text-[10px] text-muted-foreground">
                        fabric {formatMoney(v.cost_price - v.stitching_charges)} + stitching {formatMoney(v.stitching_charges)}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <FulfillmentBadge type={v.fulfillment_type} />
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

      {generatedVariants.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-4 border border-dashed rounded-lg">
          No variants generated yet. Click <span className="font-medium">Generate Variants</span> above.
        </p>
      )}
    </div>
  )
}

type StitchableVariantBuilderPropsArg = Array<{
  type: 'stitched_basic' | 'stitched_heavy' | 'custom_order'
  enabled: boolean
  charge: number
  productionDays: number
}>

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

function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n)
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

// Reused badge for fulfillment type
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
