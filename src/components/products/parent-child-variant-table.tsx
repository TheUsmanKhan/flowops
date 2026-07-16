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
  ChevronDown,
  ChevronRight,
  Link2,
  Unlink,
  RefreshCw,
  Loader2,
  AlertCircle,
  Check,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────
interface ChildVariant {
  variantId: string
  sku: string
  attributeValues: Record<string, string>
  costPrice: number
  costPriceSyncedWithParent: boolean
  fulfillmentType: string
  isActive: boolean
  salePrice: number | null
  comparePrice: number | null
  salePriceSyncedWithParent: boolean
  comparePriceSyncedWithParent: boolean
  pricingId: string | null
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
      <FlatVariantTable
        groups={data.groups}
        productId={productId}
        showCost={showCost}
        showPricing={showPricing}
        canEditCost={canEditCost}
        canEditPrice={canEditPrice}
        queryClient={queryClient}
      />
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
        />
      ))}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Group card (parent group with cascading inputs + children)
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
}) {
  const [parentCost, setParentCost] = useState('')
  const [parentSale, setParentSale] = useState('')
  const [parentCompare, setParentCompare] = useState('')
  const [applying, setApplying] = useState(false)

  // Use first child's values as defaults for the parent inputs
  const firstChild = group.children[0]
  if (parentCost === '' && firstChild) setParentCost(String(firstChild.costPrice))
  if (parentSale === '' && firstChild?.salePrice != null) setParentSale(String(firstChild.salePrice))
  if (parentCompare === '' && firstChild?.comparePrice != null) setParentCompare(String(firstChild.comparePrice))

  async function applyCostToGroup() {
    const cost = Number(parentCost)
    if (isNaN(cost) || cost < 0) {
      toast.error('Enter a valid cost price')
      return
    }
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
    } finally {
      setApplying(false)
    }
  }

  async function applySaleToGroup() {
    const sale = Number(parentSale)
    if (isNaN(sale) || sale < 0) {
      toast.error('Enter a valid sale price')
      return
    }
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
    } finally {
      setApplying(false)
    }
  }

  // Collect non-parent attribute keys for child display
  const childAttrKeys = group.children.length > 0
    ? Object.keys(group.children[0].attributeValues).filter((k) => k !== parentAttributeName)
    : []

  return (
    <Card>
      {/* Header */}
      <CardHeader className="pb-3 cursor-pointer" onClick={onToggle}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {expanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <CardTitle className="text-base">{group.parentValue}</CardTitle>
            <Badge variant="secondary" className="text-[10px]">
              {group.childCount} variant{group.childCount === 1 ? '' : 's'}
            </Badge>
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
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={parentCost}
                      onChange={(e) => setParentCost(e.target.value)}
                      className="h-8 w-28 text-sm"
                      placeholder="0.00"
                    />
                    <Button size="sm" variant="outline" onClick={applyCostToGroup} disabled={applying}>
                      {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      Apply
                    </Button>
                  </div>
                </div>
              )}
              {showPricing && canEditPrice && (
                <>
                  <div className="space-y-1">
                    <Label className="text-xs">Sale Price</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={parentSale}
                      onChange={(e) => setParentSale(e.target.value)}
                      className="h-8 w-28 text-sm"
                      placeholder="0.00"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Compare Price</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={parentCompare}
                      onChange={(e) => setParentCompare(e.target.value)}
                      className="h-8 w-28 text-sm"
                      placeholder="0.00"
                    />
                  </div>
                  <Button size="sm" variant="outline" onClick={applySaleToGroup} disabled={applying} className="mb-0.5">
                    {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    Apply to Group
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* Children table */}
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr className="text-left text-xs text-muted-foreground">
                  {childAttrKeys.map((k) => (
                    <th key={k} className="px-3 py-2 font-medium">{k}</th>
                  ))}
                  <th className="px-3 py-2 font-medium">SKU</th>
                  {showCost && <th className="px-3 py-2 font-medium text-right">Cost</th>}
                  {showPricing && <th className="px-3 py-2 font-medium text-right">Sale</th>}
                  {showPricing && <th className="px-3 py-2 font-medium text-right">Compare</th>}
                  <th className="px-3 py-2 font-medium text-center">Sync</th>
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
// Child row (individual variant with inline editing + sync indicators)
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
}: {
  child: ChildVariant
  childAttrKeys: string[]
  productId: string
  showCost: boolean
  showPricing: boolean
  canEditCost: boolean
  canEditPrice: boolean
  queryClient: ReturnType<typeof useQueryClient>
}) {
  const [costValue, setCostValue] = useState(String(child.costPrice))
  const [saleValue, setSaleValue] = useState(child.salePrice != null ? String(child.salePrice) : '')
  const [compareValue, setCompareValue] = useState(child.comparePrice != null ? String(child.comparePrice) : '')
  const [saving, setSaving] = useState(false)

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
    } finally {
      setSaving(false)
    }
  }

  async function savePrice() {
    const newSale = Number(saleValue)
    const newCompare = compareValue ? Number(compareValue) : null
    if (isNaN(newSale) || newSale < 0) return
    setSaving(true)
    try {
      await api.post(`/api/products/${productId}/variants/${child.variantId}/override-price`, {
        sale_price: newSale,
        compare_price: newCompare,
      })
      toast.success('Price overridden — no longer synced with parent')
      queryClient.invalidateQueries({ queryKey: ['variant-groups', productId] })
      queryClient.invalidateQueries({ queryKey: ['product', productId] })
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to override price')
      setSaleValue(child.salePrice != null ? String(child.salePrice) : '')
      setCompareValue(child.comparePrice != null ? String(child.comparePrice) : '')
    } finally {
      setSaving(false)
    }
  }

  async function resyncCost() {
    setSaving(true)
    try {
      const res = await api.post<{ success: boolean; cost_price: number }>(
        `/api/products/${productId}/variants/${child.variantId}/resync-cost`,
      )
      toast.success(`Re-synced with parent (Rs. ${res.cost_price})`)
      queryClient.invalidateQueries({ queryKey: ['variant-groups', productId] })
      queryClient.invalidateQueries({ queryKey: ['product', productId] })
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to re-sync')
    } finally {
      setSaving(false)
    }
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
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr className="border-t hover:bg-muted/20">
      {childAttrKeys.map((k) => (
        <td key={k} className="px-3 py-2 text-xs">{child.attributeValues[k] ?? '—'}</td>
      ))}
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs">{child.sku}</span>
        </div>
      </td>
      {showCost && (
        <td className="px-3 py-2">
          <div className="flex items-center gap-1 justify-end">
            {canEditCost ? (
              <Input
                type="number"
                min="0"
                step="0.01"
                value={costValue}
                onChange={(e) => setCostValue(e.target.value)}
                onBlur={saveCost}
                className="h-7 w-20 text-xs text-right"
              />
            ) : (
              <span className="text-xs">{child.costPrice}</span>
            )}
            {child.costPriceSyncedWithParent ? (
              <Link2 className="h-3 w-3 text-emerald-500" title="Synced with parent" />
            ) : (
              <Unlink className="h-3 w-3 text-amber-500" title="Overridden" />
            )}
          </div>
        </td>
      )}
      {showPricing && (
        <td className="px-3 py-2">
          <div className="flex items-center gap-1 justify-end">
            {canEditPrice ? (
              <Input
                type="number"
                min="0"
                step="0.01"
                value={saleValue}
                onChange={(e) => setSaleValue(e.target.value)}
                onBlur={savePrice}
                className="h-7 w-20 text-xs text-right"
              />
            ) : (
              <span className="text-xs">{child.salePrice ?? '—'}</span>
            )}
            {child.salePriceSyncedWithParent ? (
              <Link2 className="h-3 w-3 text-emerald-500" />
            ) : (
              <Unlink className="h-3 w-3 text-amber-500" />
            )}
          </div>
        </td>
      )}
      {showPricing && (
        <td className="px-3 py-2">
          <div className="flex items-center gap-1 justify-end">
            {canEditPrice ? (
              <Input
                type="number"
                min="0"
                step="0.01"
                value={compareValue}
                onChange={(e) => setCompareValue(e.target.value)}
                onBlur={savePrice}
                className="h-7 w-20 text-xs text-right"
              />
            ) : (
              <span className="text-xs">{child.comparePrice ?? '—'}</span>
            )}
          </div>
        </td>
      )}
      <td className="px-3 py-2 text-center">
        <FulfillmentTypeBadge type={child.fulfillmentType} />
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          {showCost && !child.costPriceSyncedWithParent && canEditCost && (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={resyncCost} disabled={saving}>
              <RefreshCw className="h-3 w-3" /> Re-sync Cost
            </Button>
          )}
          {showPricing && !child.salePriceSyncedWithParent && canEditPrice && (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => resyncPrice('sale_price')} disabled={saving}>
              <RefreshCw className="h-3 w-3" /> Re-sync Price
            </Button>
          )}
        </div>
      </td>
    </tr>
  )
}

