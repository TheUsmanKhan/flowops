import { NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { saveCityAlias } from '@/lib/integrations/city-matcher'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/couriers/save-city-alias
 * Body: { providerKey: string, typedCity: string, resolvedCityName: string }
 *
 * Persists a confirmed city mapping so it auto-resolves next time.
 * Called after a staff member manually confirms a suggested/corrected city.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const body = await readBody<{
      providerKey: string
      typedCity: string
      resolvedCityName: string
    }>(req)
    if (!body.providerKey || !body.typedCity || !body.resolvedCityName) {
      throw new ApiError(400, 'providerKey, typedCity, and resolvedCityName are required')
    }

    await saveCityAlias(body.providerKey, body.typedCity, body.resolvedCityName, companyId)
    return Response.json({ success: true })
  } catch (err) {
    return handleError(err)
  }
}
