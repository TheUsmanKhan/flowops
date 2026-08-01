import { ApiError, handleError, readBody } from '@/lib/workspace'
import {
  listAvailableProviders,
  listCompanyIntegrations,
  connectIntegration,
} from '@/lib/actions/integration.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/integrations?category=courier|ecommerce */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const category = url.searchParams.get('category') as 'courier' | 'ecommerce' | null

    const [providersResult, integrationsResult] = await Promise.all([
      listAvailableProviders(category ?? undefined),
      listCompanyIntegrations(category ?? undefined),
    ])

    if (!providersResult.success) throw new ApiError(400, providersResult.error ?? 'Failed')
    if (!integrationsResult.success) throw new ApiError(400, integrationsResult.error ?? 'Failed')

    return Response.json({
      providers: providersResult.data!.providers,
      integrations: integrationsResult.data!.integrations,
    })
  } catch (err) {
    return handleError(err)
  }
}

/** POST /api/integrations — connect a new integration */
export async function POST(req: Request) {
  try {
    const body = await readBody<Record<string, unknown>>(req)
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
