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
export async function revalidateCityAtBookingTime(
  providerKey: string,
  cityName: string,
): Promise<boolean> {
  const city = await db.courierOperationalCity.findFirst({
    where: {
      providerKey,
      cityName: { equals: cityName, mode: 'insensitive' },
      isDeliveryCity: true,
    },
    select: { id: true },
  })
  return !!city
}
