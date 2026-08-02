/**
 * Draft persistence server actions.
 *
 * Saves in-progress form data as JSON in the form_drafts table, so users
 * can save their work before completing a full product/order creation.
 * This is used by the Unsaved Changes Guard system.
 *
 * These actions are strictly additive — they do NOT touch any existing
 * product/order creation logic. Drafts are promoted to real records when
 * the user completes the standard creation flow.
 */

import { db } from '@/lib/db'
import { getWorkspace } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// ──────────────────────────────────────────────────────────────
// saveProductDraft
// ──────────────────────────────────────────────────────────────

export async function saveProductDraft(input: {
  draftId?: string
  draftData: Record<string, unknown>
  draftTitle?: string
}): Promise<ActionResult<{ draftId: string }>> {
  try {
    const ctx = await getWorkspace()

    const data = JSON.stringify(input.draftData)

    if (input.draftId) {
      // Update existing draft
      const existing = await db.formDraft.findFirst({
        where: {
          id: input.draftId,
          companyId: ctx.company.id,
          draftType: 'product',
        },
      })
      if (!existing) {
        return { success: false, error: 'Draft not found' }
      }

      await db.formDraft.update({
        where: { id: input.draftId },
        data: {
          draftData: data,
          draftTitle: input.draftTitle ?? existing.draftTitle,
        },
      })

      return { success: true, data: { draftId: input.draftId } }
    }

    // Create new draft
    const draft = await db.formDraft.create({
      data: {
        organizationId: ctx.company.organizationId,
        companyId: ctx.company.id,
        createdBy: ctx.employee.id,
        draftType: 'product',
        draftData: data,
        draftTitle: input.draftTitle ?? 'Untitled Product Draft',
      },
    })

    await insertAuditLog({
      action: 'draft.product_saved',
      entityType: 'form_draft',
      entityId: draft.id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
    })

    await insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'form_draft',
      entityId: draft.id,
      metricKey: 'draft.product_saved',
      numericValue: 1,
    }).catch(() => {})

    return { success: true, data: { draftId: draft.id } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to save product draft',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// saveOrderDraft
// ──────────────────────────────────────────────────────────────

export async function saveOrderDraft(input: {
  draftId?: string
  draftData: Record<string, unknown>
  draftTitle?: string
}): Promise<ActionResult<{ draftId: string; draftNumber?: string }>> {
  try {
    const ctx = await getWorkspace()

    const data = JSON.stringify(input.draftData)

    if (input.draftId) {
      // Update existing draft — do NOT generate a new draftNumber
      const existing = await db.formDraft.findFirst({
        where: {
          id: input.draftId,
          companyId: ctx.company.id,
          draftType: 'order',
        },
      })
      if (!existing) {
        return { success: false, error: 'Draft not found' }
      }

      await db.formDraft.update({
        where: { id: input.draftId },
        data: {
          draftData: data,
          draftTitle: input.draftTitle ?? existing.draftTitle,
        },
      })

      return { success: true, data: { draftId: input.draftId, draftNumber: existing.draftNumber ?? undefined } }
    }

    // Create new draft — generate a draft number from the independent sequence
    // This calls generate_draft_number() which does nextval('draft_order_number_seq')
    // — completely separate from the real order number generation (generate_order_number()
    // which does MAX+1 on the "Order" table). No shared counter, no shared code path.
    const draftNumberRows = await db.$queryRaw<{ draft_number: string }[]>`
      SELECT generate_draft_number() AS draft_number
    `
    const draftNumber = draftNumberRows[0]?.draft_number

    const draft = await db.formDraft.create({
      data: {
        organizationId: ctx.company.organizationId,
        companyId: ctx.company.id,
        createdBy: ctx.employee.id,
        draftType: 'order',
        draftData: data,
        draftTitle: input.draftTitle ?? 'Untitled Order Draft',
        draftNumber,
      },
    })

    await insertAuditLog({
      action: 'draft.order_saved',
      entityType: 'form_draft',
      entityId: draft.id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
    })

    await insertMetricEvent({
      companyId: ctx.company.id,
      entityType: 'form_draft',
      entityId: draft.id,
      metricKey: 'draft.order_saved',
      numericValue: 1,
    }).catch(() => {})

    return { success: true, data: { draftId: draft.id, draftNumber: draftNumber ?? undefined } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to save order draft',
    }
  }
}

// ══════════════════════════════════════════════════════════════
// listDrafts — fetch drafts for the active company
// ══════════════════════════════════════════════════════════════
/**
 * List form drafts for the active company.
 *
 * @param draftType - 'product' | 'order'
 * @param scope - 'mine' (createdBy = current employee) | 'all' (all in company)
 *                Default: 'mine' for orders, 'all' for products (per Phase 11 spec)
 */
export async function listDrafts(input: {
  draftType: 'product' | 'order'
  scope?: 'mine' | 'all'
}): Promise<ActionResult<{
  drafts: Array<{
    id: string
    draftType: string
    draftTitle: string | null
    draftData: string
    createdAt: Date
    updatedAt: Date
    createdBy: string | null
    createdByEmployee: { user: { fullName: string } } | null
  }>
}>> {
  try {
    const ctx = await getWorkspace()

    const where: Record<string, unknown> = {
      companyId: ctx.company.id,
      draftType: input.draftType,
    }

    // Phase 11: order drafts default to 'mine', product drafts default to 'all'
    const scope = input.scope ?? (input.draftType === 'order' ? 'mine' : 'all')
    if (scope === 'mine') {
      where.createdBy = ctx.employee.id
    }

    const drafts = await db.formDraft.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        createdByEmployee: {
          select: { user: { select: { fullName: true } } },
        },
      },
    })

    return {
      success: true,
      data: {
        drafts: drafts.map((d) => ({
          id: d.id,
          draftType: d.draftType,
          draftTitle: d.draftTitle,
          draftData: d.draftData,
          draftNumber: d.draftNumber,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          createdBy: d.createdBy,
          createdByEmployee: d.createdByEmployee,
        })),
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list drafts',
    }
  }
}

