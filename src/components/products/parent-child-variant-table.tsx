'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, FetchError } from '@/lib/api-client'
import { useCan } from '@/stores/app-store'
import { PERMISSIONS } from '@/lib/permissions'
import { FulfillmentTypeBadge } from '@/components/products/fulfillment-type-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ChevronDown,
  ChevronRight,
  Link2,
  Unlink,
  RefreshCw,
  Loader2,
  AlertCircle,
  Check,
  Pencil,
  Star,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────
interface ChildVariant {
  variantId: string
  sku: string
  barcode: string | null
  attributeValues: Record<string, string>
  costPrice: number
  costPriceSyncedWithParent: boolean
  fulfillmentType: string
  isActive: boolean
  isDefault: boolean
  salePrice: number | null
  comparePrice: number | null
  salePriceSyncedWithParent: boolean
  comparePriceSyncedWithParent: boolean
  pricingId: string | null
  // Edit dialog fields
  weightGrams?: number
  stitchingCharges?: number
  productionDays?: number
  isTaxable?: boolean
  requiresShipping?: boolean
  inventoryPolicy?: string
  stitchingType?: string | null
}

interface VariantGroup {
  parentValue: string
  childCount: number
  children: ChildVariant[]
}

interface VariantGroupsResponse {
  parentAttributeName: string | null
  parentAttributeDisplayName: string | null
  hasMultipleAttributes: boolean
  groups: VariantGroup[]
}

