'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api-client'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Search, Loader2, Plus, User, Phone, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CustomerSearchResult } from './types'

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
 * Debounced phone/name search input with a dropdown of matches.
 *
 * As the user types, calls GET /api/customers?detailed=1&search=... which
 * normalizes the input via the normalize_phone() SQL function and matches
 * against customer_phones.phoneNormalized + customer name.
 *
 * Selecting a match fires onSelect with the full customer object (including
 * all phones and addresses). A "+ Create New Customer" option at the bottom
 * fires onCreateNew (which the caller uses to expand the CreateCustomerForm
 * inline).
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

  // Search query — only fires when debouncedQuery is non-empty
  const searchQuery = useQuery<CustomerSearchResult>({
    queryKey: ['customer-search', debouncedQuery],
    queryFn: () =>
      api.get<CustomerSearchResult>(
        `/api/customers?detailed=1&search=${encodeURIComponent(debouncedQuery)}`,
      ),
    enabled: debouncedQuery.trim().length >= 3,
    staleTime: 10_000,
  })

  const customer = searchQuery.data?.customer
  const showDropdown = isOpen && debouncedQuery.trim().length >= 3
  const isLoading = searchQuery.isFetching && debouncedQuery.trim().length >= 3

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

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showDropdown) return
    const maxIndex = customer ? 1 : 0 // [result? , create-new]
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightedIndex((i) => Math.min(i + 1, maxIndex))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIndex((i) => Math.max(i - 1, -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlightedIndex === -1) return
      if (customer && highlightedIndex === 0) handleSelect(customer)
      else handleCreateNew()
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
          ) : customer ? (
            <>
              {/* Exact match result */}
              <button
                type="button"
                onMouseEnter={() => setHighlightedIndex(0)}
                onClick={() => handleSelect(customer)}
                className={cn(
                  'w-full text-left px-3 py-2.5 transition-colors flex items-center justify-between gap-2',
                  highlightedIndex === 0 ? 'bg-muted/60' : 'hover:bg-muted/40',
                )}
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary shrink-0">
                    <User className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">{customer.name}</p>
                      {customer.isFlagged && (
                        <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200 text-[10px] h-4 px-1.5">
                          Flagged
                        </Badge>
                      )}
                    </div>
                    {customer.phones[0] && (
                      <p className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                        <Phone className="h-2.5 w-2.5" /> {customer.phones[0].phoneRaw}
                      </p>
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      {customer.totalOrdersCount} order{customer.totalOrdersCount === 1 ? '' : 's'}
                      {customer.addresses.length > 0 && ` · ${customer.addresses.length} address${customer.addresses.length === 1 ? '' : 'es'}`}
                    </p>
                  </div>
                </div>
              </button>

              {/* Create new option */}
              <button
                type="button"
                onMouseEnter={() => setHighlightedIndex(1)}
                onClick={handleCreateNew}
                className={cn(
                  'w-full text-left px-3 py-2 border-t transition-colors flex items-center gap-2',
                  highlightedIndex === 1 ? 'bg-muted/60' : 'hover:bg-muted/40',
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
