import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { ensureCityCached } from '@/lib/integrations/city-matcher'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/couriers/[providerKey]/cities?q=search_term&live=true
 *
 * Lightweight search endpoint for the CityAutocomplete component.
 * Returns cached courier_operational_cities for the given provider
 * where cityName contains the search term (case-insensitive).
 *
 * Only returns delivery cities (isDeliveryCity=true) — pickup cities
 * are a separate concept used only by the address book.
 *
 * AUTO-FETCH MISSING CITIES (live=true):
 *   When `live=true` is passed AND the cache returns ZERO results for the
 *   query, the route calls ensureCityCached() which fetches the full city
 *   list live from the courier API, upserts ALL cities into the cache, then
 *   re-runs the search. This guarantees no city is ever permanently
 *   "missing" from the UI — if the courier serves it, it WILL appear after
 *   the live fetch. The frontend CityAutocomplete component automatically
 *   appends `live=true` on its second attempt when the first returns empty.
 *   The live fetch is non-fatal: if the courier API is unreachable or no
 *   integration is connected, the route simply returns an empty list.
 *
 * Special providerKey='all': searches across ALL providers' cities
 * (union). Used by the Order Create form when no specific courier is
 * selected yet — the user still gets city suggestions from the union
 * of all connected couriers' cached cities. Results are deduplicated
 * by cityName (case-insensitive), keeping the first provider's entry.
 * (live=true is NOT supported in 'all' mode — there's no single courier
 * to fetch from.)
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
    const wantLive = searchParams.get('live') === 'true'

    if (providerKey === 'all') {
      // Union mode — search across ALL providers' delivery cities.
      // Deduplicate by case-insensitive cityName, AGGREGATE all providers
      // covering that city into a `providers: string[]` array so the
      // frontend can show courier badges (e.g. "Leopard + PostEx").
      // live=true is NOT supported in 'all' mode (no single courier to fetch from).
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
        take: limit * 10, // over-fetch to aggregate all providers per city
      })

      // Group by case-insensitive cityName, collecting all providers
      const byName = new Map<
        string,
        {
          id: string
          cityName: string
          cityId: string | null
          isPickupCity: boolean
          isDeliveryCity: boolean
          providers: string[]
        }
      >()
      for (const c of allCities) {
        const key = c.cityName.toLowerCase()
        const existing = byName.get(key)
        if (existing) {
          // Aggregate: a city is a pickup/delivery city if ANY provider serves it as such
          if (c.isPickupCity) existing.isPickupCity = true
          if (c.isDeliveryCity) existing.isDeliveryCity = true
          if (!existing.providers.includes(c.providerKey)) {
            existing.providers.push(c.providerKey)
          }
        } else {
          byName.set(key, {
            id: c.id,
            cityName: c.cityName,
            cityId: c.cityId,
            isPickupCity: c.isPickupCity,
            isDeliveryCity: c.isDeliveryCity,
            providers: [c.providerKey],
          })
        }
        if (byName.size >= limit * 3) break // safety cap
      }

      const cities = Array.from(byName.values()).slice(0, limit)
      return Response.json({ cities })
    }

    const where = {
      providerKey,
      isDeliveryCity: true,
      ...(q ? { cityName: { contains: q, mode: 'insensitive' as const } } : {}),
    }

    let cities = await db.courierOperationalCity.findMany({
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

    // ── AUTO-FETCH MISSING CITY ──
    // If the cache returned nothing AND the caller asked for a live
    // fallback, fetch the full city list from the courier API, cache it,
    // then re-run the search. This catches cities that exist at the
    // courier but aren't in our cache yet (recently added, or the last
    // bulk sync failed/hasn't run). Non-fatal: returns empty list on error.
    if (cities.length === 0 && wantLive && q.length >= 2) {
      await ensureCityCached(providerKey, q)
      // Re-run the same search against the now-refreshed cache.
      cities = await db.courierOperationalCity.findMany({
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
    }

    // Single-provider mode: attach the providerKey as a single-element
    // `providers` array so the frontend can use one consistent code path
    // for rendering courier badges in both 'all' and single-provider modes.
    const citiesWithProviders = cities.map((c) => ({
      ...c,
      providers: [providerKey],
    }))

    return Response.json({ cities: citiesWithProviders })
  } catch (err) {
    return handleError(err)
  }
}
