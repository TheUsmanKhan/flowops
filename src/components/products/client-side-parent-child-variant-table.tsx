'use client'

/**
 * Client-side parent-child variant table for the product CREATION wizard.
 *
 * This is the client-side counterpart of the edit-page ParentChildVariantTable.
 * It uses the SAME shared grouping utility (/lib/utils/variant-grouping.ts) and
 * the SAME shared presentational sub-components (variant-table-parts.tsx) as
 * the edit-page table — so grouping behavior and visual markup are identical
 * between the two contexts.
 *
 * The key difference: ALL state changes here update LOCAL component state (the
 * parent wizard's variant array, via the onVariantsChange callback) instead of
 * calling any server action. No network calls happen for grouping, cascading,
 * or overriding during the wizard flow — all of that is pure local state until
 * the wizard's final submit.
 *
 * When hasMeaningfulGrouping is false (single-attribute or zero-attribute
 * products), it renders a flat table matching the wizard's existing flat
 * preview table.
 */

import { useState, useMemo, useEffect, useRef } from 'react'
import {
  Card,
  CardContent,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { FulfillmentTypeBadge } from '@/components/products/fulfillment-type-badge'
import {
  ParentGroupInputs,
  SyncIndicator,
  ResyncButton,
} from '@/components/products/variant-table-parts'
import {
  determineParentAttribute,
  groupVariantsByParentAttribute,
  type GroupableAttribute,
} from '@/lib/utils/variant-grouping'
import { FULFILLMENT_LABELS } from '@/lib/constants/fulfillment-types'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

/**
 * The minimum shape a wizard variant needs to participate in grouped
 * pricing. The component is generic over T so any extra fields
 * (opening_stock_*, stitching_*, etc.) pass through untouched.
 */
export interface WizardGroupableVariant {
  /** Unique key (use SKU since no DB id exists yet) */
  sku: string
  attribute_values: Record<string, string>
  cost_price: number
  sale_price: number
  compare_price: number | null
  cost_price_synced_with_parent: boolean
  sale_price_synced_with_parent: boolean
  compare_price_synced_with_parent: boolean
  fulfillment_type: string
  is_active: boolean
  is_default: boolean
  // Weight tracking (kg) — mirrors cost_price cascade pattern
  weight_kg?: number | null
  weight_synced_with_parent?: boolean
}

interface Props<T extends WizardGroupableVariant> {
  variants: T[]
  selectedAttributes: GroupableAttribute[]
  onVariantsChange: (variants: T[]) => void
  /** Whether the user can edit (always true in the wizard if they have products.create) */
  canEdit?: boolean
}

// ──────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────

export function ClientSideParentChildVariantTable<T extends WizardGroupableVariant>({
  variants,
  selectedAttributes,
  onVariantsChange,
  canEdit = true,
}: Props<T>) {
  // Compute grouping using the SHARED utility (same as the server endpoint)
  const grouping = useMemo(() => {
    const parent = determineParentAttribute(selectedAttributes)
    // Map wizard variants to GroupableVariant shape (id = sku for client-side keying)
    const groupable = variants.map((v) => ({
      id: v.sku,
      attribute_values: v.attribute_values,
      data: v, // preserve the full variant as opaque payload
    }))
    return groupVariantsByParentAttribute(groupable, parent?.name ?? null)
  }, [variants, selectedAttributes])

  const parentAttrName = grouping.parentAttributeName

  if (!grouping.hasMeaningfulGrouping) {
    return <FlatVariantTable variants={variants} canEdit={canEdit} onVariantsChange={onVariantsChange} />
  }

  // Extract the original variant data from the grouped result
  const groupedVariants = grouping.groups.map((g) => ({
    parentValue: g.parentValue,
    children: g.children.map((c) => c.data),
  }))

  return (
    <GroupedVariantTable
      variants={variants}
      groups={groupedVariants}
      parentAttrName={parentAttrName!}
      canEdit={canEdit}
      onVariantsChange={onVariantsChange}
    />
  )
}

// ──────────────────────────────────────────────────────────────
// Grouped table — collapsible parent groups with cascade
// ──────────────────────────────────────────────────────────────

function GroupedVariantTable<T extends WizardGroupableVariant>({
  variants,
  groups,
  parentAttrName,
  canEdit,
  onVariantsChange,
}: {
  variants: T[]
  groups: Array<{ parentValue: string; children: T[] }>
  parentAttrName: string
  canEdit: boolean
  onVariantsChange: (v: T[]) => void
}) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(groups.map((g) => g.parentValue)),
  )

  // Auto-expand new groups
  useEffect(() => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      for (const g of groups) next.add(g.parentValue)
      return next
    })
  }, [groups])

  function toggleGroup(parentValue: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(parentValue)) next.delete(parentValue)
      else next.add(parentValue)
      return next
    })
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Grouped by <span className="font-medium text-foreground">{parentAttrName}</span> — set
        prices once per group, or override individual variants.
      </p>
      {groups.map((group) => (
        <GroupCard
          key={group.parentValue}
          group={group}
          parentAttrName={parentAttrName}
          expanded={expandedGroups.has(group.parentValue)}
          onToggle={() => toggleGroup(group.parentValue)}
          canEdit={canEdit}
          onVariantsChange={onVariantsChange}
          allVariants={variants}
        />
      ))}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Group card — parent header + children table
