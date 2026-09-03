'use client'

import { useEffect } from 'react'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { MapPin, Star, Plus } from 'lucide-react'
import { formatLastUsed, type AddressDTO } from './types'
import { CityAutocomplete } from '@/components/couriers/city-autocomplete'
import { CountrySelector } from '@/components/ui/country-selector'

export interface AddressSelectorValue {
  usedCustomerAddressId: string | null
  deliveryAddress: string
  deliveryCity: string
  deliveryCountry: string
  saveAddressForNextTime: boolean
}

export interface AddressSelectorProps {
  addresses: AddressDTO[]
  value: AddressSelectorValue
  onChange: (value: AddressSelectorValue) => void
  addressError?: string
  cityError?: string
  courierProviderKey?: string
}

/**
 * Compact address selector for the order-create customer section.
 *
 * Redesign (Shopify-style compact):
 *   - Saved address cards are single-line rows (not tall cards)
 *   - Address text uses a single-line Input (not a Textarea)
 *   - Helper text is inline and minimal
 *   - The "editable for this order" note is a tiny inline hint
 *
 * The selected/entered address text is ALWAYS editable (per the snapshot
 * behavior: the order's delivery_address is a copy that can be tweaked
 * per-order without altering the saved customer_addresses row).
 */
export function AddressSelector({
  addresses,
  value,
  onChange,
  addressError,
  cityError,
  courierProviderKey,
}: AddressSelectorProps) {
  const { usedCustomerAddressId, deliveryAddress, deliveryCity, deliveryCountry, saveAddressForNextTime } = value
  const isNewMode = usedCustomerAddressId === null

  // When a saved address is selected, pre-fill the editable text from it.
  useEffect(() => {
    if (usedCustomerAddressId) {
      const selected = addresses.find((a) => a.id === usedCustomerAddressId)
      if (selected) {
        const currentMatch = addresses.find(
          (a) => a.address === deliveryAddress && a.city === deliveryCity,
        )
        if (!deliveryAddress || currentMatch) {
          onChange({
            ...value,
            deliveryAddress: selected.address,
            deliveryCity: selected.city,
            deliveryCountry: selected.country ?? 'PK',
          })
        }
      }
    }
  }, [usedCustomerAddressId])

  const selectSaved = (addr: AddressDTO) => {
    onChange({
      ...value,
      usedCustomerAddressId: addr.id,
      deliveryAddress: addr.address,
      deliveryCity: addr.city,
      deliveryCountry: addr.country ?? 'PK',
      saveAddressForNextTime: false,
    })
  }

  const selectNew = () => {
    onChange({
      ...value,
      usedCustomerAddressId: null,
      deliveryAddress: '',
      deliveryCity: '',
      deliveryCountry: 'PK',
      saveAddressForNextTime: false,
    })
  }

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1">
        <MapPin className="h-3 w-3" /> Delivery Address
      </p>

      {/* Saved address cards — compact single-line rows */}
      {addresses.length > 0 && (
        <div className="space-y-1">
          {addresses.map((addr) => {
            const isSelected = usedCustomerAddressId === addr.id
            return (
              <button
                key={addr.id}
                type="button"
                onClick={() => selectSaved(addr)}
                className={cn(
                  'w-full text-left rounded-md border px-2.5 py-1.5 transition-colors',
                  isSelected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                    : 'border-border hover:border-primary/30 hover:bg-muted/40',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1 flex items-center gap-1.5">
                    <span className="text-xs font-medium truncate">{addr.address || '—'}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">· {addr.city}</span>
                    {addr.isDefault && (
                      <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 text-[9px] h-3.5 px-1 shrink-0">
                        <Star className="h-2 w-2 mr-0.5 fill-current" />Default
                      </Badge>
                    )}
                  </div>
                  <div className={cn(
                    'h-3.5 w-3.5 rounded-full border-2 shrink-0',
                    isSelected ? 'border-primary bg-primary' : 'border-muted-foreground/30',
                  )} />
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* "+ Use a new address" option — compact */}
      <button
        type="button"
        onClick={selectNew}
        className={cn(
          'w-full text-left rounded-md border border-dashed px-2.5 py-1.5 transition-colors',
          isNewMode
            ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
            : 'border-border hover:border-primary/30 hover:bg-muted/40',
        )}
      >
        <div className="flex items-center gap-1.5">
          <Plus className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs">Use a new address</span>
        </div>
      </button>

      {/* Editable address fields — single-line Input (was Textarea) */}
      <div className="grid sm:grid-cols-2 gap-2 pt-0.5">
        <div className="space-y-1 sm:col-span-2 min-w-0">
          <Label className="text-[10px]">
            Address {isNewMode ? '*' : <span className="text-muted-foreground">(editable for this order)</span>}
          </Label>
          <Input
            placeholder="House #, street, area"
            value={deliveryAddress}
            onChange={(e) => onChange({ ...value, deliveryAddress: e.target.value })}
            className="text-sm h-8"
          />
          {addressError && <p className="text-[10px] text-destructive">{addressError}</p>}
        </div>
        <div className="space-y-1 min-w-0">
          <Label className="text-[10px]">City *</Label>
          {deliveryCountry === 'PK' ? (
            courierProviderKey ? (
              <CityAutocomplete
                providerKey={courierProviderKey}
                value={deliveryCity}
                onChange={(city) => onChange({ ...value, deliveryCity: city })}
                placeholder="Search city…"
              />
            ) : (
              <CityAutocomplete
                providerKey="all"
                value={deliveryCity}
                onChange={(city) => onChange({ ...value, deliveryCity: city })}
                placeholder="Search city (all couriers)…"
              />
            )
          ) : (
            <Input
              placeholder="Enter city"
              value={deliveryCity}
              onChange={(e) => onChange({ ...value, deliveryCity: e.target.value })}
              className="pl-8 text-sm h-8"
              autoComplete="off"
            />
          )}
          {cityError && <p className="text-[10px] text-destructive">{cityError}</p>}
        </div>
        <div className="space-y-1 min-w-0">
          <Label className="text-[10px]">Country *</Label>
          <CountrySelector
            value={deliveryCountry}
            onChange={(code) =>
              onChange({
                ...value,
                deliveryCountry: code,
              })
            }
            placeholder="Select country"
          />
        </div>
      </div>

      {/* "Save for next time" checkbox — only in new-address mode */}
      {isNewMode && (
        <label className="flex items-center gap-2 cursor-pointer">
          <Checkbox
            checked={saveAddressForNextTime}
            onCheckedChange={(v) => onChange({ ...value, saveAddressForNextTime: v === true })}
          />
          <span className="text-[11px] text-muted-foreground">
            Save this address for future orders
          </span>
        </label>
      )}

      {/* Inline hint — tiny, single line */}
      {!isNewMode && (
        <p className="text-[10px] text-muted-foreground">
          Edits apply to this order only — the saved customer address is not changed.
        </p>
      )}
    </div>
  )
}
