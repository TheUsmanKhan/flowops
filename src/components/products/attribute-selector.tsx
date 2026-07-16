'use client'

// ============================================================================
// FlowOps — Generic AttributeSelector
// ----------------------------------------------------------------------------
// Replaces the hardcoded Size/Stitching UI in the variant builder with a
// fully attribute-driven system. Reads attributes + conditional rules from
// /api/catalog/available-attributes, lets the user toggle attributes (max 3),
// pick values per attribute, create new values inline, and create new
// attributes inline. Rule enforcement is GENERIC — driven entirely by the
// `rules` payload, never hardcoded to "Piece Type" / "Size" / "Unstitched".
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, FetchError } from '@/lib/api-client'
import { useCan } from '@/stores/app-store'
import { PERMISSIONS } from '@/lib/permissions'
import { cn } from '@/lib/utils'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Plus,
  Check,
  X,
  Lock,
  ChevronDown,
  Palette,
  Tag,
  Loader2,
  AlertCircle,
  Trash2,
  Sparkles,
} from 'lucide-react'

// ============================================================================
// Public Types
// ============================================================================

export interface AttributeValueOption {
  id: string
  value: string
  displayValue: string
  colorHex: string | null
  skuCode: string | null
  displayOrder: number
}

export interface AttributeOption {
  id: string
  name: string
  displayName: string
  attributeType: 'select' | 'color'
  displayOrder: number
  values: AttributeValueOption[]
}

export interface AttributeRule {
  id: string
  triggerValueId: string
  triggerValueInfo: { id: string; value: string; attributeId: string }
  forcesAttributeId: string
  forcesAttributeName: string
  forcesValueId: string
  forcesValueInfo: { id: string; value: string; displayValue: string }
}

interface AvailableAttributesResponse {
  attributes: AttributeOption[]
  rules: AttributeRule[]
}

export interface SelectionStateValue {
  value_id: string
  value: string
  display_value: string
  sku_code: string | null
}

export interface SelectionStateAttribute {
  attribute_id: string
  attribute_name: string
  display_order: number
  selected_values: SelectionStateValue[]
}

export interface SelectionState {
  selectedAttributes: SelectionStateAttribute[]
}

interface AttributeSelectorProps {
  onChange: (selection: SelectionState) => void
  initialSelection?: SelectionState
}

// ============================================================================
// Constants
// ============================================================================

const MAX_ATTRIBUTES = 3
const MAX_3_TOOLTIP =
  'Products can use up to 3 attributes (Shopify compatibility). Uncheck one to select a different attribute.'

// ============================================================================
// Main component
// ============================================================================

