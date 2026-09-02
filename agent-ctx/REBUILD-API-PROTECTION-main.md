# Task ID: REBUILD-API-PROTECTION
**Agent:** main (Z.ai Code)
**Date:** 2025

## Task
Phase 2 of the permission system: add `requirePermission` checks to unprotected API routes + add order ownership checks for `scope='own'` employees. Phase 1 (sidebar) was already done.

## Files MODIFIED (10)

### API route protection (added `requirePermission` + replaced `getCurrentUser()` with `getWorkspace()`)

1. **`src/app/api/orders/[id]/route.ts`** GET
   - Added `await requirePermission(ctx, PERMISSIONS.ORDERS_VIEW)` after `getWorkspace()`
   - Added ownership scoping: `where.salesEmployeeId = ctx.employee.id` when `getOrdersDataScope(ctx) === 'own'`
   - Updated imports to include `requirePermission`, `getOrdersDataScope`, `PERMISSIONS`

2. **`src/app/api/employees/route.ts`** GET
   - Replaced `getCurrentUser()` + `db.userSetting.findUnique()` with `getWorkspace()` + `requirePermission(ctx, PERMISSIONS.EMPLOYEES_VIEW)`
   - POST handler unchanged (still uses `getCurrentUser()`)

3. **`src/app/api/employees/[id]/route.ts`** GET
   - Same as above. PATCH handler unchanged.

4. **`src/app/api/roles/route.ts`** GET
   - Replaced `getCurrentUser()` + manual lookup with `getWorkspace()` + `requirePermission(ctx, PERMISSIONS.SETTINGS_ROLES_MANAGE)`
   - POST handler unchanged.

5. **`src/app/api/company/route.ts`** GET
   - Replaced `getCurrentUser()` + settings lookup with `getWorkspace()` + `requirePermission(ctx, PERMISSIONS.SETTINGS_COMPANY_VIEW)`
   - Now uses `db.company.findUnique({ where: { id: ctx.company.id } })` to fetch the full company record (the ctx.company only has lightweight fields)
   - PATCH handler unchanged.

6. **`src/app/api/products/route.ts`** GET
   - Replaced `getCurrentUser()` + settings lookup with `getWorkspace()` + `requirePermission(ctx, PERMISSIONS.PRODUCTS_VIEW)`
   - `companyId` / `orgId` now sourced from `ctx.company.id` / `ctx.company.organizationId`
   - POST handler unchanged.

7. **`src/app/api/dashboard/route.ts`** GET
   - Replaced `getCurrentUser()` with `getWorkspace()`
   - Added `const canViewAudit = await hasPermission(ctx, PERMISSIONS.AUDIT_VIEW)` 
   - Audit log fetch is now conditional (`canViewAudit ? db.auditLog.findMany(...) : Promise.resolve([])`) inside `Promise.all`
   - Removed unused `ApiError` import (only `handleError`, `getWorkspace`, `hasPermission` needed now)

### Action-layer permission checks

8. **`src/lib/actions/customer.actions.ts`** `listCustomers()`
   - Added `await requirePermission(ctx, PERMISSIONS.CUSTOMERS_VIEW)` after `getWorkspace()`
   - `requirePermission` + `PERMISSIONS` were already imported.

9. **`src/lib/actions/integration.actions.ts`** `listCompanyIntegrations()`
   - Added `await requirePermission(ctx, PERMISSIONS.INTEGRATIONS_VIEW)` after `getWorkspace()`
   - `requirePermission` + `PERMISSIONS` were already imported.

### Order ownership checks (Phase 2 scope='own' enforcement)

10. **`src/lib/actions/order.actions.ts`**
    - `cancelOrder()`: After `if (!order) return ...`, added ownership check guarded by `!injectedContext` (so webhook-driven cancels bypass it, consistent with the existing `requirePermission` skip pattern):
      ```ts
      if (!injectedContext && !isElevated(ctx) && getOrdersDataScope(ctx) === 'own' && order.salesEmployeeId !== ctx.employee.id) {
        return { success: false, error: 'You can only cancel orders you created.' }
      }
      ```
      - `salesEmployeeId` was already in the existing `select` clause.
    - `markOrderPacked()`: After `if (!order) return ...`, added:
      ```ts
      if (!isElevated(ctx) && getOrdersDataScope(ctx) === 'own' && order.salesEmployeeId !== ctx.employee.id) {
        return { success: false, error: 'You can only pack orders you created.' }
      }
      ```
      - The original `findFirst` had no `select` clause (returned all fields). I added a `select: { id, status, salesEmployeeId }` for explicitness — only these 3 fields are read after the fetch.
    - `isElevated`, `getOrdersDataScope` were already imported. `PERMISSIONS` already imported.

## Design Decisions

1. **Why guard `cancelOrder` ownership with `!injectedContext`?**
   - The existing `requirePermission(ORDERS_CANCEL)` is already guarded by `!injectedContext` (webhook path skips it because HMAC signature authorizes).
   - The webhook path could theoretically use a synthetic non-elevated employee with `ordersDataScope='own'`, which would block legitimate system-driven cancels. The `!injectedContext` guard preserves the existing webhook bypass pattern.
   - `markOrderPacked()` has no `injectedContext` parameter — UI-only flow — so no guard needed.

2. **Why use `Promise.resolve([])` for the conditional audit fetch in dashboard?**
   - Keeps the `Promise.all` shape (5 entries) so the array destructuring remains unchanged.
   - When `canViewAudit` is false, the audit query is skipped entirely (no DB round-trip), and `recentActivity: []` is returned to the client.

3. **Why `db.company.findUnique` in company GET (vs `settings.activeCompany`)?**
   - The `WorkspaceContext.company` object only contains lightweight fields (`id`, `name`, `slug`, `logoUrl`, `baseCurrency`, `countryCode`, `organizationId`). The full company profile (legalName, taxId, address*, etc.) needs a separate fetch.
   - This is a minor regression — adds 1 query — but it's necessary because `getWorkspace()` doesn't load the full company row. The trade-off is acceptable: this GET is a rare admin-view call, not a hot path.

## Verification

- **Lint**: `bun run lint` → **0 errors, 12 warnings** (all pre-existing `react-hooks/incompatible-library` warnings in unrelated products/*-view.tsx files — NONE in my files).
- **Targeted lint** on the 10 modified files: clean (no output).
- **Git commit**: succeeded — `6abd54d BATCH-5: API route protection + order ownership checks` (10 files changed, 117 insertions(+), 53 deletions(-)).
- **Dev server**: `dev.log` shows a pre-existing `DATABASE_URL` misconfiguration (`must start with the protocol postgresql://`) — UNRELATED to my changes, was present before. My code compiles past the import stage; runtime testing requires the DB URL to be fixed (out of scope).

## No blockers.
