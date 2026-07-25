'use client'

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api-client'
import { useAppStore, useCan } from '@/stores/app-store'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  RefreshCw,
  Loader2,
  Save,
  ShieldAlert,
  CheckCircle2,
  MapPin,
  Truck,
  Settings,
} from 'lucide-react'
import { getErrorMessage } from './_shared'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface OrderSettings {
  id: string
  companyId: string
  requireOrderConfirmation: boolean
  requirePackingStep: boolean
  defaultCourier: string | null
  defaultDispatchLocationId: string | null
  updatedAt: string
}

interface SettingsResponse {
  settings: OrderSettings
}

interface InventoryLocation {
  id: string
  name: string
  locationType: string
  city: string
  province: string
}

interface LocationsResponse {
  locations: InventoryLocation[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function OrderWorkflowSettingsView() {
  const can = useCan()
  const queryClient = useQueryClient()
  const navigate = useAppStore((s) => s.navigate)
  const employee = useAppStore((s) => s.employee)

  // GUARD: elevated roles only
  const isElevated = employee?.isElevated ?? false
  const canView = isElevated || can('settings.company.view')

  const settingsQuery = useQuery<SettingsResponse>({
    queryKey: ['order-settings'],
    queryFn: () => api.get<SettingsResponse>('/api/order-settings'),
    staleTime: 30_000,
    enabled: canView,
  })

  const locationsQuery = useQuery<LocationsResponse>({
    queryKey: ['inventory-locations'],
    queryFn: () => api.get<LocationsResponse>('/api/inventory-locations'),
    staleTime: 60_000,
    enabled: canView,
  })

  const [requireConfirmation, setRequireConfirmation] = useState(false)
  const [requirePacking, setRequirePacking] = useState(false)
  const [defaultCourier, setDefaultCourier] = useState('')
  const [defaultLocationId, setDefaultLocationId] = useState('')
  const [hydrated, setHydrated] = useState(false)

  // Hydrate local form state from the fetched settings
  useEffect(() => {
    if (settingsQuery.data?.settings && !hydrated) {
      const s = settingsQuery.data.settings
      setRequireConfirmation(s.requireOrderConfirmation)
      setRequirePacking(s.requirePackingStep)
      setDefaultCourier(s.defaultCourier ?? '')
      setDefaultLocationId(s.defaultDispatchLocationId ?? '')
      setHydrated(true)
    }
  }, [settingsQuery.data, hydrated])

  const mutation = useMutation({
    mutationFn: async () =>
      api.put('/api/order-settings', {
        require_order_confirmation: requireConfirmation,
        require_packing_step: requirePacking,
        default_courier: defaultCourier,
        default_dispatch_location_id: defaultLocationId,
      }),
    onSuccess: () => {
      toast.success('Order workflow settings saved.')
      void queryClient.invalidateQueries({ queryKey: ['order-settings'] })
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  if (!canView) {
    return (
      <div className="space-y-6">
        <PageHeader title="Order Workflow Settings" />
        <Card>
          <CardContent className="p-10 text-center">
            <ShieldAlert className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">
              Only elevated employees can view order workflow settings.
            </p>
            <Button variant="outline" className="mt-4" onClick={() => navigate({ name: 'orders' })}>
              Back to orders
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (settingsQuery.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Order Workflow Settings" />
        <Card>
          <CardContent className="p-5 space-y-3">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (settingsQuery.isError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Order Workflow Settings" />
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">
              Couldn&apos;t load settings. {getErrorMessage(settingsQuery.error)}
            </p>
            <Button variant="outline" onClick={() => settingsQuery.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const locations = locationsQuery.data?.locations ?? []

  return (
    <div className="space-y-6">
      <PageHeader
        title="Order Workflow Settings"
        description="Configure how strict your order lifecycle is. Skipped steps are auto-backfilled on dispatch."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void settingsQuery.refetch()
              void locationsQuery.refetch()
              setHydrated(false)
            }}
            disabled={settingsQuery.isFetching}
          >
            <RefreshCw className={settingsQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            Refresh
          </Button>
        }
      />

      {!isElevated && (
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <ShieldAlert className="h-5 w-5 text-amber-600" />
            <div>
              <p className="text-sm font-medium">Read-only view</p>
              <p className="text-xs text-muted-foreground">
                Only elevated employees can modify order workflow settings.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Confirmation toggle */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Settings className="h-4 w-4 text-muted-foreground" /> Order Confirmation
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="flex items-start justify-between gap-3 cursor-pointer">
              <div>
                <span className="text-sm font-medium block">
                  Require manual confirmation
                </span>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                  When ON, new COD orders start as <code className="text-xs">pending</code> and
                  require a staff member to confirm them before stock is reserved. When OFF, orders
                  auto-confirm on creation. Prepaid orders always auto-confirm regardless of this
                  setting.
                </p>
              </div>
              <Switch
                checked={requireConfirmation}
                onCheckedChange={setRequireConfirmation}
                disabled={mutation.isPending || !isElevated}
                aria-label="Require order confirmation"
              />
            </label>
            <div
              className={`rounded-md p-3 text-xs border ${
                requireConfirmation
                  ? 'bg-amber-50 border-amber-200 text-amber-800'
                  : 'bg-emerald-50 border-emerald-200 text-emerald-800'
              }`}
            >
              {requireConfirmation ? (
                <>
                  <strong>Strict mode:</strong> New COD orders wait in the Pending Confirmation
                  queue. Prepaid/converted orders bypass this and confirm immediately.
                </>
              ) : (
                <>
                  <strong>Fast mode:</strong> All new orders confirm on creation and stock is
                  reserved automatically.
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Packing step toggle */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-muted-foreground" /> Packing Step
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="flex items-start justify-between gap-3 cursor-pointer">
              <div>
                <span className="text-sm font-medium block">Require packing step</span>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                  When ON, confirmed orders must be marked as &quot;packed&quot; before they can be
                  dispatched. When OFF, the dispatch action auto-backfills the packed timestamp.
                </p>
              </div>
              <Switch
                checked={requirePacking}
                onCheckedChange={setRequirePacking}
                disabled={mutation.isPending || !isElevated}
                aria-label="Require packing step"
              />
            </label>
            <div
              className={`rounded-md p-3 text-xs border ${
                requirePacking
                  ? 'bg-amber-50 border-amber-200 text-amber-800'
                  : 'bg-emerald-50 border-emerald-200 text-emerald-800'
              }`}
            >
              {requirePacking ? (
                <>
                  <strong>Two-step fulfillment:</strong> Confirmed → Processing → Packed →
                  Dispatched.
                </>
              ) : (
                <>
                  <strong>One-step fulfillment:</strong> Confirmed → Dispatched (packed timestamp
                  auto-filled).
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Defaults */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Truck className="h-4 w-4 text-muted-foreground" /> Default Courier &amp; Dispatch Location
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="default-courier">Default courier</Label>
                <Input
                  id="default-courier"
                  placeholder="e.g. TCS, Leopards"
                  value={defaultCourier}
                  onChange={(e) => setDefaultCourier(e.target.value)}
                  disabled={mutation.isPending || !isElevated}
                />
                <p className="text-xs text-muted-foreground">
                  Pre-filled on new manual orders.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="default-location">
                  <span className="flex items-center gap-1">
                    <MapPin className="h-3 w-3" /> Default dispatch location
                  </span>
                </Label>
                {locationsQuery.isLoading ? (
                  <Skeleton className="h-9" />
                ) : (
                  <Select
                    value={defaultLocationId || '__none__'}
                    onValueChange={(v) => setDefaultLocationId(v === '__none__' ? '' : v)}
                    disabled={mutation.isPending || !isElevated}
                  >
                    <SelectTrigger id="default-location">
                      <SelectValue placeholder="No default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No default</SelectItem>
                      {locations.map((l) => (
                        <SelectItem key={l.id} value={l.id}>
                          {l.name} ({l.city})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <p className="text-xs text-muted-foreground">
                  Where stock is reserved from when no override is given.
                </p>
              </div>
            </div>

            {locations.length === 0 && !locationsQuery.isLoading && (
              <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
                No active inventory locations found. Create one in the Inventory module before
                setting a default dispatch location.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Save bar */}
      <div className="flex items-center justify-end gap-2 sticky bottom-0 bg-background/80 backdrop-blur border-t pt-4 -mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <p className="text-xs text-muted-foreground mr-auto">
          Last updated {settingsQuery.data?.settings.updatedAt
            ? new Date(settingsQuery.data.settings.updatedAt).toLocaleString('en-PK')
            : '—'}
        </p>
        <Button
          variant="outline"
          onClick={() => {
            setHydrated(false)
            void settingsQuery.refetch()
          }}
          disabled={mutation.isPending || !isElevated}
        >
          Reset
        </Button>
        <Button
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || !isElevated}
        >
          {mutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Saving…
            </>
          ) : (
            <>
              <Save className="h-4 w-4" /> Save settings
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