// ──────────────────────────────────────────────────────────────

function GroupCard<T extends WizardGroupableVariant>({
  group,
  parentAttrName,
  expanded,
  onToggle,
  canEdit,
  onVariantsChange,
  allVariants,
}: {
  group: { parentValue: string; children: T[] }
  parentAttrName: string
  expanded: boolean
  onToggle: () => void
  canEdit: boolean
  onVariantsChange: (v: T[]) => void
  allVariants: T[]
}) {
  const showCost = true
  const showPricing = true

  // Parent input local state — initializes from the first synced child
  const firstSyncedCost = group.children.find((c) => c.cost_price_synced_with_parent)
  const firstSyncedSale = group.children.find((c) => c.sale_price_synced_with_parent)
  const firstSyncedCompare = group.children.find((c) => c.compare_price_synced_with_parent)
  const firstSyncedWeight = group.children.find((c) => c.weight_synced_with_parent)
  const [parentCost, setParentCost] = useState(
    String(firstSyncedCost?.cost_price ?? group.children[0]?.cost_price ?? 0),
  )
  const [parentSale, setParentSale] = useState(
    String(firstSyncedSale?.sale_price ?? group.children[0]?.sale_price ?? 0),
  )
  const [parentCompare, setParentCompare] = useState(
    firstSyncedCompare?.compare_price != null
      ? String(firstSyncedCompare.compare_price)
      : group.children[0]?.compare_price != null
        ? String(group.children[0].compare_price)
        : '',
  )
  const [parentWeight, setParentWeight] = useState(
    firstSyncedWeight?.weight_kg != null
      ? String(firstSyncedWeight.weight_kg)
      : group.children[0]?.weight_kg != null
        ? String(group.children[0].weight_kg)
        : '',
  )

  // Re-init when the group identity changes (different children)
  const groupKey = group.children.map((c) => c.sku).join(',')
  const lastGroupKeyRef = useRef(groupKey)
  useEffect(() => {
    if (lastGroupKeyRef.current !== groupKey) {
      lastGroupKeyRef.current = groupKey
      const sc = group.children.find((c) => c.cost_price_synced_with_parent)
      const ss = group.children.find((c) => c.sale_price_synced_with_parent)
      const sp = group.children.find((c) => c.compare_price_synced_with_parent)
      const sw = group.children.find((c) => c.weight_synced_with_parent)
      setParentCost(String(sc?.cost_price ?? group.children[0]?.cost_price ?? 0))
      setParentSale(String(ss?.sale_price ?? group.children[0]?.sale_price ?? 0))
      setParentCompare(
        sp?.compare_price != null
          ? String(sp.compare_price)
          : group.children[0]?.compare_price != null
            ? String(group.children[0].compare_price)
            : '',
      )
      setParentWeight(
        sw?.weight_kg != null
          ? String(sw.weight_kg)
          : group.children[0]?.weight_kg != null
            ? String(group.children[0].weight_kg)
            : '',
      )
    }
  }, [groupKey, group.children])

  // Child attribute keys (exclude parent attribute)
  const childAttrKeys = group.children.length > 0
    ? Object.keys(group.children[0].attribute_values).filter((k) => k !== parentAttrName)
    : []

  // ── Cascade handler (pure local state, no network) ──
  // Bug 1 fix: ONE handler cascades ALL THREE fields (cost, sale, compare)
  // independently to their respective synced children. Each field only
  // updates children whose relevant synced flag is true, so the three flags
  // remain INDEPENDENT.

  function applyAllToGroup() {
    const cost = Number(parentCost)
    const sale = Number(parentSale)
    const compare = parentCompare ? Number(parentCompare) : null
    const weight = parentWeight ? Number(parentWeight) : null

    if (isNaN(cost) || cost < 0) {
      toast.error('Enter a valid cost price')
      return
    }
    if (isNaN(sale) || sale < 0) {
      toast.error('Enter a valid sale price')
      return
    }
    if (parentWeight && (isNaN(weight as number) || (weight as number) < 0)) {
      toast.error('Enter a valid weight')
      return
    }

    const updated = allVariants.map((v) => {
      const isChild = group.children.some((c) => c.sku === v.sku)
      if (!isChild) return v
      const patch: Partial<T> = {}
      // Cost cascades to cost-synced children only
      if (v.cost_price_synced_with_parent) {
        ;(patch as Record<string, unknown>).cost_price = cost
      }
      // Sale cascades to sale-synced children only
      if (v.sale_price_synced_with_parent) {
        ;(patch as Record<string, unknown>).sale_price = sale
      }
      // Compare cascades to compare-synced children only
      if (v.compare_price_synced_with_parent) {
        ;(patch as Record<string, unknown>).compare_price = compare
      }
      // Weight cascades to weight-synced children only (only if a weight was entered)
      if (v.weight_synced_with_parent && parentWeight) {
        ;(patch as Record<string, unknown>).weight_kg = weight
      }
      return Object.keys(patch).length > 0 ? { ...v, ...patch } : v
    })
    onVariantsChange(updated)

    const costCount = group.children.filter((c) => c.cost_price_synced_with_parent).length
    const saleCount = group.children.filter((c) => c.sale_price_synced_with_parent).length
    const compareCount = group.children.filter((c) => c.compare_price_synced_with_parent).length
    const weightCount = parentWeight ? group.children.filter((c) => c.weight_synced_with_parent).length : 0
    toast.success(
      `Applied to group — Cost: ${costCount}, Sale: ${saleCount}, Compare: ${compareCount}${parentWeight ? `, Weight: ${weightCount}` : ''} variant(s)`,
    )
  }

  function updateChild(sku: string, patch: Partial<T>) {
    onVariantsChange(allVariants.map((v) => (v.sku === sku ? { ...v, ...patch } : v)))
  }

  // Find the current synced value from siblings (for re-sync)
  function getSyncedSiblingValue(field: 'cost_price' | 'sale_price' | 'compare_price' | 'weight_kg'): number | null | undefined {
    const synced = group.children.find((c) => {
      if (field === 'cost_price') return c.cost_price_synced_with_parent
      if (field === 'sale_price') return c.sale_price_synced_with_parent
      if (field === 'compare_price') return c.compare_price_synced_with_parent
      return c.weight_synced_with_parent
    })
    if (synced) return synced[field] as number | null
    // Fall back to the parent input value
    if (field === 'cost_price') return Number(parentCost)
    if (field === 'sale_price') return Number(parentSale)
    if (field === 'compare_price') return parentCompare ? Number(parentCompare) : null
    return parentWeight ? Number(parentWeight) : null
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        {/* Collapsible header */}
        <div
          className="flex items-center justify-between cursor-pointer"
          onClick={onToggle}
        >
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold">{group.parentValue}</span>
            <Badge variant="secondary" className="text-[10px]">
              {group.children.length} variant{group.children.length === 1 ? '' : 's'}
            </Badge>
          </div>
          <Button variant="ghost" size="sm" className="h-7 text-xs">
            {expanded ? 'Collapse' : 'Expand'}
          </Button>
        </div>

        {expanded && (
          <>
            {/* Parent group inputs */}
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
              showWeight={canEdit}
              canEditCost={canEdit}
              canEditPrice={canEdit}
              canEditWeight={canEdit}
              applying={false}
            />

            {/* Children table */}
            <div className="rounded-md border overflow-x-auto scrollbar-thin">
              <table className="w-full text-sm">
                <thead className="bg-muted/30">
                  <tr className="text-left text-xs text-muted-foreground">
                    {childAttrKeys.map((k) => (
                      <th key={k} className="px-3 py-2 font-medium">{k}</th>
                    ))}
                    <th className="px-3 py-2 font-medium">SKU</th>
                    <th className="px-3 py-2 font-medium">Fulfillment</th>
                    <th className="px-3 py-2 font-medium text-right">Cost</th>
                    <th className="px-3 py-2 font-medium text-right">Sale</th>
                    <th className="px-3 py-2 font-medium text-right">Compare</th>
                    <th className="px-3 py-2 font-medium text-right">Weight (kg)</th>
                    <th className="px-3 py-2 font-medium text-center">Active</th>
                    <th className="px-3 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {group.children.map((child) => (
                    <GroupedChildRow
                      key={child.sku}
                      child={child}
                      childAttrKeys={childAttrKeys}
                      canEdit={canEdit}
                      onUpdate={(patch) => updateChild(child.sku, patch)}
                      onResyncCost={() => {
                        const val = getSyncedSiblingValue('cost_price')
                        if (val == null) return
                        updateChild(child.sku, {
                          cost_price: val,
                          cost_price_synced_with_parent: true,
                        } as Partial<T>)
                        toast.success(`Re-synced cost with parent (Rs. ${val})`)
                      }}
                      onResyncSale={() => {
                        const val = getSyncedSiblingValue('sale_price')
                        if (val == null) return
                        updateChild(child.sku, {
                          sale_price: val,
                          sale_price_synced_with_parent: true,
                        } as Partial<T>)
                        toast.success(`Re-synced sale price with parent (Rs. ${val})`)
                      }}
                      onResyncCompare={() => {
                        const val = getSyncedSiblingValue('compare_price')
                        updateChild(child.sku, {
                          compare_price: val,
                          compare_price_synced_with_parent: true,
                        } as Partial<T>)
                        toast.success('Re-synced compare price with parent')
                      }}
                      onResyncWeight={() => {
                        const val = getSyncedSiblingValue('weight_kg')
                        updateChild(child.sku, {
                          weight_kg: val,
                          weight_synced_with_parent: true,
                        } as Partial<T>)
                        toast.success(`Re-synced weight with parent${val != null ? ` (${val} kg)` : ''}`)
                      }}
                      canResync={
                        group.children.some((c) => c.cost_price_synced_with_parent && c.sku !== child.sku) ||
                        !!firstSyncedCost
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ──────────────────────────────────────────────────────────────
// Grouped child row — with sync indicators + re-sync actions
// ──────────────────────────────────────────────────────────────

function GroupedChildRow<T extends WizardGroupableVariant>({
  child,
  childAttrKeys,
  canEdit,
  onUpdate,
  onResyncCost,
  onResyncSale,
  onResyncCompare,
  onResyncWeight,
  canResync,
}: {
  child: T
  childAttrKeys: string[]
  canEdit: boolean
  onUpdate: (patch: Partial<T>) => void
  onResyncCost: () => void
  onResyncSale: () => void
  onResyncCompare: () => void
  onResyncWeight: () => void
  canResync: boolean
}) {
  const [costValue, setCostValue] = useState(String(child.cost_price))
  const [saleValue, setSaleValue] = useState(child.sale_price != null ? String(child.sale_price) : '')
  const [compareValue, setCompareValue] = useState(child.compare_price != null ? String(child.compare_price) : '')
  const [weightValue, setWeightValue] = useState(child.weight_kg != null ? String(child.weight_kg) : '')

  // Sync local input state when the child's values change externally (e.g. after Apply to Group or re-sync)
  useEffect(() => {
    setCostValue(String(child.cost_price))
  }, [child.cost_price])
  useEffect(() => {
    setSaleValue(child.sale_price != null ? String(child.sale_price) : '')
  }, [child.sale_price])
  useEffect(() => {
    setCompareValue(child.compare_price != null ? String(child.compare_price) : '')
  }, [child.compare_price])
  useEffect(() => {
    setWeightValue(child.weight_kg != null ? String(child.weight_kg) : '')
  }, [child.weight_kg])

  function saveCost() {
    const newCost = Number(costValue)
    if (isNaN(newCost) || newCost < 0) return
    if (newCost === child.cost_price) return
    // Override: flip synced flag to false
    onUpdate({ cost_price: newCost, cost_price_synced_with_parent: false } as Partial<T>)
  }

  function saveWeight() {
    const newWeight = weightValue ? Number(weightValue) : null
    if (weightValue && (isNaN(newWeight as number) || (newWeight as number) < 0)) return
    if (newWeight === child.weight_kg) return
    // Override: flip synced flag to false
    onUpdate({ weight_kg: newWeight, weight_synced_with_parent: false } as Partial<T>)
  }

  function saveSale() {
    const newSale = Number(saleValue)
    if (isNaN(newSale) || newSale < 0) return
    const newCompare = compareValue ? Number(compareValue) : null
    const patch: Partial<T> = {}
    if (newSale !== child.sale_price) {
      ;(patch as Record<string, unknown>).sale_price = newSale
      ;(patch as Record<string, unknown>).sale_price_synced_with_parent = false
    }
    if (newCompare !== child.compare_price) {
      ;(patch as Record<string, unknown>).compare_price = newCompare
      ;(patch as Record<string, unknown>).compare_price_synced_with_parent = false
    }
    if (Object.keys(patch).length > 0) onUpdate(patch)
  }

  function toggleActive() {
    onUpdate({ is_active: !child.is_active } as Partial<T>)
  }

  return (
    <tr className="border-t hover:bg-muted/20">
      {childAttrKeys.map((k) => (
        <td key={k} className="px-3 py-2 text-xs">{child.attribute_values[k] ?? '—'}</td>
      ))}
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          {canEdit ? (
            <Input
              value={child.sku}
              onChange={(e) => onUpdate({ sku: e.target.value } as Partial<T>)}
              className="h-7 w-40 text-xs font-mono"
            />
          ) : (
            <span className="font-mono text-xs">{child.sku}</span>
          )}
          {child.is_default && <Badge variant="secondary" className="text-[9px] py-0 px-1">DEFAULT</Badge>}
        </div>
      </td>
      <td className="px-3 py-2">
        {canEdit ? (
          <Select
            value={child.fulfillment_type}
            onValueChange={(val) => onUpdate({ fulfillment_type: val } as Partial<T>)}
          >
            <SelectTrigger className="h-7 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stock_based">Stock Tracked</SelectItem>
              <SelectItem value="made_to_order">Made to Order</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <FulfillmentTypeBadge type={child.fulfillment_type} />
        )}
      </td>
      {/* Cost with sync indicator */}
      <td className="px-3 py-2">
        <div className="flex items-center gap-1 justify-end">
          {canEdit ? (
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
            <span className="text-xs">{child.cost_price}</span>
          )}
          <SyncIndicator synced={child.cost_price_synced_with_parent} />
        </div>
      </td>
      {/* Sale with sync indicator */}
      <td className="px-3 py-2">
        <div className="flex items-center gap-1 justify-end">
          {canEdit ? (
            <Input
              type="number"
              min="0"
              step="0.01"
              value={saleValue}
              onChange={(e) => setSaleValue(e.target.value)}
              onBlur={saveSale}
              className="h-7 w-20 text-xs text-right"
            />
          ) : (
            <span className="text-xs">{child.sale_price ?? '—'}</span>
          )}
          <SyncIndicator synced={child.sale_price_synced_with_parent} />
        </div>
      </td>
      {/* Compare with sync indicator */}
      <td className="px-3 py-2">
        <div className="flex items-center gap-1 justify-end">
          {canEdit ? (
            <Input
              type="number"
              min="0"
              step="0.01"
              value={compareValue}
              onChange={(e) => setCompareValue(e.target.value)}
              onBlur={saveSale}
              className="h-7 w-20 text-xs text-right"
            />
          ) : (
            <span className="text-xs text-muted-foreground">{child.compare_price ?? '—'}</span>
          )}
          <SyncIndicator synced={child.compare_price_synced_with_parent} />
        </div>
      </td>
      {/* Weight (kg) with sync indicator */}
      <td className="px-3 py-2">
        <div className="flex items-center gap-1 justify-end">
          {canEdit ? (
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
            <span className="text-xs text-muted-foreground">{child.weight_kg ?? '—'}</span>
          )}
          <SyncIndicator synced={child.weight_synced_with_parent ?? true} />
        </div>
      </td>
      <td className="px-3 py-2 text-center">
        <Switch checked={child.is_active} onCheckedChange={toggleActive} disabled={!canEdit} />
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          {canEdit && !child.cost_price_synced_with_parent && (
            <ResyncButton
              label="Cost"
              onClick={onResyncCost}
              disabled={!canResync}
              title={canResync ? 'Re-sync cost with parent' : 'No synced siblings to sync from yet'}
            />
          )}
          {canEdit && !child.sale_price_synced_with_parent && (
            <ResyncButton
              label="Price"
              onClick={onResyncSale}
              disabled={!canResync}
              title={canResync ? 'Re-sync sale price with parent' : 'No synced siblings to sync from yet'}
            />
          )}
          {canEdit && !child.compare_price_synced_with_parent && (
            <ResyncButton
              label="Compare"
              onClick={onResyncCompare}
              disabled={!canResync}
              title={canResync ? 'Re-sync compare price with parent' : 'No synced siblings to sync from yet'}
            />
          )}
          {canEdit && !(child.weight_synced_with_parent ?? true) && (
            <ResyncButton
              label="Wt"
              onClick={onResyncWeight}
              disabled={!canResync}
              title={canResync ? 'Re-sync weight with parent' : 'No synced siblings to sync from yet'}
            />
          )}
        </div>
      </td>
    </tr>
  )
}

// ──────────────────────────────────────────────────────────────
// Flat table — for single-attribute or zero-attribute products
// (same visual layout as the wizard's existing flat preview table)
// ──────────────────────────────────────────────────────────────

function FlatVariantTable<T extends WizardGroupableVariant>({
  variants,
  canEdit,
  onVariantsChange,
}: {
  variants: T[]
  canEdit: boolean
  onVariantsChange: (v: T[]) => void
}) {
  // Collect the union of attribute keys across all variants
  const attributeKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const v of variants) {
      for (const k of Object.keys(v.attribute_values)) keys.add(k)
    }
    return Array.from(keys)
  }, [variants])

  function updateChild(sku: string, patch: Partial<T>) {
    onVariantsChange(variants.map((v) => (v.sku === sku ? { ...v, ...patch } : v)))
  }

  if (variants.length === 0) {
    return (
      <p className="text-xs text-muted-foreground text-center py-4 border border-dashed rounded-lg">
        No variants generated yet.
      </p>
    )
  }

  return (
    <div className="rounded-lg border overflow-hidden">
      <div className="flex items-center justify-between p-3 border-b bg-muted/30">
        <p className="text-sm font-medium">
          Generated variants ({variants.length})
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
                <th key={k} className="px-3 py-2 font-medium">{k}</th>
              ))}
              <th className="px-3 py-2 font-medium">SKU</th>
              <th className="px-3 py-2 font-medium">Cost</th>
              <th className="px-3 py-2 font-medium">Fulfillment</th>
              <th className="px-3 py-2 font-medium">Sale price</th>
              <th className="px-3 py-2 font-medium">Weight (kg)</th>
              <th className="px-3 py-2 font-medium text-center">Active</th>
            </tr>
          </thead>
          <tbody>
            {variants.map((v, i) => (
              <FlatChildRow
                key={v.sku}
                variant={v}
                attributeKeys={attributeKeys}
                canEdit={canEdit}
                onUpdate={(patch) => updateChild(v.sku, patch)}
                index={i}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function FlatChildRow<T extends WizardGroupableVariant>({
  variant,
  attributeKeys,
  canEdit,
  onUpdate,
}: {
  variant: T
  attributeKeys: string[]
  canEdit: boolean
  onUpdate: (patch: Partial<T>) => void
  index: number
}) {
  return (
    <tr className="border-t">
      {attributeKeys.map((k) => (
        <td key={k} className="px-3 py-2 text-xs">
          {variant.attribute_values[k] ?? '—'}
        </td>
      ))}
      <td className="px-3 py-2">
        <Input
          value={variant.sku}
          onChange={(e) => onUpdate({ sku: e.target.value } as Partial<T>)}
          className="h-8 w-40 text-xs font-mono"
          disabled={!canEdit}
        />
      </td>
      <td className="px-3 py-2">
        <Input
          type="number"
          min="0"
          step="0.01"
          value={variant.cost_price || ''}
          onChange={(e) => onUpdate({ cost_price: Number(e.target.value) } as Partial<T>)}
          className="h-8 w-20 text-xs"
          disabled={!canEdit}
        />
      </td>
      <td className="px-3 py-2">
        <Select
          value={variant.fulfillment_type}
          onValueChange={(val) => onUpdate({ fulfillment_type: val } as Partial<T>)}
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
          value={variant.sale_price || ''}
          onChange={(e) => onUpdate({ sale_price: Number(e.target.value) } as Partial<T>)}
          className="h-8 w-24 text-xs"
          disabled={!canEdit}
        />
      </td>
      <td className="px-3 py-2">
        <Input
          type="number"
          min="0"
          step="0.001"
          value={variant.weight_kg ?? ''}
          onChange={(e) => onUpdate({ weight_kg: e.target.value ? Number(e.target.value) : null, weight_synced_with_parent: false } as Partial<T>)}
          className="h-8 w-20 text-xs"
          disabled={!canEdit}
          placeholder="—"
        />
      </td>
      <td className="px-3 py-2 text-center">
        <Switch
          checked={variant.is_active}
          onCheckedChange={(c) => onUpdate({ is_active: c } as Partial<T>)}
          disabled={!canEdit}
        />
      </td>
    </tr>
  )
}
