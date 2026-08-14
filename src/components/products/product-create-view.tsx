'use client'

import { useCallback, useEffect, useMemo, useRef, useState , memo} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import { useFormGuard } from '@/hooks/form-guard/use-form-guard'
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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
  X,
  Save,
} from 'lucide-react'
import {
  PRODUCT_TYPE_LABELS,
  PRODUCT_SCOPE_LABELS,
  FULFILLMENT_LABELS,
} from '@/lib/constants/fulfillment-types'
import { cn } from '@/lib/utils'
import {
  AttributeSelector,
  type SelectionState,
} from '@/components/products/attribute-selector'
import { ClientSideParentChildVariantTable } from '@/components/products/client-side-parent-child-variant-table'

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
  sale_price: number
  is_active: boolean
  compare_price: number | null
  // Parent-child pricing cascade flags — default true for freshly generated
  // variants; flipped to false when a user overrides an individual child.
  cost_price_synced_with_parent: boolean
  sale_price_synced_with_parent: boolean
  compare_price_synced_with_parent: boolean
  opening_stock_qty?: number
  opening_stock_cost?: number
  opening_stock_location_id?: string
  // Bug 2 fix: track_inventory is a SEPARATE mutable field from
  // fulfillment_type. fulfillment_type never changes (describes HOW the
  // variant is normally fulfilled); track_inventory changes when opening
  // stock is added to a made_to_order variant (flips to true). The badge
  // in the Opening Stock table reads THIS field, not fulfillment_type.
  // Default: stock_based → true, made_to_order → false. Flipped to true
  // optimistically in local state when the user enters Qty > 0 for an MTO
  // variant's opening stock.
  track_inventory: boolean
  // Weight tracking (kg) — mirrors cost_price cascade pattern. Default null
  // (not set); weight_synced_with_parent defaults true.
  weight_kg?: number | null
  weight_synced_with_parent?: boolean
}

