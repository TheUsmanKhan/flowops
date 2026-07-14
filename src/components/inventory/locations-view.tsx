'use client'

import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { toast } from 'sonner'
import { api, FetchError } from '@/lib/api-client'
import { useAppStore, useCan } from '@/stores/app-store'
import { PERMISSIONS } from '@/lib/permissions'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Warehouse,
  Building2,
  Store,
  Truck,
  AlertOctagon,
  Plus,
  Pencil,
  Star,
  MapPin,
  Eye,
  PowerOff,
  Loader2,
  Package,
  RefreshCw,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type LocationType = 'warehouse' | 'dispatch_hub' | 'retail_store' | 'transit' | 'damaged_hold'

interface InventoryLocation {
  id: string
  name: string
  locationType: LocationType
  city: string
  province: string
  countryCode: string
  isOrgLevel: boolean
  isDefault: boolean
  contactPerson: string | null
  contactPhone: string | null
}

interface LocationsResponse {
  locations: InventoryLocation[]
}

interface DashboardResponse {
  stockTable: Array<{ locationId: string; stockValue: number }>
}

// ─────────────────────────────────────────────────────────────────────────────
// Display maps
// ─────────────────────────────────────────────────────────────────────────────

const LOCATION_TYPE_META: Record<LocationType, { label: string; icon: typeof Warehouse }> = {
  warehouse: { label: 'Warehouse', icon: Warehouse },
  dispatch_hub: { label: 'Dispatch hub', icon: Truck },
  retail_store: { label: 'Retail store', icon: Store },
  transit: { label: 'Transit', icon: Truck },
  damaged_hold: { label: 'Damaged hold', icon: AlertOctagon },
}

const LOCATION_TYPE_OPTIONS: { value: LocationType; label: string }[] = [
  { value: 'warehouse', label: 'Warehouse' },
  { value: 'dispatch_hub', label: 'Dispatch hub' },
  { value: 'retail_store', label: 'Retail store' },
  { value: 'transit', label: 'Transit' },
  { value: 'damaged_hold', label: 'Damaged hold' },
]

const PKR = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 })

function formatPKR(n: number): string {
  return `Rs. ${PKR.format(n)}`
}

function getErrorMessage(err: unknown): string {
  if (err instanceof FetchError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong. Please try again.'
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod schema — matches the POST /api/inventory-locations body contract
// ─────────────────────────────────────────────────────────────────────────────

const locationFormSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100, 'Name is too long'),
  locationType: z.enum([
    'warehouse',
    'dispatch_hub',
    'retail_store',
    'transit',
    'damaged_hold',
  ]),
  city: z.string().min(1, 'City is required').max(80, 'City is too long'),
  province: z.string().min(1, 'Province is required').max(80, 'Province is too long'),
  isDefault: z.boolean(),
  isOrgLevel: z.boolean(),
})
type LocationFormValues = z.infer<typeof locationFormSchema>

