/**
 * City Matching Logic — Provider-Agnostic.
 *
 * Resolves a user-typed city name against the cached courier_operational_cities
 * for a given provider. Uses a 3-tier strategy:
 *   1. Learned aliases (courier_city_aliases) — company-specific takes priority
 *      over org-wide.
 *   2. Exact case-insensitive match against delivery cities.
 *   3. Fuzzy Levenshtein-distance similarity (top 3 suggestions above 70%).
 *
 * Also provides:
 *   - saveCityAlias(): persists a confirmed mapping for future auto-resolution.
 *   - revalidateCityAtBookingTime(): final authoritative check at the exact
 *     moment of courier booking — guards against the 3-hour sync window where
 *     a city could have been disabled between order creation and booking.
 */

import { db } from '@/lib/db'

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export type MatchCityResult =
  | { status: 'matched'; cityName: string }
  | { status: 'unresolved'; suggestions: string[] }

// ──────────────────────────────────────────────────────────────
// Levenshtein distance — lightweight inline implementation
// (no new npm dependency needed; this is ~30 lines and well-understood)
// ──────────────────────────────────────────────────────────────

/**
 * Compute the Levenshtein distance between two strings.
 * The minimum number of single-character edits (insertions, deletions,
 * substitutions) required to change one string into the other.
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m

  // Use two rows (previous + current) to save memory
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)

  for (let j = 0; j <= n; j++) prev[j] = j

  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost, // substitution
      )
    }
    ;[prev, curr] = [curr, prev]
  }

  return prev[n]
}

/**
 * Compute a similarity ratio (0 to 1) between two strings.
 * 1 = identical, 0 = completely different.
 * Uses Levenshtein distance normalized by the longer string's length.
 */
function similarityRatio(a: string, b: string): number {
  const longer = a.length > b.length ? a : b
  const shorter = a.length > b.length ? b : a
  if (longer.length === 0) return 1.0 // both empty
  const distance = levenshteinDistance(longer, shorter)
  return (longer.length - distance) / longer.length
}

/** Minimum similarity ratio for a suggestion to be included (70%). */
const SUGGESTION_THRESHOLD = 0.7

/** Maximum number of suggestions to return. */
const MAX_SUGGESTIONS = 3

// ──────────────────────────────────────────────────────────────
// matchCity — the main 3-tier resolver
// ──────────────────────────────────────────────────────────────

/**
 * Resolve a user-typed city name against cached courier cities.
 *
 * Strategy:
 *   1. Check courier_city_aliases for an existing learned mapping
 *      (company-specific alias takes priority over org-wide alias).
 *   2. Try exact match (case-insensitive) against courier_operational_cities
 *      where isDeliveryCity=true for that providerKey.
 *   3. Run fuzzy similarity check against all cached cities for that provider,
 *      return top 3 suggestions above the 70% threshold.
 *   4. If nothing meets the threshold, return unresolved with empty suggestions.
 */
export async function matchCity(
  providerKey: string,
  typedCity: string,
  companyId?: string,
): Promise<MatchCityResult> {
  const normalizedTyped = typedCity.trim().toLowerCase()
  if (!normalizedTyped) {
    return { status: 'unresolved', suggestions: [] }
  }

  // ── Tier 1: Learned aliases ──
  // Company-specific alias takes priority over org-wide (companyId=null).
  const aliasWhere = {
    providerKey,
    typedCityText: normalizedTyped,
    ...(companyId ? { OR: [{ companyId }, { companyId: null }] } : { companyId: null }),
  }
  const aliases = await db.courierCityAlias.findMany({
    where: aliasWhere,
    orderBy: { companyId: 'desc' }, // company-specific first (non-null sorts first in desc)
    select: { resolvedCityName: true, companyId: true },
  })

  if (aliases.length > 0) {
    // Company-specific alias (companyId non-null) takes priority
    const companyAlias = aliases.find((a) => a.companyId !== null)
    const resolved = (companyAlias ?? aliases[0]).resolvedCityName
    // Verify the resolved city is still a valid delivery city
    const stillValid = await db.courierOperationalCity.findFirst({
      where: { providerKey, cityName: resolved, isDeliveryCity: true },
      select: { id: true },
    })
    if (stillValid) {
      return { status: 'matched', cityName: resolved }
    }
    // If the alias points to a now-disabled city, fall through to other tiers
  }

  // ── Tier 2: Exact case-insensitive match ──
  const exactMatch = await db.courierOperationalCity.findFirst({
    where: {
      providerKey,
      isDeliveryCity: true,
      cityName: { equals: typedCity.trim(), mode: 'insensitive' },
    },
    select: { cityName: true },
  })
  if (exactMatch) {
    return { status: 'matched', cityName: exactMatch.cityName }
  }

  // ── Tier 3: Fuzzy similarity ──
  const allCities = await db.courierOperationalCity.findMany({
    where: { providerKey, isDeliveryCity: true },
    select: { cityName: true },
  })

  const scored = allCities.map((c) => ({
    cityName: c.cityName,
    score: similarityRatio(normalizedTyped, c.cityName.toLowerCase()),
  }))

  const suggestions = scored
    .filter((s) => s.score >= SUGGESTION_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => s.cityName)

  return { status: 'unresolved', suggestions }
}

