'use client'

/**
 * Shared presentational sub-components for variant tables.
 *
 * Used by BOTH:
 *   - The edit-page ParentChildVariantTable (server-backed, calls API mutations)
 *   - The creation-wizard ClientSideParentChildVariantTable (local-state-backed)
 *
 * These components are purely presentational — they receive data + callbacks
 * and render. The PARENT component decides whether the callbacks call a
 * server mutation or update local state. This guarantees the visual markup
 * is never duplicated between the two contexts.
 */

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  ChevronDown,
  ChevronRight,
  Link2,
  Unlink,
  RefreshCw,
  Loader2,
  Check,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ──────────────────────────────────────────────────────────────
// Sync indicator — the 🔗 synced / 🔓 overridden icon
// ──────────────────────────────────────────────────────────────

export function SyncIndicator({
  synced,
  className,
}: {
  synced: boolean
  className?: string
}) {
  return synced ? (
    <Link2 className={cn('h-3 w-3 text-emerald-500', className)} />
  ) : (
    <Unlink className={cn('h-3 w-3 text-amber-500', className)} />
  )
}

// ──────────────────────────────────────────────────────────────
// Parent group header — collapsible header with parent inputs
// ──────────────────────────────────────────────────────────────

export function ParentGroupHeader({
  parentValue,
  childCount,
  expanded,
  onToggle,
  parentCost,
  parentSale,
  parentCompare,
  onCostChange,
  onSaleChange,
  onCompareChange,
  onApplyCost,
  onApplySale,
  showCost,
  showPricing,
  canEditCost,
  canEditPrice,
  applying,
}: {
  parentValue: string
  childCount: number
  expanded: boolean
  onToggle: () => void
  parentCost: string
  parentSale: string
  parentCompare: string
  onCostChange: (v: string) => void
  onSaleChange: (v: string) => void
  onCompareChange: (v: string) => void
  onApplyCost: () => void
  onApplySale: () => void
  showCost: boolean
  showPricing: boolean
  canEditCost: boolean
  canEditPrice: boolean
  applying: boolean
}) {
  return (
    <div
      className="flex items-center justify-between cursor-pointer pb-3"
      onClick={onToggle}
    >
      <div className="flex items-center gap-2">
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <span className="text-base font-semibold">{parentValue}</span>
        <Badge variant="secondary" className="text-[10px]">
          {childCount} variant{childCount === 1 ? '' : 's'}
        </Badge>
      </div>
    </div>
  )
}

/**
 * The parent group input row — Cost Price + Sale Price + Compare Price +
 * a single "Apply to Group" button that cascades ALL THREE fields
 * independently to their respective synced children.
 *
 * Bug 1 fix: previously there were TWO separate Apply buttons ("Apply" for
 * cost, "Apply to Group" for sale+compare), which caused users to only
 * cascade sale price and miss cost/compare. Now there is ONE button that
 * cascades all three fields at once — each field only updates children
 * whose relevant synced flag is true, so the three flags remain
 * INDEPENDENT (cost_price_synced_with_parent, sale_price_synced_with_parent,
 * compare_price_synced_with_parent).
 */
