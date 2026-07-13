# SPRINT3-UI — Product Catalog UI

## Task
Build 3 React components for the FlowOps ERP Product Catalog UI and wire them into the SPA router.

## Work Log
- Read `worklog.md` and existing files: `app-store.ts`, `page.tsx`, `dashboard-shell.tsx`, `api-client.ts`, `lib/constants/fulfillment-types.ts`, `lib/validations/product.ts`, the 3 product API routes (`/api/products`, `/api/products/[id]`, `/api/products/generate-stitched`), `/api/categories`, `/api/brands`, and reference components (`employees-view`, `employee-detail-view`, `create-organization-view`).
- Built `/src/components/products/products-view.tsx`:
  * TanStack Query `useQuery` with `queryKey: ['products']`, `staleTime: 30_000`.
  * PageHeader with "New Product" button (navigates to `product-create`).
  * Search input + product type filter (All/Simple/Variable/Bundle/Service).
  * Responsive grid (1/2/3/4 cols) of product cards. Each card: primary image or `Package` placeholder, title, slug, type/scope/variant-count badges, category/brand line, price range (min-max salePrice), featured/stitchable/owner corner badges, ChevronRight affordance, keyboard accessible.
  * Loading skeleton grid (8 cards), empty state ("Create your first product" CTA), error state with retry.
  * Click any card → navigate to `product-detail` with `id`.
- Built `/src/components/products/product-create-view.tsx` — 3-step wizard:
  * Stepper UI matching the existing `create-organization-view` design (numbered circles, ring on active, check on completed).
  * **Step 1 (Basic Details):** title (required), short description (500 char counter), full description, visual product-type cards (Simple/Variable/Bundle/Service), Category dropdown + inline "Add new" dialog (POST /api/categories, optimistic local state), Brand dropdown + inline "Add new" dialog (POST /api/brands), Featured toggle, Stitchable toggle (only shown when product_type = variable).
  * **Step 2 (Variants & Pricing)** — 3 modes:
    * Mode A (simple/bundle/service): single-variant form with SKU, barcode, cost/sale/compare prices, weight, fulfillment type, conditional production days + stitching type for made_to_order.
    * Mode B (stitchable variable): full builder — include-unstitched toggle + fabric cost, include-sizes toggle + STANDARD_SIZES checkbox grid + custom size input, 3 stitching types (Basic/Heavy/Custom) each with charge + production days inputs (defaults from DEFAULT_PRODUCTION_DAYS), ⚡ Generate Variants button → POST /api/products/generate-stitched, preview table with editable sale price + active toggle per row, FulfillmentBadge (green=stock_based, sky-blue=made_to_order).
    * Mode C (regular variable): manual variant rows — SKU, cost, sale price, multiline attributes (`Key: Value` per line), set-default / delete-row buttons, min 1 enforced.
  * **Step 3 (Scope & Confirm):** scope selector cards (Private/Organization/Selective with descriptions), review summary (title/type/category/brand/variant count/stitchable/featured/scope), "What will happen" info box, Create Product button.
  * Per-step validation (`validateStep`), inline error banner with AlertCircle + dismiss, loading state on submit button, on success → toast + invalidate `['products']` + navigate to `product-detail`.
  * On submit: clones variants, ensures at least one is_default, sends full `ProductInput` payload to POST /api/products.
  * Helper `useEffect` clears `isStitchable` when product type changes away from variable.
- Built `/src/components/products/product-detail-view.tsx` — tabbed detail page:
  * TanStack Query `queryKey: ['product', productId]`, `staleTime: 30_000`.
  * Back button → `products`. PageHeader with product title + badges (type, scope, stitchable, active, featured, owner).
  * If `isOwner`: Edit button (disabled, future) + "Promote to Org" button (opens dialog to switch scope via PATCH /api/products/[id]).
  * Tabs: Overview | Variants | Images | Shopify Sync (+ Pricing tab when not owner & has subscription).
  * **Overview tab:** description + short description, details card (category, brand, variant count, slug), stitching info (base price, has size variants) when isStitchable.
  * **Variants tab:** full table — SKU + barcode, attributes (Piece Type + Size from attributeValues), cost price (+ stitching charges breakdown), sale price, compare price, FulfillmentBadge, stitching type, production days, inventory policy badge, active switch. Plus a Shopify Sync Preview section at the bottom showing inventory_management ("shopify"/null), inventory_policy, price, compare_at_price, grams, requires_shipping, taxable per variant.
  * **Images tab:** responsive grid of images with Primary/Variant badges, or empty state.
  * **Shopify Sync tab:** JSON payload preview of what would be sent, plus sync notes (stock_based vs made_to_order inventory_management mapping explanation).
  * **Pricing tab (non-owner + subscription):** editable sale_price/compare_price per variant with dirty-tracking and Save button (PATCH `/api/products/[id]/variants/[variantId]/pricing`).
  * Error state with retry, loading spinner.
- Wired into `/src/app/page.tsx`:
  * Imported `ProductsView`, `ProductCreateView`, `ProductDetailView`.
  * Added `ProductCreateViewWithBack` wrapper that supplies `onBack={() => navigate({ name: 'products' })}`.
  * Added switch cases: `products` → `<ProductsView/>`, `product-create` → `<ProductCreateViewWithBack/>`, `product-detail` → `<ProductDetailView productId={route.id}/>`.
- Lint & type-check:
  * `bun run lint`: 0 errors, 0 warnings in new files. (6 remaining warnings are all pre-existing in other files.)
  * `bunx tsc --noEmit`: 0 errors in new files. Fixed initial TS issues:
    - `opt.type` → `opt.key` in StitchableVariantBuilder (5 spots) — STITCHING_OPTIONS field is named `key`.
    - PromoteDialog scope-state type narrowing: replaced `.filter()` on a `'private'|'organization'|'selective'` array (TypeScript can't narrow through filter) with a separate `PROMOTE_SCOPE_OPTIONS` constant typed `'organization' | 'selective'`.
    - Removed unused `variantsDefault` helper and unused `ScopeOption` interface / `SCOPE_OPTIONS` constant.
    - Removed unused `@next/next/no-img-element` eslint-disable comments in my 2 image `<img>` usages.
  * Pre-existing errors in other files (`src/app/api/company/route.ts`, `dashboard/route.ts`, `lib/validations/product.ts` zod `z.record(z.string())`, onboarding/settings `session: unknown`, etc.) are NOT from this task and were left untouched.

## Files Created
- `/home/z/my-project/src/components/products/products-view.tsx`
- `/home/z/my-project/src/components/products/product-create-view.tsx`
- `/home/z/my-project/src/components/products/product-detail-view.tsx`

## Files Modified
- `/home/z/my-project/src/app/page.tsx` — added 3 imports + 3 switch cases + `ProductCreateViewWithBack` wrapper.

## Design Notes
- Emerald-primary design system preserved (no blue/indigo outside the `FulfillmentBadge` made-to-order state which uses `bg-sky-100 text-sky-700` per the spec: "stock_based = green, made_to_order = blue").
- Mobile-first responsive: grid breakpoints sm/lg/xl, sticky tab lists, horizontal-scroll tables on mobile.
- All async UIs show loaders and provide toast error feedback via sonner.
- Reused existing shadcn/ui components, `cn()` utility, `PageHeader`, `api`/`FetchError`, and Zustand `useAppStore.navigate` for SPA routing.
- Keyboard accessible product cards (Enter/Space activates click).
