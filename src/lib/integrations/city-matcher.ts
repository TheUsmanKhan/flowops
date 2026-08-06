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
 * Guards against the 3-hour sync window where a city could have been
 * disabled between order creation and booking.
 *
 * LIVE FALLBACK (migration 015+): if the city is NOT in our local cache,
 * this function queries the courier's API live (via the adapter's
 * fetchOperationalCities) to check whether the city is operational. If the
 * courier confirms the city, we UPSERT it into courier_operational_cities
 * so future bookings don't re-hit the API. This ensures booking NEVER fails
 * due to a stale or incomplete local cache — the courier is the source of
 * truth, our DB is just a cache.
 *
 * @param providerKey The courier provider key (e.g. 'postex')
 * @param cityName The delivery city name to validate
 * @param companyIntegrationId Optional: required for the live fallback.
 *   If not provided, the live fallback is skipped and this degrades to a
 *   pure local-cache lookup (the original behavior).
 * @returns true if the city is a valid delivery city, false otherwise.
 */
export async function revalidateCityAtBookingTime(
  providerKey: string,
  cityName: string,
  companyIntegrationId?: string,
): Promise<boolean> {
  // ── Tier 1: local cache lookup (fast path) ──
  const city = await db.courierOperationalCity.findFirst({
    where: {
      providerKey,
      cityName: { equals: cityName, mode: 'insensitive' },
      isDeliveryCity: true,
    },
    select: { id: true, cityName: true },
  })
  if (city) {
    // Update lastSyncedAt so we know this city was recently confirmed
    // (non-blocking — don't wait for this)
    db.courierOperationalCity
      .update({ where: { id: city.id }, data: { lastSyncedAt: new Date() } })
      .catch(() => {})
    return true
  }

  // ── Tier 2: live courier API fallback (slow path, only on cache miss) ──
  // This is the critical fix: if the city isn't in our cache, query the
  // courier live. The courier is the source of truth — our DB is just a
  // cache. If the courier says the city is operational, we trust it and
  // upsert it into the cache for next time.
  if (!companyIntegrationId) {
    // No integration ID provided — can't do a live lookup (no credentials).
    // Degrade to the original behavior (return false = booking fails).
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
      return false
    }

    const provider = integration.provider
    if (provider.providerKey !== providerKey) {
      // Provider mismatch — the integration ID doesn't match the providerKey.
      // This shouldn't happen, but guard against it.
      return false
    }

    const adapter = getCourierAdapter(
      provider.providerKey,
      decryptCredentials(integration.credentialsEncrypted),
    )
    if (!adapter.fetchOperationalCities) {
      // Adapter doesn't support live city fetching — can't fall back
      return false
    }

    // Fetch ALL cities live from the courier (PostEx doesn't expose a
    // per-city search endpoint — we have to fetch the full list).
    // This is expensive (~1-2s) but only runs on a cache miss, and the
    // result is cached in the DB so subsequent bookings for the same city
    // hit the fast path.
    const liveCities = await adapter.fetchOperationalCities()

    // Upsert ALL fetched cities into the cache (not just the one we're
    // looking for) — this is a bonus refresh that catches any other cities
    // PostEx may have added since our last sync. Batched in a transaction
    // for performance.
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
    // Log and return false — don't crash the booking
    console.error(
      `[city-matcher] Live fallback failed for ${providerKey}/${cityName}:`,
      err instanceof Error ? err.message : err,
    )
    return false
  }
}
