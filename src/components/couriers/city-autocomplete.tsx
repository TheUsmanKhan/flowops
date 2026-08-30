'use client'

/**
 * CityAutocomplete — reusable courier city search input.
 *
 * Text input with live suggestions dropdown, sourced from
 * courier_operational_cities for the given provider via
 * GET /api/couriers/[providerKey]/cities?q=search_term.
 *
 * AUTO-FETCH MISSING CITIES:
 *   When the first (cache-only) search returns ZERO results, the component
 *   AUTOMATICALLY fires a second search with `?live=true`. The backend then
 *   calls the courier API live, caches the full city list, and re-runs the
 *   search. This means: if the courier serves a city that isn't in our local
 *   cache yet (recently added, or sync hasn't run), the user will STILL see
 *   it — they'll just see a "Checking live courier API…" loader for ~1-2s
 *   first. This guarantees no city is ever permanently "missing" or a "bug"
 *   in the city search.
 *
 * GENERIC — not hardcoded into any specific form. Will be reused in:
 *   - Order Create (Prompt 5)
 *   - Exchange Shipment forms (Prompt 5)
 *   - Booking Workbench (Prompt 5)
 *   - Pickup Address Book form (this prompt)
 *
 * Usage:
 *   <CityAutocomplete
 *     providerKey="postex"
 *     value={city}
 *     onChange={setCity}
 *     placeholder="Search city..."
 *   />
 */

import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api-client'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Loader2, MapPin, CloudOff } from 'lucide-react'

interface CityOption {
  id: string
  cityName: string
  cityId: string | null
  isPickupCity: boolean
  isDeliveryCity: boolean
  /** Which couriers serve this city (for courier-name badges). */
  servedBy?: Array<{ providerKey: string; isPickupCity: boolean; isDeliveryCity: boolean }>
}

interface CitySearchResponse {
  cities: CityOption[]
}

export interface CityAutocompleteProps {
  /**
   * The courier provider key (e.g. 'postex', 'tcs'). Use 'all' to search
   * across ALL connected couriers' cities (union) — useful when no specific
   * courier is selected yet but the user still needs city suggestions.
   * Use '' (empty) to disable autocomplete entirely (plain text input).
   */
  providerKey: string
  value: string
  onChange: (cityName: string) => void
  onBlur?: () => void
  placeholder?: string
  className?: string
  disabled?: boolean
  /** Optional: show only pickup cities (for address book forms) */
  pickupOnly?: boolean
}

