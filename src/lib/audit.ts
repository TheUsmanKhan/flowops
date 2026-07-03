import { db } from './db'
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
 */
export async function insertAuditLog(input: InsertAuditLogInput) {
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
  try {
    return await db.auditLog.create({ data })
  } catch (err) {
    // Audit logging must never break the primary operation.
    console.error('[audit] failed to insert audit log:', err)
    return null
  }
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
