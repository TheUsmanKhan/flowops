'use client'

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Plus, Trash2, Star, Phone, MapPin, Loader2, User, Mail } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CreateCustomerInput, PhoneInput, AddressInput } from './types'

export interface CreateCustomerFormProps {
  /** Called on successful creation with the new customer ID. */
  onCreated: (customerId: string) => void
  /** Pre-fill the first phone field (e.g. from a search box the user just typed in). */
  defaultPhone?: string
  /** Compact mode — used inline in the order-create page (no outer card). */
  compact?: boolean
  /** Submit button label override. */
  submitLabel?: string
}

interface PhoneEntry extends PhoneInput {
  _key: string
}
interface AddressEntry extends AddressInput {
  _key: string
}

let _keyCounter = 0
function nextKey() { return `e${++_keyCounter}` }

/**
 * Full multi-phone / multi-address customer creation form.
 *
 * - Exactly one phone must be primary (the first entry defaults to primary;
 *   its "set as primary" checkbox is hidden since there must always be one).
 * - Exactly one address must be default (same first-entry behavior).
 * - "+ Add another phone" / "+ Add another address" buttons add more entries.
 *
 * Used in:
 *   - The standalone /customers "Add Customer" dialog
 *   - Inline within the Order Creation page's customer section when no match
 *     is found
 */
