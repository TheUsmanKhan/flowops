'use client'

import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import { Check, ChevronsUpDown } from 'lucide-react'
import {
  COUNTRIES,
  getCountryByCode,
  ALL_TIMEZONES,
  POPULAR_TIMEZONES,
} from '@/lib/data/countries'
import { cn } from '@/lib/utils'

/** Searchable country selector (same pattern as CurrencySelector). */
export function CountrySelector({
  value,
  onChange,
  disabled,
  placeholder = 'Select country',
}: {
  value: string
  onChange: (code: string) => void
  disabled?: boolean
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = getCountryByCode(value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          {selected ? (
            <span className="flex items-center gap-2 truncate">
              <span className="text-base">{selected.flag}</span>
              <span className="truncate">{selected.name}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search country…" />
          <CommandList>
            <CommandEmpty>No country found.</CommandEmpty>
            <CommandGroup>
              {COUNTRIES.map((c) => (
                <CommandItem
                  key={c.code}
                  onSelect={() => {
                    onChange(c.code)
                    setOpen(false)
                  }}
                  className="gap-2"
                >
                  <span className="text-base">{c.flag}</span>
                  <span className="flex-1 truncate text-sm">{c.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{c.code}</span>
                  <Check className={cn('h-4 w-4', value === c.code ? 'opacity-100' : 'opacity-0')} />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Searchable timezone selector. */
export function TimezoneSelector({
  value,
  onChange,
  disabled,
  placeholder = 'Select timezone',
}: {
  value: string
  onChange: (tz: string) => void
  disabled?: boolean
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const others = ALL_TIMEZONES.filter((t) => !POPULAR_TIMEZONES.includes(t))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className={value ? '' : 'text-muted-foreground'}>{value || placeholder}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search timezone…" />
          <CommandList>
            <CommandEmpty>No timezone found.</CommandEmpty>
            <CommandGroup heading="Popular">
              {POPULAR_TIMEZONES.map((tz) => (
                <CommandItem
                  key={tz}
                  onSelect={() => {
                    onChange(tz)
                    setOpen(false)
                  }}
                  className="gap-2 font-mono text-xs"
                >
                  <span className="flex-1">{tz}</span>
                  <Check className={cn('h-4 w-4', value === tz ? 'opacity-100' : 'opacity-0')} />
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading="All timezones">
              {others.map((tz) => (
                <CommandItem
                  key={tz}
                  onSelect={() => {
                    onChange(tz)
                    setOpen(false)
                  }}
                  className="gap-2 font-mono text-xs"
                >
                  <span className="flex-1">{tz}</span>
                  <Check className={cn('h-4 w-4', value === tz ? 'opacity-100' : 'opacity-0')} />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
