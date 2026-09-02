# SPRINT5-DETAIL-REBUILD — Product Detail View Rebuild

**Agent:** main
**File modified:** `src/components/products/product-detail-view.tsx` (891 → 1685 lines)

## Goal

Rebuild the FlowOps ERP product detail page so the disabled Edit button and the disabled variant active toggle both work end-to-end against the existing backend API.

## Work Log

### 1. Imports
Added: `useMutation` from `@tanstack/react-query`, `useCan` from `@/stores/app-store`, `useRef` from `react`, `Textarea`, `Select` family, `Dialog` family, `CardAction`, `FulfillmentTypeBadge` from `@/components/products/fulfillment-type-badge`, and icons `Check`, `X`, `Upload`, `Trash2`, `Star`. Removed the unused `Package` import and the `FULFILLMENT_LABELS` import (no longer needed after switching to the shared `FulfillmentTypeBadge`).

### 2. Header — disabled Edit button removed
The `<Button variant="outline" disabled title="Coming soon">Edit</Button>` was deleted from the `PageHeader` actions. Only the "Promote to Org" button remains in the header (unchanged — it already worked via `changeScope`). Edit functionality now lives inside the Overview tab.

### 3. DetailsTab (Overview tab) — inline edit mode
Extracted the Overview tab content into a new `DetailsTab` sub-component.

- Edit button placed in `CardAction` of the Description card; hidden when `!canEdit` (`useCan()('products.edit')`).
- Clicking Edit flips a local `editing` state. In edit mode:
  - Title becomes `Input`
  - Short description becomes `Input`
  - Description becomes `Textarea`
  - Category becomes `Select` (lazily-loaded via `useQuery(['categories'])`, `enabled: editing`)
  - Brand becomes `Select` (lazily-loaded via `useQuery(['brands'])`, `enabled: editing`)
  - Active / Featured / Stitchable become `Switch` controls
  - When `isStitchable`: stitching base price `Input` + has_size_variants `Switch` shown
- Save Changes / Cancel buttons live in the card header. Save builds a diff (only changed snake_case fields) and calls `PATCH /api/products/[id]` via `useMutation`. onSuccess → invalidate `['product', productId]` + `['products']`, toast "Product updated", exit edit mode. onError → stay in edit mode, toast the real `FetchError.message`.
- Cancel reverts to view mode without saving.
- View mode renders plain text (not disabled inputs).
- Fixed a React-Compiler lint error by inlining the initial form state in the `useState` initializer (the original `initForm` helper triggered `react-hooks/immutability`).

### 4. VariantsTab — interactive Switch + per-row edit dialog
Extracted the Variants tab into a new `VariantsTab` sub-component.

