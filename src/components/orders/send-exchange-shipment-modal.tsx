'use client'

/**
 * SendExchangeShipmentModal
 * -------------------------
 * Reusable Dialog used by ExchangeDetailView to dispatch a new replacement
 * item to the customer via a courier.
 *
 * Two modes (driven by exchangeMethod + isExchangeReplacement):
 *   - courier_replacement  → POST /api/exchanges/{id}/dispatch-new-item
 *                            (immediate dispatch — old item NOT yet received)
 *   - customer_self_return → POST /api/exchanges/{id}/dispatch-replacement
 *                            (post-verification dispatch)
 *
 * The dialog collects 6 fields in strict sequence:
 *   1. Courier integration (must be selected first — drives the city provider)
 *   2. Delivery city (uses CityAutocomplete with the selected courier's
 *      providerKey so only operational cities are offered)
 *   3. Shipping address (dropdown of customer's existing addresses + "Add New")
 *   4. Shipping phone (dropdown of customer's existing phones + "Add New")
 *   5. Invoice / COD amount (defaults to defaultInvoiceAmount)
 *   6. Quantity (defaults to defaultQuantity)
 *
 * The Add New flows POST to /api/customers/{customerId}/addresses|phones,
 * then refetch + auto-select the new record.
 *
 * On submit, the collected payload is POSTed to the dispatch endpoint. The
 * backend (Prompt 5 parent integration) reads these fields to create the
 * ExchangeShipment, reserve stock, and call the courier adapter.
 *
 * City-mismatch resolution is intentionally NOT implemented inline — the
 * backend returns a clear error which we surface via toast.
 */

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, FetchError } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Truck,
  Loader2,
  MapPin,
  Phone,
  Plus,
  Banknote,
  Package,
  CheckCircle2,
  AlertCircle,
  Hash,
  FileText,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { CityAutocomplete } from '@/components/couriers/city-autocomplete'
import { getErrorMessage } from './_shared'

export interface SendExchangeShipmentModalProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  exchangeId: string
  exchangeMethod: 'courier_replacement' | 'customer_self_return'
  /** true = courier_replacement (immediate dispatch); false = customer_self_return (post-verification) */
  isExchangeReplacement: boolean
  defaultCustomerId: string
  defaultVariantId: string
  defaultQuantity: number
  defaultInvoiceAmount: number
  onSuccess?: () => void
}

// ─────────────────────────────────────────────────────────────────────────────
// API response shapes
// ─────────────────────────────────────────────────────────────────────────────

interface IntegrationProvider {
  id: string
  providerKey: string
  providerName: string
  category: string
  logoUrl: string | null
}

interface CompanyIntegration {
  id: string
  connectionName: string
  isActive: boolean
  provider: IntegrationProvider
}

interface IntegrationsResponse {
  providers: IntegrationProvider[]
  integrations: CompanyIntegration[]
}

interface CustomerPhoneDTO {
  id: string
  phoneRaw: string
  label: string | null
  isPrimary: boolean
}

interface CustomerAddressDTO {
  id: string
  label: string | null
  address: string
  city: string
  isDefault: boolean
}

