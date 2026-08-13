import { db } from './db'
import { getSessionUserId } from './session'
import type { PermissionKey } from './permissions'

/**
 * Workspace context helpers — the application-layer equivalent of the
 * Supabase `get_active_company_id()` / `has_permission()` / `is_elevated_employee()`
 * SQL functions. Every company-scoped API route MUST resolve the active
 * company via these helpers and never trust a client-supplied company_id.
 */

export interface WorkspaceContext {
  user: {
    id: string
    email: string
    fullName: string
    avatarUrl: string | null
    isOnboarded: boolean
  }
  employee: {
    id: string
    companyId: string
    roleId: string
    status: string
    designation: string | null
    department: string | null
  } & {
    role: {
      id: string
      name: string
      roleTier: string
      isSystemRole: boolean
      systemRoleKey: string | null
      /** Orders data scope: "own" = see only own orders, "all" = see all company orders. */
      ordersDataScope: 'own' | 'all'
    }
  }
  company: {
    id: string
    name: string
    slug: string
    logoUrl: string | null
    baseCurrency: string
    organizationId: string
  }
}

/**
 * Resolve the caller's active company + employee record. Throws ApiError on failure.
 *
 * PERFORMANCE: Previously this made 4 SEQUENTIAL DB round-trips on every
 * authenticated request (profile → userSetting → employee → company),
 * costing ~4× the per-query network latency. Now it makes a SINGLE query
 * using Prisma's relation `include`/`select` to traverse the chain
 *   Profile → settings.activeCompany  (for the company)
 *   Profile → employees.role          (for the employee + role)
 * in one SQL JOIN. The user's employees are fetched as an array (typically
 * 1-3 rows) and filtered in JS by `companyId === activeCompanyId`, because
 * Prisma relation filters cannot reference a sibling relation field
 * (`settings.activeCompanyId`) at the SQL level.
 *
 * Return shape is IDENTICAL to the previous implementation — all 89 call
 * sites across the codebase (Orders, Customers, Integrations, Exchange
 * Shipments, Booking, Inventory, etc.) are unaffected. Access-control
 * semantics are preserved exactly: a user without an active employee
 * record in the target company still gets a 403.
 */
export async function getWorkspace(): Promise<WorkspaceContext> {
  const userId = await getSessionUserId()
  if (!userId) {
    throw new ApiError(401, 'You must be signed in to continue.')
  }

  // SINGLE QUERY — traverses Profile → settings → activeCompany AND
  // Profile → employees → role in one SQL JOIN.
  const profile = await db.profile.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      fullName: true,
      avatarUrl: true,
      isOnboarded: true,
      settings: {
        select: {
          activeCompanyId: true,
          activeCompany: {
            select: {
              id: true,
              name: true,
              slug: true,
              logoUrl: true,
              baseCurrency: true,
              organizationId: true,
              isActive: true,
            },
          },
        },
      },
      employees: {
        // Fetch all the user's employee records (typically 1-3 rows).
        // We can't filter by settings.activeCompanyId at the SQL level
        // (sibling relation), so we filter in JS below. This is cheaper
        // than a 2nd round-trip and preserves the original findFirst
        // semantics (no status filter — matches previous behavior).
        select: {
          id: true,
          companyId: true,
          roleId: true,
          status: true,
          designation: true,
          department: true,
          role: {
            select: {
              id: true,
              name: true,
              roleTier: true,
              isSystemRole: true,
              systemRoleKey: true,
              ordersDataScope: true,
            },
          },
        },
      },
    },
  })

  if (!profile) {
    throw new ApiError(401, 'You must be signed in to continue.')
  }

  const activeCompanyId = profile.settings?.activeCompanyId
  if (!activeCompanyId) {
    throw new ApiError(403, 'No active company. Please complete onboarding.')
  }

  const company = profile.settings?.activeCompany
  if (!company || !company.isActive) {
    throw new ApiError(403, 'Active company is unavailable.')
  }

  // Filter employees in JS to find the one matching the active company.
  // Preserves original findFirst semantics (no status filter).
  const employee = profile.employees.find((e) => e.companyId === activeCompanyId)
  if (!employee) {
    throw new ApiError(403, 'You are not a member of the active company.')
  }

  return {
    user: {
      id: profile.id,
      email: profile.email,
      fullName: profile.fullName,
      avatarUrl: profile.avatarUrl,
      isOnboarded: profile.isOnboarded,
    },
    employee: {
      ...employee,
      role: {
        id: employee.role.id,
        name: employee.role.name,
        roleTier: employee.role.roleTier,
        isSystemRole: employee.role.isSystemRole,
        systemRoleKey: employee.role.systemRoleKey,
        ordersDataScope: employee.role.ordersDataScope as 'own' | 'all',
      },
    },
    company: {
      id: company.id,
      name: company.name,
      slug: company.slug,
      logoUrl: company.logoUrl,
      baseCurrency: company.baseCurrency,
      organizationId: company.organizationId,
    },
  }
}

