'use client'

/**
 * CityMismatchResolver — inline component shown when matchCity() returns 'unresolved'.
 *
 * Displays the top 3 suggestions as clickable options plus a manual search
 * fallback (CityAutocomplete). On selection, calls saveCityAlias() to persist
 * the mapping and returns the resolved city name to the parent form via
 * onResolved().
 *
 * Usage:
 *   {matchResult?.status === 'unresolved' && (
 *     <CityMismatchResolver
 *       providerKey="postex"
 *       typedCity={typedCity}
 *       suggestions={matchResult.suggestions}
 *       onResolved={(cityName) => {
 *         setCity(cityName)
 *         setMatchResult(null)
 *       }}
 *       onCancelled={() => setMatchResult(null)}
 *     />
 *   )}
 */

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api-client'
import { toast } from 'sonner'
import { CityAutocomplete } from '@/components/couriers/city-autocomplete'
import { Button } from '@/components/ui/button'
import { AlertCircle, Check, X } from 'lucide-react'

export interface CityMismatchResolverProps {
  providerKey: string
  typedCity: string
  suggestions: string[]
  onResolved: (cityName: string) => void
  onCancelled: () => void
}

export function CityMismatchResolver({
  providerKey,
  typedCity,
  suggestions,
  onResolved,
  onCancelled,
}: CityMismatchResolverProps) {
  const [manualCity, setManualCity] = useState('')
  const [showManualSearch, setShowManualSearch] = useState(suggestions.length === 0)

  const saveAliasMutation = useMutation({
    mutationFn: (resolvedCityName: string) =>
      api.post('/api/couriers/save-city-alias', {
        providerKey,
        typedCity,
        resolvedCityName,
      }),
    onSuccess: (_, resolvedCityName) => {
      toast.success(`City mapping saved — "${typedCity}" → "${resolvedCityName}" will auto-resolve next time.`)
      onResolved(resolvedCityName)
    },
    onError: (err) => {
      toast.error('Failed to save city alias, but you can continue.')
      // Still resolve the city in the form even if alias save fails
      onResolved(manualCity || suggestions[0] || '')
    },
  })

  function handleSelect(cityName: string) {
    saveAliasMutation.mutate(cityName)
  }

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-3">
      <div className="flex items-start gap-2">
        <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-amber-900">
            City &quot;{typedCity}&quot; not found in courier&apos;s delivery cities
          </p>
          <p className="text-[11px] text-amber-700 mt-0.5">
            Select the correct city below. The mapping will be saved so it auto-resolves next time.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-amber-700 hover:text-amber-900 hover:bg-amber-100"
          onClick={onCancelled}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Suggestion buttons */}
      {suggestions.length > 0 && !showManualSearch && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((city) => (
            <Button
              key={city}
              size="sm"
              variant="outline"
              className="h-7 text-xs bg-white border-amber-300 hover:bg-amber-100"
              disabled={saveAliasMutation.isPending}
              onClick={() => handleSelect(city)}
            >
              <Check className="h-3 w-3 mr-1" /> {city}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-amber-700"
            onClick={() => setShowManualSearch(true)}
          >
            Search manually...
          </Button>
        </div>
      )}

      {/* Manual search fallback */}
      {showManualSearch && (
        <div className="space-y-2">
          <CityAutocomplete
            providerKey={providerKey}
            value={manualCity}
            onChange={setManualCity}
            placeholder="Search correct city..."
            className="w-full"
          />
          {manualCity && (
            <Button
              size="sm"
              className="w-full h-7 text-xs"
              disabled={saveAliasMutation.isPending}
              onClick={() => handleSelect(manualCity)}
            >
              {saveAliasMutation.isPending ? 'Saving...' : `Use "${manualCity}"`}
            </Button>
          )}
          {suggestions.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="w-full h-7 text-xs text-amber-700"
              onClick={() => setShowManualSearch(false)}
            >
              Back to suggestions
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