export function AttributeSelector({ onChange, initialSelection }: AttributeSelectorProps) {
  const queryClient = useQueryClient()
  const can = useCan()
  const canManageCatalog = can(PERMISSIONS.PRODUCTS_MANAGE_CATALOG)

  // -- State: which attributes are checked, which values are picked per
  // attribute, which values are auto-locked by rules, which attribute blocks
  // are collapsed.
  const [selectedAttrs, setSelectedAttrs] = useState<Set<string>>(new Set())
  const [selectedValues, setSelectedValues] = useState<Map<string, Set<string>>>(
    new Map(),
  )
  const [lockedValues, setLockedValues] = useState<Map<string, Set<string>>>(
    new Map(),
  )
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  // Inline creation dialogs
  const [inlineValueAttr, setInlineValueAttr] = useState<AttributeOption | null>(
    null,
  )
  const [inlineAttrOpen, setInlineAttrOpen] = useState(false)

  // ---- Fetch attributes + rules
  const {
    data,
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useQuery<AvailableAttributesResponse>({
    queryKey: ['available-attributes'],
    queryFn: () =>
      api.get<AvailableAttributesResponse>('/api/catalog/available-attributes'),
    staleTime: 30_000,
  })

  const attributes = useMemo(() => data?.attributes ?? [], [data])
  const rules = useMemo(() => data?.rules ?? [], [data])

  // ---- Recompute locked values from current selection + rules.
  // A lock applies when (a) the trigger value is currently selected AND
  // (b) the forced attribute is currently selected. Locked values cannot be
  // deselected by the user.
  const recomputeLocks = useCallback(
    (
      attrIds: Set<string>,
      valueMap: Map<string, Set<string>>,
      ruleList: AttributeRule[],
    ): Map<string, Set<string>> => {
      const locks = new Map<string, Set<string>>()
      for (const rule of ruleList) {
        const triggerAttrId = rule.triggerValueInfo.attributeId
        const triggerSelected =
          valueMap.get(triggerAttrId)?.has(rule.triggerValueId) ?? false
        if (!triggerSelected) continue
        if (!attrIds.has(rule.forcesAttributeId)) continue
        if (!locks.has(rule.forcesAttributeId)) {
          locks.set(rule.forcesAttributeId, new Set())
        }
        locks.get(rule.forcesAttributeId)!.add(rule.forcesValueId)
      }
      return locks
    },
    [],
  )

  // ---- Initialize from initialSelection once data arrives.
  const initedRef = useRef(false)
  useEffect(() => {
    if (!data || initedRef.current) return
    initedRef.current = true
    if (!initialSelection || initialSelection.selectedAttributes.length === 0) {
      return
    }
    const attrIds = new Set<string>()
    const valueMap = new Map<string, Set<string>>()
    for (const attr of initialSelection.selectedAttributes) {
      attrIds.add(attr.attribute_id)
      valueMap.set(
        attr.attribute_id,
        new Set(attr.selected_values.map((v) => v.value_id)),
      )
    }
    setSelectedAttrs(attrIds)
    setSelectedValues(valueMap)
    setLockedValues(recomputeLocks(attrIds, valueMap, rules))
  }, [data, initialSelection, rules, recomputeLocks])

  // ---- Build the SelectionState to emit
  const selectionState: SelectionState = useMemo(() => {
    const out: SelectionStateAttribute[] = []
    for (const attr of attributes) {
      if (!selectedAttrs.has(attr.id)) continue
      const vals = selectedValues.get(attr.id)
      if (!vals || vals.size === 0) continue
      const selectedValueObjects = attr.values
        .filter((v) => vals.has(v.id))
        .map((v) => ({
          value_id: v.id,
          value: v.value,
          display_value: v.displayValue,
          sku_code: v.skuCode ?? null,
        }))
      if (selectedValueObjects.length === 0) continue
      out.push({
        attribute_id: attr.id,
        attribute_name: attr.name,
        display_order: attr.displayOrder,
        selected_values: selectedValueObjects,
      })
    }
    out.sort((a, b) => a.display_order - b.display_order)
    return { selectedAttributes: out }
  }, [attributes, selectedAttrs, selectedValues])

  // ---- Emit selection on every change. Use a stable onChange ref so we
  // don't re-fire when the parent passes an inline function.
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])
  useEffect(() => {
    onChangeRef.current(selectionState)
  }, [selectionState])

  // ---- Handlers
  function toggleAttribute(attr: AttributeOption) {
    setSelectedAttrs((prev) => {
      const next = new Set(prev)
      if (next.has(attr.id)) {
        next.delete(attr.id)
        setSelectedValues((v) => {
          const nv = new Map(v)
          nv.delete(attr.id)
          setLockedValues(recomputeLocks(next, nv, rules))
          return nv
        })
      } else {
        if (next.size >= MAX_ATTRIBUTES) return prev
        next.add(attr.id)
        // No values yet for this attribute — just recompute locks.
        setLockedValues(recomputeLocks(next, selectedValues, rules))
      }
      return next
    })
  }

  function toggleValue(attr: AttributeOption, value: AttributeValueOption) {
    const isLocked = lockedValues.get(attr.id)?.has(value.id) ?? false
    setSelectedValues((prev) => {
      const next = new Map(prev)
      const cur = new Set(next.get(attr.id) ?? [])
      if (cur.has(value.id)) {
        if (isLocked) {
          toast.info('This value is auto-locked by a rule and cannot be removed.')
          return prev
        }
        cur.delete(value.id)
      } else {
        cur.add(value.id)
      }
      if (cur.size === 0) {
        next.delete(attr.id)
      } else {
        next.set(attr.id, cur)
      }
      setLockedValues(recomputeLocks(selectedAttrs, next, rules))
      return next
    })
  }

  function toggleCollapse(attrId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(attrId)) next.delete(attrId)
      else next.add(attrId)
      return next
    })
  }

  // ---- Inline value creation
  const inlineValueMutation = useMutation({
    mutationFn: async (input: {
      attribute_id: string
      value: string
      display_value?: string
      sku_code?: string
      color_hex?: string
    }) =>
      api.post<{
        id: string
        value: string
        displayValue: string
        colorHex: string | null
        skuCode: string | null
        displayOrder: number
      }>('/api/catalog/inline-value', input),
    onSuccess: (created, vars) => {
      // Optimistically update the cache so the new value appears immediately.
      queryClient.setQueryData<AvailableAttributesResponse>(
        ['available-attributes'],
        (old) => {
          if (!old) return old
          return {
            ...old,
            attributes: old.attributes
              .map((a) =>
                a.id === vars.attribute_id
                  ? {
                      ...a,
                      values: [...a.values, created].sort(
                        (x, y) => x.displayOrder - y.displayOrder,
                      ),
                    }
                  : a,
              )
              .sort((a, b) => a.displayOrder - b.displayOrder),
          }
        },
      )
      // Invalidate so a background refetch confirms server state.
      queryClient.invalidateQueries({ queryKey: ['available-attributes'] })
      toast.success(`Value “${created.displayValue}” added.`)

      // Auto-select the new value (and ensure its attribute is checked).
      setSelectedAttrs((prev) => {
        const next = new Set(prev)
        next.add(vars.attribute_id)
        return next
      })
      setSelectedValues((prev) => {
        const next = new Map(prev)
        const cur = new Set(next.get(vars.attribute_id) ?? [])
        cur.add(created.id)
        next.set(vars.attribute_id, cur)
        // Locks depend on the rule list — recompute against the latest cache.
        // We pull the latest rules from the (just-updated) query cache.
        const latest = queryClient.getQueryData<AvailableAttributesResponse>([
          'available-attributes',
        ])
        setLockedValues(
          recomputeLocks(
            new Set([vars.attribute_id, ...selectedAttrs]),
            next,
            latest?.rules ?? rules,
          ),
        )
        return next
      })
      setInlineValueAttr(null)
    },
    onError: (err) => {
      toast.error(
        err instanceof FetchError ? err.message : 'Failed to create value.',
      )
    },
  })

  // ---- Inline attribute creation
  const inlineAttrMutation = useMutation({
    mutationFn: async (input: {
      name: string
      display_name?: string
      attribute_type?: 'select' | 'color'
      initial_values?: Array<{
        value: string
        display_value?: string
        sku_code?: string
        color_hex?: string
      }>
    }) =>
      api.post<{
        id: string
        name: string
        displayName: string
        attributeType: string
        displayOrder: number
        values: Array<{
          id: string
          value: string
          displayValue: string
          colorHex: string | null
          skuCode: string | null
          displayOrder: number
        }>
      }>('/api/catalog/inline-attribute', input),
    onSuccess: (created) => {
      // Optimistically update cache
      queryClient.setQueryData<AvailableAttributesResponse>(
        ['available-attributes'],
        (old) => {
          if (!old) return old
          return {
            ...old,
            attributes: [
              ...old.attributes,
              {
                id: created.id,
                name: created.name,
                displayName: created.displayName,
                attributeType: created.attributeType as 'select' | 'color',
                displayOrder: created.displayOrder,
                values: created.values.map((v) => ({
                  id: v.id,
                  value: v.value,
                  displayValue: v.displayValue,
                  colorHex: v.colorHex,
                  skuCode: v.skuCode,
                  displayOrder: v.displayOrder,
                })),
              },
            ].sort((a, b) => a.displayOrder - b.displayOrder),
          }
        },
      )
      queryClient.invalidateQueries({ queryKey: ['available-attributes'] })
      toast.success(`Attribute “${created.displayName}” created.`)

      // Auto-select the new attribute. If it has initial values, auto-select
      // the first one so the user sees an immediate effect.
      setSelectedAttrs((prev) => {
        const next = new Set(prev)
        next.add(created.id)
        return next
      })
      if (created.values.length > 0) {
        const firstValueId = created.values[0].id
        setSelectedValues((prev) => {
          const next = new Map(prev)
          const cur = new Set(next.get(created.id) ?? [])
          cur.add(firstValueId)
          next.set(created.id, cur)
          return next
        })
      }
      setInlineAttrOpen(false)
    },
    onError: (err) => {
      toast.error(
        err instanceof FetchError ? err.message : 'Failed to create attribute.',
      )
    },
  })

  // ---- Derived: total selected count for the cap
  const selectedCount = selectedAttrs.size
  const atCapacity = selectedCount >= MAX_ATTRIBUTES

  // ---- Render
  if (isLoading) {
    return <AttributeSelectorSkeleton />
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
        <AlertCircle className="h-6 w-6 text-destructive mx-auto mb-2" />
        <p className="text-sm font-medium text-destructive">
          Couldn&apos;t load attributes
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          We couldn&apos;t reach the catalog service.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          {isFetching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <AlertCircle className="h-4 w-4" />
          )}
          Retry
        </Button>
      </div>
    )
  }

  if (attributes.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center">
        <Tag className="h-6 w-6 text-muted-foreground mx-auto mb-2" />
        <p className="text-sm font-medium">No attributes found</p>
        <p className="text-xs text-muted-foreground mt-1">
          Create your first attribute to start building variants.
        </p>
        {canManageCatalog && (
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => setInlineAttrOpen(true)}
          >
            <Plus className="h-4 w-4" /> Create attribute
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Header / capacity indicator */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Select up to{' '}
          <span className="font-medium text-foreground">{MAX_ATTRIBUTES}</span>{' '}
          attributes ({selectedCount}/{MAX_ATTRIBUTES} selected)
        </p>
        {isFetching && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        )}
      </div>

      {/* Attribute blocks */}
      <div className="space-y-2.5">
        {attributes
          .slice()
          .sort((a, b) => a.displayOrder - b.displayOrder)
          .map((attr) => {
            const checked = selectedAttrs.has(attr.id)
            const disabled = !checked && atCapacity
            const isCollapsed = collapsed.has(attr.id)
            const selectedSet = selectedValues.get(attr.id) ?? new Set()
            const lockedSet = lockedValues.get(attr.id) ?? new Set()
            const selectedCountForAttr = selectedSet.size

            return (
              <div
                key={attr.id}
                className={cn(
                  'rounded-lg border transition-all',
                  checked
                    ? 'border-primary/40 bg-primary/[0.03] ring-1 ring-primary/15'
                    : 'border-border bg-card',
                  disabled && 'opacity-60',
                )}
              >
                {/* Header row: checkbox + name + meta + chevron */}
                <div className="flex items-start gap-2.5 p-3">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="pt-0.5 inline-flex">
                        <Checkbox
                          checked={checked}
                          disabled={disabled}
                          onCheckedChange={() => toggleAttribute(attr)}
                          aria-label={`Select attribute ${attr.displayName}`}
                        />
                      </span>
                    </TooltipTrigger>
                    {disabled && (
                      <TooltipContent side="top" className="max-w-xs">
                        {MAX_3_TOOLTIP}
                      </TooltipContent>
                    )}
                  </Tooltip>

                  <button
                    type="button"
                    onClick={() => toggleAttribute(attr)}
                    disabled={disabled}
                    className="flex-1 min-w-0 text-left"
                  >
                    <div className="flex items-center gap-2">
                      {attr.attributeType === 'color' ? (
                        <Palette className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <Tag className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <p
                        className={cn(
                          'text-sm font-medium truncate',
                          checked ? 'text-foreground' : 'text-foreground/80',
                        )}
                      >
                        {attr.displayName}
                      </p>
                      {checked && selectedCountForAttr > 0 && (
                        <Badge
                          variant="secondary"
                          className="text-[10px] h-4 px-1.5"
                        >
                          {selectedCountForAttr} selected
                        </Badge>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {attr.values.length} value
                      {attr.values.length === 1 ? '' : 's'} ·{' '}
                      <code className="font-mono">{attr.name}</code>
                    </p>
                  </button>

                  {checked && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleCollapse(attr.id)
                      }}
                      aria-label={
                        isCollapsed ? 'Expand values' : 'Collapse values'
                      }
                    >
                      <ChevronDown
                        className={cn(
                          'h-4 w-4 transition-transform',
                          isCollapsed && '-rotate-90',
                        )}
                      />
                    </Button>
                  )}
                </div>

                {/* Value pills */}
                {checked && !isCollapsed && (
                  <div className="px-3 pb-3 space-y-2.5">
                    <div className="flex flex-wrap gap-1.5">
                      {attr.values
                        .slice()
                        .sort((a, b) => a.displayOrder - b.displayOrder)
                        .map((v) => {
                          const isSelected = selectedSet.has(v.id)
                          const isLocked = lockedSet.has(v.id)
                          return (
                            <ValuePill
                              key={v.id}
                              value={v}
                              attributeType={attr.attributeType}
                              selected={isSelected}
                              locked={isLocked}
                              onToggle={() => toggleValue(attr, v)}
                            />
                          )
                        })}
                      {attr.values.length === 0 && (
                        <p className="text-xs text-muted-foreground italic">
                          No values yet.
                        </p>
                      )}
                    </div>

                    {canManageCatalog && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => setInlineValueAttr(attr)}
                      >
                        <Plus className="h-3.5 w-3.5" /> Add custom{' '}
                        {attr.displayName}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
      </div>

      {/* Create new attribute button */}
      {canManageCatalog && selectedCount < MAX_ATTRIBUTES && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full border-dashed"
          onClick={() => setInlineAttrOpen(true)}
        >
          <Plus className="h-4 w-4" /> Create new attribute
        </Button>
      )}

      {/* Inline value dialog */}
      {inlineValueAttr && (
        <InlineValueDialog
          attribute={inlineValueAttr}
          open={!!inlineValueAttr}
          onOpenChange={(v) => !v && setInlineValueAttr(null)}
          isPending={inlineValueMutation.isPending}
          onSubmit={(payload) =>
            inlineValueMutation.mutate({
              attribute_id: inlineValueAttr.id,
              ...payload,
            })
          }
        />
      )}

      {/* Inline attribute dialog */}
      <InlineAttributeDialog
        open={inlineAttrOpen}
        onOpenChange={setInlineAttrOpen}
        isPending={inlineAttrMutation.isPending}
        onSubmit={(payload) => inlineAttrMutation.mutate(payload)}
      />

      {/* Rules summary footer — show active rules so the user understands the
          auto-locking behavior. Generic — describes rules by their attribute
          names, never hardcodes "Piece Type" / "Size" / "Unstitched". */}
      {rules.length > 0 && (
        <RulesSummary rules={rules} selectedAttrs={selectedAttrs} />
      )}
    </div>
  )
}

// ============================================================================
// ValuePill — a single toggleable value chip
// ============================================================================

function ValuePill({
  value,
  attributeType,
  selected,
  locked,
  onToggle,
}: {
  value: AttributeValueOption
  attributeType: 'select' | 'color'
  selected: boolean
  locked: boolean
  onToggle: () => void
}) {
  const label = value.displayValue || value.value
  const showSwatch = attributeType === 'color' && !!value.colorHex

  return (
    <button
      type="button"
      onClick={onToggle}
      title={locked ? 'Auto-selected by a rule — cannot be removed' : label}
      className={cn(
        'h-8 px-3 rounded-md border text-xs font-medium inline-flex items-center gap-1.5 transition-all',
        selected
          ? 'border-primary bg-primary text-primary-foreground shadow-sm'
          : 'border-border bg-background hover:border-primary/40 hover:bg-muted/40',
        locked && 'cursor-not-allowed',
      )}
    >
      {showSwatch && (
        <span
          className="h-3 w-3 rounded-full border border-black/10 shrink-0"
          style={{ backgroundColor: value.colorHex ?? undefined }}
          aria-hidden
        />
      )}
      <span className="truncate max-w-[140px]">{label}</span>
      {selected && !locked && (
        <Check className="h-3 w-3 opacity-90 shrink-0" aria-hidden />
      )}
      {locked && (
        <Lock className="h-3 w-3 opacity-90 shrink-0" aria-label="Locked by rule" />
      )}
    </button>
  )
}

// ============================================================================
// InlineValueDialog — create a new value for an attribute
// ============================================================================

function InlineValueDialog({
  attribute,
  open,
  onOpenChange,
  isPending,
  onSubmit,
}: {
  attribute: AttributeOption
  open: boolean
  onOpenChange: (v: boolean) => void
  isPending: boolean
  onSubmit: (payload: {
    value: string
    display_value?: string
    sku_code?: string
    color_hex?: string
  }) => void
}) {
  const isColor = attribute.attributeType === 'color'
  const [value, setValue] = useState('')
  const [skuCode, setSkuCode] = useState('')
  const [colorHex, setColorHex] = useState('#000000')

  // Reset on open
  useEffect(() => {
    if (open) {
      setValue('')
      setSkuCode('')
      setColorHex('#000000')
    }
  }, [open])

  function handleSubmit() {
    const trimmed = value.trim()
    if (trimmed.length < 1) {
      toast.error('Value is required.')
      return
    }
    onSubmit({
      value: trimmed,
      display_value: trimmed,
      sku_code: skuCode.trim() || undefined,
      color_hex: isColor ? colorHex : undefined,
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !isPending && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isColor ? (
              <Palette className="h-4 w-4 text-primary" />
            ) : (
              <Tag className="h-4 w-4 text-primary" />
            )}
            Add custom {attribute.displayName}
          </DialogTitle>
          <DialogDescription>
            Create a new value for the {attribute.displayName} attribute. It
            will be available to all products in your organization.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="iv-value">
              Value <span className="text-destructive">*</span>
            </Label>
            <Input
              id="iv-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={
                isColor ? 'e.g. Navy Blue' : 'e.g. Extra Large'
              }
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleSubmit()
                }
              }}
            />
            <p className="text-xs text-muted-foreground">
              Used both as the value and the display name.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="iv-sku">SKU code (optional)</Label>
            <Input
              id="iv-sku"
              value={skuCode}
              onChange={(e) =>
                setSkuCode(e.target.value.toUpperCase().replace(/\s+/g, ''))
              }
              placeholder="e.g. XL, NAV, BLUE"
            />
            <p className="text-xs text-muted-foreground">
              Leave blank to auto-generate from the value.
            </p>
          </div>

          {isColor && (
            <div className="space-y-1.5">
              <Label htmlFor="iv-color">Color swatch</Label>
              <div className="flex items-center gap-2">
                <input
                  id="iv-color"
                  type="color"
                  value={colorHex}
                  onChange={(e) => setColorHex(e.target.value)}
                  className="h-9 w-12 rounded-md border border-border bg-background cursor-pointer p-1"
                  aria-label="Pick a color"
                />
                <Input
                  value={colorHex}
                  onChange={(e) => setColorHex(e.target.value)}
                  className="font-mono text-sm flex-1"
                  placeholder="#000000"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Shown as a swatch next to the value pill.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isPending || value.trim().length < 1}
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            Add &amp; Use Now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ============================================================================
// InlineAttributeDialog — create a new attribute with optional initial values
// ============================================================================

interface InitialValueRow {
  id: string
  value: string
  skuCode: string
  colorHex: string
}

function InlineAttributeDialog({
  open,
  onOpenChange,
  isPending,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  isPending: boolean
  onSubmit: (payload: {
    name: string
    display_name?: string
    attribute_type?: 'select' | 'color'
    initial_values?: Array<{
      value: string
      display_value?: string
      sku_code?: string
      color_hex?: string
    }>
  }) => void
}) {
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [attrType, setAttrType] = useState<'select' | 'color'>('select')
  const [rows, setRows] = useState<InitialValueRow[]>([
    { id: 'r1', value: '', skuCode: '', colorHex: '#000000' },
  ])

  useEffect(() => {
    if (open) {
      setName('')
      setDisplayName('')
      setAttrType('select')
      setRows([
        { id: 'r1', value: '', skuCode: '', colorHex: '#000000' },
      ])
    }
  }, [open])

  function addRow() {
    setRows((r) => [
      ...r,
      {
        id: `r${Date.now()}`,
        value: '',
        skuCode: '',
        colorHex: '#000000',
      },
    ])
  }
  function removeRow(id: string) {
    setRows((r) => (r.length > 1 ? r.filter((x) => x.id !== id) : r))
  }
  function updateRow(id: string, patch: Partial<InitialValueRow>) {
    setRows((r) => r.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  }

  function handleSubmit() {
    const trimmedName = name.trim()
    if (trimmedName.length < 2) {
      toast.error('Attribute name must be at least 2 characters.')
      return
    }
    // Filter to non-empty rows
    const filledRows = rows.filter((r) => r.value.trim().length > 0)
    const initialValues = filledRows.map((r) => ({
      value: r.value.trim(),
      display_value: r.value.trim(),
      sku_code: r.skuCode.trim() || undefined,
      color_hex: attrType === 'color' ? r.colorHex : undefined,
    }))

    onSubmit({
      name: trimmedName,
      display_name: displayName.trim() || undefined,
      attribute_type: attrType,
      initial_values: initialValues.length > 0 ? initialValues : undefined,
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !isPending && onOpenChange(v)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Create new attribute
          </DialogTitle>
          <DialogDescription>
            Define a new variant attribute for your organization. It will be
            available to all products.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ia-name">
                Key <span className="text-destructive">*</span>
              </Label>
              <Input
                id="ia-name"
                value={name}
                onChange={(e) =>
                  setName(
                    e.target.value.toLowerCase().replace(/[^a-z0-9_\s-]/g, ''),
                  )
                }
                placeholder="e.g. fabric, sleeve, fit"
                className="font-mono lowercase"
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Lowercase, no spaces. Used as the variant key.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ia-display">Display name</Label>
              <Input
                id="ia-display"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. Fabric, Sleeve Length"
              />
              <p className="text-xs text-muted-foreground">
                Leave blank to use the key as the display name.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ia-type">Type</Label>
            <Select
              value={attrType}
              onValueChange={(v) => setAttrType(v as 'select' | 'color')}
            >
              <SelectTrigger id="ia-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="select">
                  <span className="flex items-center gap-2">
                    <Tag className="h-3.5 w-3.5" /> Select — plain text values
                  </span>
                </SelectItem>
                <SelectItem value="color">
                  <span className="flex items-center gap-2">
                    <Palette className="h-3.5 w-3.5" /> Color — values carry a
                    hex swatch
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Initial values */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Initial values (optional)</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={addRow}
              >
                <Plus className="h-3.5 w-3.5" /> Add row
              </Button>
            </div>
            <div className="space-y-2 max-h-56 overflow-y-auto scrollbar-thin pr-1">
              {rows.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-2 rounded-md border p-2 bg-muted/20"
                >
                  {attrType === 'color' && (
                    <input
                      type="color"
                      value={r.colorHex}
                      onChange={(e) =>
                        updateRow(r.id, { colorHex: e.target.value })
                      }
                      className="h-8 w-8 rounded-md border border-border bg-background cursor-pointer p-0.5 shrink-0"
                      aria-label="Color swatch"
                    />
                  )}
                  <Input
                    value={r.value}
                    onChange={(e) => updateRow(r.id, { value: e.target.value })}
                    placeholder="Value (e.g. Red)"
                    className="h-8 text-sm flex-1"
                  />
                  <Input
                    value={r.skuCode}
                    onChange={(e) =>
                      updateRow(r.id, {
                        skuCode: e.target.value
                          .toUpperCase()
                          .replace(/\s+/g, ''),
                      })
                    }
                    placeholder="SKU code"
                    className="h-8 text-sm font-mono w-24"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => removeRow(r.id)}
                    disabled={rows.length === 1}
                    aria-label="Remove row"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Add a few common values to get started. You can add more later.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isPending || name.trim().length < 2}
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            Create &amp; Use Now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ============================================================================
// RulesSummary — surfaces the active rules so the user understands locking
// ============================================================================

function RulesSummary({
  rules,
  selectedAttrs,
}: {
  rules: AttributeRule[]
  selectedAttrs: Set<string>
}) {
  // Only show rules where both attributes are in the current selection.
  const visible = rules.filter(
    (r) =>
      selectedAttrs.has(r.triggerValueInfo.attributeId) &&
      selectedAttrs.has(r.forcesAttributeId),
  )
  if (visible.length === 0) return null

  return (
    <Alert className="border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20">
      <Lock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
      <AlertDescription className="text-xs text-amber-800 dark:text-amber-200">
        <p className="font-medium mb-1">Active rules</p>
        <ul className="space-y-0.5">
          {visible.map((r) => (
            <li key={r.id} className="flex items-start gap-1.5">
              <span className="text-amber-500">•</span>
              <span>
                Selecting <strong>{r.triggerValueInfo.value}</strong> forces{' '}
                <strong>{r.forcesAttributeName}</strong> ={' '}
                <strong>{r.forcesValueInfo.displayValue}</strong>. The forced
                value will be auto-selected and locked.
              </span>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

// ============================================================================
// Loading skeleton
// ============================================================================

function AttributeSelectorSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Skeleton className="h-3.5 w-48" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-lg border p-3 space-y-2.5">
          <div className="flex items-center gap-2.5">
            <Skeleton className="h-4 w-4 rounded" />
            <div className="space-y-1.5 flex-1">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-2.5 w-20" />
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Skeleton className="h-8 w-16 rounded-md" />
            <Skeleton className="h-8 w-12 rounded-md" />
            <Skeleton className="h-8 w-20 rounded-md" />
            <Skeleton className="h-8 w-14 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  )
}

export default AttributeSelector
