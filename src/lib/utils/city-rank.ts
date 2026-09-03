/**
 * City Search Ranking — prefix-first fuzzy matching.
 *
 * Standard search UX: when a user types "L", cities STARTING with "L"
 * should appear first, then cities containing "L" elsewhere. This is the
 * expected behavior in every search box (Google, IDE file search, etc.).
 *
 * Tiered scoring (lower rank = shown first):
 *   Tier 0: Exact match (cityName.toLowerCase() === q)
 *   Tier 1: Prefix match (startsWith q, case-insensitive)
 *   Tier 2: Word-boundary match (a word in cityName starts with q)
 *   Tier 3: Contains match (q appears anywhere)
 *   Tier 4: No match (shouldn't happen if DB already filtered, but safe)
 *
 * Within the same tier, sort alphabetically (case-insensitive) for
 * deterministic, stable output.
 *
 * This is a pure function — no DB access. The caller fetches a superset
 * of matches from the DB (using `contains`), then ranks + slices here.
 */

export interface RankedCity {
  /** The original city object (any shape) */
  city: any
  /** Sort rank: 0 = best (exact), 4 = worst (no match). Lower sorts first. */
  rank: number
  /** Case-insensitive city name, used for alphabetical tiebreak */
  sortKey: string
}

/**
 * Compute the match rank of a city name against a query.
 * Returns 0 (exact) through 4 (no match).
 */
export function computeCityRank(cityName: string, q: string): number {
  if (!cityName || !q) return 4
  const name = cityName.toLowerCase()
  const query = q.toLowerCase()

  // Tier 0: exact match
  if (name === query) return 0

  // Tier 1: prefix match
  if (name.startsWith(query)) return 1

  // Tier 2: word-boundary match — any whitespace-separated word starts with q
  // e.g. q="kar" matches "KARACHI ALHYDRI" (word "KARACHI" starts with "kar")
  //       q="ala" matches "ISLAMABAD" (word "ISLAMABAD" — no... wait)
  // Actually: split by whitespace, check if any word startsWith q.
  const words = name.split(/\s+/)
  for (const w of words) {
    if (w.startsWith(query)) return 2
  }

  // Tier 3: contains anywhere (the DB already filtered by contains, so this
  // is the fallback for matches that aren't prefix or word-boundary)
  if (name.includes(query)) return 3

  // Tier 4: no match (shouldn't happen post-DB-filter, but safe)
  return 4
}

/**
 * Rank + sort an array of city objects by prefix-first rules.
 *
 * @param cities  Array of city objects (any shape, must have `cityName`)
 * @param q       The user's search query
 * @returns       New array, sorted best-match-first
 */
export function rankCities<T extends { cityName: string }>(
  cities: T[],
  q: string,
): T[] {
  if (!q) {
    // No query — just alphabetical (existing behavior)
    return [...cities].sort(
      (a, b) => a.cityName.localeCompare(b.cityName, undefined, { sensitivity: 'base' }),
    )
  }

  const ranked: Array<{ city: T; rank: number; sortKey: string }> = cities.map((city) => ({
    city,
    rank: computeCityRank(city.cityName, q),
    sortKey: city.cityName.toLowerCase(),
  }))

  ranked.sort((a, b) => {
    // Primary: rank (lower first)
    if (a.rank !== b.rank) return a.rank - b.rank
    // Secondary: alphabetical (case-insensitive)
    return a.sortKey.localeCompare(b.sortKey, undefined, { sensitivity: 'base' })
  })

  return ranked.map((r) => r.city)
}