// ──────────────────────────────────────────────────────────────
// saveCityAlias — persists a confirmed mapping
// ──────────────────────────────────────────────────────────────

/**
 * Persist a confirmed city mapping so it auto-resolves next time.
 * Called after a staff member manually confirms a suggested/corrected city.
 *
 * If companyId is provided, the alias is company-specific (takes priority
 * over org-wide). If null/omitted, it's org-wide.
 */
export async function saveCityAlias(
  providerKey: string,
  typedCity: string,
  resolvedCityName: string,
  companyId?: string,
): Promise<void> {
  const normalizedTyped = typedCity.trim().toLowerCase()
  if (!normalizedTyped || !resolvedCityName.trim()) return

  // Check if alias already exists (compound unique key includes nullable companyId,
  // which Prisma's upsert can't handle directly for the where clause when companyId is null)
  const existing = await db.courierCityAlias.findFirst({
    where: {
      providerKey,
      typedCityText: normalizedTyped,
      companyId: companyId ?? null,
    },
  })

  if (existing) {
    await db.courierCityAlias.update({
      where: { id: existing.id },
      data: { resolvedCityName: resolvedCityName.trim() },
    })
  } else {
    await db.courierCityAlias.create({
      data: {
        providerKey,
        typedCityText: normalizedTyped,
        resolvedCityName: resolvedCityName.trim(),
        companyId: companyId ?? null,
      },
    })
  }
}

// ──────────────────────────────────────────────────────────────
// ensureCityCached — on-demand city fetch for the search autocomplete
// ──────────────────────────────────────────────────────────────

/**
 * Ensure a specific city is present in the local cache by fetching the full
 * city list live from the courier if the city is missing.
 *
 * This is the ON-DEMAND city fetch used by the city-search autocomplete
 * (GET /api/couriers/[providerKey]/cities?live=true) so that a genuinely
 * missing city — one not in courier_operational_cities because the last
 * bulk sync hasn't run yet, or the city was recently added by the courier —
 * is fetched and cached the moment a user searches for it. This guarantees
 * no city is ever permanently "missing" from the UI.
 *
 * Mirrors the live-fallback logic of revalidateCityAtBookingTime() but:
 *   - returns the city OBJECT (not a boolean) so the caller can use it
 *   - has NO staleness gate (a pure cache-miss trigger — if the city IS
 *     cached, even if stale, we return it immediately without re-fetching;
 *     staleness is the booking-time check's concern, not the search's)
 *   - is non-fatal: returns null on any error so the search UI can still
 *     show "no results" gracefully
 *
 * @param providerKey  The courier provider key (e.g. 'postex')
 * @param cityName     The city name to ensure is cached (case-insensitive)
 * @returns The cached city row, or null if it couldn't be resolved.
 */
