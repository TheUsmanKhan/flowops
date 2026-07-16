# SPRINT9-GENERIC-ATTRIBUTES — Work Record

**Task ID:** SPRINT9-GENERIC-ATTRIBUTES
**Agent:** main
**Task:** Build the generic `AttributeSelector` component and refactor `StitchableVariantBuilder` in `product-create-view.tsx` to use it. Replace hardcoded Size/Stitching UI with a fully attribute-driven system.

## Files Created / Modified

### 1. `src/components/products/attribute-selector.tsx` (NEW — ~820 lines)

Generic, reusable attribute-driven variant selector. Designed to drop into any product/variant creation flow.

**Public exports:**
- `AttributeSelector` — the main component
- Types: `AttributeOption`, `AttributeValueOption`, `AttributeRule`, `SelectionState`, `SelectionStateAttribute`, `SelectionStateValue`

**Props:**
```ts
interface AttributeSelectorProps {
  onChange: (selection: SelectionState) => void
  initialSelection?: SelectionState
}
```

**Data fetching:**
- `useQuery({ queryKey: ['available-attributes'], queryFn: () => api.get('/api/catalog/available-attributes') })` with 30s staleTime.
- Returns `{ attributes: AttributeOption[], rules: AttributeRule[] }`.

**Selection UI:**
- Each attribute renders as a checkbox-expandable block (checkbox + name + meta + collapsible chevron).
- Checkbox toggles attribute selection; obeys max-3 cap (remaining checkboxes disabled with tooltip: *"Products can use up to 3 attributes (Shopify compatibility). Uncheck one to select a different attribute."*).
- When checked: show value pills (multi-select toggleable). Color-type attributes show a color swatch + name.
- "+ Add Custom {Attribute Name}" button under each attribute's pills (gated by `PERMISSIONS.PRODUCTS_MANAGE_CATALOG`).
- "+ Create New Attribute" button at the bottom (only when `selectedCount < 3` and user has catalog permission).

**Conditional Rule Enforcement (GENERIC):**
- Maintains `selectedAttrs: Set<string>`, `selectedValues: Map<attributeId, Set<valueId>>`, `lockedValues: Map<attributeId, Set<valueId>>`.
- `recomputeLocks(attrIds, valueMap, ruleList)` — pure function that walks every rule and adds a lock when (a) the trigger value is currently selected AND (b) the forced attribute is currently selected.
- A locked value pill shows a Lock icon and is non-deselectable (toast on click attempt).
- Locks are recomputed on every attribute toggle and every value toggle.
- The `SelectionState` emitted via `onChange` always reflects the *current* selection; rule-violating combinations are filtered at generation time by the backend route (`/api/products/[id]/variants/generate`).
- No hardcoded "Piece Type" / "Size" / "Unstitched" anywhere — the rules payload drives all lock behavior.
- A `RulesSummary` Alert surfaces active rules (only those where both trigger+forced attributes are currently selected) so the user understands the auto-locking.

**Inline Value Creation Dialog (`InlineValueDialog`):**
- Triggered by "+ Add Custom {Attribute Name}".
- Fields: Value text input (required), SKU Code (optional, helper "Leave blank to auto-generate"), Color Hex picker (only if `attributeType === 'color'` — uses native `<input type="color">` + hex text input).
- `[Add & Use Now]` calls `POST /api/catalog/inline-value` with `{ attribute_id, value, display_value, sku_code?, color_hex? }`.
- On success: optimistic `queryClient.setQueryData` (so the new value appears immediately in the pills list), `invalidateQueries(['available-attributes'])` (background refetch confirms server state), toast, auto-select the new value (and ensure its parent attribute is checked), recompute locks.

**Inline Attribute Creation Dialog (`InlineAttributeDialog`):**
- Triggered by "+ Create New Attribute".
- Fields: Key (lowercase, no spaces), Display Name (optional), Type selector (`select` | `color`), Repeatable initial values list (value + optional SKU code + optional color swatch per row, "Add row" button to repeat).
- `[Create & Use Now]` calls `POST /api/catalog/inline-attribute` with `{ name, display_name?, attribute_type?, initial_values?: [{value, display_value?, sku_code?, color_hex?}] }`.
- On success: optimistic `queryClient.setQueryData`, `invalidateQueries(['available-attributes'])`, toast, auto-select the new attribute (and the first initial value if any), recompute locks.

