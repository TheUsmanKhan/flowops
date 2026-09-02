import { db } from './db'
import { fireAndForget } from './fire-and-forget'
import type { Prisma } from '@prisma/client'

interface InsertAuditLogInput {
  action: string // dot-notation e.g. "employee.invited"
  entityType: string // "employee" | "company" | "organization" | ...
  entityId?: string | null
  companyId?: string | null
  organizationId?: string | null
  userId?: string | null
  employeeId?: string | null
  oldValues?: unknown
  newValues?: unknown
  metadata?: unknown
  ipAddress?: string | null
  userAgent?: string | null
}

/**
 * Insert an immutable audit-log entry. Every mutating server action in
 * FlowOps MUST call this on success. Never updates or deletes rows.
 *
 * FIRE-AND-FORGET (non-blocking):
 *   Returns `void` immediately. The DB write is scheduled on the event
 *   loop via `fireAndForget()` and completes AFTER the caller's response
 *   is sent. This removes the audit-log DB round-trip from the critical
 *   path of every mutation in the system (~159 call sites).
 *
 *   Callers may still write `insertAuditLog({...})` — awaiting
 *   `void` resolves synchronously (a harmless microtask yield), so
 *   existing call sites need NO change. For clarity, call sites SHOULD
 *   drop the `await` (a mechanical pass does this).
 *
 *   The internal try/catch is preserved as a FIRST line of defense — a
 *   failure inside the write never throws. `fireAndForget()`'s `.catch()`
 *   is the SECOND line of defense (defense-in-depth) so no failure can
 *   ever become an unhandled promise rejection.
 *
 *   NOTE: because this now returns `void`, callers cannot use the created
 *   row. No caller in the codebase uses the return value (verified by grep
 *   for `= await insertAuditLog` / `= insertAuditLog`).
 */
export function insertAuditLog(input: InsertAuditLogInput): void {
  const data: Prisma.AuditLogUncheckedCreateInput = {
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    companyId: input.companyId ?? null,
    organizationId: input.organizationId ?? null,
    userId: input.userId ?? null,
    employeeId: input.employeeId ?? null,
    oldValues: input.oldValues ? JSON.stringify(input.oldValues) : null,
    newValues: input.newValues ? JSON.stringify(input.newValues) : null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : '{}',
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  }
  fireAndForget(
    (async () => {
      try {
        await db.auditLog.create({ data })
      } catch (err) {
        // Audit logging must never break the primary operation.
        console.error('[audit] failed to insert audit log:', err)
      }
    })(),
  )
}

/** Parse a metadata JSON column safely. */
export function parseMeta<T = unknown>(raw: string | null): T {
  if (!raw) return {} as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return {} as T
  }
}