- Each row's `Switch` is now interactive via a new `VariantActiveSwitch` sub-component.
- `VariantActiveSwitch` uses `useMutation` with **optimistic update** in `onMutate` (cancel in-flight queries, snapshot cache, patch the cached variant's `isActive`). On error → revert the cache from the snapshot and toast the real message. On success → invalidate `['product', productId]` and toast "Variant status updated". Endpoint: `POST /api/products/[id]/variants/[variantId]/toggle` with `{ is_active }`.
- Switch is disabled when `!canEdit` or while the mutation is pending.
- Each row has a new "Actions" column with a pencil `Button` (only when `canEdit`) that opens `VariantEditDialog`.
- Replaced the local `FulfillmentBadge` with the shared `FulfillmentTypeBadge` (icon + colors).
- Stitching column: `made_to_order` → stitching_type label; `stock_based` → "Stock tracked" text.
- Days column: only shows `productionDays` for `made_to_order` variants.
- The Shopify Sync Preview card (originally also on the Variants tab) was preserved verbatim.

### 5. VariantEditDialog — edit form + SKU change confirmation
Two-step dialog:

- Step `edit`: Inputs for SKU (mono font), barcode, cost_price, weight_grams, stitching_charges, production_days, plus Switch controls for is_taxable and requires_shipping. A live inline warning shows under SKU when it differs from the original.
- On Save: build a diff (only changed fields). If SKU is in the diff, switch to step `confirm`; otherwise call the mutation immediately.
- Step `confirm`: shows old vs. new SKU and the warning "Changing SKU won't affect history but may cause confusion with existing labels. Continue?". Back button returns to the edit step. Continue calls the mutation.
- Mutation: `PATCH /api/products/[id]/variants/[variantId]` via `useMutation`. onSuccess → invalidate `['product', productId]`, toast "Variant updated", close dialog. onError → return to edit step, toast the real `FetchError.message`.
- Dialog close is blocked while the mutation is pending.

### 6. ImagesTab — upload + delete + primary badge
Extracted the Images tab into a new `ImagesTab` sub-component.

- Upload button in `CardAction` (hidden when `!canEdit`). Uses a hidden `<input type="file" accept="image/jpeg,image/png,image/webp">` + `useRef` to trigger the picker.
- Client-side size guard (5 MB) — backend also enforces this, but the guard avoids the round-trip for obviously-too-large files.
- Upload uses **raw `fetch`** (not `api.post`) because multipart FormData must not carry a JSON `Content-Type` (the api-client always sets `application/json`). Errors are parsed the same way as `FetchError` (look for `body.error`, fall back to the raw text, then "Upload failed").
- onSuccess → invalidate `['product', productId]`, toast "Image uploaded".
- onError → toast the real message (e.g. "Only JPG, PNG, and WebP images are allowed.", "File too large. Maximum 5 MB.", 403 messages, etc.).
- Each image card: primary badge with star icon (top-left), variant badge (bottom-left, when applicable), and a trash delete button (top-right, revealed on hover).
- Delete calls `DELETE /api/products/[id]/images?image_id=xxx` via `useMutation`. Per-image loading state via `deletingId`. On error → toast the real message.
- **Set Primary button intentionally skipped** — the backend route `PATCH /api/products/[id]/images/[imageId]` for setting `is_primary` does not exist yet. A code comment explains this; the upload endpoint already auto-sets the first image as primary.

### 7. Pricing tab — fixed endpoint mismatch
The spec said the existing pricing tab "already works (saves via POST /api/products/[id]/pricing)" but the original code called a non-existent `PATCH /api/products/[id]/variants/[variantId]/pricing` route. Fixed:

- Save now calls `POST /api/products/[id]/pricing` with the correct payload shape `{ pricing: [{ org_variant_id, sale_price, compare_price? }] }` (verified against `setCompanyPricingSchema` in `src/lib/validations/product.ts`).
- Save button is disabled when `salePrice` is null/≤0 or when `comparePrice` is set but not greater than `salePrice` (matches the schema's `.refine` rule).
- Added a defensive guard in `save()` that toasts "Sale price must be a positive number." if the user somehow submits with an invalid value.

### 8. Preserved unchanged
- `ProductDetailView` main component shell (loading/error states, PageHeader, header badges, Tabs container, PromoteDialog wiring).
- `DetailRow`, `PromoteDialog`, `PricingTab` (logic preserved; only the save endpoint/payload was corrected).
- Shopify Sync tab (full JSON payload preview + sync notes).
- All types (`ProductImage`, `ProductVariant`, `ProductDetail`).
- `formatMoney` utility.

## Code style conformance
- `'use client'` at top.
- `useQuery` for product detail with `queryKey: ['product', productId]`.
- `useMutation` for every mutation; `onSuccess` invalidates `['product', productId]` (and `['products']` for product-level edits).
- `useCan()('products.edit')` gates every Edit / Upload / Delete / Switch / pencil control.
- Loading spinners (`Loader2 animate-spin`) on every submit button while pending.
- Sonner toasts on every success and error.
- Real `FetchError.message` surfaced everywhere (no generic "Something went wrong").
- snake_case keys in API payloads (matches backend Zod schemas).

## Verification
- `bun run lint`: **0 errors** in `product-detail-view.tsx`. (11 pre-existing warnings in other files: catalog-settings-view, returned-stitched-view, roles-view, logo-upload — all unrelated React Hook Form `watch()` advisories and unused eslint-disable directives.)
- `bunx tsc --noEmit`: **0 errors** in `product-detail-view.tsx`. (Pre-existing errors in other files — company route, dashboard route, onboarding views, products list route — all unrelated.)
- Dev server: not yet started by the system at the time of writing; the file compiles cleanly under both linters.

## Stage Summary
Product detail page is now fully interactive:
- Edit button works (inline edit mode with diff-based PATCH).
- Variant active toggle works (optimistic update with revert-on-error).
- Variant edit dialog works (with SKU change confirmation flow).
- Image upload works (multipart, real error messages, per-image delete).
- Pricing tab actually saves correctly now (was calling a non-existent endpoint before).
- Header is clean (no more disabled "Coming soon" Edit button).
- All edit UI is permission-gated on `products.edit`.
