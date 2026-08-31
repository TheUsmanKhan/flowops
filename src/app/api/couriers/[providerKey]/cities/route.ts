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
 *   selected yet — the user still gets city suggestions from the union
 *   of all connected couriers' cached cities. Results are GROUPED by
 *   cityName (case-insensitive) — each city appears once with a
 *   `servedBy` array listing ALL providers that serve it. This powers
 *   the courier-name badges in the autocomplete dropdown.
 *   (live=true is NOT supported in 'all' mode — there's no single courier
 *   to fetch from.)
 *
 * COURIER BADGES (servedBy):
 *   Every city in the response includes a `servedBy` array:
 *     [{ providerKey: 'leopard', isPickupCity: true, isDeliveryCity: true },
 *      { providerKey: 'postex', isPickupCity: true, isDeliveryCity: true }]
 *   The UI uses this to show courier-name badges (PostEx/Leopard/etc.) per
 *   city instead of Pickup/Delivery badges. In per-provider mode, servedBy
 *   includes the selected provider + any OTHER providers that also serve
 *   the same city name. In 'all' mode, servedBy includes ALL providers
 *   that serve the city.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ providerKey: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const { providerKey } = await params

    // ── Resolve the caller's active company to scope servedBy[] ──
    // CourierOperationalCity rows are global reference data (shared across
    // tenants by design — see city-sync.actions.ts), but the courier-name
    // badges shown to the user should only reflect providers the CALLING
    // company has an active, connected integration for. A company with no
    // Leopard integration (or a still-pending one) should never see a
    // 'leopard' badge, even though the underlying city rows are shared.
    //
    // This matches the auth pattern used by the sibling courier routes
    // (sync-cities, match-city): getCurrentUser() → userSetting → companyId.
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')
    const connectedIntegrations = await db.companyIntegration.findMany({
      where: { companyId, isActive: true, connectionStatus: 'connected' },
      select: { provider: { select: { providerKey: true } } },
    })
    const connectedProviderKeys = new Set(
      connectedIntegrations.map((i) => i.provider.providerKey),
    )

    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') ?? '').trim()
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 50)
    const wantLive = searchParams.get('live') === 'true'

    if (providerKey === 'all') {
      // Union mode — search across ALL providers' delivery cities.
      // GROUP by cityName (case-insensitive) — each city appears once with
      // a servedBy array of ALL providers that serve it AND that the calling
      // company has an active, connected integration for. A provider the
      // company hasn't connected (or whose integration is still pending)
      // is excluded from servedBy[], so its badge never shows up.
      //
      // If the company has NO connected courier integrations, return an
      // empty list immediately (no point querying the cache).
      if (connectedProviderKeys.size === 0) {
        return Response.json({ cities: [] })
      }
      const allCities = await db.courierOperationalCity.findMany({
        where: {
          isDeliveryCity: true,
          providerKey: { in: Array.from(connectedProviderKeys) },
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
        take: limit * 5, // over-fetch to allow grouping without losing results
      })

      // Group by cityName (case-insensitive), preserving first-seen order
      const grouped = new Map<string, {
        id: string
        cityName: string
        cityId: string | null
        isPickupCity: boolean
        isDeliveryCity: boolean
        providerKey: string
        servedBy: Array<{ providerKey: string; isPickupCity: boolean; isDeliveryCity: boolean }>
      }>()
      for (const c of allCities) {
        const key = c.cityName.toLowerCase()
        const existing = grouped.get(key)
        if (existing) {
          // Add this provider to servedBy; also OR the pickup/delivery flags
          // so the primary fields reflect "at least one provider supports this"
          existing.servedBy.push({
            providerKey: c.providerKey,
            isPickupCity: c.isPickupCity,
            isDeliveryCity: c.isDeliveryCity,
          })
          existing.isPickupCity = existing.isPickupCity || c.isPickupCity
          existing.isDeliveryCity = existing.isDeliveryCity || c.isDeliveryCity
        } else {
          grouped.set(key, {
            id: c.id,
            cityName: c.cityName,
            cityId: c.cityId,
            isPickupCity: c.isPickupCity,
            isDeliveryCity: c.isDeliveryCity,
            providerKey: c.providerKey,
            servedBy: [{
              providerKey: c.providerKey,
              isPickupCity: c.isPickupCity,
              isDeliveryCity: c.isDeliveryCity,
            }],
          })
        }
        if (grouped.size >= limit) break
      }
      return Response.json({ cities: Array.from(grouped.values()) })
    }

    // ── Per-provider mode guard ──
    // If the calling company has NO active, connected integration for the
    // requested providerKey, return an empty list. This prevents a company
    // from querying a specific courier's cities they haven't connected
    // (e.g. a company with no Leopard integration shouldn't see Leopard's
    // city cache, even though the rows are globally shared).
    if (!connectedProviderKeys.has(providerKey)) {
      return Response.json({ cities: [] })
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

    // ── Enrich with servedBy: which OTHER providers also serve each city ──
    // For each city in the result, look up ALL providers that have the same
    // cityName (case-insensitive). This powers the courier-name badges in the
    // UI (e.g. "this city is served by Leopard AND PostEx"). FILTERED to only
    // include providers the calling company has connected — a provider the
    // company hasn't connected won't appear in servedBy[] even if it serves
    // the same city globally.
    let citiesWithCoverage: Array<{
      id: string
      cityName: string
      cityId: string | null
      isPickupCity: boolean
      isDeliveryCity: boolean
      providerKey: string
      servedBy: Array<{ providerKey: string; isPickupCity: boolean; isDeliveryCity: boolean }>
    }> = cities.map((c) => ({
      ...c,
      providerKey,
      servedBy: [{
        providerKey,
        isPickupCity: c.isPickupCity,
        isDeliveryCity: c.isDeliveryCity,
      }],
    }))

    if (cities.length > 0) {
      const cityNames = cities.map((c) => c.cityName)
      const allProviders = await db.courierOperationalCity.findMany({
        where: {
          cityName: { in: cityNames, mode: 'insensitive' as const },
          isDeliveryCity: true,
          // Scope to providers the calling company has connected — same
          // filter as the 'all' mode above. A provider the company hasn't
          // connected won't show up as a badge on any city.
          providerKey: { in: Array.from(connectedProviderKeys) },
        },
        select: { cityName: true, providerKey: true, isPickupCity: true, isDeliveryCity: true },
      })
      // Build a lookup: cityName(lower) -> [{ providerKey, isPickupCity, isDeliveryCity }]
      const byCity = new Map<string, Array<{ providerKey: string; isPickupCity: boolean; isDeliveryCity: boolean }>>()
      for (const c of allProviders) {
        const key = c.cityName.toLowerCase()
        if (!byCity.has(key)) byCity.set(key, [])
        byCity.get(key)!.push({
          providerKey: c.providerKey,
          isPickupCity: c.isPickupCity,
          isDeliveryCity: c.isDeliveryCity,
        })
      }
      citiesWithCoverage = citiesWithCoverage.map((c) => ({
        ...c,
        servedBy: byCity.get(c.cityName.toLowerCase()) ?? c.servedBy,
      }))
    }

    return Response.json({ cities: citiesWithCoverage })
  } catch (err) {
    return handleError(err)
  }
}
