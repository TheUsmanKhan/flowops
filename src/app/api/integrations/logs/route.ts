import { db } from '@/lib/db'
import { getWorkspace, isElevated, ApiError, handleError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/integrations/logs
 *
 * Returns integration_action_logs for the active company (elevated only).
 * Filters: provider_key, action_type, status, date_from, date_to.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getWorkspace()
    if (!isElevated(ctx)) {
      throw new ApiError(403, 'Only elevated employees can view integration logs')
    }

    const url = new URL(req.url)
    const providerKey = url.searchParams.get('provider_key')
    const actionType = url.searchParams.get('action_type')
    const status = url.searchParams.get('status')
    const dateFrom = url.searchParams.get('date_from')
    const dateTo = url.searchParams.get('date_to')
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '100'), 200)

    const where: Record<string, unknown> = {
      companyIntegration: {
        companyId: ctx.company.id,
        ...(providerKey ? { provider: { providerKey } } : {}),
      },
    }
    if (actionType) where.actionType = actionType
    if (status) where.status = status
    if (dateFrom || dateTo) {
      where.createdAt = {}
      if (dateFrom) (where.createdAt as Record<string, unknown>).gte = new Date(dateFrom)
      if (dateTo) (where.createdAt as Record<string, unknown>).lte = new Date(dateTo)
    }

    const logs = await db.integrationActionLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        companyIntegration: {
          select: {
            id: true,
            connectionName: true,
            provider: { select: { providerKey: true, providerName: true } },
          },
        },
      },
    })

    return Response.json({
      logs: logs.map((l) => ({
        id: l.id,
        actionType: l.actionType,
        direction: l.direction,
        requestPayload: l.requestPayload,
        responsePayload: l.responsePayload,
        status: l.status,
        errorMessage: l.errorMessage,
        relatedEntityType: l.relatedEntityType,
        relatedEntityId: l.relatedEntityId,
        durationMs: l.durationMs,
        createdAt: l.createdAt.toISOString(),
        integration: {
          connectionName: l.companyIntegration.connectionName,
          providerKey: l.companyIntegration.provider.providerKey,
          providerName: l.companyIntegration.provider.providerName,
        },
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}
