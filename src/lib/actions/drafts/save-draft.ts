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
}): Promise<ActionResult<{ draftId: string }>> {
  try {
    const ctx = await getWorkspace()

    const data = JSON.stringify(input.draftData)

    if (input.draftId) {
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

      return { success: true, data: { draftId: input.draftId } }
    }

    const draft = await db.formDraft.create({
      data: {
        organizationId: ctx.company.organizationId,
        companyId: ctx.company.id,
        createdBy: ctx.employee.id,
        draftType: 'order',
        draftData: data,
        draftTitle: input.draftTitle ?? 'Untitled Order Draft',
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

    return { success: true, data: { draftId: draft.id } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to save order draft',
    }
  }
}