**States:**
- Loading: `AttributeSelectorSkeleton` (3 fake attribute blocks with skeleton pills).
- Error: red-tinted card with retry button.
- Empty: "No attributes found. Create your first attribute to start building variants." with a "Create attribute" button (gated by catalog permission).

**Emission:**
- `useMemo` builds `SelectionState` from `selectedAttrs` × `selectedValues` × the cached `attributes` (for value metadata).
- Sorted by `display_order` ascending.
- Emitted via `useEffect` on every change. Uses an `onChangeRef` to avoid re-firing when the parent passes an inline function.

**Initialization from `initialSelection`:**
- A `useEffect` (guarded by `initedRef`) runs once when data first arrives, hydrating internal state from `initialSelection` and recomputing locks. Subsequent prop changes do NOT re-trigger initialization.

### 2. `src/components/products/product-create-view.tsx` (MODIFIED)

**Imports cleaned:**
- Removed: `Checkbox`, `Skeleton`, `STITCHING_LABELS`, `STANDARD_SIZES`, `DEFAULT_PRODUCTION_DAYS`, `STITCHING_OPTIONS` constant, `formatMoney` helper, `FulfillmentBadge` helper.
- Added: `useCallback`, `useRef`, `Skeleton` (removed), `Sparkles` icon, `AttributeSelector` + `SelectionState` type.

**State changes (in `ProductCreateView`):**
- Removed: `includeUnstitched`, `baseFabricCost`, `includeSizes`, `selectedSizes`, `customSizes`, `customSizeInput`, `stitchingTypes`.
- Added: `attributeSelection: SelectionState` (initial `{ selectedAttributes: [] }`).
- Kept: `generatedVariants`, `generating`.

**Validation (`validateStep`):**
- Removed stitching-type / base-fabric-cost checks.
- Added: "Pick at least one attribute and value to generate variants." message when zero variants exist in stitchable mode.

**`generateVariants` (old, removed):** Used `/api/products/generate-stitched` with hardcoded sizes + stitching types.

**`handleAttributeChange` (new):**
- `useCallback` with deps `[slug, baseSku]`.
- On every AttributeSelector emission:
  1. `setAttributeSelection(selection)`.
  2. If empty: clear `generatedVariants`.
  3. Otherwise: POST `/api/products/new/variants/generate` with `{ product_slug: slug, base_sku, selected_attributes: selection.selectedAttributes }`.
     - The `new` literal is a dummy id — the route does not use the path id; it only reads `product_slug` from the body for SKU prefix generation.
  4. Stale-response guard via `lastReqIdRef` (increments on every call; only the latest response is applied).
  5. Preserves user edits (cost_price, sale_price, is_active, fulfillment_type, stitching_type, production_days) for SKUs that already existed in `generatedVariants`. New SKUs default to: `cost_price=0`, `sale_price=0`, `is_active=true`, `is_default=(i===0)`, `fulfillment_type=suggested_fulfillment_type`, `stitching_type='stitched_basic'` if MTO else `'unstitched'`.
  6. Error → `setSubmitError` + `toast.error`.

**Submit payload:**
- `stitching_base_price: 0` (was `baseFabricCost`).
- `has_size_variants: isStitchable && productType === 'variable' && attributeSelection.selectedAttributes.some(a => a.attribute_name.toLowerCase() === 'size')` (now derived from the selected attribute names rather than a separate toggle).
- Per-variant fields unchanged: SKU, attribute_values, cost_price, stitching_charges, compare_price, weight_grams, fulfillment_type, stitching_type, production_days, allow_backorder, requires_shipping, is_taxable, is_active, is_default, sale_price.