interface VariantDraft {
  sku: string
  barcode: string
  attribute_values: Record<string, string>
  cost_price: number
  stitching_charges: number
  compare_price: number | null
  weight_grams: number
  weight_kg: number | null
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
export function ProductCreateView({ onBack, draftId: initialDraftId }: { onBack: () => void; draftId?: string }) {
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
  const [generatedVariants, setGeneratedVariants] = useState<GeneratedVariant[]>([])
  const [generating, setGenerating] = useState(false)

  // Step 2 — regular variable mode
  const [regularVariants, setRegularVariants] = useState<VariantDraft[]>([
    blankRegularVariant(1),
  ])

  // Step 3 state
  const [productScope, setProductScope] = useState<ProductScope>('private')

  // ── Form Guard: dirty-state tracking + save-draft + guard hook ─────────
  const [hasChanges, setHasChanges] = useState(false)
  const markDirty = useCallback(() => { if (!hasChanges) setHasChanges(true) }, [hasChanges])
  const [draftId, setDraftId] = useState<string | undefined>(initialDraftId)

  // Load draft data on mount if a draftId was passed (from the Drafts list "Resume" button)
  useEffect(() => {
    if (!initialDraftId) return
    let cancelled = false
    ;(async () => {
      try {
        const draft = await api.get<{ id: string; draftData: string; draftType: string }>(`/api/drafts?id=${initialDraftId}`)
        if (cancelled || !draft) return
        const data = JSON.parse(draft.draftData) as Record<string, unknown>
        // Pre-fill all form fields from the draft data
        if (typeof data.step === 'number') setStep(data.step)
        if (typeof data.title === 'string') setTitle(data.title)
        if (typeof data.shortDescription === 'string') setShortDescription(data.shortDescription)
        if (typeof data.description === 'string') setDescription(data.description)
        if (typeof data.productType === 'string') setProductType(data.productType as ProductType)
        if (typeof data.categoryId === 'string') setCategoryId(data.categoryId)
        if (typeof data.brandId === 'string') setBrandId(data.brandId)
        if (typeof data.baseSku === 'string') setBaseSku(data.baseSku)
        if (typeof data.isFeatured === 'boolean') setIsFeatured(data.isFeatured)
        if (typeof data.isStitchable === 'boolean') setIsStitchable(data.isStitchable)
        if (data.simpleVariant) setSimpleVariant(data.simpleVariant as VariantDraft)
        if (data.attributeSelection) setAttributeSelection(data.attributeSelection as SelectionState)
        if (Array.isArray(data.generatedVariants)) setGeneratedVariants(data.generatedVariants as GeneratedVariant[])
        if (Array.isArray(data.regularVariants)) setRegularVariants(data.regularVariants as VariantDraft[])
        if (typeof data.productScope === 'string') setProductScope(data.productScope as ProductScope)
        toast.info('Draft loaded — continue editing.')
      } catch {
        if (!cancelled) toast.error('Failed to load draft.')
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDraftId])
  const [savingDraft, setSavingDraft] = useState(false)

  const saveDraft = useCallback(async () => {
    setSavingDraft(true)
    try {
      const result = await api.post<{ draftId: string }>('/api/products/drafts', {
        draftId,
        draftData: {
          step, title, shortDescription, description, productType,
          categoryId, brandId, baseSku, isFeatured, isStitchable,
          simpleVariant, attributeSelection, generatedVariants, regularVariants,
          productScope,
        },
        draftTitle: title || 'Untitled Product Draft',
      })
      if (result.draftId) setDraftId(result.draftId)
      setHasChanges(false) // Reset guard — just saved
    } finally {
      setSavingDraft(false)
    }
  }, [draftId, step, title, shortDescription, description, productType,
      categoryId, brandId, baseSku, isFeatured, isStitchable,
      simpleVariant, attributeSelection, generatedVariants, regularVariants, productScope])

  const { ConfirmModal: formGuardModal, attemptNavigation: guardedNavigate } = useFormGuard({
    isDirty: hasChanges && !submitting,
    onSaveDraft: saveDraft,
  })

  // Reset dirty flag after successful submission
  // (called from the submit handler — see below)

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

  // Scroll to top whenever the step changes (Continue/Back/draft-restore).
  // Without this, navigating to step 3 (Scope & Confirm) leaves the page
  // scrolled to the bottom (where the Continue button was), so the user
  // sees the bottom of the form instead of the top.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [step])

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
        compare_price: g.compare_price,
        weight_grams: 0,
        weight_kg: g.weight_kg ?? null,
        fulfillment_type: g.fulfillment_type as 'stock_based' | 'made_to_order',
        stitching_type: g.stitching_type as VariantDraft['stitching_type'],
        production_days: g.production_days,
        sale_price: g.sale_price,
        is_active: g.is_active,
        is_default: g.is_default,
        // CRITICAL: propagate the user-entered opening stock values from the
        // Mode B preview table — previously these were hardcoded to zero/empty,
        // which silently dropped ALL opening stock for stitchable variants.
        // Only stock_based variants qualify for opening stock. A variant is
        // considered to "have" opening stock when qty > 0 AND a location is
        // selected.
        has_opening_stock:
          g.fulfillment_type === 'stock_based' &&
          !!g.opening_stock_location_id &&
          Number(g.opening_stock_qty ?? 0) > 0,
        opening_stock_qty: Number(g.opening_stock_qty ?? 0),
        opening_stock_cost: Number(g.opening_stock_cost ?? 0),
        opening_stock_location_id: g.opening_stock_location_id ?? '',
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
                compare_price: existing?.compare_price ?? null,
                // Default synced=true for new variants; preserve for existing
                cost_price_synced_with_parent: existing?.cost_price_synced_with_parent ?? true,
                sale_price_synced_with_parent: existing?.sale_price_synced_with_parent ?? true,
                compare_price_synced_with_parent: existing?.compare_price_synced_with_parent ?? true,
                // Preserve opening stock edits across regenerations
                opening_stock_qty: existing?.opening_stock_qty,
                opening_stock_cost: existing?.opening_stock_cost,
                opening_stock_location_id: existing?.opening_stock_location_id,
                // Bug 2 fix: track_inventory defaults based on fulfillment_type
                // (stock_based → true, made_to_order → false). Preserved for
                // existing variants so the user's opening stock entry isn't
                // lost on regeneration.
                track_inventory:
                  existing?.track_inventory ??
                  c.suggested_fulfillment_type === 'stock_based',
                // Weight (kg) — default null (not set); preserved for existing.
                weight_kg: existing?.weight_kg ?? null,
                weight_synced_with_parent: existing?.weight_synced_with_parent ?? true,
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
        weight_kg: v.weight_kg ?? undefined,
        fulfillment_type: v.fulfillment_type,
        stitching_type: v.stitching_type ?? undefined,
        production_days: Number(v.production_days) || 0,
        allow_backorder: false,
        requires_shipping: true,
        is_taxable: true,
        is_active: v.is_active,
        is_default: v.is_default,
        sale_price: Number(v.sale_price) || 0,
        fabric_source_variant_id: v.fabric_source_variant_id || undefined,
      })),
    }