export async function ensureCityCached(
  providerKey: string,
  cityName: string,
): Promise<{ id: string; cityName: string; cityId: string | null; isPickupCity: boolean; isDeliveryCity: boolean } | null> {
  const trimmed = cityName.trim()
  if (!trimmed) return null

  // ── Tier 1: cache lookup (fast path — no staleness gate) ──
  const cached = await db.courierOperationalCity.findFirst({
    where: {
      providerKey,
      cityName: { equals: trimmed, mode: 'insensitive' },
    },
    select: { id: true, cityName: true, cityId: true, isPickupCity: true, isDeliveryCity: true },
  })
  if (cached) {
    return cached
  }

  // ── Tier 2: cache miss → live courier API fallback ──
  // Find ANY active integration for this provider to decrypt credentials.
  const integration = await db.companyIntegration.findFirst({
    where: { provider: { providerKey }, isActive: true },
    include: { provider: true },
  })
  if (!integration || !integration.credentialsEncrypted) {
    return null // no credentials → can't fetch live
  }

  try {
    const { decryptCredentials } = await import('@/lib/utils/encryption')
    const { getCourierAdapter } = await import('@/lib/integrations/registry')

    const adapter = getCourierAdapter(
      integration.provider.providerKey,
      decryptCredentials(integration.credentialsEncrypted),
    )
    if (!adapter.fetchOperationalCities) {
      return null // adapter doesn't support live city fetching
    }

    // Fetch ALL cities live (neither PostEx nor Leopard exposes a per-city
    // search endpoint — both return the full list).
    const liveCities = await adapter.fetchOperationalCities()

    // Bulk-insert ALL fetched cities in a SINGLE query via createMany +
    // skipDuplicates. This is dramatically faster than N individual upserts
    // (873 cities × ~100ms/query = ~87s sequential vs ~1s for one bulk
    // INSERT). skipDuplicates generates INSERT ... ON CONFLICT DO NOTHING,
    // so existing cities are left untouched (their flags/lastSyncedAt stay
    // as-is — the periodic bulk sync + the booking-time staleness check
    // handle flag refreshes). For the SEARCH use case, the only goal is to
    // make missing cities APPEAR in results — we don't need to refresh
    // existing cities' metadata here.
    const now = new Date()
    if (liveCities.length > 0) {
      await db.courierOperationalCity.createMany({
        data: liveCities.map((c) => ({
          providerKey,
          cityName: c.cityName,
          cityId: c.cityId ?? null,
          isPickupCity: c.isPickupCity,
          isDeliveryCity: c.isDeliveryCity,
          lastSyncedAt: now,
        })),
        skipDuplicates: true,
      })
    }

    // Now re-query the target city from the freshly-updated cache.
    const refreshed = await db.courierOperationalCity.findFirst({
      where: {
        providerKey,
        cityName: { equals: trimmed, mode: 'insensitive' },
      },
      select: { id: true, cityName: true, cityId: true, isPickupCity: true, isDeliveryCity: true },
    })
    return refreshed ?? null
  } catch (err) {
    // Live fallback failed — non-fatal for search (just return null).
    console.error(
      `[city-matcher] ensureCityCached live fallback failed for ${providerKey}/${trimmed}:`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

// ──────────────────────────────────────────────────────────────
// revalidateCityAtBookingTime — final authoritative check
// ──────────────────────────────────────────────────────────────

/**
 * Final, authoritative check performed at the exact moment of courier booking
 * (not just at order-creation time). Confirms the city is STILL marked
 * isDeliveryCity=true in the current cache.
 *
 * This guards against the 3-hour sync window where a city could have been
 * disabled between order creation and actual booking.
 *
 * Returns true if the city is still a valid delivery city, false otherwise.
 */
/**
 * Final authoritative city validation at the exact moment of courier booking.
 *
 * Two-tier check with staleness protection:
 *   1. Local cache lookup — if the city exists AND its lastSyncedAt is fresh
 *      (< 3 hours), trust the isDeliveryCity flag and return immediately.
 *   2. Live courier API fallback — fires when:
 *      a) The city is NOT in the cache at all (cache miss), OR
 *      b) The cached city's lastSyncedAt is STALE (> 3 hours old) — the
 *         courier may have disabled the city since our last sync.
 *
 * In both fallback cases, we fetch the full city list live from the courier,
 * upsert ALL cities into the cache (refreshing lastSyncedAt), then re-check.
 *
 * FAIL-SAFE: if the live fetch fails (network error, bad credentials), we
 * do NOT proceed on stale data — we return false with a clear "could not
 * verify city availability" semantic. Booking is blocked rather than
 * risking a courier rejection downstream.
 *
 * @param providerKey The courier provider key (e.g. 'postex')
 * @param cityName The delivery city name to validate
 * @param companyIntegrationId Required for the live fallback (to decrypt
 *   credentials). If not provided, staleness check is skipped and only the
 *   pure local-cache lookup runs (degrades to original behavior).
 * @returns true if the city is a valid delivery city, false otherwise.
 */
export async function revalidateCityAtBookingTime(
  providerKey: string,
  cityName: string,
  companyIntegrationId?: string,
): Promise<boolean> {
  // 3-hour staleness threshold — matches the intended cron sync interval.
  const STALE_THRESHOLD_MS = 3 * 60 * 60 * 1000

  // ── Tier 1: local cache lookup (fast path) ──
  const city = await db.courierOperationalCity.findFirst({
    where: {
      providerKey,
      cityName: { equals: cityName, mode: 'insensitive' },
    },
    select: { id: true, cityName: true, isDeliveryCity: true, lastSyncedAt: true },
  })

  const isStale = (city?.lastSyncedAt?.getTime() ?? 0) < Date.now() - STALE_THRESHOLD_MS

  if (city && !isStale) {
    // Fresh cache hit — trust the isDeliveryCity flag
    if (city.isDeliveryCity) {
      // Bump lastSyncedAt (non-blocking) so we know this city was recently confirmed
      db.courierOperationalCity
        .update({ where: { id: city.id }, data: { lastSyncedAt: new Date() } })
        .catch(() => {})
      return true
    }
    // Fresh cache says city is NOT a delivery city — trust it
    return false
  }

  // ── Tier 2: live courier API fallback ──
  // Fires when: (a) city not in cache, OR (b) cached record is stale.
  // Without a companyIntegrationId we can't decrypt credentials → fail safe.
  if (!companyIntegrationId) {
    // No integration ID — can't do a live lookup. If we have a stale cached
    // hit that says isDeliveryCity=true, we COULD trust it, but per the
    // fail-safe principle we return the cached value only if it's a hit
    // (better to allow booking on stale-but-positive data than block with
    // no recourse). A cache miss with no integration ID = hard block.
    if (city?.isDeliveryCity) {
      return true
    }
    return false
  }

  try {
    // Dynamic imports to avoid circular dependencies + only load when needed
    const { decryptCredentials } = await import('@/lib/utils/encryption')
    const { getCourierAdapter } = await import('@/lib/integrations/registry')

    const integration = await db.companyIntegration.findFirst({
      where: { id: companyIntegrationId, isActive: true },
      include: { provider: true },
    })
    if (!integration || !integration.credentialsEncrypted) {
      // Can't authenticate — fail safe (block booking)
      return false
    }

    const provider = integration.provider
    if (provider.providerKey !== providerKey) {
      return false
    }

    const adapter = getCourierAdapter(
      provider.providerKey,
      decryptCredentials(integration.credentialsEncrypted),
    )
    if (!adapter.fetchOperationalCities) {
      // Adapter doesn't support live city fetching — can't fall back.
      // Degrade to cached value if we have one, else block.
      return !!city?.isDeliveryCity
    }

    // Fetch ALL cities live from the courier (PostEx doesn't expose a
    // per-city search endpoint — we have to fetch the full list).
    const liveCities = await adapter.fetchOperationalCities()

    // Upsert ALL fetched cities into the cache — refreshes lastSyncedAt for
    // every city, catching both newly-added and newly-disabled cities.
    const now = new Date()
    await db.$transaction(
      liveCities.map((c) =>
        db.courierOperationalCity.upsert({
          where: {
            providerKey_cityName: { providerKey, cityName: c.cityName },
          },
          update: {
            cityId: c.cityId ?? null,
            isPickupCity: c.isPickupCity,
            isDeliveryCity: c.isDeliveryCity,
            lastSyncedAt: now,
          },
          create: {
            providerKey,
            cityName: c.cityName,
            cityId: c.cityId ?? null,
            isPickupCity: c.isPickupCity,
            isDeliveryCity: c.isDeliveryCity,
            lastSyncedAt: now,
          },
        }),
      ),
    )

    // Now check if the target city is in the freshly-updated cache
    const refreshedCity = await db.courierOperationalCity.findFirst({
      where: {
        providerKey,
        cityName: { equals: cityName, mode: 'insensitive' },
        isDeliveryCity: true,
      },
      select: { id: true },
    })
    return !!refreshedCity
  } catch (err) {
    // Live fallback failed (network error, bad credentials, etc.)
    // FAIL-SAFE: do NOT proceed on stale data. Log and block the booking
    // with a clear semantic — the caller should surface "could not verify
    // city availability, try again" to the user.
    console.error(
      `[city-matcher] Live fallback failed for ${providerKey}/${cityName}:`,
      err instanceof Error ? err.message : err,
    )
    return false
  }
}