**`StitchableVariantBuilder` (Mode B) — fully rewritten:**
- Props: `slug`, `selection: SelectionState`, `onSelectionChange`, `generatedVariants`, `setGeneratedVariants`, `generating`.
- Renders:
  1. Intro blurb (Sparkles icon) explaining the generic attribute-driven flow.
  2. `<AttributeSelector onChange={onSelectionChange} initialSelection={selection.selectedAttributes.length > 0 ? selection : undefined} />`.
  3. Live preview count card: shows `"{N} variants will be generated"` updating as selections change. State-aware copy: "Select at least one attribute and value…", "Select at least one value…", "Calculating combinations…", or the count.
  4. Preview table — **dynamic attribute columns** computed from the union of keys in `generatedVariants[*].attribute_values`. Plus per-row editable fields:
     - SKU (Input, editable)
     - Cost (Input number, editable)
     - Fulfillment type (Select stock_based / made_to_order, editable)
     - Sale price (Input number, editable)
     - Active (Switch, toggle)
  5. Empty-state copy when no combinations.

**Modes A (Simple/Bundle/Service) and C (Regular variable) — unchanged.** The `SimpleVariantForm` and `RegularVariantBuilder` components are untouched. Only Mode B was replaced.

## API Contract Verification

- `GET /api/catalog/available-attributes` → `{ attributes: [{id, name, displayName, attributeType, displayOrder, values: [{id, value, displayValue, colorHex, skuCode, displayOrder}]}], rules: [{id, triggerValueId, triggerValueInfo, forcesAttributeId, forcesAttributeName, forcesValueId, forcesValueInfo}] }` — matches the types in `attribute-selector.tsx`.
- `POST /api/catalog/inline-attribute` body `{ name, display_name?, attribute_type?, initial_values?: [{value, display_value?, sku_code?, color_hex?}] }` — matches `inlineAttrMutation.mutationFn` input.
- `POST /api/catalog/inline-value` body `{ attribute_id, value, display_value?, sku_code?, color_hex? }` — matches `inlineValueMutation.mutationFn` input.
- `POST /api/products/[id]/variants/generate` body `{ product_slug, base_sku?, selected_attributes: SelectionStateAttribute[] }` → returns `{ combinations: [{ attribute_values, suggested_sku, suggested_fulfillment_type }] }` — matches the `api.post` call in `handleAttributeChange`.

## Verification

- **Lint:** `bun run lint` → 0 errors, 15 pre-existing warnings (all in unrelated files: page.tsx, locations-view, loss-detail-view, supplier-detail-view, suppliers-view, create-company-view, create-organization-view, catalog-settings-view, returned-stitched-view, roles-view, logo-upload). **0 warnings introduced** in `attribute-selector.tsx` or `product-create-view.tsx`.
- **TypeScript strict:** `npx tsc --noEmit` reports **0 errors** in `attribute-selector.tsx` and `product-create-view.tsx`. All errors are pre-existing in unrelated files.
- **API contract alignment:** verified against all 4 backend route handlers — every payload field matches the route's `readBody` shape and the return shapes match what the frontend consumes.

## Stage Summary

- The hardcoded Size/Stitching UI in Mode B of the product-creation wizard is replaced with a fully generic, attribute-driven `AttributeSelector` component.
- Max-3-attribute cap (Shopify compatibility) is enforced with clear UX (disabled checkboxes + tooltip).
- Conditional rules (`AttributeValueRule` rows) are enforced generically — when a trigger value is selected and its forced attribute is also selected, the forced value is auto-selected and locked with a Lock icon. Rule logic never hardcodes "Piece Type" / "Size" / "Unstitched" — it operates purely on `triggerValueId` / `forcesAttributeId` / `forcesValueId`.
- Inline value + attribute creation lets users expand their catalog without leaving the product-creation flow. Both use optimistic `setQueryData` + `invalidateQueries` so the new entries appear instantly and a background refetch confirms server state.
- The variant preview table now renders **dynamic attribute columns** instead of the old fixed "Piece type" / "Size" columns. Per-row editable fields (SKU, cost, fulfillment type, sale price, active) are preserved and the live "X variants will be generated" counter updates as selections change.
- The generate endpoint is hit on every selection change (with a stale-response guard) using a dummy `new` path id; the route doesn't read the path id, only the `product_slug` in the body. User edits are preserved across regenerations by matching on SKU.
- Production-ready: full loading/empty/error states, permission gating (`PERMISSIONS.PRODUCTS_MANAGE_CATALOG`) on all create-buttons, optimistic cache updates, Sonner toasts, mobile-responsive layouts, custom scrollbar on long lists.
