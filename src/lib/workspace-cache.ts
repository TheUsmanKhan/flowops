/**
 * In-memory cache for WorkspaceContext + role permissions.
 *
 * PROBLEM (from CUSTOMER_SEARCH_AUDIT.md Fix #4):
 *   getWorkspace() does 1 DB query per request (~140-280ms to Supabase pooler).
 *   requirePermission() does 1 DB query per permission check.
 *   This adds ~280-560ms to every authenticated API call.
 *
 * SOLUTION: cache the resolved WorkspaceContext for 60 seconds per user.
 *   - Same user's repeated API calls within 60s hit the cache (0ms).
 *   - Cache invalidates on: company switch, logout, role/permission changes.
 *   - TTL is short enough that staleness is acceptable (company data rarely
 *     changes mid-session; if it does, the user re-logs-in).
 *
 * This is a per-process Map cache (not Redis). In a multi-instance deployment,
 * each instance has its own cache — that's fine for a 60s TTL (worst case:
 * a permission change takes 60s to propagate to all instances, which is
 * acceptable for an ERP system).
 *
 * Cache keys are scoped by userId (NOT by session token — the token carries
 * only userId, so userId is the stable identifier).
 */

import type { WorkspaceContext } from './workspace'

interface CacheEntry<T> {
  value: T
  expiresAt: number // epoch ms
}

const DEFAULT_TTL_MS = 60_000 // 60 seconds

// WorkspaceContext cache: userId → { value, expiresAt }
const workspaceCache = new Map<string, CacheEntry<WorkspaceContext>>()

// Role permissions cache: roleId → { value: Set<permissionKey>, expiresAt }
const rolePermissionsCache = new Map<string, CacheEntry<Set<string>>>()

/**
 * Get a cached WorkspaceContext for the user, or null if not cached / expired.
 */
export function getCachedWorkspace(userId: string): WorkspaceContext | null {
  const entry = workspaceCache.get(userId)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    workspaceCache.delete(userId)
    return null
  }
  return entry.value
}

/**
 * Cache a WorkspaceContext for the user (TTL: 60s).
 */
export function setCachedWorkspace(userId: string, ctx: WorkspaceContext, ttlMs: number = DEFAULT_TTL_MS): void {
  workspaceCache.set(userId, {
    value: ctx,
    expiresAt: Date.now() + ttlMs,
  })
}

/**
 * Invalidate the cached WorkspaceContext for a user.
 * Call this when: user switches company, logs out, or their employee/role
 * is modified (e.g., by an admin in the Employees module).
 */
export function invalidateWorkspaceCache(userId: string): void {
  workspaceCache.delete(userId)
  // Also invalidate role permissions cache — if the user's role changed,
  // their old role's permission set may be cached. Clear it so the next
  // requirePermission call re-fetches.
  // (We don't know the roleId here without a DB query, so we clear the
  // whole rolePermissionsCache — it's small and will refill on demand.)
  rolePermissionsCache.clear()
}

/**
 * Invalidate ALL caches. Call on logout / global role changes.
 */
export function clearAllCaches(): void {
  workspaceCache.clear()
  rolePermissionsCache.clear()
}

// ──────────────────────────────────────────────────────────────
// Role permissions cache
// ──────────────────────────────────────────────────────────────

/**
 * Get cached permission keys for a role, or null if not cached / expired.
 */
export function getCachedRolePermissions(roleId: string): Set<string> | null {
  const entry = rolePermissionsCache.get(roleId)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    rolePermissionsCache.delete(roleId)
    return null
  }
  return entry.value
}

/**
 * Cache permission keys for a role (TTL: 60s).
 */
export function setCachedRolePermissions(roleId: string, permissions: Set<string>, ttlMs: number = DEFAULT_TTL_MS): void {
  rolePermissionsCache.set(roleId, {
    value: permissions,
    expiresAt: Date.now() + ttlMs,
  })
}

/**
 * Invalidate the cached permissions for a specific role.
 * Call this when an admin edits a role's permissions.
 */
export function invalidateRolePermissions(roleId: string): void {
  rolePermissionsCache.delete(roleId)
}
