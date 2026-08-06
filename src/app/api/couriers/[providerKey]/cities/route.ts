import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/couriers/[providerKey]/cities?q=search_term
 *
 * Lightweight search endpoint for the CityAutocomplete component.
 * Returns cached courier_operational_cities for the given provider
 * where cityName contains the search term (case-insensitive).
 *
 * Only returns delivery cities (isDeliveryCity=true) — pickup cities
 * are a separate concept used only by the address book.
 *
 * Special providerKey='all': searches across ALL providers' cities
 * (union). Used by the Order Create form when no specific courier is
 * selected yet — the user still gets city suggestions from the union
 * of all connected couriers' cached cities. Results are deduplicated
 * by cityName (case-insensitive), keeping the first provider's entry.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ providerKey: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const { providerKey } = await params

    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') ?? '').trim()
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 50)

    if (providerKey === 'all') {
      // Union mode — search across ALL providers' delivery cities.
      // Deduplicate by case-insensitive cityName, keeping the first match.
      const allCities = await db.courierOperationalCity.findMany({
        where: {
          isDeliveryCity: true,
          ...(q ? { cityName: { contains: q, mode: 'insensitive' as const } } : {}),
        },
        select: {
          id: true,
          cityName: true,
          cityId: true,
          isPickupCity: true,
          isDeliveryCity: true,
          providerKey: true,
        },
        orderBy: { cityName: 'asc' },
        take: limit * 3, // over-fetch to allow dedup without losing results
      })
      const seen = new Set<string>()
      const cities: Array<{
        id: string
        cityName: string
        cityId: string | null
        isPickupCity: boolean
        isDeliveryCity: boolean
        providerKey: string
      }> = []
      for (const c of allCities) {
        const key = c.cityName.toLowerCase()
        if (!seen.has(key)) {
          seen.add(key)
          cities.push(c)
        }
        if (cities.length >= limit) break
      }
      return Response.json({ cities })
    }

    const where = {
      providerKey,
      isDeliveryCity: true,
      ...(q ? { cityName: { contains: q, mode: 'insensitive' as const } } : {}),
    }

    const cities = await db.courierOperationalCity.findMany({
      where,
      select: {
        id: true,
        cityName: true,
        cityId: true,
        isPickupCity: true,
        isDeliveryCity: true,
      },
      orderBy: { cityName: 'asc' },
      take: limit,
    })

    return Response.json({ cities })
  } catch (err) {
    return handleError(err)
  }
}