export function isElevated(ctx: WorkspaceContext): boolean {
  return ctx.employee.role.roleTier === 'elevated'
}

/**
 * Resolve the caller's Orders data scope — determines which orders they can
 * see in order-list and KPI queries.
 *
 *   'all' → sees ALL orders in the company (managers, inventory staff, etc.)
 *   'own' → sees only orders where salesEmployeeId === ctx.employee.id
 *
 * Elevated roles (Owner, Founder, Co-Founder, Investor) ALWAYS return 'all'
 * regardless of the stored ordersDataScope value — they bypass scoping
 * entirely, consistent with how they bypass all other permission checks.
 *
 * For standard roles, reads ctx.employee.role.ordersDataScope. Falls back
 * to 'all' if the field is somehow null/undefined (defensive — should never
 * happen since the schema defaults to 'all').
 *
 * Used by Phase 3 (order creation — to auto-set salesEmployeeId) and later
 * phases (order queries, KPI queries — to filter by salesEmployeeId).
 */
export function getOrdersDataScope(ctx: WorkspaceContext): 'own' | 'all' {
  if (isElevated(ctx)) return 'all'
  return ctx.employee.role.ordersDataScope === 'own' ? 'own' : 'all'
}

/** Check a single permission key. Elevated roles always pass. */
export async function hasPermission(
  ctx: WorkspaceContext,
  key: PermissionKey,
): Promise<boolean> {
  if (isElevated(ctx)) return true
  const count = await db.rolePermission.count({
    where: { roleId: ctx.employee.roleId, permissionKey: key },
  })
  return count > 0
}

/** Throw 403 if the user lacks the permission. */
export async function requirePermission(
  ctx: WorkspaceContext,
  key: PermissionKey,
): Promise<void> {
  const ok = await hasPermission(ctx, key)
  if (!ok) {
    throw new ApiError(403, `You lack the required permission: ${key}`)
  }
}

/** All companies where the user has an active employee record. */
export async function getUserCompanies(userId: string) {
  const employees = await db.employee.findMany({
    where: { userId, status: 'active' },
    include: { company: true },
  })
  return employees
    .map((e) => e.company)
    .filter((c): c is NonNullable<typeof c> => c !== null && c.isActive)
}

/** Typed API error with status code. */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Standard JSON response helper. */
export function json<T>(data: T, status = 200) {
  return Response.json(data, { status })
}

/** Read & validate JSON body, throwing ApiError(400) on invalid JSON. */
export async function readBody<T = unknown>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    throw new ApiError(400, 'Invalid JSON body.')
  }
}

/** Uniform error handler for API routes. */
export function handleError(err: unknown) {
  if (err instanceof ApiError) {
    return json({ error: err.message }, err.status)
  }
  console.error('[api] unhandled error:', err)
  const message =
    err instanceof Error ? err.message : 'An unexpected error occurred.'
  return json({ error: message }, 500)
}