// ──────────────────────────────────────────────────────────────
// Flat table (for single-attribute products — no grouping)
// ──────────────────────────────────────────────────────────────
function FlatVariantTable({
  groups,
  productId,
  showCost,
  showPricing,
  canEditCost,
  canEditPrice,
  queryClient,
}: {
  groups: VariantGroup[]
  productId: string
  showCost: boolean
  showPricing: boolean
  canEditCost: boolean
  canEditPrice: boolean
  queryClient: ReturnType<typeof useQueryClient>
}) {
  // Flatten all children from all groups
  const allChildren = groups.flatMap((g) => g.children)

  return (
    <Card>
      <CardContent className="p-0">
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/30">
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Variant</th>
                <th className="px-3 py-2 font-medium">SKU</th>
                <th className="px-3 py-2 font-medium">Fulfillment</th>
                {showCost && <th className="px-3 py-2 font-medium text-right">Cost</th>}
                {showPricing && <th className="px-3 py-2 font-medium text-right">Sale</th>}
                {showPricing && <th className="px-3 py-2 font-medium text-right">Compare</th>
              </tr>
            </thead>
            <tbody>
              {allChildren.map((child) => {
                const attrValues = Object.entries(child.attributeValues).map(([, v]) => v).join(' / ')
                return (
                  <tr key={child.variantId} className="border-t">
                    <td className="px-3 py-2 text-xs">{attrValues || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{child.sku}</td>
                    <td className="px-3 py-2"><FulfillmentTypeBadge type={child.fulfillmentType} /></td>
                    {showCost && <td className="px-3 py-2 text-right text-xs">{child.costPrice}</td>}
                    {showPricing && <td className="px-3 py-2 text-right text-xs">{child.salePrice ?? '—'}</td>}
                    {showPricing && <td className="px-3 py-2 text-right text-xs text-muted-foreground">{child.comparePrice ?? '—'}</td>}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}