export function ParentGroupInputs({
  parentCost,
  parentSale,
  parentCompare,
  parentWeight,
  onCostChange,
  onSaleChange,
  onCompareChange,
  onWeightChange,
  onApplyAll,
  showCost,
  showPricing,
  showWeight,
  canEditCost,
  canEditPrice,
  canEditWeight,
  applying,
}: {
  parentCost: string
  parentSale: string
  parentCompare: string
  parentWeight?: string
  onCostChange: (v: string) => void
  onSaleChange: (v: string) => void
  onCompareChange: (v: string) => void
  onWeightChange?: (v: string) => void
  /** Single handler that cascades cost + sale + compare (+ weight if shown) to synced children. */
  onApplyAll: () => void
  showCost: boolean
  showPricing: boolean
  showWeight?: boolean
  canEditCost: boolean
  canEditPrice: boolean
  canEditWeight?: boolean
  applying: boolean
}) {
  return (
    <div className="rounded-lg bg-muted/30 p-3 space-y-3">
      <p className="text-xs font-medium text-muted-foreground">
        Parent Group — applies to all synced children
      </p>
      <div className="flex flex-wrap items-end gap-3">
        {showCost && canEditCost && (
          <div className="space-y-1">
            <Label className="text-xs">Cost Price</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={parentCost}
              onChange={(e) => onCostChange(e.target.value)}
              className="h-8 w-28 text-sm"
              placeholder="0.00"
            />
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
                onChange={(e) => onSaleChange(e.target.value)}
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
                onChange={(e) => onCompareChange(e.target.value)}
                className="h-8 w-28 text-sm"
                placeholder="0.00"
              />
            </div>
          </>
        )}
        {showWeight && canEditWeight && (
          <div className="space-y-1">
            <Label className="text-xs">Weight (kg)</Label>
            <Input
              type="number"
              min="0"
              step="0.001"
              value={parentWeight ?? ''}
              onChange={(e) => onWeightChange?.(e.target.value)}
              className="h-8 w-24 text-sm"
              placeholder="0.000"
            />
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={onApplyAll}
          disabled={applying}
          className="mb-0.5"
        >
          {applying ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}{' '}
          Apply to Group
        </Button>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Weight cell — weight (kg) with sync indicator (mirrors CostCell)
// ──────────────────────────────────────────────────────────────

export function WeightCell({
  value,
  synced,
  canEdit,
  onChange,
  onSave,
}: {
  value: string
  synced: boolean
  canEdit: boolean
  onChange: (v: string) => void
  onSave: () => void
}) {
  return (
    <td className="px-3 py-2">
      <div className="flex items-center gap-1 justify-end">
        {canEdit ? (
          <Input
            type="number"
            min="0"
            step="0.001"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onSave}
            className="h-7 w-20 text-xs text-right"
            placeholder="—"
          />
        ) : (
          <span className="text-xs">{value || '—'}</span>
        )}
        <SyncIndicator synced={synced} />
      </div>
    </td>
  )
}

// ──────────────────────────────────────────────────────────────
// Price cells — cost / sale / compare with sync indicators
// ──────────────────────────────────────────────────────────────

export function CostCell({
  value,
  synced,
  canEdit,
  onChange,
  onSave,
}: {
  value: string
  synced: boolean
  canEdit: boolean
  onChange: (v: string) => void
  onSave: () => void
}) {
  return (
    <td className="px-3 py-2">
      <div className="flex items-center gap-1 justify-end">
        {canEdit ? (
          <Input
            type="number"
            min="0"
            step="0.01"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onSave}
            className="h-7 w-20 text-xs text-right"
          />
        ) : (
          <span className="text-xs">{value}</span>
        )}
        <SyncIndicator synced={synced} />
      </div>
    </td>
  )
}

export function SaleCell({
  value,
  synced,
  canEdit,
  onChange,
  onSave,
}: {
  value: string
  synced: boolean
  canEdit: boolean
  onChange: (v: string) => void
  onSave: () => void
}) {
  return (
    <td className="px-3 py-2">
      <div className="flex items-center gap-1 justify-end">
        {canEdit ? (
          <Input
            type="number"
            min="0"
            step="0.01"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onSave}
            className="h-7 w-20 text-xs text-right"
          />
        ) : (
          <span className="text-xs">{value || '—'}</span>
        )}
        <SyncIndicator synced={synced} />
      </div>
    </td>
  )
}

export function CompareCell({
  value,
  canEdit,
  onChange,
  onSave,
}: {
  value: string
  canEdit: boolean
  onChange: (v: string) => void
  onSave: () => void
}) {
  return (
    <td className="px-3 py-2">
      <div className="flex items-center gap-1 justify-end">
        {canEdit ? (
          <Input
            type="number"
            min="0"
            step="0.01"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onSave}
            className="h-7 w-20 text-xs text-right"
          />
        ) : (
          <span className="text-xs text-muted-foreground">{value || '—'}</span>
        )}
      </div>
    </td>
  )
}

// ──────────────────────────────────────────────────────────────
// Re-sync button — shown on overridden children
// ──────────────────────────────────────────────────────────────

export function ResyncButton({
  label,
  onClick,
  disabled,
  title,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 px-2 text-[10px]"
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      <RefreshCw className="h-3 w-3" /> {label}
    </Button>
  )
}