interface CustomerDetail {
  id: string
  name: string
  phones: CustomerPhoneDTO[]
  addresses: CustomerAddressDTO[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ADD_NEW_SENTINEL = '__add_new__'

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export function SendExchangeShipmentModal({
  open,
  onOpenChange,
  exchangeId,
  exchangeMethod,
  isExchangeReplacement,
  defaultCustomerId,
  defaultVariantId,
  defaultQuantity,
  defaultInvoiceAmount,
  onSuccess,
}: SendExchangeShipmentModalProps) {
  const queryClient = useQueryClient()

  // ── Form state ──────────────────────────────────────────────────────────
  const [companyIntegrationId, setCompanyIntegrationId] = useState<string>('')
  const [deliveryCity, setDeliveryCity] = useState<string>('')
  const [addressId, setAddressId] = useState<string>('')
  const [phoneId, setPhoneId] = useState<string>('')
  const [invoiceAmount, setInvoiceAmount] = useState<string>(
    String(defaultInvoiceAmount ?? 0),
  )
  const [quantity, setQuantity] = useState<string>(
    String(defaultQuantity ?? 1),
  )
  // Universal courier reference fields (migration 015). Both are optional —
  // the backend defaults orderRefNumber to the generated EXCH-YYYY-NNNNN
  // and auto-builds orderDetail from the variant (product title + SKU +
  // attributes + qty). Editing here overrides those defaults.
  const [orderRefNumber, setOrderRefNumber] = useState<string>('')
  const [orderDetail, setOrderDetail] = useState<string>('')

  // Inline "Add New" sub-forms
  const [addingAddress, setAddingAddress] = useState(false)
  const [newAddressLabel, setNewAddressLabel] = useState('')
  const [newAddressLine, setNewAddressLine] = useState('')
  const [newAddressCity, setNewAddressCity] = useState('')
  const [newAddressIsDefault, setNewAddressIsDefault] = useState(false)

  const [addingPhone, setAddingPhone] = useState(false)
  const [newPhoneRaw, setNewPhoneRaw] = useState('')
  const [newPhoneLabel, setNewPhoneLabel] = useState('')
  const [newPhoneIsPrimary, setNewPhoneIsPrimary] = useState(false)

  // Reset form when modal closes
  useEffect(() => {
    if (!open) {
      setCompanyIntegrationId('')
      setDeliveryCity('')
      setAddressId('')
      setPhoneId('')
      setInvoiceAmount(String(defaultInvoiceAmount ?? 0))
      setQuantity(String(defaultQuantity ?? 1))
      setOrderRefNumber('')
      setOrderDetail('')
      setAddingAddress(false)
      setAddingPhone(false)
      setNewAddressLabel('')
      setNewAddressLine('')
      setNewAddressCity('')
      setNewAddressIsDefault(false)
      setNewPhoneRaw('')
      setNewPhoneLabel('')
      setNewPhoneIsPrimary(false)
    }
  }, [open, defaultInvoiceAmount, defaultQuantity])

  // ── Data: integrations ──────────────────────────────────────────────────
  const integrationsQuery = useQuery<IntegrationsResponse>({
    queryKey: ['integrations', 'courier'],
    queryFn: () => api.get<IntegrationsResponse>('/api/integrations?category=courier'),
    enabled: open,
    staleTime: 30_000,
  })

  const courierIntegrations = useMemo(
    () =>
      (integrationsQuery.data?.integrations ?? []).filter(
        (i) => i.isActive && i.provider?.category === 'courier',
      ),
    [integrationsQuery.data],
  )

  const selectedIntegration = useMemo(
    () => courierIntegrations.find((i) => i.id === companyIntegrationId),
    [courierIntegrations, companyIntegrationId],
  )
  const selectedProviderKey = selectedIntegration?.provider?.providerKey ?? ''

  // ── Data: customer (addresses + phones) ─────────────────────────────────
  const customerQuery = useQuery<CustomerDetail>({
    queryKey: ['customer-detail', defaultCustomerId],
    queryFn: () => api.get<CustomerDetail>(`/api/customers/${defaultCustomerId}`),
    enabled: open && !!defaultCustomerId,
    staleTime: 0,
  })

  const addresses = customerQuery.data?.addresses ?? []
  const phones = customerQuery.data?.phones ?? []

  // Default new-address city to the selected delivery city
  useEffect(() => {
    if (addingAddress && !newAddressCity && deliveryCity) {
      setNewAddressCity(deliveryCity)
    }
  }, [addingAddress, newAddressCity, deliveryCity])

  // ── Mutations: Add new address / phone ──────────────────────────────────
  const addAddressMutation = useMutation({
    mutationFn: async () => {
      if (!newAddressLine.trim()) throw new Error('Address line is required')
      if (!newAddressCity.trim()) throw new Error('City is required')
      return api.post<{ addressId: string }>(
        `/api/customers/${defaultCustomerId}/addresses`,
        {
          label: newAddressLabel.trim() || undefined,
          address: newAddressLine.trim(),
          city: newAddressCity.trim(),
          is_default: newAddressIsDefault,
        },
      )
    },
    onSuccess: (data) => {
      toast.success('Address added to customer record.')
      // Reset inline form
      setNewAddressLabel('')
      setNewAddressLine('')
      setNewAddressIsDefault(false)
      setAddingAddress(false)
      // Refetch customer, then auto-select the new address
      queryClient.invalidateQueries({
        queryKey: ['customer-detail', defaultCustomerId],
      })
      setAddressId(data.addressId)
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const addPhoneMutation = useMutation({
    mutationFn: async () => {
      if (!newPhoneRaw.trim()) throw new Error('Phone number is required')
      return api.post<{ phoneId: string }>(
        `/api/customers/${defaultCustomerId}/phones`,
        {
          phone: newPhoneRaw.trim(),
          label: newPhoneLabel.trim() || undefined,
          is_primary: newPhoneIsPrimary,
        },
      )
    },
    onSuccess: (data) => {
      toast.success('Phone added to customer record.')
      setNewPhoneRaw('')
      setNewPhoneLabel('')
      setNewPhoneIsPrimary(false)
      setAddingPhone(false)
      queryClient.invalidateQueries({
        queryKey: ['customer-detail', defaultCustomerId],
      })
      setPhoneId(data.phoneId)
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  // ── Mutation: dispatch ──────────────────────────────────────────────────
  const dispatchMutation = useMutation({
    mutationFn: async () => {
      const endpoint = isExchangeReplacement
        ? `/api/exchanges/${exchangeId}/dispatch-new-item`
        : `/api/exchanges/${exchangeId}/dispatch-replacement`
      return api.post(endpoint, {
        companyIntegrationId,
        deliveryCity: deliveryCity.trim(),
        shippingAddressId: addressId || undefined,
        shippingPhoneId: phoneId || undefined,
        invoiceAmount: Number(invoiceAmount) || 0,
        quantity: Number(quantity) || 1,
        variantId: defaultVariantId,
        // Universal courier reference fields (migration 015) — optional;
        // backend defaults orderRefNumber to the EXCH-##### number and
        // auto-builds orderDetail from the variant when these are blank.
        orderRefNumber: orderRefNumber.trim() || undefined,
        orderDetail: orderDetail.trim() || undefined,
      })
    },
    onSuccess: () => {
      const msg = isExchangeReplacement
        ? 'Replacement item dispatched — ExchangeShipment created.'
        : 'Replacement shipment dispatched.'
      toast.success(msg)
      // Invalidate exchange + shipments so the parent refetches
      queryClient.invalidateQueries({ queryKey: ['exchanges'] })
      queryClient.invalidateQueries({ queryKey: ['exchange', exchangeId] })
      queryClient.invalidateQueries({ queryKey: ['inventory-pools'] })
      onSuccess?.()
      onOpenChange(false)
    },
    onError: (err) => {
      // Keep the dialog open on failure so the user can fix inputs.
      toast.error(
        err instanceof FetchError
          ? err.message
          : getErrorMessage(err),
      )
    },
  })

  // ── Validation ──────────────────────────────────────────────────────────
  const canSubmit =
    !!companyIntegrationId &&
    !!deliveryCity.trim() &&
    !!addressId &&
    !!phoneId &&
    !addingAddress &&
    !addingPhone &&
    !dispatchMutation.isPending

  const methodLabel = isExchangeReplacement
    ? 'Courier Replacement — Immediate Dispatch'
    : 'Customer Self-Return — Post-Verification Dispatch'

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onOpenChange(false)}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="h-4 w-4" /> Dispatch Replacement Shipment
          </DialogTitle>
          <DialogDescription>
            {methodLabel}. Fill in courier + delivery details to create an
            ExchangeShipment (EXCH-#####) and book with the courier.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Method badge */}
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={cn(
                'text-[10px]',
                isExchangeReplacement
                  ? 'bg-violet-50 text-violet-700 border-violet-200'
                  : 'bg-sky-50 text-sky-700 border-sky-200',
              )}
            >
              {exchangeMethod.replace(/_/g, ' ')}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Exchange {exchangeId.slice(0, 8)}…
            </span>
          </div>

          {/* 1. Courier integration */}
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1">
              <Truck className="h-3 w-3" /> 1. Courier *
            </Label>
            <Select
              value={companyIntegrationId}
              onValueChange={(v) => {
                setCompanyIntegrationId(v)
                // Reset city when courier changes (different provider → different cities)
                setDeliveryCity('')
              }}
              disabled={integrationsQuery.isLoading}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    integrationsQuery.isLoading
                      ? 'Loading couriers…'
                      : courierIntegrations.length === 0
                        ? 'No courier integrations connected'
                        : 'Select courier integration'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {courierIntegrations.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    <span className="flex items-center gap-2">
                      <span className="font-medium">
                        {i.provider.providerName}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        ({i.connectionName})
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {integrationsQuery.isError && (
              <p className="text-xs text-rose-600 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" /> Failed to load courier
                integrations.
              </p>
            )}
          </div>

          {/* 2. City */}
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1">
              <MapPin className="h-3 w-3" /> 2. Delivery City *
            </Label>
            <CityAutocomplete
              providerKey={selectedProviderKey}
              value={deliveryCity}
              onChange={setDeliveryCity}
              placeholder={
                selectedProviderKey
                  ? 'Search city…'
                  : 'Select a courier first'
              }
              disabled={!selectedProviderKey}
            />
            {!selectedProviderKey && (
              <p className="text-xs text-muted-foreground">
                City options are filtered to the courier's operational cities.
              </p>
            )}
          </div>

          {/* 3. Customer address */}
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1">
              <MapPin className="h-3 w-3" /> 3. Shipping Address *
            </Label>
            <Select
              value={addressId}
              onValueChange={(v) => {
                if (v === ADD_NEW_SENTINEL) {
                  setAddingAddress(true)
                  setAddressId('')
                } else {
                  setAddingAddress(false)
                  setAddressId(v)
                }
              }}
              disabled={customerQuery.isLoading}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    customerQuery.isLoading
                      ? 'Loading addresses…'
                      : addresses.length === 0
                        ? 'No addresses — add new'
                        : 'Select address'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {addresses.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <span className="flex flex-col">
                      <span>
                        {a.address}
                        {a.isDefault && (
                          <span className="ml-1 text-[10px] text-emerald-600">
                            (default)
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {a.city}
                        {a.label ? ` · ${a.label}` : ''}
                      </span>
                    </span>
                  </SelectItem>
                ))}
                <SelectItem value={ADD_NEW_SENTINEL}>
                  <span className="flex items-center gap-1 text-primary">
                    <Plus className="h-3 w-3" /> Add new address
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>

            {/* Inline Add New Address form */}
            {addingAddress && (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
                <p className="text-xs font-medium flex items-center gap-1">
                  <Plus className="h-3 w-3" /> New Address
                </p>
                <Input
                  placeholder="Address line *"
                  value={newAddressLine}
                  onChange={(e) => setNewAddressLine(e.target.value)}
                  className="text-xs h-8"
                />
                <Input
                  placeholder="City *"
                  value={newAddressCity}
                  onChange={(e) => setNewAddressCity(e.target.value)}
                  className="text-xs h-8"
                />
                <Input
                  placeholder="Label (optional, e.g. Home, Office)"
                  value={newAddressLabel}
                  onChange={(e) => setNewAddressLabel(e.target.value)}
                  className="text-xs h-8"
                />
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="new-addr-default"
                    checked={newAddressIsDefault}
                    onCheckedChange={(v) => setNewAddressIsDefault(v === true)}
                  />
                  <Label
                    htmlFor="new-addr-default"
                    className="text-xs text-muted-foreground"
                  >
                    Set as default address
                  </Label>
                </div>
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => setAddingAddress(false)}
                    disabled={addAddressMutation.isPending}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => addAddressMutation.mutate()}
                    disabled={
                      addAddressMutation.isPending ||
                      !newAddressLine.trim() ||
                      !newAddressCity.trim()
                    }
                  >
                    {addAddressMutation.isPending ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin" /> Saving…
                      </>
                    ) : (
                      'Save Address'
                    )}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* 4. Customer phone */}
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1">
              <Phone className="h-3 w-3" /> 4. Customer Phone *
            </Label>
            <Select
              value={phoneId}
              onValueChange={(v) => {
                if (v === ADD_NEW_SENTINEL) {
                  setAddingPhone(true)
                  setPhoneId('')
                } else {
                  setAddingPhone(false)
                  setPhoneId(v)
                }
              }}
              disabled={customerQuery.isLoading}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    customerQuery.isLoading
                      ? 'Loading phones…'
                      : phones.length === 0
                        ? 'No phones — add new'
                        : 'Select phone'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {phones.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="flex items-center gap-2">
                      <span className="font-mono">{p.phoneRaw}</span>
                      {p.isPrimary && (
                        <span className="text-[10px] text-emerald-600">
                          (primary)
                        </span>
                      )}
                      {p.label && (
                        <span className="text-xs text-muted-foreground">
                          · {p.label}
                        </span>
                      )}
                    </span>
                  </SelectItem>
                ))}
                <SelectItem value={ADD_NEW_SENTINEL}>
                  <span className="flex items-center gap-1 text-primary">
                    <Plus className="h-3 w-3" /> Add new phone
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>

            {/* Inline Add New Phone form */}
            {addingPhone && (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
                <p className="text-xs font-medium flex items-center gap-1">
                  <Plus className="h-3 w-3" /> New Phone
                </p>
                <Input
                  placeholder="Phone number * (e.g. 03001234567)"
                  value={newPhoneRaw}
                  onChange={(e) => setNewPhoneRaw(e.target.value)}
                  className="text-xs h-8"
                />
                <Input
                  placeholder="Label (optional, e.g. WhatsApp, Home)"
                  value={newPhoneLabel}
                  onChange={(e) => setNewPhoneLabel(e.target.value)}
                  className="text-xs h-8"
                />
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="new-phone-primary"
                    checked={newPhoneIsPrimary}
                    onCheckedChange={(v) => setNewPhoneIsPrimary(v === true)}
                  />
                  <Label
                    htmlFor="new-phone-primary"
                    className="text-xs text-muted-foreground"
                  >
                    Set as primary (unsets existing primary)
                  </Label>
                </div>
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => setAddingPhone(false)}
                    disabled={addPhoneMutation.isPending}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => addPhoneMutation.mutate()}
                    disabled={
                      addPhoneMutation.isPending || !newPhoneRaw.trim()
                    }
                  >
                    {addPhoneMutation.isPending ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin" /> Saving…
                      </>
                    ) : (
                      'Save Phone'
                    )}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* 5. Invoice / COD amount */}
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1">
              <Banknote className="h-3 w-3" /> 5. Invoice / COD Amount (Rs.) *
            </Label>
            <Input
              type="number"
              min="0"
              step="1"
              value={invoiceAmount}
              onChange={(e) => setInvoiceAmount(e.target.value)}
              placeholder="0"
            />
            <p className="text-xs text-muted-foreground">
              Collected from customer on delivery (Cash on Delivery).
            </p>
          </div>

          {/* 6. Quantity */}
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1">
              <Package className="h-3 w-3" /> 6. Quantity *
            </Label>
            <Input
              type="number"
              min="1"
              step="1"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="1"
            />
          </div>

          {/* 7. Order Reference — universal courier reference field (migration 015) */}
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1">
              <Hash className="h-3 w-3" /> 7. Order Reference
              <span className="text-[10px] text-amber-700">(for courier)</span>
            </Label>
            <Input
              value={orderRefNumber}
              onChange={(e) => setOrderRefNumber(e.target.value)}
              placeholder="Defaults to EXCH-##### — type to override"
            />
            <p className="text-xs text-muted-foreground">
              Universal courier reference. Almost every courier (PostEx, TCS,
              Leopard…) has a reference field — we map this to the courier's
              own field at booking time. Leave blank to use the auto-generated
              Exchange Shipment number.
            </p>
          </div>

          {/* 8. Order Detail — item description for the courier */}
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1">
              <FileText className="h-3 w-3" /> 8. Order Detail
              <span className="text-[10px] text-amber-700">(item summary)</span>
            </Label>
            <Input
              value={orderDetail}
              onChange={(e) => setOrderDetail(e.target.value)}
              placeholder="Auto-filled from variant (title + SKU + attributes × qty)"
            />
            <p className="text-xs text-muted-foreground">
              Human-readable item description passed to the courier. Leave
              blank to auto-generate from the variant.
            </p>
          </div>

          {/* Summary footer note */}
          <div className="rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground flex items-start gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5 text-emerald-600" />
            <span>
              On submit, an ExchangeShipment (EXCH-#####) will be created,
              inventory reserved, and the shipment booked with{' '}
              <strong className="text-foreground">
                {selectedIntegration?.provider?.providerName ?? 'the courier'}
              </strong>
              .
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={dispatchMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() => dispatchMutation.mutate()}
          >
            {dispatchMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Dispatching…
              </>
            ) : (
              <>
                <Truck className="h-4 w-4" /> Dispatch Shipment
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
