'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api-client'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Search, Loader2, Plus, User, Phone, MapPin, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CustomerSearchResult } from './types'

/**
 * Multi-result customer search response (CUS-019).
 *
 * Returned by GET /api/customers?detailed=1&search=...&multi=1.
 * The `customers` array contains up to 10 matches (empty when no match).
 */
interface CustomerSearchMultiResult {
  customers: NonNullable<CustomerSearchResult['customer']>[]
}

export interface CustomerSearchAutocompleteProps {
  /** Called when a customer is selected from the dropdown. */
  onSelect: (customer: NonNullable<CustomerSearchResult['customer']>) => void
  /** Called when the user clicks "+ Create New Customer". */
  onCreateNew: () => void
  /** Placeholder for the search input. */
  placeholder?: string
  /** Auto-focus the input on mount. */
  autoFocus?: boolean
  /** Optional className for the wrapper. */
  className?: string
}

/**
 * Debounced phone/name search input with a dropdown of MULTIPLE matches.
 *
 * CUS-019: previously, the search returned only ONE result, so when a query
 * matched multiple customers (e.g. "Ahmed" → Ahmed Khan + Ahmed Ali), only
 * the first was shown. The dropdown now renders ALL matches (up to 10) and
 * a "+ Create New Customer" option at the bottom.
 *
 * Calls GET /api/customers?detailed=1&search=...&multi=1 which normalizes
 * the input via the pure-JS normalizePhoneInternational() and matches
 * against customer_phones.phoneNormalized + customer name + email.
 *
 * Used in:
 *   - The Order Creation page's customer section
 */
export function CustomerSearchAutocomplete({
  onSelect,
  onCreateNew,
  placeholder = 'Search by phone or name…',
  autoFocus = false,
  className,
}: CustomerSearchAutocompleteProps) {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Debounce 300ms
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300)
    return () => clearTimeout(t)
  }, [query])

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // CUS-019: multi-result search — returns up to 10 matches.
  const searchQuery = useQuery<CustomerSearchMultiResult>({
    queryKey: ['customer-search-multi', debouncedQuery],
    queryFn: () =>
      api.get<CustomerSearchMultiResult>(
        `/api/customers?detailed=1&multi=1&search=${encodeURIComponent(debouncedQuery)}`,
      ),
    enabled: debouncedQuery.trim().length >= 3,
    staleTime: 10_000,
  })

  const customers = searchQuery.data?.customers ?? []
  const hasAnyMatch = customers.length > 0
  const showDropdown = isOpen && debouncedQuery.trim().length >= 3
  const isLoading = searchQuery.isFetching && debouncedQuery.trim().length >= 3

  // Total dropdown items: matches + 1 (create-new) when at least one match
  // exists, OR 0 matches + 1 (no-match create-new).
  const totalItems = hasAnyMatch ? customers.length + 1 : 1

  const handleSelect = useCallback(
    (c: NonNullable<CustomerSearchResult['customer']>) => {
      onSelect(c)
      setQuery('')
      setDebouncedQuery('')
      setIsOpen(false)
      setHighlightedIndex(-1)
    },
    [onSelect],
  )

  const handleCreateNew = useCallback(() => {
    onCreateNew()
    setIsOpen(false)
    setHighlightedIndex(-1)
  }, [onCreateNew])

  // Keyboard navigation across all dropdown items.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showDropdown) return
    const createNewIndex = hasAnyMatch ? customers.length : 0
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightedIndex((i) => Math.min(i + 1, createNewIndex))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIndex((i) => Math.max(i - 1, -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlightedIndex === -1) return
      if (highlightedIndex < customers.length) {
        handleSelect(customers[highlightedIndex])
      } else {
        handleCreateNew()
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false)
      setHighlightedIndex(-1)
    }
  }

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          ref={inputRef}
          placeholder={placeholder}
          className="pl-9 pr-9"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setIsOpen(true)
            setHighlightedIndex(-1)
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          autoFocus={autoFocus}
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('')
              setDebouncedQuery('')
              inputRef.current?.focus()
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {isLoading && (
          <Loader2 className="absolute right-9 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {showDropdown && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md max-h-72 overflow-y-auto scrollbar-thin">
          {isLoading ? (
            <div className="p-3 space-y-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : hasAnyMatch ? (
            <>
              {/* CUS-019: render ALL matches (up to 10) — previously only
                  the first match was shown. */}
              {customers.map((c, idx) => (
                <button
                  key={c.id}
                  type="button"
                  onMouseEnter={() => setHighlightedIndex(idx)}
                  onClick={() => handleSelect(c)}
                  className={cn(
                    'w-full text-left px-3 py-2.5 transition-colors flex items-center justify-between gap-2 border-b last:border-b-0',
                    highlightedIndex === idx ? 'bg-muted/60' : 'hover:bg-muted/40',
                  )}
                >
                  <div className="flex items-start gap-2.5 min-w-0">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary shrink-0">
                      <User className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">{c.name}</p>
                        {c.isFlagged && (
                          <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200 text-[10px] h-4 px-1.5 shrink-0">
                            Flagged
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {c.phones[0] && (
                          <span className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                            <Phone className="h-2.5 w-2.5" /> {c.phones[0].phoneRaw}
                          </span>
                        )}
                        {c.addresses[0]?.city && (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <MapPin className="h-2.5 w-2.5" /> {c.addresses[0].city}
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {c.totalOrdersCount} order{c.totalOrdersCount === 1 ? '' : 's'}
                        {c.addresses.length > 0 && ` · ${c.addresses.length} address${c.addresses.length === 1 ? '' : 'es'}`}
                      </p>
                    </div>
                  </div>
                </button>
              ))}

              {/* Create new option */}
              <button
                type="button"
                onMouseEnter={() => setHighlightedIndex(customers.length)}
                onClick={handleCreateNew}
                className={cn(
                  'w-full text-left px-3 py-2 border-t transition-colors flex items-center gap-2',
                  highlightedIndex === customers.length ? 'bg-muted/60' : 'hover:bg-muted/40',
                )}
              >
                <Plus className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Create new customer…</span>
              </button>
            </>
          ) : (
            // No match found
            <button
              type="button"
              onMouseEnter={() => setHighlightedIndex(0)}
              onClick={handleCreateNew}
              className={cn(
                'w-full text-left px-3 py-3 transition-colors flex items-center gap-2',
                highlightedIndex === 0 ? 'bg-muted/60' : 'hover:bg-muted/40',
              )}
            >
              <Plus className="h-4 w-4 text-primary" />
              <div>
                <p className="text-sm font-medium">No match found</p>
                <p className="text-xs text-muted-foreground">Create a new customer…</p>
              </div>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
