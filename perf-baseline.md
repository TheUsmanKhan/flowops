# FlowOps ERP — Performance Baseline

**Date**: August 14, 2026
**Purpose**: Establish a "before" measurement before implementing code-splitting and other frontend performance fixes.

---

## Build Environment

| Metric | Value |
|---|---|
| Next.js version | 16.1.3 (Turbopack) |
| React version | 19 |
| Build command | `bun run build` (→ `next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/`) |
| Output mode | `standalone` |
| Build duration | ~44 seconds |
| Build result | ✅ Success (0 errors, `typescript.ignoreBuildErrors: true`) |

---

## Build Output — Route Summary

FlowOps is a single-page app. The entire frontend is ONE route (`/`):

```
Route (app)
┌ ○ /                    ← The entire SPA (all 62 views)
├ ○ /_not-found
└ ƒ /api/*               ← 148 API routes (server-rendered on demand)

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

---

## Bundle Size Breakdown

### Total `.next/static/` directory: 3.7 MB

### Chunk inventory (sorted by size)

| Chunk file | Size | Role |
|---|---|---|
| `f871ec6c9b44795f.js` | **2,638 KB** | **SPA page chunk** — ALL 62 view components + all client deps |
| `2e9c5333df59f348.js` | 220 KB | Root main (React + React-DOM) |
| `de18f5750dafaba4.css` | 164 KB | Main CSS (Tailwind + all component styles) |
| `40a0a5cd37f53e57.js` | 115 KB | Root main (Next.js framework) |
| `a6dad97d9634a72d.js` | 110 KB | Polyfill |
| `a123a24156b7ab0f.js` | 52 KB | Root main (shared modules) |
| `18a6dbe68180f42a.js` | 41 KB | Root main (framework) |
| `452a3479b1b93bbe.js` | 31 KB | Root main (shared) |
| `32aabbdf217108bf.js` | 17 KB | Root main (React runtime) |
| `ab71fc68357acd6b.js` | 13 KB | Root main (misc) |
| `turbopack-662f580b37a679e5.js` | 10 KB | Turbopack runtime |
| `34d933785a17edf3.css` | 3.6 KB | Additional CSS |
| **Total JS** | **3,247 KB** | |
| **Total CSS** | **168 KB** | |
| **Total (JS + CSS)** | **3,415 KB** | |

### First Load JS (what every user downloads on first visit)

| Component | Size |
|---|---|
| Root main JS (5 chunks) | 400 KB |
| Polyfill | 110 KB |
| **SPA page chunk** (all 62 views + deps) | **2,638 KB** |
| **First Load JS Total** | **3,148 KB (~3.1 MB)** |
| First Load JS + CSS | 3,316 KB (~3.2 MB) |

### What this means

Every user — even one who only visits the login page — downloads **3.1 MB of JavaScript** before the app can render. This is because all 62 view components are statically imported in `src/app/page.tsx` and bundled into a single 2.6 MB chunk.

For comparison, Next.js recommends keeping First Load JS under **300 KB** for good performance. FlowOps is **10× over that threshold**.

---

## Bundle Analyzer

### `@next/bundle-analyzer` result

**Incompatible with Turbopack.** The analyzer output:

```
The Next Bundle Analyzer is not compatible with Turbopack builds, no report will be generated.
Consider trying the new Turbopack analyzer via `next experimental-analyze`.
```

The Turbopack-native `next experimental-analyze` command also did not produce a visual report (timed out).

### Manual analysis (grep-based)

Since the visual analyzer didn't work, the bundle was analyzed manually by grepping the 2.6 MB page chunk for known package signatures.

#### Packages confirmed in the page chunk (2.6 MB):

| Package | Files importing it | Notes |
|---|---|---|
| `react` | 149 | Core |
| `lucide-react` | 116 | Icons — heaviest dep by import count |
| `sonner` | 67 | Toast notifications |
| `@tanstack/react-query` | 65 | Data fetching |
| `zod` | 33 | Validation |
| `react-hook-form` | 12 | Forms |
| `@hookform/resolvers` | 11 | Zod resolver |
| `class-variance-authority` | 8 | shadcn/ui styling |
| `date-fns` | 6 | Date formatting |
| `@radix-ui/*` (12 packages) | 1 each (via ui/) | shadcn/ui primitives |
| `recharts` | 3 | Charts (orders-view, performance-tab, ui/chart) |
| `next-themes` | 2 | Theme provider |
| `cmdk` | 1 | Command palette (ui/command.tsx) |
| `vaul` | 1 | Drawer (ui/drawer.tsx) |
| `embla-carousel-react` | 1 | Carousel (ui/carousel.tsx) |
| `react-day-picker` | 1 | Calendar (ui/calendar.tsx) |
| `react-resizable-panels` | 1 | Resizable (ui/resizable.tsx) |
| `input-otp` | 1 | OTP input (ui/input-otp.tsx) |
| `zustand` | 1 | State management (app-store) |
| `clsx` | 1 | Class merging |
| `tailwind-merge` | 1 | Tailwind class dedup |

#### Dead dependencies (installed but NOT imported anywhere in `src/`):

These are installed in `node_modules` but **NOT bundled** (Turbopack tree-shakes them). They don't affect the bundle size but add install time + disk usage.

| Package | node_modules size | Status |
|---|---|---|
| `react-syntax-highlighter` | 8.9 MB | ❌ Dead |
| `framer-motion` | 5.4 MB | ❌ Dead |
| `next-auth` | 2.7 MB | ❌ Dead (app uses custom HMAC sessions) |
| `@dnd-kit/core` | 1.7 MB | ❌ Dead |
| `next-intl` | 1.6 MB | ❌ Dead |
| `@mdxeditor/editor` | 1.1 MB | ❌ Dead |
| `@tanstack/react-table` | 796 KB | ❌ Dead |
| `@dnd-kit/sortable` | 404 KB | ❌ Dead |
| `@dnd-kit/utilities` | 272 KB | ❌ Dead |
| `react-markdown` | 88 KB | ❌ Dead |
| **Total dead deps** | **~22 MB** in node_modules | Can be safely `bun remove`d |

#### shadcn/ui components (52) all bundled

All 52 shadcn/ui components in `src/components/ui/` are statically imported (most via direct import in consuming components, some via barrel re-exports). Since they're all in the single page chunk, even unused components (like `carousel`, `calendar`, `resizable`, `command`, `menubar`, `navigation-menu`) are bundled.

---

## Component Code Size Analysis

### Top 10 largest component files (by LOC)

| File | Lines | % of total components |
|---|---|---|
| `orders/orders-view.tsx` | 2,599 | 4.2% |
| `orders/order-create-view.tsx` | 2,390 | 3.8% |
| `products/product-create-view.tsx` | 2,321 | 3.7% |
| `products/catalog-settings-view.tsx` | 2,289 | 3.7% |
| `inventory/losses-view.tsx` | 2,249 | 3.6% |
| `inventory/cycle-counts-view.tsx` | 2,249 | 3.6% |
| `orders/order-detail-view.tsx` | 2,040 | 3.3% |
| `products/product-detail-view.tsx` | 1,949 | 3.1% |
| `products/returned-stitched-view.tsx` | 1,349 | 2.2% |
| `products/org-catalog-view.tsx` | 1,221 | 2.0% |
| **Top 10 total** | **~21,656** | **34.7%** |

### Total component code

| Metric | Value |
|---|---|
| Non-UI component files | 101 |
| shadcn/ui components | 52 |
| Total component files | 153 |
| Total LOC in `src/components/` | ~62,309 |

---

## Performance Patterns (current state)

### What's optimized ✅

| Pattern | Usage | Impact |
|---|---|---|
| Zustand atomic subscriptions | All components use `useAppStore((s) => s.field)` | Prevents unnecessary re-renders |
| TanStack Query caching | 64 components, global `staleTime: 30s`, 100+ per-query overrides | Reduces API calls |
| `useMemo` | 41 files | Prevents expensive re-computation |
| `useCallback` | 8 files | Stable handler references |
| Debounced search | 7 instances (300ms) | Reduces API calls during typing |
| Optimistic workspace switch | `setQueryData` in workspace-switcher | Instant UI feedback |
| Targeted cache invalidation | workspace-switcher invalidates 5 specific keys | Doesn't nuke entire cache |
| Prefetch | Dashboard prefetched after workspace switch | Faster first render on switch |
| Fire-and-forget audit/metric writes | Server-side (not client) | Reduces API response time |

### What needs improvement ⚠️

| Issue | Impact | Priority |
|---|---|---|
| **NO code-splitting** — all 62 views in one 2.6 MB chunk | Every user downloads 3.1 MB on first load, even if they only use the dashboard | **CRITICAL** |
| **NO `React.memo`** — zero usage anywhere | Every Zustand state change re-renders entire active view tree | HIGH |
| **6 views use raw `api.get()` in `useEffect`** instead of TanStack Query | No caching, no dedup, manual loading state | MEDIUM |
| **52 shadcn/ui components all bundled** even if unused | Carousel, calendar, resizable, command, menubar, navigation-menu all bundled but rarely used | MEDIUM |
| **10 dead dependencies** installed (~22 MB in node_modules) | Slower installs, larger Docker images, cognitive overhead | LOW (doesn't affect bundle) |
| **`payroll-run-detail` missing from `routesWithId`** in url-sync.ts | URL loses ID on refresh | BUG |

---

## Key Numbers for Before/After Comparison

| Metric | Baseline (current) | Target (after code-splitting) |
|---|---|---|
| First Load JS | **3,148 KB (3.1 MB)** | < 500 KB |
| SPA page chunk | **2,638 KB (2.6 MB)** | < 200 KB (shared shell only) |
| Number of JS chunks | 10 (all loaded upfront) | 10+ shared + 62 lazy chunks |
| Largest individual chunk | 2,638 KB | < 300 KB (per-view) |
| Dead deps installed | 10 packages (~22 MB) | 0 |
| `React.memo` usage | 0 | TBD |
| Dynamic imports | 0 | 62 (one per view) |

---

## How to Reproduce This Baseline

```bash
# 1. Ensure .env has correct DATABASE_URL (postgresql://)
head -1 .env

# 2. Clean build
rm -rf .next
bun run build

# 3. Check chunk sizes
ls -lhS .next/static/chunks/*.js

# 4. Calculate First Load JS
# Root main files (from .next/build-manifest.json → rootMainFiles):
for f in 32aabbdf217108bf.js 18a6dbe68180f42a.js 2e9c5333df59f348.js 40a0a5cd37f53e57.js turbopack-662f580b37a679e5.js; do
  stat -c%s .next/static/chunks/$f
done | paste -sd+ | bc  # Root main total in bytes

# Polyfill:
stat -c%s .next/static/chunks/a6dad97d9634a72d.js

# Page chunk (the big one):
ls -lhS .next/static/chunks/*.js | head -1

# 5. Bundle analyzer (NOTE: does NOT work with Turbopack):
# ANALYZE=true bun run build
# → "The Next Bundle Analyzer is not compatible with Turbopack builds"
```

---

## Next Steps (Step 1+ — Code Splitting)

The primary optimization is replacing the 62 static imports in `src/app/page.tsx` with `next/dynamic` lazy imports keyed off `route.name`. This will:

1. Split the 2.6 MB page chunk into ~62 smaller chunks (one per view)
2. Reduce First Load JS from 3.1 MB to ~400-500 KB (React + framework + shell only)
3. Load each view on-demand when the user navigates to it
4. Allow browsers to cache individual view chunks independently

Additional optimizations to consider after code-splitting:
- Remove 10 dead dependencies (`bun remove`)
- Add `React.memo` to large list components
- Migrate 6 views from `useEffect + api.get()` to TanStack Query
- Lazy-load rarely-used shadcn/ui components (carousel, calendar, etc.)
