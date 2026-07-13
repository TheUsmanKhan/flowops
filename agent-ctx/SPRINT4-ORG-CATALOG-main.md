# SPRINT4-ORG-CATALOG — Org Catalog page

## What was built
`/src/components/products/org-catalog-view.tsx` — a single SPA view component (`OrgCatalogView`) for FlowOps ERP with 2 tabs: Org Catalog (shared products) | Promotable Products (private products ready to be promoted).

## API contract used
| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/org/catalog` | list shared + promotable products + companies (elevated only; 403 otherwise) |
| POST | `/api/products/[id]/promote` | promote to organization/selective (body: `target_scope`, `selected_company_ids[]`) |
| POST | `/api/products/[id]/demote` | demote to private/selective (body: `new_scope`, `reason`) → returns `warnings[]` |
| POST | `/api/products/[id]/selective-access` | grant selective access (body: `company_id`) |
| DELETE | `/api/products/[id]/selective-access?company_id=xxx` | revoke selective access |

## Key decisions
- **Permission gate**: if `/api/org/catalog` fails with 403, render a `PermissionMessage` card instead of the tabs. Query `retry` skips 403s (won't self-heal).
- **Query**: TanStack Query `['org-catalog']`, `staleTime: 30_000`. All 3 mutations (promote, demote, revoke) invalidate it.
- **Demote warnings flow**: dialog stays open after a successful demote if `warnings[]` is non-empty — shows an amber Alert listing them, swaps the Submit button for "Acknowledge & close", and emits a `toast.warning`. On success without warnings, dialog closes + `toast.success`.
- **Promote radio cards**: built as styled `<button>`s with selected-state ring + checkmark (emerald for Organization, amber for Selective) rather than using the shadcn RadioGroup — gives the "card" look the spec called for.
- **Selective company picker**: checkbox list, excludes the source company, `max-h-56 overflow-y-auto scrollbar-thin`, disabled submit if 0 selected.
- **Revoke action**: only shown for `scope === 'selective'` products AND non-revoked subscribers. Row-level Loader2 spinner via `revokingId` derived from `revokeMutation.variables`.
- **Not-ready state**: `readyToPromote=false` → muted "Not ready" Badge (Tooltip lists what's missing) AND the Promote button is disabled (also wrapped in Tooltip with the same message).
- **Subscribers table**: columns Company (with "source" tag for owner) | Status badge (emerald/amber/rose for active/paused/revoked) | Their price = "N/A" | Actions. Uses shadcn Table primitives.
- **Icons**: used the lucide icons from the spec import list (Globe, Lock, Users, ChevronRight, AlertTriangle, Check, X, Plus, Building2, ArrowUpRight, Loader2). Added two tiny inline SVG icons (`PackageIcon`, `ImageIcon`) for variant/image counts to avoid growing the lucide import list — purely presentational.

## Files touched
- **Created**: `/src/components/products/org-catalog-view.tsx` (~870 lines)
- **Appended**: `/home/z/my-project/worklog.md`

## Verification
- `bun run lint`: 0 errors in org-catalog-view.tsx. (11 pre-existing warnings in other files — React-Compiler `watch()` advisories in catalog-settings-view/returned-stitched-view, unused eslint-disable in roles-view/logo-upload.)
- `bunx tsc --noEmit`: 0 errors in org-catalog-view.tsx. (Pre-existing errors in company-settings-view.tsx + organization-view.tsx — `session` is of type 'unknown' — unrelated to this task.)
- dev.log: dev server compiles `/` cleanly.

## Note for downstream agents
- This component is **not yet wired into `src/app/page.tsx`**. To mount it, add a route case (e.g. `case 'org-catalog': return <OrgCatalogView />`) in `renderRoute()` and a matching nav item in `sidebar.tsx` / `mobile-nav.tsx`. The task only asked for the component file, so wiring is left to the next agent.
- The POST `/api/products/[id]/selective-access` (grant) endpoint is supported by the UI mutation layer in spirit (via the promote dialog's selective flow), but there is no standalone "Grant access" button on the shared-catalog subscribers table. If you want a "+ Add subscriber" affordance on existing selective products, that's a future enhancement — the spec only required Revoke.
EOF
