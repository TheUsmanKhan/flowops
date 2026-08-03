import { NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { matchCity } from '@/lib/integrations/city-matcher'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/couriers/match-city
 * Body: { providerKey: string, typedCity: string }
 *
 * Resolves a user-typed city name against cached courier cities.
 * Returns { status: 'matched', cityName } or { status: 'unresolved', suggestions: string[] }.
 *
 * Used by the CityMismatchResolver component and (later) order creation.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const body = await readBody<{ providerKey: string; typedCity: string }>(req)
    if (!body.providerKey || !body.typedCity) {
      throw new ApiError(400, 'providerKey and typedCity are required')
    }

    const result = await matchCity(body.providerKey, body.typedCity, companyId)
    return Response.json(result)
  } catch (err) {
    return handleError(err)
  }
}