export function CreateCustomerForm({
  onCreated,
  defaultPhone = '',
  compact = false,
  submitLabel = 'Create Customer',
}: CreateCustomerFormProps) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phones, setPhones] = useState<PhoneEntry[]>([
    { _key: nextKey(), phone: defaultPhone, is_primary: true, label: '' },
  ])
  const [addresses, setAddresses] = useState<AddressEntry[]>([
    { _key: nextKey(), address: '', city: '', is_default: true, label: '' },
  ])

  const createMutation = useMutation({
    mutationFn: async (input: CreateCustomerInput) =>
      api.post<{ customerId: string }>('/api/customers', input),
    onSuccess: (data) => {
      toast.success('Customer created.')
      onCreated(data.customerId)
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to create customer'
      toast.error(msg)
    },
  })

  const addPhone = () => {
    setPhones((p) => [...p, { _key: nextKey(), phone: '', is_primary: false, label: '' }])
  }
  const removePhone = (key: string) => {
    setPhones((p) => p.filter((e) => e._key !== key))
  }
  const setPrimaryPhone = (key: string) => {
    setPhones((p) => p.map((e) => ({ ...e, is_primary: e._key === key })))
  }
  const updatePhone = (key: string, field: keyof PhoneInput, value: string | boolean) => {
    setPhones((p) => p.map((e) => (e._key === key ? { ...e, [field]: value } : e)))
  }

  const addAddress = () => {
    setAddresses((p) => [...p, { _key: nextKey(), address: '', city: '', is_default: false, label: '' }])
  }
  const removeAddress = (key: string) => {
    setAddresses((p) => p.filter((e) => e._key !== key))
  }
  const setDefaultAddress = (key: string) => {
    setAddresses((p) => p.map((e) => ({ ...e, is_default: e._key === key })))
  }
  const updateAddress = (key: string, field: keyof AddressInput, value: string | boolean) => {
    setAddresses((p) => p.map((e) => (e._key === key ? { ...e, [field]: value } : e)))
  }

  const handleSubmit = () => {
    if (!name.trim()) { toast.error('Name is required'); return }
    if (phones.length === 0 || !phones[0].phone.trim()) { toast.error('At least one phone is required'); return }
    if (addresses.length === 0 || !addresses[0].address.trim()) { toast.error('At least one address is required'); return }

    const payload: CreateCustomerInput = {
      name: name.trim(),
      email: email.trim() || undefined,
      phones: phones.map((p) => ({
        phone: p.phone.trim(),
        label: p.label?.trim() || undefined,
        is_primary: p.is_primary,
      })),
      addresses: addresses.map((a) => ({
        label: a.label?.trim() || undefined,
        address: a.address.trim(),
        city: a.city.trim(),
        is_default: a.is_default,
      })),
    }
    createMutation.mutate(payload)
  }

  const formContent = (
    <div className={cn('space-y-4', !compact && 'p-1')}>
      {/* Name + Email */}
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs flex items-center gap-1"><User className="h-3 w-3" /> Full Name *</Label>
          <Input
            placeholder="e.g. Ayesha Khan"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus={!compact}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs flex items-center gap-1"><Mail className="h-3 w-3" /> Email (optional)</Label>
          <Input
            type="email"
            placeholder="ayesha@example.pk"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      </div>

      {/* Phone numbers */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1">
          <Phone className="h-3 w-3" /> Phone Numbers
        </p>
        {phones.map((entry, idx) => (
          <div key={entry._key} className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              {idx === 0 && <Label className="text-[10px]">Phone *</Label>}
              <Input
                placeholder="0300-1234567"
                value={entry.phone}
                onChange={(e) => updatePhone(entry._key, 'phone', e.target.value)}
                className="text-sm"
              />
            </div>
            <div className="w-32 space-y-1">
              {idx === 0 && <Label className="text-[10px]">Label</Label>}
              <Input
                placeholder="Personal"
                value={entry.label ?? ''}
                onChange={(e) => updatePhone(entry._key, 'label', e.target.value)}
                className="text-sm"
              />
            </div>
            {phones.length > 1 && (
              <div className="flex items-center gap-1 pb-1">
                {idx > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant={entry.is_primary ? 'default' : 'outline'}
                    className="h-8 px-2"
                    onClick={() => setPrimaryPhone(entry._key)}
                    title="Set as primary"
                  >
                    <Star className={cn('h-3.5 w-3.5', entry.is_primary && 'fill-current')} />
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2 text-muted-foreground hover:text-destructive"
                  onClick={() => removePhone(entry._key)}
                  title="Remove phone"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
            {idx === 0 && phones.length === 1 && (
              <div className="pb-2">
                <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 text-[10px]">
                  <Star className="h-2.5 w-2.5 mr-0.5 fill-current" /> Primary
                </Badge>
              </div>
            )}
          </div>
        ))}
        <Button type="button" variant="ghost" size="sm" onClick={addPhone} className="text-xs">
          <Plus className="h-3 w-3" /> Add another phone
        </Button>
      </div>

      {/* Addresses */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1">
          <MapPin className="h-3 w-3" /> Addresses
        </p>
        {addresses.map((entry, idx) => (
          <div key={entry._key} className="rounded-md border p-3 space-y-2">
            <div className="flex items-center justify-between">
              {idx === 0 && addresses.length === 1 ? (
                <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 text-[10px]">
                  <Star className="h-2.5 w-2.5 mr-0.5 fill-current" /> Default
                </Badge>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant={entry.is_default ? 'default' : 'outline'}
                  className="h-6 px-2 text-[10px]"
                  onClick={() => setDefaultAddress(entry._key)}
                >
                  <Star className={cn('h-2.5 w-2.5 mr-0.5', entry.is_default && 'fill-current')} />
                  {entry.is_default ? 'Default' : 'Set as default'}
                </Button>
              )}
              {addresses.length > 1 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                  onClick={() => removeAddress(entry._key)}
                >
                  <Trash2 className="h-3 w-3" /> Remove
                </Button>
              )}
            </div>
            <div className="grid sm:grid-cols-2 gap-2">
              <div className="space-y-1 sm:col-span-2">
                {idx === 0 && <Label className="text-[10px]">Address *</Label>}
                <Input
                  placeholder="House #, street, area"
                  value={entry.address}
                  onChange={(e) => updateAddress(entry._key, 'address', e.target.value)}
                  className="text-sm"
                />
              </div>
              <div className="space-y-1">
                {idx === 0 && <Label className="text-[10px]">City *</Label>}
                <Input
                  placeholder="e.g. Lahore"
                  value={entry.city}
                  onChange={(e) => updateAddress(entry._key, 'city', e.target.value)}
                  className="text-sm"
                />
              </div>
              <div className="space-y-1">
                {idx === 0 && <Label className="text-[10px]">Label (optional)</Label>}
                <Input
                  placeholder="Home, Office…"
                  value={entry.label ?? ''}
                  onChange={(e) => updateAddress(entry._key, 'label', e.target.value)}
                  className="text-sm"
                />
              </div>
            </div>
          </div>
        ))}
        <Button type="button" variant="ghost" size="sm" onClick={addAddress} className="text-xs">
          <Plus className="h-3 w-3" /> Add another address
        </Button>
      </div>

      <Button
        type="button"
        onClick={handleSubmit}
        disabled={createMutation.isPending}
        className="w-full"
      >
        {createMutation.isPending ? (
          <><Loader2 className="h-4 w-4 animate-spin" /> Creating…</>
        ) : (
          <><Plus className="h-4 w-4" /> {submitLabel}</>
        )}
      </Button>
    </div>
  )

  if (compact) {
    return formContent
  }

  return (
    <Card>
      <CardContent className="pt-6">
        {formContent}
      </CardContent>
    </Card>
  )
}
