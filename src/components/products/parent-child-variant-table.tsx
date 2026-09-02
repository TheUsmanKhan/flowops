'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
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
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ParentGroupInputs } from '@/components/products/variant-table-parts'

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
  // Bug 2 fix: trackInventory is a separate mutable field. The badge reads
  // THIS (not fulfillmentType) to show whether the variant currently holds
  // tracked stock.
  trackInventory?: boolean
  isActive: boolean
  isDefault: boolean
  salePrice: number | null
  comparePrice: number | null
  salePriceSyncedWithParent: boolean
  comparePriceSyncedWithParent: boolean
  pricingId: string | null
  // Weight tracking (kg) — mirrors costPrice/costPriceSyncedWithParent pattern
  weightKg?: number | null
  weightSyncedWithParent?: boolean
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

// Shape returned by /api/inventory/summary?product_id=...
interface InventorySummaryVariant {
  variantId: string
  totalOnHand: number
  totalReserved: number
  totalAvailable: number
  totalValue: number
  locations: Array<{ locationId: string; locationName: string; onHand: number; reserved: number; available: number; avgCost: number }>
}
interface InventorySummaryResponse {
  variants: InventorySummaryVariant[]
}

/**
 * Fetches live inventory per variant for this product and returns a map keyed
 * by variantId. Used by the parent-child table to display on-hand stock
 * alongside cost/price columns. Reads from the same inventory_pools data as
 * the Inventory tab and the Inventory Dashboard — no parallel data source.
 */
function useVariantInventoryMap(productId: string) {
  const { data } = useQuery<InventorySummaryResponse>({
    queryKey: ['product-inventory', productId],
    queryFn: () => api.get(`/api/inventory/summary?product_id=${productId}`),
    staleTime: 15_000,
  })
  const map = new Map<string, InventorySummaryVariant>()
  for (const v of data?.variants ?? []) {
    map.set(v.variantId, v)
  }
  return map
}

/** Compact stock cell — shows on_hand, with available in muted subtext. */
function StockCell({ inv }: { inv?: InventorySummaryVariant }) {
  if (!inv) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  const onHand = inv.totalOnHand
  const available = inv.totalAvailable
  if (onHand === 0) {
    return <span className="text-xs text-muted-foreground">0</span>
  }
  const lowStock = available > 0 && available <= 5
  return (
    <div className="text-xs leading-tight">
      <span className={cn('font-medium', lowStock ? 'text-amber-700' : 'text-foreground')}>{onHand}</span>
      {available !== onHand && (
        <div className="text-[10px] text-muted-foreground">{available} avail.</div>
      )}
    </div>
  )
}

/**
 * Bug 2 fix: badge that reads trackInventory (mutable), NOT fulfillmentType
 * (immutable). A made_to_order variant with opening stock added shows
 * "Stock Tracked" because trackInventory is true. Falls back to
 * fulfillmentType-based display if trackInventory is undefined (e.g. older
 * API responses that don't include the field).
 */
