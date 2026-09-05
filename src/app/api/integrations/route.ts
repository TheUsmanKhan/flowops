import { db } from '@/lib/db'
import {
  getWorkspace,
  requirePermission,
  handleError,
  readBody,
  ApiError,
} from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/integrations?category=courier|ecommerce
 *
 * Inlined from integration.actions.ts to avoid loading the 800-line module
 * (which has deep transitive deps — courier adapters, registry, logged-call,
 * encryption — that fail on Hostinger production).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const category = url.searchParams.get('category') as
      | 'courier'
      | 'ecommerce'
      | null

    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.INTEGRATIONS_VIEW)

    // Dynamic import — registry is needed for adapter status but is heavy
    const { getAdapterStatus } = await import('@/lib/integrations/registry')

    const providerWhere: { category?: string; isActive: boolean } = {
      isActive: true,
    }
    if (category) providerWhere.category = category

    const [providers, integrations] = await Promise.all([
      db.integrationProvider.findMany({
        where: providerWhere,
        orderBy: { category: 'asc' },
      }),
      db.companyIntegration.findMany({
        where: {
          companyId: ctx.company.id,
          ...(category ? { provider: { category } } : {}),
        },
        include: {
          provider: {
            select: {
              id: true,
              providerKey: true,
              providerName: true,
              category: true,
              logoUrl: true,
              authType: true,
              supportsWebhook: true,
              configSchema: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ])

    const appUrl = process.env.APP_URL || 'http://localhost:3000'

    return Response.json({
      providers: providers.map((p) => ({
        id: p.id,
        providerKey: p.providerKey,
        providerName: p.providerName,
        category: p.category,
        logoUrl: p.logoUrl,
        authType: p.authType,
        supportsWebhook: p.supportsWebhook,
        configSchema: p.configSchema,
        capabilities: p.capabilities,
        adapterStatus: getAdapterStatus(p.providerKey),
      })),
      integrations: integrations.map((i) => ({
        id: i.id,
        connectionName: i.connectionName,
        isActive: i.isActive,
        isDefault: i.isDefault,
        connectionStatus: i.connectionStatus,
        lastSyncAt: i.lastSyncAt,
        lastError: i.lastError,
        webhookEndpointId: i.webhookEndpointId,
        webhookUrl: i.webhookEndpointId
          ? `${appUrl}/api/webhooks/${i.provider.providerKey}/${i.webhookEndpointId}`
          : null,
        createdAt: i.createdAt,
        provider: {
          id: i.provider.id,
          providerKey: i.provider.providerKey,
          providerName: i.provider.providerName,
          category: i.provider.category,
          logoUrl: i.provider.logoUrl,
          authType: i.provider.authType,
          supportsWebhook: i.provider.supportsWebhook,
        },
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}

/** POST /api/integrations — connect a new integration */
export async function POST(req: Request) {
  try {
    const body = await readBody<Record<string, unknown>>(req)
    const idempotencyKey = req.headers.get('Idempotency-Key')

    // Dynamic import — connectIntegration is heavy (encryption, adapter init)
    const { connectIntegration } = await import(
      '@/lib/actions/integration.actions'
    )

    if (idempotencyKey) {
      const ctx = await getWorkspace()
      const { withIdempotency } = await import('@/lib/idempotency')
      const { result, wasReplay } = await withIdempotency({
        key: idempotencyKey,
        companyId: ctx.company.id,
        employeeId: ctx.employee.id,
        actionType: 'integration.connect',
        fn: async () => {
          const res = await connectIntegration({
            providerId: String(body.provider_id ?? ''),
            connectionName: String(body.connection_name ?? ''),
            credentials: (body.credentials as Record<string, string>) ?? {},
          })
          if (!res.success || !res.data) {
            throw new ApiError(
              400,
              res.error ?? 'Failed to connect integration',
            )
          }
          return res.data
        },
      })
      return Response.json(result, { status: wasReplay ? 200 : 201 })
    }

    const result = await connectIntegration({
      providerId: String(body.provider_id ?? ''),
      connectionName: String(body.connection_name ?? ''),
      credentials: (body.credentials as Record<string, string>) ?? {},
    })
    if (!result.success) throw new ApiError(400, result.error ?? 'Failed')
    return Response.json(result.data, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
