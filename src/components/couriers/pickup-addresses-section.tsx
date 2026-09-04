'use client'

/**
 * PickupAddressesSection — embedded in the Integrations view per courier
 * integration card. Shows saved pickup/return addresses with Set Default
 * and Add Address actions.
 *
 * PostEx's API returns addressType="Pickup/Return Address" (one address
 * serves both), so we do NOT build separate pickup vs return concepts.
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, FetchError } from '@/lib/api-client'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
  MapPin,
  Plus,
  Star,
  Trash2,
  Loader2,
  User,
  Phone,
  RefreshCw,
  Download,
  Users,
} from 'lucide-react'
import { CityAutocomplete } from '@/components/couriers/city-autocomplete'
import { getErrorMessage } from '@/components/orders/_shared'

interface PickupAddress {
  id: string
  providerAddressCode: string
  label: string
  address: string
  cityName: string
  contactPersonName: string
  phone1: string
  phone2: string | null
  isDefault: boolean
  createdAt: string
}

interface PickupAddressesSectionProps {
  companyIntegrationId: string
  providerKey: string
}

export function PickupAddressesSection({
  companyIntegrationId,
  providerKey,
}: PickupAddressesSectionProps) {
  const queryClient = useQueryClient()
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [importShipmentId, setImportShipmentId] = useState('')

  const query = useQuery<{ addresses: PickupAddress[] }>({
    queryKey: ['pickup-addresses', companyIntegrationId],
    queryFn: () => api.get(`/api/integrations/${companyIntegrationId}/pickup-addresses`),
    staleTime: 15_000,
  })

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['pickup-addresses', companyIntegrationId] })
  }

  const setDefaultMutation = useMutation({
    mutationFn: (addressId: string) =>
      api.patch(`/api/integrations/${companyIntegrationId}/pickup-addresses/${addressId}`, {
        action: 'set-default',
      }),
    onSuccess: () => {
      toast.success('Default address updated.')
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const deleteMutation = useMutation({
    mutationFn: (addressId: string) =>
      api.delete(`/api/integrations/${companyIntegrationId}/pickup-addresses/${addressId}`),
    onSuccess: () => {
      toast.success('Address deleted.')
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const refreshMutation = useMutation({
    mutationFn: () =>
      api.post<{ refreshed: number; updated: number; errors: string[] }>(
        `/api/integrations/${companyIntegrationId}/pickup-addresses/refresh`,
      ),
    onSuccess: (data) => {
      if (data.updated > 0) {
        toast.success(`Refreshed ${data.refreshed} shipper(s) — ${data.updated} updated.`)
      } else if (data.refreshed > 0) {
        toast.success(`Refreshed ${data.refreshed} shipper(s) — all up to date.`)
      } else {
        toast.info('No shippers to refresh. Use Import to add shippers first.')
      }
      // Show any per-shipper errors as a warning toast
      if (data.errors && data.errors.length > 0) {
        toast.warning(`${data.errors.length} shipper(s) had issues: ${data.errors[0]}`)
      }
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const importMutation = useMutation({
    mutationFn: (shipmentId: string) =>
      api.post<{ addressId: string; providerAddressCode: string; label: string }>(
        `/api/integrations/${companyIntegrationId}/pickup-addresses/import-by-id`,
        { shipment_id: shipmentId },
      ),
    onSuccess: (data) => {
      toast.success(`Shipper imported: ${data.label}`)
      setShowImportDialog(false)
      setImportShipmentId('')
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const addresses = query.data?.addresses ?? []

  return (
    <div className="space-y-2 mt-3 pt-3 border-t">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
          <Users className="h-3 w-3" /> Shippers Detail
        </p>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px] px-2"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            title="Re-fetch each shipper's latest details from courier API"
          >
            {refreshMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            {' '}Refresh
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px] px-2"
            onClick={() => setShowAddDialog(true)}
          >
            <Plus className="h-3 w-3" /> Add
          </Button>
          {providerKey === 'leopard' && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-[10px] px-2"
              onClick={() => setShowImportDialog(true)}
            >
              <Download className="h-3 w-3" /> Import
            </Button>
          )}
        </div>
      </div>

      {query.isLoading && (
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading addresses...
        </div>
      )}

      {addresses.length === 0 && !query.isLoading && (
        <p className="text-[10px] text-muted-foreground italic">
          No shippers saved. Use Import to add a shipper by their shipment_id.
        </p>
      )}

      {addresses.length > 0 && (
        <div className="space-y-1.5">
          {addresses.map((addr) => (
            <div
              key={addr.id}
              className="rounded-md border bg-card p-2 space-y-1"
            >
              <div className="flex items-start justify-between gap-1">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span className="text-xs font-medium truncate">{addr.label}</span>
                    {addr.isDefault && (
                      <Badge variant="outline" className="text-[8px] py-0 px-1 bg-primary/10 text-primary border-primary/20">
                        <Star className="h-2 w-2 mr-0.5 fill-current" /> Default
                      </Badge>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground truncate">{addr.address}</p>
                  <p className="text-[10px] text-muted-foreground">{addr.cityName}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[9px] text-muted-foreground flex items-center gap-0.5">
                      <User className="h-2.5 w-2.5" /> {addr.contactPersonName}
                    </span>
                    <span className="text-[9px] text-muted-foreground flex items-center gap-0.5">
                      <Phone className="h-2.5 w-2.5" /> {addr.phone1}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col gap-0.5">
                  {!addr.isDefault && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 w-5 p-0"
                      disabled={setDefaultMutation.isPending}
                      onClick={() => setDefaultMutation.mutate(addr.id)}
                      title="Set as default"
                    >
                      <Star className="h-3 w-3" />
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 w-5 p-0 text-rose-500 hover:text-rose-700 hover:bg-rose-50"
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      if (confirm(`Delete address "${addr.label}"?`)) {
                        deleteMutation.mutate(addr.id)
                      }
                    }}
                    title="Delete address"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showAddDialog && (
        <AddPickupAddressDialog
          companyIntegrationId={companyIntegrationId}
          providerKey={providerKey}
          open={showAddDialog}
          onOpenChange={setShowAddDialog}
          onAdded={() => {
            setShowAddDialog(false)
            invalidate()
          }}
        />
      )}

      {showImportDialog && (
        <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Import Shipper by ID</DialogTitle>
              <DialogDescription>
                Enter the Leopard shipment_id of the shipper you want to import.
                We&apos;ll fetch their details from Leopard and add them to your address book.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="space-y-1.5">
                <Label>Shipment ID</Label>
                <Input
                  placeholder="e.g. 2549202"
                  value={importShipmentId}
                  onChange={(e) => setImportShipmentId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && importShipmentId.trim() && !importMutation.isPending) {
                      importMutation.mutate(importShipmentId.trim())
                    }
                  }}
                />
                <p className="text-[10px] text-muted-foreground">
                  Find the shipment_id in your Leopard merchant dashboard.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowImportDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => importMutation.mutate(importShipmentId.trim())}
                disabled={!importShipmentId.trim() || importMutation.isPending}
              >
                {importMutation.isPending ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Importing...</>
                ) : (
                  <><Download className="h-4 w-4" /> Import</>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Add Address Dialog
// ──────────────────────────────────────────────────────────────

function AddPickupAddressDialog({
  companyIntegrationId,
  providerKey,
  open,
  onOpenChange,
  onAdded,
}: {
  companyIntegrationId: string
  providerKey: string
  open: boolean
  onOpenChange: (v: boolean) => void
  onAdded: () => void
}) {
  const [form, setForm] = useState({
    label: '',
    address: '',
    cityName: '',
    contactPersonName: '',
    phone1: '',
    phone2: '',
  })

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/api/integrations/${companyIntegrationId}/pickup-addresses`, {
        label: form.label.trim(),
        address: form.address.trim(),
        cityName: form.cityName.trim(),
        contactPersonName: form.contactPersonName.trim(),
        phone1: form.phone1.trim(),
        phone2: form.phone2.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('Pickup address added.')
      onAdded()
    },
    onError: (err) => {
      toast.error(err instanceof FetchError ? err.message : 'Failed to add address')
    },
  })

  function handleSubmit() {
    if (!form.label.trim() || !form.address.trim() || !form.cityName.trim() || !form.contactPersonName.trim() || !form.phone1.trim()) {
      toast.error('All fields except phone2 are required.')
      return
    }
    mutation.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Shipper</DialogTitle>
          <DialogDescription>
            Add a shipper manually. For Leopard, use Import to fetch directly from the API.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Label *</Label>
            <Input
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder="Main Warehouse"
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Address *</Label>
            <Input
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              placeholder="House 123, Block A, Gulshan-e-Iqbal"
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">City *</Label>
            <CityAutocomplete
              providerKey={providerKey}
              value={form.cityName}
              onChange={(v) => setForm({ ...form, cityName: v })}
              placeholder="Search city..."
              pickupOnly
              className="w-full"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Contact Person *</Label>
              <Input
                value={form.contactPersonName}
                onChange={(e) => setForm({ ...form, contactPersonName: e.target.value })}
                placeholder="John Doe"
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Phone 1 *</Label>
              <Input
                value={form.phone1}
                onChange={(e) => setForm({ ...form, phone1: e.target.value })}
                placeholder="03001234567"
                className="h-8 text-sm"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Phone 2 (optional)</Label>
            <Input
              value={form.phone2}
              onChange={(e) => setForm({ ...form, phone2: e.target.value })}
              placeholder="03007654321"
              className="h-8 text-sm"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Add Address
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
