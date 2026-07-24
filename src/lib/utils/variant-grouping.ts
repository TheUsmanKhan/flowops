/**
 * Shared, pure, side-effect-free variant grouping utilities.
 *
 * This file is the SINGLE SOURCE OF TRUTH for "which attribute is the
 * parent" and "how variants group under it". It is imported by:
 *   - The server-side API route powering GET /api/products/{id}/variant-groups
 *     (the edit page's ParentChildVariantTable)
 *   - The client-side ClientSideParentChildVariantTable used in the product
 *     creation wizard (before the product exists in the database)
 *
 * Both callers MUST use these functions — there must be no duplicate
 * implementation of this logic anywhere else in the codebase. If the
 * logic drifts between the two callers, the creation wizard and the
 * edit page could disagree on what counts as a parent or how children
 * are grouped, which would be a silent correctness bug.
 *
 * This file has NO database calls, NO Supabase client usage, and NO
 * Next.js-specific imports — it is importable from both server and
 * client code.
 */

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

/**
 * A selectable attribute with its display order — the same shape the
 * AttributeSelector produces and the same shape the server fetches
 * from org_attributes.
 */
export interface GroupableAttribute {
  attribute_id: string
  name: string
  display_order: number
}

/**
 * The minimum shape a variant needs to be groupable. Any extra fields
 * (sku, cost_price, sale_price, fulfillment_type, etc.) pass through
 * untouched — the grouping functions are generic over the full variant
 * type so callers don't lose any data.
 */
export interface GroupableVariant {
  /** Stable identifier (real UUID for persisted variants, or a temp client-side key) */
  id: string
  /** e.g. { "Piece Type": "Stitched", "Size": "M" } */
  attribute_values: Record<string, string>
}

export interface VariantGroup<T extends GroupableVariant> {
  parentValue: string
  children: T[]
}

export interface GroupingResult<T extends GroupableVariant> {
  hasMeaningfulGrouping: boolean
  parentAttributeName: string | null
  groups: VariantGroup<T>[]
}

// ──────────────────────────────────────────────────────────────
// Functions
// ──────────────────────────────────────────────────────────────

/**
 * Determine which attribute is the "parent" — the one with the lowest
 * display_order among the provided list.
 *
 * Returns null if the list is empty.
 * If there is only one attribute, still returns it — the caller decides
 * whether grouping is meaningful with just one attribute (see
 * groupVariantsByParentAttribute).
 *
 * Ties are broken by input order (the first attribute encountered at
 * the minimum display_order wins), matching Array.prototype.sort stability.
 */
export function determineParentAttribute(
  selectedAttributes: GroupableAttribute[],
): GroupableAttribute | null {
  if (selectedAttributes.length === 0) return null

  let lowest: GroupableAttribute | null = null
  for (const attr of selectedAttributes) {
    if (lowest === null || attr.display_order < lowest.display_order) {
      lowest = attr
    }
  }
  return lowest
}

/**
 * Group variants by their value for the parent attribute.
 *
 * If parentAttributeName is null, OR if there are fewer than 2 distinct
 * attribute keys across all variants (i.e. there's no child dimension to
 * group by — a single-attribute product), returns
 * hasMeaningfulGrouping: false with a single group containing all variants.
 * The caller can then render a flat table instead.
 *
 * Otherwise, buckets variants by their value for parentAttributeName,
 * preserving input order within each bucket, and returns
 * hasMeaningfulGrouping: true.
 *
 * Variants that don't have the parent attribute key are bucketed under
 * the fallback value "—".
 */
export function groupVariantsByParentAttribute<T extends GroupableVariant>(
  variants: T[],
  parentAttributeName: string | null,
): GroupingResult<T> {
  // No parent attribute → no meaningful grouping
  if (parentAttributeName === null || variants.length === 0) {
    return {
      hasMeaningfulGrouping: false,
      parentAttributeName: null,
      groups: [{ parentValue: 'All variants', children: [...variants] }],
    }
  }

  // Count distinct attribute keys across all variants to determine
  // whether there's a child dimension (2+ attributes = meaningful grouping).
  const allAttributeKeys = new Set<string>()
  for (const v of variants) {
    for (const key of Object.keys(v.attribute_values)) {
      allAttributeKeys.add(key)
    }
  }

  if (allAttributeKeys.size < 2) {
    // Single-attribute (or zero-attribute) product — no parent-child hierarchy
    return {
      hasMeaningfulGrouping: false,
      parentAttributeName,
      groups: [{ parentValue: 'All variants', children: [...variants] }],
    }
  }

  // Bucket variants by parent attribute value, preserving input order
  const groupMap = new Map<string, T[]>()
  const groupOrder: string[] = []

  for (const v of variants) {
    const parentValue = v.attribute_values[parentAttributeName] ?? '—'
    if (!groupMap.has(parentValue)) {
      groupMap.set(parentValue, [])
      groupOrder.push(parentValue)
    }
    groupMap.get(parentValue)!.push(v)
  }

  return {
    hasMeaningfulGrouping: true,
    parentAttributeName,
    groups: groupOrder.map((parentValue) => ({
      parentValue,
      children: groupMap.get(parentValue)!,
    })),
  }
}

/**
 * Convenience: compute the full grouping from the variant list + the
 * selected attributes in one call. This is the typical entry point for
 * both the server endpoint and the wizard.
 */
export function computeVariantGrouping<T extends GroupableVariant>(
  variants: T[],
  selectedAttributes: GroupableAttribute[],
): GroupingResult<T> {
  const parent = determineParentAttribute(selectedAttributes)
  return groupVariantsByParentAttribute(variants, parent?.name ?? null)
}