// ══════════════════════════════════════════════════════════════
// countDrafts — lightweight count for sidebar badges
// ══════════════════════════════════════════════════════════════
/**
 * Count drafts by type for the active company. Lightweight query for
 * sidebar badge rendering — does not fetch draft data.
 */
export async function countDrafts(input: {
  draftType: 'product' | 'order'
  scope?: 'mine' | 'all'
}): Promise<ActionResult<{ count: number }>> {
  try {
    const ctx = await getWorkspace()

    const where: Record<string, unknown> = {
      companyId: ctx.company.id,
      draftType: input.draftType,
    }

    const scope = input.scope ?? (input.draftType === 'order' ? 'mine' : 'all')
    if (scope === 'mine') {
      where.createdBy = ctx.employee.id
    }

    const count = await db.formDraft.count({ where })

    return { success: true, data: { count } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to count drafts',
    }
  }
}

// ══════════════════════════════════════════════════════════════
// deleteDraft — remove a draft after finalization or explicit discard
// ══════════════════════════════════════════════════════════════
/**
 * Delete a form draft. Called after a draft is finalized into a real
 * product/order (Phase 10), or when the user explicitly discards a draft.
 */
export async function deleteDraft(draftId: string): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    const draft = await db.formDraft.findFirst({
      where: { id: draftId, companyId: ctx.company.id },
    })
    if (!draft) return { success: false, error: 'Draft not found' }
    await db.formDraft.delete({ where: { id: draftId } })
    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to delete draft',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// getDraft — fetch a single draft by ID (for resume/edit flow)
// ──────────────────────────────────────────────────────────────
export async function getDraft(draftId: string): Promise<ActionResult<{
  id: string
  draftType: string
  draftTitle: string | null
  draftData: string
  draftNumber: string | null
  createdAt: Date
  updatedAt: Date
}>> {
  try {
    const ctx = await getWorkspace()
    const draft = await db.formDraft.findFirst({
      where: { id: draftId, companyId: ctx.company.id },
    })
    if (!draft) return { success: false, error: 'Draft not found' }
    return {
      success: true,
      data: {
        id: draft.id,
        draftType: draft.draftType,
        draftTitle: draft.draftTitle,
        draftData: draft.draftData,
        draftNumber: draft.draftNumber,
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt,
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to get draft',
    }
  }
}

// ══════════════════════════════════════════════════════════════
// DORMANCY RULES — CRITICAL DOCUMENTATION
// ══════════════════════════════════════════════════════════════
// The saveProductDraft and saveOrderDraft actions above MUST NOT:
//   - Decrement or reference inventory_pools
//   - Enter anything into the backorder FIFO queue
//   - Create any payment record (COD, advance, prepaid)
//   - Call updateCustomerStats()
//   - Write to integration_action_logs
//   - Trigger any courier/adapter call
//   - Create any order_items, inventory_transactions, or stock_loss_records
//
// Drafts are stored in the form_drafts table as JSON — completely isolated
// from the real products/orders/inventory tables. They only become real
// records when the user completes the standard creation flow (Phase 10).
//
// If you are a future developer tempted to "helpfully" wire these in:
// DON'T. The isolation is intentional and critical.
// ══════════════════════════════════════════════════════════════
