'use client'

import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import { Check, ChevronsUpDown, Search } from 'lucide-react'
import {
  CURRENCIES,
  POPULAR_CURRENCIES,
  getCurrencyByCode,
  type Currency,
} from '@/lib/data/currencies'
import { cn } from '@/lib/utils'

/**
 * Searchable currency selector.
 * Shows popular currencies at the top, then the full alphabetical list.
 * Search matches code, name, and symbol.
 */
export function CurrencySelector({
  value,
  onChange,
  disabled,
  placeholder = 'Select currency',
}: {
  value: string
  onChange: (code: string) => void
  disabled?: boolean
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = getCurrencyByCode(value)
  const popular = CURRENCIES.filter((c) => POPULAR_CURRENCIES.includes(c.code))
  const others = CURRENCIES.filter((c) => !POPULAR_CURRENCIES.includes(c.code))

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
              <span className="font-mono text-xs">{selected.code}</span>
              <span className="text-muted-foreground truncate">{selected.name}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search currency…" />
          <CommandList>
            <CommandEmpty>No currency found.</CommandEmpty>
            <CommandGroup heading="Popular">
              {popular.map((c) => (
                <CurrencyItem
                  key={c.code}
                  currency={c}
                  selected={value === c.code}
                  onSelect={() => {
                    onChange(c.code)
                    setOpen(false)
                  }}
                />
              ))}
            </CommandGroup>
            <CommandGroup heading="All currencies">
              {others.map((c) => (
                <CurrencyItem
                  key={c.code}
                  currency={c}
                  selected={value === c.code}
                  onSelect={() => {
                    onChange(c.code)
                    setOpen(false)
                  }}
                />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function CurrencyItem({
  currency,
  selected,
  onSelect,
}: {
  currency: Currency
  selected: boolean
  onSelect: () => void
}) {
  return (
    <CommandItem onSelect={onSelect} className="gap-2">
      <span className="text-base">{currency.flag}</span>
      <span className="font-mono text-xs font-medium w-10">{currency.code}</span>
      <span className="flex-1 truncate text-sm">{currency.name}</span>
      <span className="text-xs text-muted-foreground">{currency.symbol}</span>
      <Check className={cn('h-4 w-4', selected ? 'opacity-100' : 'opacity-0')} />
    </CommandItem>
  )
}