    setSubmitting(true)
    try {
      // 1. Create the product + variants FIRST. We need the real variant UUIDs
      //    returned by the API before we can attach opening stock to them.
      const res = await api.post<{ id: string; slug: string; title: string; variantIds: string[] }>(
        '/api/products',
        payload,
      )

      // 2. Identify variants that have opening stock data filled in. We use
      //    the actual variant UUIDs returned by the API (matched by index).
      //    Each variant can have its OWN location_id now — no more forced
      //    single-location batching.
      const variantsWithOpeningStock = variants
        .map((v, i) => ({ variant: v, variantId: res.variantIds?.[i] }))
        .filter(
          ({ variant, variantId }) =>
            variantId &&
            variant.has_opening_stock &&
            variant.opening_stock_qty > 0 &&
            variant.opening_stock_location_id,
        )

      // 3. Call the dedicated opening-stock endpoint PER VARIANT ROW. Each
      //    call is awaited (not fire-and-forget) so we can surface per-variant
      //    failures clearly. The endpoint wraps processInventoryTransaction()
      //    — the SAME function every other inventory movement uses — so this
      //    produces real inventory_pools + inventory_transactions rows
      //    identical to Receive Stock / PO receiving.
      const failedVariants: Array<{ sku: string; reason: string }> = []
      const succeededVariants: Array<{ sku: string; locationId: string }> = []
      const touchedLocationIds = new Set<string>()

      for (const { variant, variantId } of variantsWithOpeningStock) {
        try {
          const result = await api.post<{
            success: boolean
            transaction_id: string
            location_id: string
          }>('/api/inventory/opening-stock', {
            org_variant_id: variantId,
            location_id: variant.opening_stock_location_id,
            quantity: variant.opening_stock_qty,
            // Cost is set EXACTLY ONCE per variant — via the parent-group
            // cascade or individual override in the grouped pricing table above.
            // The Opening Stock section no longer has its own cost input; it
            // uses the variant's current cost_price directly, so the two can
            // never diverge. See Bug 2 fix.
            cost_per_unit: variant.cost_price,
            notes: `Opening stock for ${res.title}`,
          })
          if (result?.success) {
            succeededVariants.push({ sku: variant.sku, locationId: variant.opening_stock_location_id })
            touchedLocationIds.add(variant.opening_stock_location_id)
          } else {
            failedVariants.push({ sku: variant.sku, reason: 'Unknown error' })
          }
        } catch (err) {
          const reason = err instanceof FetchError ? err.message : 'Network error'
          failedVariants.push({ sku: variant.sku, reason })
        }
      }

      // 4. Surface per-variant failures — NEVER silently drop. The product
      //    was created successfully, but if any opening stock entry failed,
      //    the user MUST see exactly which variant failed and why.
      if (failedVariants.length > 0) {
        const failedList = failedVariants.map((f) => `• ${f.sku}: ${f.reason}`).join('\n')
        toast.error(
          `Opening stock failed for ${failedVariants.length} variant(s):\n${failedList}`,
          { duration: 8000 },
        )
        toast.warning(
          `Product "${res.title}" was created, but ${failedVariants.length} opening stock entr${failedVariants.length === 1 ? 'y' : 'ies'} failed. Use Receive Stock manually to record them.`,
          { duration: 8000 },
        )
      } else if (succeededVariants.length > 0) {
        toast.success(
          `Opening stock recorded for ${succeededVariants.length} variant${succeededVariants.length === 1 ? '' : 's'}.`,
        )
      }

      // 5. Invalidate EVERYTHING that opening stock touches — inventory
      //    dashboard, transactions ledger, product detail (multiple keys
      //    including the pricing tab + inventory tab), per-location views,
      //    and the products list. This guarantees no stale data anywhere.
      queryClient.invalidateQueries({ queryKey: ['products'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-pools'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-transactions'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-dashboard'] })
      queryClient.invalidateQueries({ queryKey: ['product', res.id] })
      queryClient.invalidateQueries({ queryKey: ['product-inventory', res.id] })
      queryClient.invalidateQueries({ queryKey: ['product-inventory-summary', res.id] })
      queryClient.invalidateQueries({ queryKey: ['inventory-locations'] })
      for (const locId of touchedLocationIds) {
        queryClient.invalidateQueries({ queryKey: ['location', locId] })
      }

      toast.success(`"${res.title}" created.`)
      setHasChanges(false) // Reset guard — no false-positive prompt after saving
      // Phase 10: Delete the draft now that the real product is created
      if (draftId) {
        await api.delete(`/api/drafts?id=${draftId}`).catch(() => {})
        setDraftId(undefined)
      }
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
        onClick={() => guardedNavigate(onBack)}
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
                onChange={(e) => { setTitle(e.target.value); markDirty() }}
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
                onChange={(e) => { setBaseSku(e.target.value.toUpperCase().trim()); markDirty() }}
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
                onChange={(e) => { setShortDescription(e.target.value); markDirty() }}
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
                onChange={(e) => { setDescription(e.target.value); markDirty() }}
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
        <Button
          variant="outline"
          onClick={async () => {
            try { await saveDraft(); toast.success('Draft saved.') }
            catch { toast.error('Failed to save draft.') }
          }}
          disabled={submitting || savingDraft}
        >
          {savingDraft ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save Draft
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
      {formGuardModal}
    </div>
  )
}

// ----------------------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------------------
const Row = memo(function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-dashed pb-1.5 last:border-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-medium text-right truncate max-w-[60%]">{value}</dd>
    </div>
  )
})

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
  const navigate = useAppStore((s) => s.navigate)
  const set = <K extends keyof VariantDraft>(key: K, v: VariantDraft[K]) =>
    onChange({ ...value, [key]: v })

  const isMto = value.fulfillment_type === 'made_to_order'

  // Fetch locations for the opening stock dropdown
  const { data: locData } = useQuery<{ locations: Array<{ id: string; name: string; isDefault?: boolean }> }>({
    queryKey: ['inventory-locations'],
    queryFn: () => api.get('/api/inventory-locations'),
    staleTime: 60_000,
  })
  const locations = locData?.locations ?? []
  const noLocations = locations.length === 0

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
        <div className="space-y-1.5">
          <Label>Weight (kg)</Label>
          <Input type="number" min="0" step="0.001" value={value.weight_kg ?? ''} onChange={(e) => set('weight_kg', e.target.value ? Number(e.target.value) : null)} placeholder="0.000" />
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

      {/* Opening Stock section — shown for stock_based variants, OR for
          made_to_order variants once the user explicitly confirms they want
          to hold pre-made bulk stock (which also flips track_inventory on). */}
      {(!isMto || value.has_opening_stock) && (
        <div className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">
                {isMto ? 'Pre-made Bulk Stock' : 'Opening Stock'}
              </p>
              <p className="text-xs text-muted-foreground">
                {isMto
                  ? 'Record pre-made stock for this made-to-order variant. Inventory tracking will be enabled.'
                  : 'Receive initial stock for this variant now'}
              </p>
            </div>
            <Switch
              checked={value.has_opening_stock}
              onCheckedChange={(c) =>
                set('has_opening_stock', c)
              }
            />
          </div>
          {value.has_opening_stock && noLocations && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>No warehouse locations found</AlertTitle>
              <AlertDescription>
                You need at least one inventory location before you can record opening stock.{' '}
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
          {value.has_opening_stock && (
            <div className="grid sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Quantity</Label>
                <Input type="number" min="1" step="1" value={value.opening_stock_qty || ''} onChange={(e) => set('opening_stock_qty', Number(e.target.value))} placeholder="0" />
              </div>
              {/* Cost — read-only reference (Bug 2 fix). Set via the cost_price field above. */}
              <div className="space-y-1.5">
                <Label className="text-xs">Cost per unit</Label>
                <div className="h-9 flex items-center px-3 rounded-md border bg-muted/30 text-xs text-muted-foreground">
                  Rs. {Number(value.cost_price || 0).toLocaleString()}{' '}
                  <span className="text-[10px] text-muted-foreground/70 ml-1">(set above)</span>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Location</Label>
                <Select
                  value={value.opening_stock_location_id}
                  onValueChange={(v) => set('opening_stock_location_id', v)}
                >
                  <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Select location" /></SelectTrigger>
                  <SelectContent>
                    {locations.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.name}
                        {l.isDefault ? ' (default)' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>
      )}

      {/* MTO confirmation CTA — only shown when MTO and the user hasn't
          yet opted in to pre-made bulk stock. */}
      {isMto && !value.has_opening_stock && (
        <div className="rounded-lg border border-purple-200 bg-purple-50 p-3 space-y-2">
          <p className="text-xs text-purple-800">
            This is a made-to-order variant. If you also want to hold pre-made bulk stock, you can record opening stock — inventory tracking will be enabled for this variant.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={noLocations}
            onClick={() => {
              set('has_opening_stock', true)
              if (!value.opening_stock_location_id) {
                set('opening_stock_location_id', locations.find((l) => l.isDefault)?.id ?? locations[0]?.id ?? '')
              }
            }}
          >
            + Add pre-made bulk stock
          </Button>
        </div>
      )}

      {/* Fabric Source section (for made_to_order variants) */}
      {isMto && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-2">
          <p className="text-sm font-medium text-blue-800">Fabric Source</p>
          <p className="text-xs text-blue-600">When this variant is produced, fabric will be consumed from the selected source variant. Leave blank if not applicable.</p>
          <Input
            value={value.fabric_source_variant_id ?? ''}
            onChange={(e) => set('fabric_source_variant_id', e.target.value || null)}
            placeholder="Variant UUID of the stock_based fabric source (set after product creation)"
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
  generatedVariants: GeneratedVariant[]
  setGeneratedVariants: (v: GeneratedVariant[]) => void
  generating: boolean
}) {
  // Fetch real warehouse locations for the active company/org — same query the
  // Receive Stock page uses, so the opening stock dropdown is always in sync
  // with the actual location catalog.
  const navigate = useAppStore((s) => s.navigate)
  const { data: locData } = useQuery<{
    locations: Array<{ id: string; name: string; isDefault?: boolean }>
  }>({
    queryKey: ['inventory-locations'],
    queryFn: () => api.get('/api/inventory-locations'),
    staleTime: 60_000,
  })
  const locations = locData?.locations ?? []
  const noLocations = locations.length === 0

  function updateGenerated(
    index: number,
    patch: Partial<GeneratedVariant>,
  ) {
    setGeneratedVariants(
      generatedVariants.map((v, i) => (i === index ? { ...v, ...patch } : v)),
    )
  }

  const totalSelectedValues = selection.selectedAttributes.reduce(
    (sum, a) => sum + a.selected_values.length,
    0,
  )

  // Map SelectionState attributes to the GroupableAttribute shape expected by
  // the ClientSideParentChildVariantTable (which uses the shared grouping utility).
  const groupableAttributes = selection.selectedAttributes.map((a) => ({
    attribute_id: a.attribute_id,
    name: a.attribute_name,
    display_order: a.display_order,
  }))

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

      {/* Grouped / flat variant table — uses the SAME shared grouping
          utility as the edit page's ParentChildVariantTable. When 2+ attributes
          are selected, renders collapsible parent-group cards with cost/sale
          price cascade + per-child override/re-sync. When <2 attributes,
          renders the flat preview table. All state changes are local (no
          network calls) until the wizard's final submit. */}
      {generatedVariants.length > 0 && (
        <ClientSideParentChildVariantTable
          variants={generatedVariants}
          selectedAttributes={groupableAttributes}
          onVariantsChange={setGeneratedVariants}
        />
      )}

      {/* ── Opening Stock section — compact table, one top-level note ──
          Bug 2 fix: cost is NOT entered here — it's shown as a read-only
          reference (the variant's current cost_price from the grouped
          pricing table above). The submit handler passes cost_price
          directly to createOpeningStockForNewVariant(), so the two can
          never diverge.
          Bug 3 fix: rebuilt as a compact table (not stacked cards) with
          ONE explanatory note at the top (not per-row). Made-to-order
          variants are collapsed by default with a [+ Add stock] button
          that expands just that row inline. */}
      {generatedVariants.length > 0 && (
        <OpeningStockTable
          variants={generatedVariants}
          locations={locations}
          noLocations={noLocations}
          onChange={setGeneratedVariants}
          onNavigateLocations={() => navigate({ name: 'inventory-locations' })}
        />
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
              <div className="space-y-1">
                <Label className="text-xs">Weight (kg)</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.001"
                  value={v.weight_kg ?? ''}
                  onChange={(e) => update(i, { weight_kg: e.target.value ? Number(e.target.value) : null })}
                  placeholder="0.000"
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

            {/* Opening stock (compact, per variant) */}
            <RegularVariantOpeningStock
              variant={v}
              onChange={(patch) => update(i, patch)}
            />
          </div>
        ))}
      </div>

      <Button type="button" variant="outline" onClick={addRow}>
        <Plus className="h-4 w-4" /> Add variant
      </Button>
    </div>
  )
}

/**
 * Compact opening-stock sub-component used inside the RegularVariantBuilder
 * (Mode C). Reuses the same TanStack Query for locations and the same
 * "No locations" banner pattern as the rest of the inventory frontend.
 */
function RegularVariantOpeningStock({
  variant,
  onChange,
}: {
  variant: VariantDraft
  onChange: (patch: Partial<VariantDraft>) => void
}) {
  const navigate = useAppStore((s) => s.navigate)
  const { data: locData } = useQuery<{
    locations: Array<{ id: string; name: string; isDefault?: boolean }>
  }>({
    queryKey: ['inventory-locations'],
    queryFn: () => api.get('/api/inventory-locations'),
    staleTime: 60_000,
  })
  const locations = locData?.locations ?? []
  const noLocations = locations.length === 0
  const isMto = variant.fulfillment_type === 'made_to_order'
  const mtoBulkConfirmed = variant.has_opening_stock

  return (
    <div className="rounded-md border bg-muted/20 p-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium">Opening stock</p>
        <Switch
          checked={variant.has_opening_stock}
          onCheckedChange={(c) =>
            onChange({
              has_opening_stock: c,
              ...(c
                ? {
                    opening_stock_location_id:
                      variant.opening_stock_location_id ||
                      (locations.find((l) => l.isDefault)?.id ?? locations[0]?.id ?? ''),
                  }
                : {}),
            })
          }
        />
      </div>
      {noLocations && variant.has_opening_stock && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>No warehouse locations found</AlertTitle>
          <AlertDescription>
            You need at least one inventory location before you can record opening stock.{' '}
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
      {variant.has_opening_stock && (
        <div className="grid sm:grid-cols-3 gap-2">
          <div className="space-y-1">
            <Label className="text-[10px]">Quantity</Label>
            <Input
              type="number"
              min="1"
              step="1"
              value={variant.opening_stock_qty || ''}
              onChange={(e) => onChange({ opening_stock_qty: Number(e.target.value) })}
              placeholder="0"
              className="h-8 text-xs"
            />
          </div>
          {/* Cost — read-only reference (Bug 2 fix). Set via the cost_price field in the row above. */}
          <div className="space-y-1">
            <Label className="text-[10px]">Cost per unit</Label>
            <div className="h-8 flex items-center px-3 rounded-md border bg-muted/30 text-[10px] text-muted-foreground">
              Rs. {Number(variant.cost_price || 0).toLocaleString()}{' '}
              <span className="text-[9px] text-muted-foreground/70 ml-1">(set above)</span>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px]">Location</Label>
            <Select
              value={variant.opening_stock_location_id}
              onValueChange={(val) => onChange({ opening_stock_location_id: val })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Select location" />
              </SelectTrigger>
              <SelectContent>
                {locations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                    {l.isDefault ? ' (default)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
      {variant.has_opening_stock && isMto && mtoBulkConfirmed && (
        <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          This made-to-order variant will have inventory tracking enabled once the opening stock is recorded.
        </p>
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------
// OpeningStockTable — compact table for the wizard's Opening Stock section
// (Bug 2 + Bug 3 fix). Cost is read-only (set via the grouped pricing table
// above); made-to-order variants collapse to a [+ Add stock] button.
// ----------------------------------------------------------------------------
const OpeningStockTable = memo(function OpeningStockTable({
  variants,
  locations,
  noLocations,
  onChange,
  onNavigateLocations,
}: {
  variants: GeneratedVariant[]
  locations: Array<{ id: string; name: string; isDefault?: boolean }>
  noLocations: boolean
  onChange: (v: GeneratedVariant[]) => void
  onNavigateLocations: () => void
}) {
  // Track which MTO rows are expanded (by SKU). Stock_based rows are always
  // "expanded" (inputs always visible) since they're the primary use case.
  const [expandedMtoSkus, setExpandedMtoSkus] = useState<Set<string>>(new Set())

  function toggleMtoExpand(sku: string) {
    setExpandedMtoSkus((prev) => {
      const next = new Set(prev)
      if (next.has(sku)) {
        next.delete(sku)
        // Discard any unsaved entry on collapse — also revert track_inventory
        // to false since no stock will be recorded for this MTO variant.
        onChange(
          variants.map((v) =>
            v.sku === sku
              ? {
                  ...v,
                  opening_stock_qty: 0,
                  opening_stock_location_id: '',
                  track_inventory: v.fulfillment_type === 'stock_based',
                }
              : v,
          ),
        )
      } else {
        next.add(sku)
        // Pre-fill the default location on expand
        const defaultLoc = locations.find((l) => l.isDefault)?.id ?? locations[0]?.id ?? ''
        onChange(
          variants.map((v) =>
            v.sku === sku && !v.opening_stock_location_id
              ? { ...v, opening_stock_location_id: defaultLoc }
              : v,
          ),
        )
      }
      return next
    })
  }

  function updateVariant(sku: string, patch: Partial<GeneratedVariant>) {
    // Bug 2 fix: when opening_stock_qty changes for a made_to_order variant,
    // optimistically flip track_inventory in local state so the badge updates
    // live in the wizard. If Qty is cleared back to 0, revert track_inventory
    // to false (since no stock will actually be recorded for it).
    const target = variants.find((v) => v.sku === sku)
    const isMto = target?.fulfillment_type === 'made_to_order'
    const finalPatch = { ...patch }
    if (isMto && 'opening_stock_qty' in patch) {
      const newQty = Number(patch.opening_stock_qty ?? 0)
      finalPatch.track_inventory = newQty > 0
    }
    onChange(variants.map((v) => (v.sku === sku ? { ...v, ...finalPatch } : v)))
  }

  function applyDefaultLocationToAll() {
    const defaultLoc = locations.find((l) => l.isDefault)?.id ?? locations[0]?.id
    if (!defaultLoc) return
    // Apply to every row that currently has an active Qty entry OR is a
    // stock_based variant (whose inputs are always visible).
    onChange(
      variants.map((v) => {
        const hasActiveQty = Number(v.opening_stock_qty ?? 0) > 0
        if (v.fulfillment_type === 'stock_based' || hasActiveQty) {
          return { ...v, opening_stock_location_id: defaultLoc }
        }
        return v
      }),
    )
  }

  return (
    <div className="rounded-lg border overflow-hidden">
      {/* Header — ONE explanatory note for the whole section (Bug 3 fix) */}
      <div className="p-3 border-b bg-muted/30 space-y-2">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="space-y-1">
            <p className="text-sm font-medium">Opening Stock</p>
            <p className="text-xs text-muted-foreground">
              Made-to-order variants don&apos;t hold stock by default. If you have pre-made bulk stock for any of them, you can add it below — this will enable inventory tracking for that specific variant.
            </p>
          </div>
          {locations.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs shrink-0"
              onClick={applyDefaultLocationToAll}
            >
              Use default location for all
            </Button>
          )}
        </div>
        {noLocations && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>No warehouse locations found</AlertTitle>
            <AlertDescription>
              You need at least one inventory location before you can record opening stock.{' '}
              <button
                type="button"
                className="font-medium underline underline-offset-4 hover:text-primary"
                onClick={onNavigateLocations}
              >
                Create a location
              </button>{' '}
              first.
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Compact table — one row per variant */}
      <div className="max-h-80 overflow-y-auto scrollbar-thin">
        <Table>
          <TableHeader>
            <TableRow className="text-left text-xs text-muted-foreground">
              <TableHead className="px-3 py-2 font-medium">Variant</TableHead>
              <TableHead className="px-3 py-2 font-medium">Type</TableHead>
              <TableHead className="px-3 py-2 font-medium text-right">Qty</TableHead>
              <TableHead className="px-3 py-2 font-medium text-right">Cost</TableHead>
              <TableHead className="px-3 py-2 font-medium">Location</TableHead>
              <TableHead className="px-3 py-2 font-medium text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {variants.map((v) => {
              const isMto = v.fulfillment_type === 'made_to_order'
              const isExpanded = !isMto || expandedMtoSkus.has(v.sku)
              const attrLabel = Object.values(v.attribute_values).join(' / ') || v.sku
              return (
                <TableRow key={v.sku} className="text-xs">
                  <TableCell className="px-3 py-2">
                    <div className="flex flex-col">
                      <span className="font-mono font-medium">{v.sku}</span>
                      <span className="text-[10px] text-muted-foreground">{attrLabel}</span>
                    </div>
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    {/* Bug 2 fix: badge reads track_inventory (mutable), NOT
                        fulfillment_type (immutable). A made_to_order variant
                        with opening stock added shows "Stock Tracked" because
                        track_inventory is now true. */}
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-[9px]',
                        v.track_inventory
                          ? 'bg-sky-50 text-sky-700 border-sky-200'
                          : 'bg-purple-50 text-purple-700 border-purple-200',
                      )}
                    >
                      {v.track_inventory
                        ? FULFILLMENT_LABELS.stock_based
                        : FULFILLMENT_LABELS.made_to_order}
                    </Badge>
                  </TableCell>
                  {/* Qty — visible only when row is expanded */}
                  <TableCell className="px-3 py-2 text-right">
                    {isExpanded ? (
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        placeholder="0"
                        className="h-7 w-16 text-xs text-right ml-auto"
                        value={v.opening_stock_qty ?? ''}
                        onChange={(e) =>
                          updateVariant(v.sku, { opening_stock_qty: Number(e.target.value) })
                        }
                      />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  {/* Cost — READ-ONLY reference (Bug 2 fix). Never editable here. */}
                  <TableCell className="px-3 py-2 text-right">
                    <span className="text-xs text-muted-foreground">
                      Rs. {Number(v.cost_price || 0).toLocaleString()}
                      <span className="block text-[9px] text-muted-foreground/70">(set above)</span>
                    </span>
                  </TableCell>
                  {/* Location — visible only when row is expanded */}
                  <TableCell className="px-3 py-2">
                    {isExpanded ? (
                      <Select
                        value={v.opening_stock_location_id ?? ''}
                        onValueChange={(val) =>
                          updateVariant(v.sku, { opening_stock_location_id: val })
                        }
                      >
                        <SelectTrigger className="h-7 w-36 text-xs">
                          <SelectValue placeholder="Location" />
                        </SelectTrigger>
                        <SelectContent>
                          {locations.map((l) => (
                            <SelectItem key={l.id} value={l.id}>
                              {l.name}
                              {l.isDefault ? ' (default)' : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  {/* Action — expand/collapse for MTO; nothing for stock_based */}
                  <TableCell className="px-3 py-2 text-right">
                    {isMto ? (
                      isExpanded ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-muted-foreground"
                          onClick={() => toggleMtoExpand(v.sku)}
                          title="Remove opening stock for this variant"
                        >
                          <X className="h-3 w-3" /> Remove
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={noLocations}
                          onClick={() => toggleMtoExpand(v.sku)}
                          title="Add pre-made bulk stock for this made-to-order variant"
                        >
                          <Plus className="h-3 w-3" /> Add stock
                        </Button>
                      )
                    ) : (
                      <span className="text-[10px] text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
})

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
    weight_kg: null,
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
    weight_kg: null,
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


