import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, handleError, readBody, getWorkspace, requirePermission } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'
import { insertAuditLog } from '@/lib/audit'
import { parseLeopardPreferences, DEFAULT_LEOPARD_PREFERENCES } from '@/lib/integrations/couriers/leopard-preferences'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/integrations/[id]/preferences — Leopard integration preferences */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.INTEGRATIONS_MANAGE)
    const { id } = await params

    const integration = await db.companyIntegration.findFirst({
      where: { id, companyId: ctx.company.id },
      select: {
        id: true,
        preferencesJson: true,
        provider: { select: { providerKey: true } },
      },
    })
    if (!integration) throw new ApiError(404, 'Integration not found')

    const prefs = parseLeopardPreferences(integration.preferencesJson)
    return Response.json({ preferences: prefs })
  } catch (err) {
    return handleError(err)
  }
}

/** PUT /api/integrations/[id]/preferences — save Leopard preferences */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.INTEGRATIONS_MANAGE)
    const { id } = await params

    const integration = await db.companyIntegration.findFirst({
      where: { id, companyId: ctx.company.id },
      select: { id: true, preferencesJson: true, provider: { select: { providerKey: true } } },
    })
    if (!integration) throw new ApiError(404, 'Integration not found')

    const body = await readBody<Record<string, unknown>>(req)
    const tx = (body.transactionNote ?? {}) as Record<string, unknown>

    // Merge over defaults so partial updates don't drop fields.
    const merged = {
      enabled: Boolean(tx.enabled ?? DEFAULT_LEOPARD_PREFERENCES.transactionNote.enabled),
      includeProductName: Boolean(tx.includeProductName ?? DEFAULT_LEOPARD_PREFERENCES.transactionNote.includeProductName),
      includeProductCode: Boolean(tx.includeProductCode ?? DEFAULT_LEOPARD_PREFERENCES.transactionNote.includeProductCode),
      includeColor: Boolean(tx.includeColor ?? DEFAULT_LEOPARD_PREFERENCES.transactionNote.includeColor),
      includeQuantity: Boolean(tx.includeQuantity ?? DEFAULT_LEOPARD_PREFERENCES.transactionNote.includeQuantity),
      position: (tx.position === 'end' ? 'end' : 'start') as 'start' | 'end',
      separator: typeof tx.separator === 'string' ? tx.separator : DEFAULT_LEOPARD_PREFERENCES.transactionNote.separator,
    }
    const preferencesJson = JSON.stringify({ transactionNote: merged })

    await db.companyIntegration.update({
      where: { id: integration.id },
      data: { preferencesJson },
    })

    insertAuditLog({
      action: 'integration.preferences.updated',
      entityType: 'company_integration',
      entityId: integration.id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      oldValues: integration.preferencesJson ? { preferences: JSON.parse(integration.preferencesJson) } : null,
      newValues: { preferences: { transactionNote: merged } },
    })

    return Response.json({ ok: true, preferences: { transactionNote: merged } })
  } catch (err) {
    return handleError(err)
  }
}
