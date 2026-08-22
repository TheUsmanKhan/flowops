'use client'

import { useEffect } from 'react'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { MapPin, Star, Plus } from 'lucide-react'
import { formatLastUsed, type AddressDTO } from './types'
import { CityAutocomplete } from '@/components/couriers/city-autocomplete'
import { CountrySelector } from '@/components/ui/country-selector'
import { countryCodeToName, countryNameToCode } from '@/lib/data/countries'

export interface AddressSelectorValue {
  /** The selected saved address ID, or null if "new address" mode. */
  usedCustomerAddressId: string | null
  /** The editable delivery address text (the order's own snapshot). */
  deliveryAddress: string
  /** The editable delivery city text. */
  deliveryCity: string
  /** The editable delivery country NAME (e.g. "Pakistan") — the order's own
   *  snapshot, same editable-per-order semantics as deliveryAddress/deliveryCity.
   *  Defaults to "Pakistan" (current majority use case). Stored as a NAME
   *  (not an alpha-2 code) to match CustomerAddress.country + Shopify. */
  deliveryCountry: string
  /** Whether to persist a new one-off address as a permanent customer_addresses row. */
  saveAddressForNextTime: boolean
}

export interface AddressSelectorProps {
  /** The customer's saved addresses (already ordered: default first, then lastUsedAt desc). */
  addresses: AddressDTO[]
  /** Current value. */
  value: AddressSelectorValue
  /** Callback when the value changes. */
  onChange: (value: AddressSelectorValue) => void
  /** Show the field error for delivery_address (from form validation). */
  addressError?: string
  /** Show the field error for delivery_city (from form validation). */
  cityError?: string
  /**
   * Optional: when set, the city field uses CityAutocomplete (live suggestions
   * from courier_operational_cities) instead of a plain text input. Pass the
   * selected courier's providerKey (e.g. 'postex', 'tcs').
   */
  courierProviderKey?: string
}

/**
 * Radio-style card selector for a customer's saved addresses, plus a
 * "+ Use a new address" option that reveals fresh address + city inputs.
 *
 * The selected/entered address text is ALWAYS editable (per the snapshot
 * behavior established in Step 2's createManualOrder()): the order's own
 * delivery_address is a copy that can be tweaked per-order without altering
 * the saved customer_addresses row.
 *
 * Used in:
 *   - The Order Creation page's customer section (replaces the broken empty
 *     address fields)
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

  // When a saved address is selected, pre-fill the editable text from it
  // (but only if the current text is empty OR matches a previously-selected
  // saved address — so we don't overwrite user edits when switching addresses).
  useEffect(() => {
    if (usedCustomerAddressId) {
      const selected = addresses.find((a) => a.id === usedCustomerAddressId)
      if (selected) {
        // Check if the current text is empty or matches a different saved address
        const currentMatch = addresses.find(
          (a) => a.address === deliveryAddress && a.city === deliveryCity,
        )
        if (!deliveryAddress || currentMatch) {
          onChange({
            ...value,
            deliveryAddress: selected.address,
            deliveryCity: selected.city,
            // Fall back to "Pakistan" if the saved address has no country yet
            // (rows created before the country-system phase have null).
            deliveryCountry: selected.country ?? 'Pakistan',
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
      deliveryCountry: addr.country ?? 'Pakistan',
      saveAddressForNextTime: false,
    })
  }

  const selectNew = () => {
    onChange({
      ...value,
      usedCustomerAddressId: null,
      deliveryAddress: '',
      deliveryCity: '',
      deliveryCountry: 'Pakistan',
      saveAddressForNextTime: false,
    })
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1">
        <MapPin className="h-3 w-3" /> Delivery Address
      </p>

      {/* Saved address cards */}
      {addresses.length > 0 && (
        <div className="space-y-1.5">
          {addresses.map((addr) => {
            const isSelected = usedCustomerAddressId === addr.id
            return (
              <button
                key={addr.id}
                type="button"
                onClick={() => selectSaved(addr)}
                className={cn(
                  'w-full text-left rounded-md border p-2.5 transition-colors',
                  isSelected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                    : 'border-border hover:border-primary/30 hover:bg-muted/40',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {addr.label && (
                        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                          {addr.label}
                        </span>
                      )}
                      {addr.isDefault && (
                        <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 text-[10px] h-4 px-1.5">
                          <Star className="h-2 w-2 mr-0.5 fill-current" /> Default
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm font-medium truncate mt-0.5">{addr.address}</p>
                    <p className="text-xs text-muted-foreground">
                      {addr.city}{addr.country ? `, ${addr.country}` : ''}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Last used: {formatLastUsed(addr.lastUsedAt)}
                    </p>
                  </div>
                  <div className={cn(
                    'mt-0.5 h-4 w-4 rounded-full border-2 shrink-0',
                    isSelected ? 'border-primary bg-primary' : 'border-muted-foreground/30',
                  )} />
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* "+ Use a new address" option */}
      <button
        type="button"
        onClick={selectNew}
        className={cn(
          'w-full text-left rounded-md border border-dashed p-2.5 transition-colors',
          isNewMode
            ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
            : 'border-border hover:border-primary/30 hover:bg-muted/40',
        )}
      >
        <div className="flex items-center gap-2">
          <Plus className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm">Use a new address</span>
        </div>
      </button>

      {/* Editable address text (always visible — this IS the order's snapshot) */}
      <div className="grid sm:grid-cols-2 gap-2 pt-1">
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">Address {isNewMode ? '*' : '(editable for this order)'}</Label>
          <Textarea
            placeholder="House #, street, area"
            value={deliveryAddress}
            onChange={(e) => onChange({ ...value, deliveryAddress: e.target.value })}
            className="text-sm"
            rows={2}
          />
          {addressError && <p className="text-xs text-destructive">{addressError}</p>}
        </div>
        <div className="space-y-1">
          <Label className="text-xs">City *</Label>
          {courierProviderKey ? (
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
          )}
          {cityError && <p className="text-xs text-destructive">{cityError}</p>}
        </div>
        {/* Country — required, visible. Defaults to Pakistan (current
            majority use case) but the user can change it. The selector
            works on alpha-2 codes; we translate to/from the NAME stored
            on the order/customer address. */}
        <div className="space-y-1">
          <Label className="text-xs">Country *</Label>
          <CountrySelector
            value={countryNameToCode(deliveryCountry) ?? 'PK'}
            onChange={(code) =>
              onChange({
                ...value,
                deliveryCountry: countryCodeToName(code) ?? 'Pakistan',
              })
            }
            placeholder="Select country"
          />
        </div>
      </div>

      {/* "Save for next time" checkbox — only in new-address mode */}
      {isNewMode && (
        <label className="flex items-center gap-2 cursor-pointer pt-1">
          <Checkbox
            checked={saveAddressForNextTime}
            onCheckedChange={(v) => onChange({ ...value, saveAddressForNextTime: v === true })}
          />
          <span className="text-xs text-muted-foreground">
            Save this address for future orders
          </span>
        </label>
      )}

      {!isNewMode && (
        <p className="text-[10px] text-muted-foreground">
          Edit the text above for this order only — the saved customer address is not changed.
        </p>
      )}
    </div>
  )
}