const DEFAULT_FORM_VALUES: LocationFormValues = {
  name: '',
  locationType: 'warehouse',
  city: 'Lahore',
  province: 'Punjab',
  isDefault: false,
  isOrgLevel: false,
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function LocationsView() {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const queryClient = useQueryClient()

  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<InventoryLocation | null>(null)
  const [deactivateTarget, setDeactivateTarget] = useState<InventoryLocation | null>(null)
  const [deactivateError, setDeactivateError] = useState<string | null>(null)

  const canManage = can(PERMISSIONS.INVENTORY_MANAGE_LOCATIONS)

  const locationsQuery = useQuery<LocationsResponse>({
    queryKey: ['locations'],
    queryFn: () => api.get<LocationsResponse>('/api/inventory-locations'),
    staleTime: 30_000,
  })

  // Lightweight dashboard query to compute per-location stock value & variant count.
  const stockQuery = useQuery<DashboardResponse>({
    queryKey: ['inventory-dashboard'],
    queryFn: () => api.get<DashboardResponse>('/api/inventory/dashboard'),
    staleTime: 30_000,
  })

  // Aggregate stock value + variant count by locationId.
  const stockByLocation = useMemo(() => {
    const map = new Map<string, { value: number; variantCount: number }>()
    for (const row of stockQuery.data?.stockTable ?? []) {
      const cur = map.get(row.locationId) ?? { value: 0, variantCount: 0 }
      cur.value += row.stockValue
      cur.variantCount += 1
      map.set(row.locationId, cur)
    }
    return map
  }, [stockQuery.data?.stockTable])

  const locations = locationsQuery.data?.locations ?? []

  // ── Mutations ────────────────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: async (payload: LocationFormValues) =>
      api.post('/api/inventory-locations', payload),
    onSuccess: () => {
      toast.success('Location created.')
      void queryClient.invalidateQueries({ queryKey: ['locations'] })
      void queryClient.invalidateQueries({ queryKey: ['inventory-dashboard'] })
      setCreateOpen(false)
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const editMutation = useMutation({
    mutationFn: async ({ id, payload }: { id: string; payload: Partial<LocationFormValues> }) =>
      api.patch(`/api/inventory-locations/${id}`, payload),
    onSuccess: () => {
      toast.success('Location updated.')
      void queryClient.invalidateQueries({ queryKey: ['locations'] })
      void queryClient.invalidateQueries({ queryKey: ['inventory-dashboard'] })
      setEditTarget(null)
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const setDefaultMutation = useMutation({
    mutationFn: async (id: string) => api.patch(`/api/inventory-locations/${id}`, { isDefault: true }),
    onSuccess: () => {
      toast.success('Default location set.')
      void queryClient.invalidateQueries({ queryKey: ['locations'] })
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const deactivateMutation = useMutation({
    mutationFn: async (id: string) => api.delete(`/api/inventory-locations/${id}`),
    onSuccess: () => {
      toast.success('Location deactivated.')
      void queryClient.invalidateQueries({ queryKey: ['locations'] })
      void queryClient.invalidateQueries({ queryKey: ['inventory-dashboard'] })
      setDeactivateTarget(null)
      setDeactivateError(null)
    },
    onError: (err) => {
      // 409 = stock still present — show inline in the dialog.
      const msg = getErrorMessage(err)
      setDeactivateError(msg)
      toast.error(msg)
    },
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory Locations"
        description="Warehouses, dispatch hubs and retail outlets where stock is held."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void locationsQuery.refetch()
                void stockQuery.refetch()
              }}
              disabled={locationsQuery.isFetching}
            >
              <RefreshCw
                className={locationsQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}
              />
              Refresh
            </Button>
            {canManage && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" /> Add Location
              </Button>
            )}
          </div>
        }
      />

      {locationsQuery.isLoading ? (
        <LocationsGridSkeleton />
      ) : locationsQuery.isError ? (
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">
              Couldn&apos;t load locations. Please try again.
            </p>
            <Button variant="outline" onClick={() => locationsQuery.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : locations.length === 0 ? (
        <EmptyState onCreate={() => setCreateOpen(true)} canManage={canManage} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {locations.map((loc) => {
            const meta = LOCATION_TYPE_META[loc.locationType] ?? LOCATION_TYPE_META.warehouse
            const Icon = meta.icon
            const stock = stockByLocation.get(loc.id)
            return (
              <Card key={loc.id} className="overflow-hidden">
                <CardContent className="p-5 space-y-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-medium text-sm leading-tight truncate">{loc.name}</h3>
                          {loc.isDefault && (
                            <Badge className="bg-amber-100 text-amber-700 border-transparent text-[10px] gap-1">
                              <Star className="h-3 w-3" /> Default
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          <MapPin className="h-3 w-3" />
                          {loc.city}, {loc.province}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="secondary" className="text-[10px]">
                      {meta.label}
                    </Badge>
                    <Badge variant="outline" className="text-[10px]">
                      {loc.isOrgLevel ? (
                        <span className="flex items-center gap-1">
                          <Building2 className="h-3 w-3" /> Org-level
                        </span>
                      ) : (
                        <span className="flex items-center gap-1">
                          <Store className="h-3 w-3" /> Company
                        </span>
                      )}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-2 gap-3 pt-1 border-t">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        Stock value
                      </p>
                      <p className="text-sm font-semibold tabular-nums">
                        {stock ? formatPKR(stock.value) : '—'}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        Variants
                      </p>
                      <p className="text-sm font-semibold tabular-nums flex items-center gap-1">
                        <Package className="h-3.5 w-3.5 text-muted-foreground" />
                        {stock?.variantCount ?? 0}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => navigate({ name: 'inventory-location-detail', id: loc.id })}
                    >
                      <Eye className="h-3.5 w-3.5" /> View Stock
                    </Button>
                    {canManage && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditTarget(loc)}
                          aria-label={`Edit ${loc.name}`}
                        >
                          <Pencil className="h-3.5 w-3.5" /> Edit
                        </Button>
                        {!loc.isDefault && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDefaultMutation.mutate(loc.id)}
                            disabled={setDefaultMutation.isPending}
                            aria-label={`Set ${loc.name} as default`}
                          >
                            <Star className="h-3.5 w-3.5" /> Set Default
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                          onClick={() => {
                            setDeactivateError(null)
                            setDeactivateTarget(loc)
                          }}
                          aria-label={`Deactivate ${loc.name}`}
                        >
                          <PowerOff className="h-3.5 w-3.5" /> Deactivate
                        </Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* ── Create dialog ──────────────────────────────────────────────────── */}
      <LocationFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Add location"
        description="Warehouses and dispatch hubs where you receive and ship stock."
        submitLabel="Create location"
        loading={createMutation.isPending}
        onSubmit={(values) => createMutation.mutate(values)}
      />

      {/* ── Edit dialog ────────────────────────────────────────────────────── */}
      {editTarget && (
        <LocationFormDialog
          open={!!editTarget}
          onOpenChange={(open) => {
            if (!open) setEditTarget(null)
          }}
          title={`Edit ${editTarget.name}`}
          description="Update the location details."
          submitLabel="Save changes"
          loading={editMutation.isPending}
          defaultValues={{
            name: editTarget.name,
            locationType: editTarget.locationType,
            city: editTarget.city,
            province: editTarget.province,
            isDefault: editTarget.isDefault,
            isOrgLevel: editTarget.isOrgLevel,
          }}
          onSubmit={(values) =>
            editMutation.mutate({ id: editTarget.id, payload: values })
          }
        />
      )}

      {/* ── Deactivate dialog ──────────────────────────────────────────────── */}
      <AlertDialog
        open={!!deactivateTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeactivateTarget(null)
            setDeactivateError(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate location?</AlertDialogTitle>
            <AlertDialogDescription>
              This will hide <strong>{deactivateTarget?.name}</strong> from active lists. Existing
              transactions and audit logs are preserved. The location can be re-activated later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deactivateError && (
            <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              {deactivateError}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700"
              disabled={deactivateMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (deactivateTarget) deactivateMutation.mutate(deactivateTarget.id)
              }}
            >
              {deactivateMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Deactivating…
                </>
              ) : (
                'Deactivate'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Form dialog (used for both create & edit)
// ─────────────────────────────────────────────────────────────────────────────

function LocationFormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  loading,
  defaultValues,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  submitLabel: string
  loading: boolean
  defaultValues?: LocationFormValues
  onSubmit: (values: LocationFormValues) => void
}) {
  const form = useForm<LocationFormValues>({
    resolver: zodResolver(locationFormSchema),
    defaultValues: defaultValues ?? DEFAULT_FORM_VALUES,
    values: defaultValues,
  })

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors },
  } = form

  // Reset form when dialog opens (so we don't show stale values from a previous session).
  useEffect(() => {
    if (open) reset(defaultValues ?? DEFAULT_FORM_VALUES)
  }, [open])

  const locationType = watch('locationType')
  const isDefault = watch('isDefault')
  const isOrgLevel = watch('isOrgLevel')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="loc-name">Name</Label>
            <Input
              id="loc-name"
              placeholder="e.g. Main Warehouse — Lahore"
              {...register('name')}
              autoFocus
            />
            {errors.name && <p className="text-xs text-rose-600">{errors.name.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="loc-type">Location type</Label>
            <Select
              value={locationType}
              onValueChange={(v) => setValue('locationType', v as LocationFormValues['locationType'])}
            >
              <SelectTrigger id="loc-type">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                {LOCATION_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.locationType && (
              <p className="text-xs text-rose-600">{errors.locationType.message}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="loc-city">City</Label>
              <Input id="loc-city" placeholder="Lahore" {...register('city')} />
              {errors.city && <p className="text-xs text-rose-600">{errors.city.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="loc-province">Province</Label>
              <Input id="loc-province" placeholder="Punjab" {...register('province')} />
              {errors.province && (
                <p className="text-xs text-rose-600">{errors.province.message}</p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-3 pt-2 border-t">
            <label className="flex items-start justify-between gap-3 cursor-pointer">
              <div>
                <span className="text-sm font-medium flex items-center gap-1.5">
                  <Building2 className="h-4 w-4 text-muted-foreground" /> Org-level
                </span>
                <p className="text-xs text-muted-foreground">
                  Shared across all companies in this organization. Otherwise it&apos;s private to
                  your current company.
                </p>
              </div>
              <Switch
                checked={isOrgLevel}
                onCheckedChange={(v) => setValue('isOrgLevel', v)}
                aria-label="Org-level location"
              />
            </label>
            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <div>
                <span className="text-sm font-medium flex items-center gap-1.5">
                  <Star className="h-4 w-4 text-amber-500" /> Default location
                </span>
                <p className="text-xs text-muted-foreground">
                  Used as the preselected destination for new stock.
                </p>
              </div>
              <Switch
                checked={isDefault}
                onCheckedChange={(v) => setValue('isDefault', v)}
                aria-label="Default location"
              />
            </label>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                </>
              ) : (
                submitLabel
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Skeletons & empty state
// ─────────────────────────────────────────────────────────────────────────────

function LocationsGridSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="p-5 space-y-4">
            <div className="flex items-start gap-3">
              <Skeleton className="h-10 w-10 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
            <div className="flex gap-2">
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <div className="grid grid-cols-2 gap-3 pt-2 border-t">
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
            </div>
            <Skeleton className="h-8 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function EmptyState({ onCreate, canManage }: { onCreate: () => void; canManage: boolean }) {
  return (
    <Card>
      <CardContent className="p-10 sm:p-14 text-center">
        <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <Warehouse className="h-7 w-7 text-primary" />
        </div>
        <h3 className="text-lg font-semibold">No locations yet</h3>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
          Add a warehouse, dispatch hub, or retail store to start receiving and tracking stock.
        </p>
        {canManage && (
          <Button className="mt-5" onClick={onCreate}>
            <Plus className="h-4 w-4" /> Create your first location
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