// ──────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────
export function ParentChildVariantTable({
  productId,
  mode = 'both',
}: {
  productId: string
  mode?: 'cost' | 'pricing' | 'both'
}) {
  const can = useCan()
  const queryClient = useQueryClient()
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [editingVariant, setEditingVariant] = useState<ChildVariant | null>(null)

  const canEditCost = can(PERMISSIONS.PRODUCTS_EDIT)
  const canEditPrice = can(PERMISSIONS.PRODUCTS_PRICING)
  const showCost = mode === 'cost' || mode === 'both'
  const showPricing = mode === 'pricing' || mode === 'both'

  const { data, isLoading, isError, refetch } = useQuery<VariantGroupsResponse>({
    queryKey: ['variant-groups', productId],
    queryFn: () => api.get(`/api/products/${productId}/variant-groups`),
    staleTime: 15_000,
  })

  function toggleGroup(parentValue: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(parentValue)) next.delete(parentValue)
      else next.add(parentValue)
      return next
    })
  }

  // Expand all groups by default on first load
  if (data && expandedGroups.size === 0 && data.groups.length > 0) {
    setExpandedGroups(new Set(data.groups.map((g) => g.parentValue)))
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 rounded bg-muted/50 animate-pulse" />
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
          <p className="text-sm text-muted-foreground mb-3">Failed to load variant groups.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
        </CardContent>
      </Card>
    )
  }

  if (!data || data.groups.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          No variants found for this product.
        </CardContent>
      </Card>
    )
  }

  // If only one attribute, render flat table (no grouping)
  if (!data.hasMultipleAttributes) {
    return (
      <>
        <FlatVariantTable
          groups={data.groups}
          productId={productId}
          showCost={showCost}
          showPricing={showPricing}
          canEditCost={canEditCost}
          canEditPrice={canEditPrice}
          queryClient={queryClient}
          onEdit={(v) => setEditingVariant(v)}
        />
        {editingVariant && (
          <VariantEditDialog
            variant={editingVariant}
            productId={productId}
            onClose={() => setEditingVariant(null)}
            queryClient={queryClient}
          />
        )}
      </>
    )
  }

  // Grouped table with parent-child cascade
  return (
    <div className="space-y-3">
      {data.parentAttributeName && (
        <p className="text-xs text-muted-foreground">
          Grouped by <span className="font-medium text-foreground">{data.parentAttributeDisplayName || data.parentAttributeName}</span> —
          set prices once per group, or override individual variants.
        </p>
      )}
      {data.groups.map((group) => (
        <GroupCard
          key={group.parentValue}
          group={group}
          productId={productId}
          parentAttributeName={data.parentAttributeName!}
          expanded={expandedGroups.has(group.parentValue)}
          onToggle={() => toggleGroup(group.parentValue)}
          showCost={showCost}
          showPricing={showPricing}
          canEditCost={canEditCost}
          canEditPrice={canEditPrice}
          queryClient={queryClient}
          onEditVariant={(v) => setEditingVariant(v)}
        />
      ))}
      {editingVariant && (
        <VariantEditDialog
          variant={editingVariant}
          productId={productId}
          onClose={() => setEditingVariant(null)}
          queryClient={queryClient}
        />
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Group card
// ──────────────────────────────────────────────────────────────
function GroupCard({
  group,
  productId,
  parentAttributeName,
  expanded,
  onToggle,
  showCost,
  showPricing,
  canEditCost,
  canEditPrice,
  queryClient,
  onEditVariant,
}: {
  group: VariantGroup
  productId: string
  parentAttributeName: string
  expanded: boolean
  onToggle: () => void
  showCost: boolean
  showPricing: boolean
  canEditCost: boolean
  canEditPrice: boolean
  queryClient: ReturnType<typeof useQueryClient>
  onEditVariant: (v: ChildVariant) => void
}) {
  const [parentCost, setParentCost] = useState('')
  const [parentSale, setParentSale] = useState('')
  const [parentCompare, setParentCompare] = useState('')
  const [applying, setApplying] = useState(false)

  const firstChild = group.children[0]
  if (parentCost === '' && firstChild) setParentCost(String(firstChild.costPrice))
  if (parentSale === '' && firstChild?.salePrice != null) setParentSale(String(firstChild.salePrice))
  if (parentCompare === '' && firstChild?.comparePrice != null) setParentCompare(String(firstChild.comparePrice))

  async function applyCostToGroup() {
    const cost = Number(parentCost)
    if (isNaN(cost) || cost < 0) { toast.error('Enter a valid cost price'); return }
    setApplying(true)
    try {
      const res = await api.post<{ success: boolean; updated_count: number }>(
        `/api/products/${productId}/variant-groups/dummy/cost`,
        { cost_price: cost, parent_attribute_name: parentAttributeName, parent_value: group.parentValue },
      )
      toast.success(`Applied Rs. ${cost} to ${res.updated_count} variant(s)`)
      queryClient.invalidateQueries({ queryKey: ['variant-groups', productId] })
      queryClient.invalidateQueries({ queryKey: ['product', productId] })
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to apply cost')
    } finally { setApplying(false) }
  }

  async function applySaleToGroup() {
    const sale = Number(parentSale)
    if (isNaN(sale) || sale < 0) { toast.error('Enter a valid sale price'); return }
    const compare = parentCompare ? Number(parentCompare) : null
    setApplying(true)
    try {
      const res = await api.post<{ success: boolean; updated_count: number }>(
        `/api/products/${productId}/variant-groups/dummy/sale-price`,
        { sale_price: sale, compare_price: compare, parent_attribute_name: parentAttributeName, parent_value: group.parentValue },
      )
      toast.success(`Applied sale price to ${res.updated_count} variant(s)`)
      queryClient.invalidateQueries({ queryKey: ['variant-groups', productId] })
      queryClient.invalidateQueries({ queryKey: ['product', productId] })
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to apply sale price')
    } finally { setApplying(false) }
  }

  const childAttrKeys = group.children.length > 0
    ? Object.keys(group.children[0].attributeValues).filter((k) => k !== parentAttributeName)
    : []

  return (
    <Card>
      <CardHeader className="pb-3 cursor-pointer" onClick={onToggle}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            <CardTitle className="text-base">{group.parentValue}</CardTitle>
            <Badge variant="secondary" className="text-[10px]">{group.childCount} variant{group.childCount === 1 ? '' : 's'}</Badge>
          </div>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-4">
          {/* Parent group inputs */}
          <div className="rounded-lg bg-muted/30 p-3 space-y-3">
            <p className="text-xs font-medium text-muted-foreground">Parent Group — applies to all synced children</p>
            <div className="flex flex-wrap items-end gap-3">
              {showCost && canEditCost && (
                <div className="space-y-1">
                  <Label className="text-xs">Cost Price</Label>
                  <div className="flex items-center gap-1">
                    <Input type="number" min="0" step="0.01" value={parentCost} onChange={(e) => setParentCost(e.target.value)} className="h-8 w-28 text-sm" placeholder="0.00" />
                    <Button size="sm" variant="outline" onClick={applyCostToGroup} disabled={applying}>
                      {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Apply
                    </Button>
                  </div>
                </div>
              )}
              {showPricing && canEditPrice && (
                <>
                  <div className="space-y-1">
                    <Label className="text-xs">Sale Price</Label>
                    <Input type="number" min="0" step="0.01" value={parentSale} onChange={(e) => setParentSale(e.target.value)} className="h-8 w-28 text-sm" placeholder="0.00" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Compare Price</Label>
                    <Input type="number" min="0" step="0.01" value={parentCompare} onChange={(e) => setParentCompare(e.target.value)} className="h-8 w-28 text-sm" placeholder="0.00" />
                  </div>
                  <Button size="sm" variant="outline" onClick={applySaleToGroup} disabled={applying} className="mb-0.5">
                    {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Apply to Group
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* Children table */}
          <div className="rounded-md border overflow-x-auto scrollbar-thin">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr className="text-left text-xs text-muted-foreground">
                  {childAttrKeys.map((k) => (<th key={k} className="px-3 py-2 font-medium">{k}</th>))}
                  <th className="px-3 py-2 font-medium">SKU</th>
                  <th className="px-3 py-2 font-medium">Fulfillment</th>
                  {showCost && <th className="px-3 py-2 font-medium text-right">Cost</th>}
                  {showPricing && <th className="px-3 py-2 font-medium text-right">Sale</th>}
                  {showPricing && <th className="px-3 py-2 font-medium text-right">Compare</th>}
                  <th className="px-3 py-2 font-medium text-center">Active</th>
                  <th className="px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {group.children.map((child) => (
                  <ChildRow
                    key={child.variantId}
                    child={child}
                    childAttrKeys={childAttrKeys}
                    productId={productId}
                    showCost={showCost}
                    showPricing={showPricing}
                    canEditCost={canEditCost}
                    canEditPrice={canEditPrice}
                    queryClient={queryClient}
                    onEdit={() => onEditVariant(child)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      )}
    </Card>
  )
}

// ──────────────────────────────────────────────────────────────
// Child row
// ──────────────────────────────────────────────────────────────
function ChildRow({
  child,
  childAttrKeys,
  productId,
  showCost,
  showPricing,
  canEditCost,
  canEditPrice,
  queryClient,
  onEdit,
}: {
  child: ChildVariant
  childAttrKeys: string[]
  productId: string
  showCost: boolean
  showPricing: boolean
  canEditCost: boolean
  canEditPrice: boolean
  queryClient: ReturnType<typeof useQueryClient>
  onEdit: () => void
}) {
  const [costValue, setCostValue] = useState(String(child.costPrice))
  const [saleValue, setSaleValue] = useState(child.salePrice != null ? String(child.salePrice) : '')
  const [compareValue, setCompareValue] = useState(child.comparePrice != null ? String(child.comparePrice) : '')
  const [saving, setSaving] = useState(false)
  const [toggling, setToggling] = useState(false)

  async function saveCost() {
    const newCost = Number(costValue)
    if (isNaN(newCost) || newCost < 0) return
    if (newCost === child.costPrice) return
    setSaving(true)
    try {
      await api.post(`/api/products/${productId}/variants/${child.variantId}/override-cost`, { cost_price: newCost })
      toast.success('Cost overridden — no longer synced with parent')
      queryClient.invalidateQueries({ queryKey: ['variant-groups', productId] })
      queryClient.invalidateQueries({ queryKey: ['product', productId] })
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to override cost')
      setCostValue(String(child.costPrice))
    } finally { setSaving(false) }
  }

  async function savePrice() {
    const newSale = Number(saleValue)
    const newCompare = compareValue ? Number(compareValue) : null
    if (isNaN(newSale) || newSale < 0) return
    setSaving(true)
    try {
      await api.post(`/api/products/${productId}/variants/${child.variantId}/override-price`, { sale_price: newSale, compare_price: newCompare })
      toast.success('Price overridden — no longer synced with parent')
      queryClient.invalidateQueries({ queryKey: ['variant-groups', productId] })
      queryClient.invalidateQueries({ queryKey: ['product', productId] })
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to override price')
      setSaleValue(child.salePrice != null ? String(child.salePrice) : '')
      setCompareValue(child.comparePrice != null ? String(child.comparePrice) : '')
    } finally { setSaving(false) }
  }

  async function resyncCost() {
    setSaving(true)
    try {
      const res = await api.post<{ success: boolean; cost_price: number }>(`/api/products/${productId}/variants/${child.variantId}/resync-cost`)
      toast.success(`Re-synced with parent (Rs. ${res.cost_price})`)
      queryClient.invalidateQueries({ queryKey: ['variant-groups', productId] })
      queryClient.invalidateQueries({ queryKey: ['product', productId] })
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to re-sync')
    } finally { setSaving(false) }
  }

  async function resyncPrice(field: 'sale_price' | 'compare_price') {
    setSaving(true)
    try {
      await api.post(`/api/products/${productId}/variants/${child.variantId}/resync-price`, { field })
      toast.success(`Re-synced ${field === 'sale_price' ? 'sale price' : 'compare price'} with parent`)
      queryClient.invalidateQueries({ queryKey: ['variant-groups', productId] })
      queryClient.invalidateQueries({ queryKey: ['product', productId] })
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to re-sync')
    } finally { setSaving(false) }
  }

  async function toggleActive() {
    setToggling(true)
    try {
      await api.post(`/api/products/${productId}/variants/${child.variantId}/toggle`, { is_active: !child.isActive })
      toast.success(child.isActive ? 'Variant deactivated' : 'Variant activated')
      queryClient.invalidateQueries({ queryKey: ['variant-groups', productId] })
      queryClient.invalidateQueries({ queryKey: ['product', productId] })
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to toggle')
    } finally { setToggling(false) }
  }

  return (
    <tr className="border-t hover:bg-muted/20">
      {childAttrKeys.map((k) => (
        <td key={k} className="px-3 py-2 text-xs">{child.attributeValues[k] ?? '—'}</td>
      ))}
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs">{child.sku}</span>
          {child.isDefault && <Badge variant="secondary" className="text-[9px] py-0 px-1">DEFAULT</Badge>}
        </div>
        {child.barcode && <div className="text-[10px] text-muted-foreground">{child.barcode}</div>}
      </td>
      <td className="px-3 py-2"><FulfillmentTypeBadge type={child.fulfillmentType} /></td>
      {showCost && (
        <td className="px-3 py-2">
          <div className="flex items-center gap-1 justify-end">
            {canEditCost ? (
              <Input type="number" min="0" step="0.01" value={costValue} onChange={(e) => setCostValue(e.target.value)} onBlur={saveCost} className="h-7 w-20 text-xs text-right" />
            ) : (<span className="text-xs">{child.costPrice}</span>)}
            {child.costPriceSyncedWithParent ? <Link2 className="h-3 w-3 text-emerald-500" /> : <Unlink className="h-3 w-3 text-amber-500" />}
          </div>
        </td>
      )}
      {showPricing && (
        <td className="px-3 py-2">
          <div className="flex items-center gap-1 justify-end">
            {canEditPrice ? (
              <Input type="number" min="0" step="0.01" value={saleValue} onChange={(e) => setSaleValue(e.target.value)} onBlur={savePrice} className="h-7 w-20 text-xs text-right" />
            ) : (<span className="text-xs">{child.salePrice ?? '—'}</span>)}
            {child.salePriceSyncedWithParent ? <Link2 className="h-3 w-3 text-emerald-500" /> : <Unlink className="h-3 w-3 text-amber-500" />}
          </div>
        </td>
      )}
      {showPricing && (
        <td className="px-3 py-2">
          <div className="flex items-center gap-1 justify-end">
            {canEditPrice ? (
              <Input type="number" min="0" step="0.01" value={compareValue} onChange={(e) => setCompareValue(e.target.value)} onBlur={savePrice} className="h-7 w-20 text-xs text-right" />
            ) : (<span className="text-xs">{child.comparePrice ?? '—'}</span>)}
          </div>
        </td>
      )}
      <td className="px-3 py-2 text-center">
        {canEditCost ? (
          <Switch checked={child.isActive} onCheckedChange={toggleActive} disabled={toggling} />
        ) : (
          <Badge variant={child.isActive ? 'secondary' : 'outline'} className="text-[10px]">{child.isActive ? 'Active' : 'Inactive'}</Badge>
        )}
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          {canEditCost && (
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onEdit} title="Edit variant details">
              <Pencil className="h-3 w-3" />
            </Button>
          )}
          {showCost && !child.costPriceSyncedWithParent && canEditCost && (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={resyncCost} disabled={saving} title="Re-sync cost with parent">
              <RefreshCw className="h-3 w-3" /> Cost
            </Button>
          )}
          {showPricing && !child.salePriceSyncedWithParent && canEditPrice && (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => resyncPrice('sale_price')} disabled={saving} title="Re-sync sale price with parent">
              <RefreshCw className="h-3 w-3" /> Price
            </Button>
          )}
        </div>
      </td>
    </tr>
  )
}

// ──────────────────────────────────────────────────────────────
// Variant Edit Dialog — full editing of barcode, weight, stitching, etc.
// ──────────────────────────────────────────────────────────────
function VariantEditDialog({
  variant,
  productId,
  onClose,
  queryClient,
}: {
  variant: ChildVariant
  productId: string
  onClose: () => void
  queryClient: ReturnType<typeof useQueryClient>
}) {
  const [form, setForm] = useState({
    sku: variant.sku,
    barcode: variant.barcode ?? '',
    costPrice: String(variant.costPrice),
    weightGrams: String(variant.weightGrams ?? 0),
    stitchingCharges: String(variant.stitchingCharges ?? 0),
    productionDays: String(variant.productionDays ?? 0),
    isTaxable: variant.isTaxable ?? true,
    requiresShipping: variant.requiresShipping ?? true,
  })
  const [saving, setSaving] = useState(false)
  const [confirmSkuChange, setConfirmSkuChange] = useState(false)

  async function save() {
    // If SKU changed, show confirmation
    if (form.sku !== variant.sku && !confirmSkuChange) {
      setConfirmSkuChange(true)
      return
    }

    setSaving(true)
    try {
      const patch: Record<string, unknown> = {}
      if (form.sku !== variant.sku) patch.sku = form.sku
      if (form.barcode !== (variant.barcode ?? '')) patch.barcode = form.barcode
      if (Number(form.costPrice) !== variant.costPrice) patch.cost_price = Number(form.costPrice)
      if (Number(form.weightGrams) !== (variant.weightGrams ?? 0)) patch.weight_grams = Number(form.weightGrams)
      if (Number(form.stitchingCharges) !== (variant.stitchingCharges ?? 0)) patch.stitching_charges = Number(form.stitchingCharges)
      if (Number(form.productionDays) !== (variant.productionDays ?? 0)) patch.production_days = Number(form.productionDays)
      if (form.isTaxable !== (variant.isTaxable ?? true)) patch.is_taxable = form.isTaxable
      if (form.requiresShipping !== (variant.requiresShipping ?? true)) patch.requires_shipping = form.requiresShipping

      if (Object.keys(patch).length === 0) {
        onClose()
        return
      }

      await api.patch(`/api/products/${productId}/variants/${variant.variantId}`, patch)
      toast.success('Variant updated')
      queryClient.invalidateQueries({ queryKey: ['variant-groups', productId] })
      queryClient.invalidateQueries({ queryKey: ['product', productId] })
      onClose()
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to update variant')
    } finally {
      setSaving(false)
      setConfirmSkuChange(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Variant</DialogTitle>
        </DialogHeader>

        {confirmSkuChange && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
            <p className="font-medium">Change SKU?</p>
            <p className="text-xs mt-1">Changing the SKU won&apos;t affect history but may cause confusion with existing labels. Continue?</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs">SKU</Label>
            <Input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} className="h-9 text-sm font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Barcode</Label>
            <Input value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} className="h-9 text-sm" placeholder="UPC/EAN" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Cost Price</Label>
            <Input type="number" min="0" step="0.01" value={form.costPrice} onChange={(e) => setForm({ ...form, costPrice: e.target.value })} className="h-9 text-sm" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Weight (grams)</Label>
            <Input type="number" min="0" step="1" value={form.weightGrams} onChange={(e) => setForm({ ...form, weightGrams: e.target.value })} className="h-9 text-sm" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Stitching Charges</Label>
            <Input type="number" min="0" step="0.01" value={form.stitchingCharges} onChange={(e) => setForm({ ...form, stitchingCharges: e.target.value })} className="h-9 text-sm" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Production Days</Label>
            <Input type="number" min="0" step="1" value={form.productionDays} onChange={(e) => setForm({ ...form, productionDays: e.target.value })} className="h-9 text-sm" />
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={form.isTaxable} onCheckedChange={(v) => setForm({ ...form, isTaxable: v })} />
            <Label className="text-xs">Taxable</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={form.requiresShipping} onCheckedChange={(v) => setForm({ ...form, requiresShipping: v })} />
            <Label className="text-xs">Requires Shipping</Label>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-2 border-t">
          <FulfillmentTypeBadge type={variant.fulfillmentType} />
          <span className="text-xs text-muted-foreground">Fulfillment type cannot be changed after creation</span>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {confirmSkuChange ? 'Confirm SKU Change & Save' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ──────────────────────────────────────────────────────────────
// Flat table (single-attribute products)
// ──────────────────────────────────────────────────────────────
function FlatVariantTable({
  groups,
  productId,
  showCost,
  showPricing,
  canEditCost,
  canEditPrice,
  queryClient,
  onEdit,
}: {
  groups: VariantGroup[]
  productId: string
  showCost: boolean
  showPricing: boolean
  canEditCost: boolean
  canEditPrice: boolean
  queryClient: ReturnType<typeof useQueryClient>
  onEdit: (v: ChildVariant) => void
}) {
  const allChildren = groups.flatMap((g) => g.children)

  return (
    <Card>
      <CardContent className="p-0">
        <div className="rounded-md border overflow-x-auto scrollbar-thin">
          <table className="w-full text-sm">
            <thead className="bg-muted/30">
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Variant</th>
                <th className="px-3 py-2 font-medium">SKU</th>
                <th className="px-3 py-2 font-medium">Fulfillment</th>
                {showCost && <th className="px-3 py-2 font-medium text-right">Cost</th>}
                {showPricing && <th className="px-3 py-2 font-medium text-right">Sale</th>}
                {showPricing && <th className="px-3 py-2 font-medium text-right">Compare</th>}
                <th className="px-3 py-2 font-medium text-center">Active</th>
                {canEditCost && <th className="px-3 py-2 font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {allChildren.map((child) => {
                const attrValues = Object.entries(child.attributeValues).map(([, v]) => v).join(' / ')
                return (
                  <FlatRow
                    key={child.variantId}
                    child={child}
                    attrValues={attrValues}
                    productId={productId}
                    showCost={showCost}
                    showPricing={showPricing}
                    canEditCost={canEditCost}
                    canEditPrice={canEditPrice}
                    queryClient={queryClient}
                    onEdit={() => onEdit(child)}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}

function FlatRow({
  child,
  attrValues,
  productId,
  showCost,
  showPricing,
  canEditCost,
  canEditPrice,
  queryClient,
  onEdit,
}: {
  child: ChildVariant
  attrValues: string
  productId: string
  showCost: boolean
  showPricing: boolean
  canEditCost: boolean
  canEditPrice: boolean
  queryClient: ReturnType<typeof useQueryClient>
  onEdit: () => void
}) {
  const [costValue, setCostValue] = useState(String(child.costPrice))
  const [saleValue, setSaleValue] = useState(child.salePrice != null ? String(child.salePrice) : '')
  const [compareValue, setCompareValue] = useState(child.comparePrice != null ? String(child.comparePrice) : '')
  const [toggling, setToggling] = useState(false)

  async function saveCost() {
    const newCost = Number(costValue)
    if (isNaN(newCost) || newCost < 0 || newCost === child.costPrice) return
    try {
      await api.post(`/api/products/${productId}/variants/${child.variantId}/override-cost`, { cost_price: newCost })
      toast.success('Cost updated')
      queryClient.invalidateQueries({ queryKey: ['variant-groups', productId] })
    } catch (err) { toast.error(err instanceof FetchError ? err.message : 'Failed') }
  }

  async function savePrice() {
    const newSale = Number(saleValue)
    if (isNaN(newSale) || newSale < 0) return
    try {
      await api.post(`/api/products/${productId}/variants/${child.variantId}/override-price`, { sale_price: newSale, compare_price: compareValue ? Number(compareValue) : null })
      toast.success('Price updated')
      queryClient.invalidateQueries({ queryKey: ['variant-groups', productId] })
    } catch (err) { toast.error(err instanceof FetchError ? err.message : 'Failed') }
  }

  async function toggleActive() {
    setToggling(true)
    try {
      await api.post(`/api/products/${productId}/variants/${child.variantId}/toggle`, { is_active: !child.isActive })
      toast.success(child.isActive ? 'Deactivated' : 'Activated')
      queryClient.invalidateQueries({ queryKey: ['variant-groups', productId] })
      queryClient.invalidateQueries({ queryKey: ['product', productId] })
    } catch (err) { toast.error(err instanceof FetchError ? err.message : 'Failed') }
    finally { setToggling(false) }
  }

  return (
    <tr className="border-t hover:bg-muted/20">
      <td className="px-3 py-2 text-xs">
        {attrValues || '—'}
        {child.isDefault && <Badge variant="secondary" className="ml-1 text-[9px]">DEFAULT</Badge>}
      </td>
      <td className="px-3 py-2">
        <span className="font-mono text-xs">{child.sku}</span>
        {child.barcode && <div className="text-[10px] text-muted-foreground">{child.barcode}</div>}
      </td>
      <td className="px-3 py-2"><FulfillmentTypeBadge type={child.fulfillmentType} /></td>
      {showCost && (
        <td className="px-3 py-2 text-right">
          {canEditCost ? (
            <Input type="number" min="0" step="0.01" value={costValue} onChange={(e) => setCostValue(e.target.value)} onBlur={saveCost} className="h-7 w-20 text-xs text-right" />
          ) : <span className="text-xs">{child.costPrice}</span>}
        </td>
      )}
      {showPricing && (
        <td className="px-3 py-2 text-right">
          {canEditPrice ? (
            <Input type="number" min="0" step="0.01" value={saleValue} onChange={(e) => setSaleValue(e.target.value)} onBlur={savePrice} className="h-7 w-20 text-xs text-right" />
          ) : <span className="text-xs">{child.salePrice ?? '—'}</span>}
        </td>
      )}
      {showPricing && (
        <td className="px-3 py-2 text-right text-xs text-muted-foreground">{child.comparePrice ?? '—'}</td>
      )}
      <td className="px-3 py-2 text-center">
        {canEditCost ? (
          <Switch checked={child.isActive} onCheckedChange={toggleActive} disabled={toggling} />
        ) : (
          <Badge variant={child.isActive ? 'secondary' : 'outline'} className="text-[10px]">{child.isActive ? 'Active' : 'Inactive'}</Badge>
        )}
      </td>
      {canEditCost && (
        <td className="px-3 py-2">
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onEdit} title="Edit variant details">
            <Pencil className="h-3 w-3" />
          </Button>
        </td>
      )}
    </tr>
  )
}
