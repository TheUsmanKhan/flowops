import { db } from './db'
import { getCurrentUser } from './session'
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

/** Resolve the caller's active company + employee record. Throws ApiError on failure. */
export async function getWorkspace(): Promise<WorkspaceContext> {
  const user = await getCurrentUser()
  if (!user) {
    throw new ApiError(401, 'You must be signed in to continue.')
  }

  const settings = await db.userSetting.findUnique({
    where: { userId: user.id },
  })
  const activeCompanyId = settings?.activeCompanyId
  if (!activeCompanyId) {
    throw new ApiError(403, 'No active company. Please complete onboarding.')
  }

  const employee = await db.employee.findFirst({
    where: { companyId: activeCompanyId, userId: user.id },
    include: { role: true },
  })
  if (!employee) {
    throw new ApiError(403, 'You are not a member of the active company.')
  }

  const company = await db.company.findUnique({ where: { id: activeCompanyId } })
  if (!company || !company.isActive) {
    throw new ApiError(403, 'Active company is unavailable.')
  }

  return {
    user,
    employee: {
      ...employee,
      role: {
        id: employee.role.id,
        name: employee.role.name,
        roleTier: employee.role.roleTier,
        isSystemRole: employee.role.isSystemRole,
        systemRoleKey: employee.role.systemRoleKey,
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
