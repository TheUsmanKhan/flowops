/**
 * Shared scoping helpers for the Orders module.
 *
 * These functions enforce server-side order visibility based on the caller's
 * role.ordersDataScope. NEVER trust a frontend filter alone — the server is
 * the authoritative enforcement point.
 */

import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { getWorkspace, getOrdersDataScope, ApiError, type WorkspaceContext } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'
import type { Prisma } from '@prisma/client'

/**
 * Resolve the caller's workspace context + a Prisma `where` filter fragment
 * that enforces ordersDataScope='own' scoping.
 *
 * For elevated roles (Owner/Founder/Co-Founder/Investor) or standard roles
 * with ordersDataScope='all', returns an empty fragment (no salesEmployeeId
 * filter — sees all company orders).
 *
 * For standard roles with ordersDataScope='own', returns
 * `{ salesEmployeeId: ctx.employee.id }` (only their attributed orders).
 *
 * Usage in queue routes:
 *   const { ctx, scopeFilter } = await resolveOrderScope()
 *   const orders = await db.order.findMany({
 *     where: { companyId: ctx.company.id, status: 'pending', ...scopeFilter },
 *     ...
 *   })
 *
 * This replaces the getCurrentUser() + db.userSetting.findUnique + db.employee.findFirst
 * pattern that the queue routes previously used, consolidating to a single
 * getWorkspace() call + the scope filter.
 */
export async function resolveOrderScope(): Promise<{
  ctx: WorkspaceContext
  /** A Prisma fragment to spread into the `where` clause. Empty for 'all' scope. */
  scopeFilter: Prisma.OrderWhereInput
}> {
  const ctx = await getWorkspace()
  await requireOrdersView(ctx)
  const scopeFilter: Prisma.OrderWhereInput =
    getOrdersDataScope(ctx) === 'own'
      ? { salesEmployeeId: ctx.employee.id }
      : {}
  return { ctx, scopeFilter }
}

/**
 * Resolve the caller's workspace context + a Prisma `where` filter fragment
 * for OrderItem-level queries (used by backordered + awaiting-production +
 * returns/review queues, which query OrderItem, not Order).
 *
 * The filter is applied to the `order` relation: `{ order: { salesEmployeeId } }`.
 */
export async function resolveOrderItemScope(): Promise<{
  ctx: WorkspaceContext
  /** A Prisma fragment to spread into the OrderItem `where.order` clause. */
  orderScopeFilter: Prisma.OrderWhereInput
}> {
  const ctx = await getWorkspace()
  await requireOrdersView(ctx)
  const orderScopeFilter: Prisma.OrderWhereInput =
    getOrdersDataScope(ctx) === 'own'
      ? { salesEmployeeId: ctx.employee.id }
      : {}
  return { ctx, orderScopeFilter }
}

/**
 * Lightweight permission check for ORDERS_VIEW. Throws ApiError(403) if the
 * caller lacks it. Elevated roles bypass.
 */
async function requireOrdersView(ctx: WorkspaceContext): Promise<void> {
  if (ctx.employee.role.roleTier === 'elevated') return
  const count = await db.rolePermission.count({
    where: { roleId: ctx.employee.roleId, permissionKey: PERMISSIONS.ORDERS_VIEW },
  })
  if (count === 0) {
    throw new ApiError(403, `You lack the required permission: ${PERMISSIONS.ORDERS_VIEW}`)
  }
}