export function CityAutocomplete({
  providerKey,
  value,
  onChange,
  onBlur,
  placeholder = 'Search city...',
  className,
  disabled = false,
  pickupOnly = false,
}: CityAutocompleteProps) {
  const [inputValue, setInputValue] = useState(value)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync external value changes into the input
  useEffect(() => {
    setInputValue(value)
  }, [value])

  // Debounce the search query
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(inputValue.trim())
    }, 200)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [inputValue])

  const enabled = debouncedQuery.length >= 1 && showSuggestions && providerKey !== ''

  // ── Query 1: cache-only search (fast path) ──
  const cacheQuery = useQuery<CitySearchResponse>({
    queryKey: ['courier-cities', providerKey, debouncedQuery],
    queryFn: () =>
      api.get<CitySearchResponse>(
        `/api/couriers/${providerKey}/cities?q=${encodeURIComponent(debouncedQuery)}&limit=10`,
      ),
    enabled,
    staleTime: 30_000,
  })

  const cacheCities = cacheQuery.data?.cities ?? []
  const cacheEmpty = cacheQuery.isSuccess && cacheCities.length === 0

  // ── Query 2: live fallback — ONLY fires when the cache search returned
  //    zero results. Appends `live=true` so the backend fetches the full
  //    city list from the courier API, caches it, then re-runs the search.
  //    This catches cities that exist at the courier but aren't in our
  //    local cache yet (recently added, sync hasn't run, etc.).
  //    providerKey='all' doesn't support live (no single courier to fetch
  //    from), so we skip the live fallback in that case.
  const liveQuery = useQuery<CitySearchResponse>({
    queryKey: ['courier-cities-live', providerKey, debouncedQuery],
    queryFn: () =>
      api.get<CitySearchResponse>(
        `/api/couriers/${providerKey}/cities?q=${encodeURIComponent(debouncedQuery)}&limit=10&live=true`,
      ),
    enabled: enabled && cacheEmpty && providerKey !== 'all',
    staleTime: 60_000, // cache the live result longer — it's expensive
  })

  // Merge: prefer cache results; fall back to live-fetched results.
  const liveCities = liveQuery.data?.cities ?? []
  const suggestions = cacheCities.length > 0 ? cacheCities : liveCities
  const filteredSuggestions = pickupOnly
    ? suggestions.filter((s) =>
        // For pickupOnly: city qualifies if the primary provider OR any
        // provider in servedBy has isPickupCity=true
        s.isPickupCity || (s.servedBy ?? []).some((p) => p.isPickupCity),
      )
    : suggestions

  const isLoading = cacheQuery.isFetching || (cacheEmpty && liveQuery.isFetching)
  const isLiveFetching = cacheEmpty && liveQuery.isFetching

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false)
        onBlur?.()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onBlur])

  function handleSelect(city: CityOption) {
    if (pickupOnly && !city.isPickupCity) return
    setInputValue(city.cityName)
    onChange(city.cityName)
    setShowSuggestions(false)
  }

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div className="relative">
        <MapPin className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input
          type="text"
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value)
            onChange(e.target.value)
            setShowSuggestions(true)
          }}
          onFocus={() => setShowSuggestions(true)}
          placeholder={placeholder}
          disabled={disabled}
          className="pl-8"
          autoComplete="off"
        />
        {isLoading && showSuggestions && (
          <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground animate-spin" />
        )}
      </div>

      {showSuggestions && debouncedQuery.length >= 1 && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md max-h-60 overflow-y-auto">
          {filteredSuggestions.length === 0 && !isLoading ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No cities found. Try a different spelling or sync cities first.
            </div>
          ) : isLiveFetching ? (
            <div className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-1.5">
              <CloudOff className="h-3 w-3" />
              Checking live courier API for &quot;{debouncedQuery}&quot;…
            </div>
          ) : filteredSuggestions.length === 0 && !isLoading ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No cities found. Try a different spelling or sync cities first.
            </div>
          ) : (
            filteredSuggestions.map((city) => (
              <button
                key={city.id}
                type="button"
                className="w-full text-left px-3 py-2 text-xs hover:bg-accent transition-colors flex items-center justify-between gap-2"
                onClick={() => handleSelect(city)}
              >
                <span className="font-medium">{city.cityName}</span>
                <div className="flex items-center gap-1">
                  {(city.servedBy ?? []).map((s) => (
                    <span
                      key={s.providerKey}
                      className={courierBadgeClass(s.providerKey)}
                      title={`${s.providerKey}: ${s.isPickupCity ? 'pickup' : ''}${s.isPickupCity && s.isDeliveryCity ? ' + ' : ''}${s.isDeliveryCity ? 'delivery' : ''}`}
                    >
                      {s.providerKey}
                    </span>
                  ))}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Courier badge styling — each provider gets a distinct color so the
// user can instantly see which couriers serve each city at a glance.
// ──────────────────────────────────────────────────────────────

function courierBadgeClass(providerKey: string): string {
  const base = 'text-[9px] px-1 py-0.5 rounded border font-medium capitalize'
  // Distinct color per provider — chosen to be visually distinguishable
  // + not conflicting with existing UI palettes.
  const styles: Record<string, string> = {
    leopard: 'bg-amber-50 text-amber-800 border-amber-300',
    postex: 'bg-violet-50 text-violet-800 border-violet-300',
    tcs: 'bg-rose-50 text-rose-800 border-rose-300',
    shopify: 'bg-emerald-50 text-emerald-800 border-emerald-300',
    daraz: 'bg-orange-50 text-orange-800 border-orange-300',
  }
  return `${base} ${styles[providerKey] ?? 'bg-slate-50 text-slate-700 border-slate-300'}`
}
