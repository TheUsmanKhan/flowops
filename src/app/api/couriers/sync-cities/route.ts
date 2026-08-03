import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { syncCourierOperationalCities } from '@/lib/actions/city-sync.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/couriers/sync-cities
 * Body: { providerKey: string } (optional — if omitted, syncs all providers)
 *
 * Manually triggers the city sync job. Intended for:
 *   - Initial sync after connecting a new courier integration.
 *   - Manual refresh when a courier adds new cities.
 *   - The scheduled 3-hour job (when infrastructure scheduling is connected).
 *
 * Elevated-only (involves making API calls with stored credentials).
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    if (caller.role.roleTier !== 'elevated') {
      throw new ApiError(403, 'Only elevated roles can trigger city sync.')
    }

    const body = await readBody<{ providerKey?: string }>(req).catch(() => ({ providerKey: undefined }))

    if (body.providerKey) {
      const result = await syncCourierOperationalCities(body.providerKey)
      return Response.json(result)
    } else {
      // Sync all providers — import the syncAll function lazily to avoid
      // circular dependency issues at module load time
      const { syncAllCourierCities } = await import('@/lib/actions/city-sync.actions')
      const results = await syncAllCourierCities()
      return Response.json({ results })
    }
  } catch (err) {
    return handleError(err)
  }
}