function TrackingBadge({
  trackInventory,
  fulfillmentType,
}: {
  trackInventory?: boolean
  fulfillmentType: string
}) {
  // If trackInventory is explicitly set, use it. Otherwise fall back to
  // the old behavior (stock_based → tracked, made_to_order → not tracked).
  const isTracked = trackInventory ?? fulfillmentType === 'stock_based'
  return (
    <Badge
      variant="outline"
      className={cn(
        'gap-1 text-xs font-medium',
        isTracked
          ? 'bg-sky-50 text-sky-700 border-sky-200'
          : 'bg-purple-50 text-purple-700 border-purple-200',
      )}
    >
      {isTracked ? 'Stock Tracked' : 'Made to Order'}
    </Badge>
  )
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

  // Live inventory per variant — powers the read-only Stock column.
  const inventoryMap = useVariantInventoryMap(productId)

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
          inventoryMap={inventoryMap}
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
          inventoryMap={inventoryMap}
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
  inventoryMap,
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
  inventoryMap: Map<string, InventorySummaryVariant>
}) {
  const [parentCost, setParentCost] = useState('')
  const [parentSale, setParentSale] = useState('')
  const [parentCompare, setParentCompare] = useState('')
  const [parentWeight, setParentWeight] = useState('')
  const [applying, setApplying] = useState(false)

  const firstChild = group.children[0]
  if (parentCost === '' && firstChild) setParentCost(String(firstChild.costPrice))
  if (parentSale === '' && firstChild?.salePrice != null) setParentSale(String(firstChild.salePrice))
  if (parentCompare === '' && firstChild?.comparePrice != null) setParentCompare(String(firstChild.comparePrice))
  if (parentWeight === '' && firstChild?.weightKg != null) setParentWeight(String(firstChild.weightKg))

  // Bug 1 fix: ONE handler cascades ALL THREE fields (cost, sale, compare).
  // Calls both server endpoints (cost + sale-price) in sequence, then
  // invalidates the cache once. Each endpoint only updates children whose
  // relevant synced flag is true, so the three flags remain INDEPENDENT.
  // Weight cascade added — calls the weight endpoint in the same sequence.
  async function applyAllToGroup() {
    const cost = Number(parentCost)
    const sale = Number(parentSale)
    const compare = parentCompare ? Number(parentCompare) : null
    const weight = parentWeight ? Number(parentWeight) : null

    if (isNaN(cost) || cost < 0) { toast.error('Enter a valid cost price'); return }
    if (isNaN(sale) || sale < 0) { toast.error('Enter a valid sale price'); return }
    if (parentWeight && (isNaN(weight as number) || (weight as number) < 0)) { toast.error('Enter a valid weight'); return }

    setApplying(true)
    let costCount = 0
    let saleCount = 0
    let weightCount = 0
    try {
      // Cascade cost to cost-synced children
      const costRes = await api.post<{ success: boolean; updated_count: number }>(
        `/api/products/${productId}/variant-groups/dummy/cost`,
        { cost_price: cost, parent_attribute_name: parentAttributeName, parent_value: group.parentValue },
      )
      costCount = costRes.updated_count

      // Cascade sale + compare to their respective synced children
      const saleRes = await api.post<{ success: boolean; updated_count: number }>(
        `/api/products/${productId}/variant-groups/dummy/sale-price`,
        { sale_price: sale, compare_price: compare, parent_attribute_name: parentAttributeName, parent_value: group.parentValue, },
      )
      saleCount = saleRes.updated_count

      // Cascade weight to weight-synced children (only if a weight was entered)
      if (parentWeight && weight != null) {
        const weightRes = await api.post<{ success: boolean; updated_count: number }>(
          `/api/products/${productId}/variant-groups/dummy/weight`,
          { weightKg: weight, parent_attribute_name: parentAttributeName, parent_value: group.parentValue },
        )
        weightCount = weightRes.updated_count
      }

      toast.success(`Applied to group — Cost: ${costCount}, Sale+Compare: ${saleCount}${parentWeight ? `, Weight: ${weightCount}` : ''} variant(s)`)
      queryClient.invalidateQueries({ queryKey: ['variant-groups', productId] })
      queryClient.invalidateQueries({ queryKey: ['product', productId] })
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to apply to group')
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
          {/* Parent group inputs — uses the shared ParentGroupInputs component
              with a single "Apply to Group" button that cascades ALL fields
              (cost, sale, compare, weight) independently. Bug 1 fix + weight extension. */}
          <ParentGroupInputs
            parentCost={parentCost}
            parentSale={parentSale}
            parentCompare={parentCompare}
            parentWeight={parentWeight}
            onCostChange={setParentCost}
            onSaleChange={setParentSale}
            onCompareChange={setParentCompare}
            onWeightChange={setParentWeight}
            onApplyAll={applyAllToGroup}
            showCost={showCost}
            showPricing={showPricing}
            showWeight={canEditCost}
            canEditCost={canEditCost}
            canEditPrice={canEditPrice}
            canEditWeight={canEditCost}
            applying={applying}
          />

          {/* Children table */}
          <div className="rounded-md border overflow-x-auto scrollbar-thin">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr className="text-left text-xs text-muted-foreground">
                  {childAttrKeys.map((k) => (<th key={k} className="px-3 py-2 font-medium">{k}</th>))}
                  <th className="px-3 py-2 font-medium">SKU</th>
                  <th className="px-3 py-2 font-medium">Fulfillment</th>
                  <th className="px-3 py-2 font-medium text-center">Stock</th>
                  {showCost && <th className="px-3 py-2 font-medium text-right">Cost</th>}
                  {showPricing && <th className="px-3 py-2 font-medium text-right">Sale</th>}
                  {showPricing && <th className="px-3 py-2 font-medium text-right">Compare</th>}
                  {canEditCost && <th className="px-3 py-2 font-medium text-right">Weight (kg)</th>}
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
                    inventory={inventoryMap.get(child.variantId)}
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
  inventory,
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
  inventory?: InventorySummaryVariant
}) {
  const [costValue, setCostValue] = useState(String(child.costPrice))
  const [saleValue, setSaleValue] = useState(child.salePrice != null ? String(child.salePrice) : '')
  const [compareValue, setCompareValue] = useState(child.comparePrice != null ? String(child.comparePrice) : '')
  const [weightValue, setWeightValue] = useState(child.weightKg != null ? String(child.weightKg) : '')
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

  async function saveWeight() {
    const newWeight = weightValue ? Number(weightValue) : null
    if (weightValue && (isNaN(newWeight as number) || (newWeight as number) < 0)) return
    if (newWeight === child.weightKg) return
    setSaving(true)
    try {
      await api.post(`/api/products/${productId}/variants/${child.variantId}/override-weight`, { weightKg: newWeight })
      toast.success('Weight overridden — no longer synced with parent')
      queryClient.invalidateQueries({ queryKey: ['variant-groups', productId] })
      queryClient.invalidateQueries({ queryKey: ['product', productId] })
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to override weight')
      setWeightValue(child.weightKg != null ? String(child.weightKg) : '')
    } finally { setSaving(false) }
  }

  async function resyncWeight() {
    setSaving(true)
    try {
      const res = await api.post<{ success: boolean; weightKg: number | null }>(`/api/products/${productId}/variants/${child.variantId}/resync-weight`)
      toast.success(`Re-synced weight with parent${res.weightKg != null ? ` (${res.weightKg} kg)` : ''}`)
      queryClient.invalidateQueries({ queryKey: ['variant-groups', productId] })
      queryClient.invalidateQueries({ queryKey: ['product', productId] })
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to re-sync')
    } finally { setSaving(false) }
  }

  async function savePrice() {
    const newSale = Number(saleValue)
    const newCompare = compareValue ? Number(compareValue) : null
    if (isNaN(newSale) || newSale < 0) return
    setSaving(true)
    try {
      await api.post(`/api/products/${productId}/variants/${child.variantId}/override-price`, { sale_price: newSale, compare_price: newCompare, })
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
      await api.post(`/api/products/${productId}/variants/${child.variantId}/resync-price`, { field, })
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
      <td className="px-3 py-2"><TrackingBadge trackInventory={child.trackInventory} fulfillmentType={child.fulfillmentType} /></td>
      <td className="px-3 py-2 text-center"><StockCell inv={inventory} /></td>
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
      {canEditCost && (
        <td className="px-3 py-2">
          <div className="flex items-center gap-1 justify-end">
            {canEditCost ? (
              <Input
                type="number"
                min="0"
                step="0.001"
                value={weightValue}
                onChange={(e) => setWeightValue(e.target.value)}
                onBlur={saveWeight}
                className="h-7 w-20 text-xs text-right"
                placeholder="—"
              />
            ) : (
              <span className="text-xs">{child.weightKg ?? '—'}</span>
            )}
            {child.weightSyncedWithParent ? <Link2 className="h-3 w-3 text-emerald-500" /> : <Unlink className="h-3 w-3 text-amber-500" />}
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
          {canEditCost && !child.weightSyncedWithParent && (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={resyncWeight} disabled={saving} title="Re-sync weight with parent">
              <RefreshCw className="h-3 w-3" /> Wt
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
    weightKg: variant.weightKg != null ? String(variant.weightKg) : '',
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
      // Weight (kg) — null when empty, otherwise the number
      const newWeightKg = form.weightKg === '' ? null : Number(form.weightKg)
      const oldWeightKg = variant.weightKg ?? null
      if (newWeightKg !== oldWeightKg) patch.weight_kg = newWeightKg
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
            <Label className="text-xs">Weight (kg)</Label>
            <Input type="number" min="0" step="0.001" value={form.weightKg} onChange={(e) => setForm({ ...form, weightKg: e.target.value })} className="h-9 text-sm" placeholder="0.000" />
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
  inventoryMap,
}: {
  groups: VariantGroup[]
  productId: string
  showCost: boolean
  showPricing: boolean
  canEditCost: boolean
  canEditPrice: boolean
  queryClient: ReturnType<typeof useQueryClient>
  onEdit: (v: ChildVariant) => void
  inventoryMap: Map<string, InventorySummaryVariant>
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
                <th className="px-3 py-2 font-medium text-center">Stock</th>
                {showCost && <th className="px-3 py-2 font-medium text-right">Cost</th>}
                {showPricing && <th className="px-3 py-2 font-medium text-right">Sale</th>}
                {showPricing && <th className="px-3 py-2 font-medium text-right">Compare</th>}
                {canEditCost && <th className="px-3 py-2 font-medium text-right">Weight (kg)</th>}
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
                    inventory={inventoryMap.get(child.variantId)}
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
  inventory,
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
  inventory?: InventorySummaryVariant
}) {
  const [costValue, setCostValue] = useState(String(child.costPrice))
  const [saleValue, setSaleValue] = useState(child.salePrice != null ? String(child.salePrice) : '')
  const [compareValue, setCompareValue] = useState(child.comparePrice != null ? String(child.comparePrice) : '')
  const [weightValue, setWeightValue] = useState(child.weightKg != null ? String(child.weightKg) : '')
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

  async function saveWeight() {
    const newWeight = weightValue ? Number(weightValue) : null
    if (weightValue && (isNaN(newWeight as number) || (newWeight as number) < 0)) return
    if (newWeight === child.weightKg) return
    try {
      await api.post(`/api/products/${productId}/variants/${child.variantId}/override-weight`, { weightKg: newWeight })
      toast.success('Weight updated')
      queryClient.invalidateQueries({ queryKey: ['variant-groups', productId] })
    } catch (err) { toast.error(err instanceof FetchError ? err.message : 'Failed') }
  }

  async function savePrice() {
    const newSale = Number(saleValue)
    if (isNaN(newSale) || newSale < 0) return
    try {
      await api.post(`/api/products/${productId}/variants/${child.variantId}/override-price`, { sale_price: newSale, compare_price: compareValue ? Number(compareValue) : null, })
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
      <td className="px-3 py-2"><TrackingBadge trackInventory={child.trackInventory} fulfillmentType={child.fulfillmentType} /></td>
      <td className="px-3 py-2 text-center"><StockCell inv={inventory} /></td>
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
      {canEditCost && (
        <td className="px-3 py-2 text-right">
          {canEditCost ? (
            <Input
              type="number"
              min="0"
              step="0.001"
              value={weightValue}
              onChange={(e) => setWeightValue(e.target.value)}
              onBlur={saveWeight}
              className="h-7 w-20 text-xs text-right"
              placeholder="—"
            />
          ) : (
            <span className="text-xs">{child.weightKg ?? '—'}</span>
          )}
        </td>
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
