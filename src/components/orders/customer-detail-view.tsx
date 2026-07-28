'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, initials } from '@/lib/api-client'
import { useAppStore, useCan } from '@/stores/app-store'
import { PERMISSIONS } from '@/lib/permissions'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Checkbox } from '@/components/ui/checkbox'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  ArrowLeft,
  Phone,
  Mail,
  MapPin,
  Flag,
  ShieldCheck,
  Loader2,
  ShoppingCart,
  Wallet,
  RotateCcw,
  RefreshCw,
  Plus,
  Trash2,
  Star,
  Pencil,
  Check,
  X,
  ExternalLink,
  Link2,
  Clock,
  TrendingUp,
  Truck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatPKR, formatDate, getErrorMessage, badgeForStatus } from './_shared'
import {
  formatLastUsed,
  PLATFORM_LABELS,
  type CustomerDetail,
  type PhoneDTO,
  type AddressDTO,
  type RecentOrderDTO,
  type ExternalIdentityDTO,
} from '@/components/customers/types'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const LAST_PHONE_TOOLTIP = 'A customer must always have at least one phone'
const LAST_ADDRESS_TOOLTIP = 'A customer must always have at least one address'

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function CustomerDetailView({ customerId }: { customerId: string }) {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const queryClient = useQueryClient()
  const canManage = can(PERMISSIONS.ORDERS_MANAGE)
  const [flagOpen, setFlagOpen] = useState(false)

  // Inline name editing state
  const [editingName, setEditingName] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const query = useQuery<CustomerDetail>({
    queryKey: ['customer-detail', customerId],
    queryFn: () => api.get<CustomerDetail>(`/api/customers/${customerId}`),
    staleTime: 15_000,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['customer-detail', customerId] })
    void queryClient.invalidateQueries({ queryKey: ['customers'] })
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  const updateNameMutation = useMutation({
    mutationFn: async (name: string) =>
      api.patch<{ customerId: string }>(`/api/customers/${customerId}`, { name }),
    onSuccess: () => {
      toast.success('Customer name updated.')
      setEditingName(null)
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const flagMutation = useMutation({
    mutationFn: async ({
      action,
      reason,
    }: {
      action: 'flag' | 'unflag'
      reason?: string
    }) => api.post('/api/customers', { customer_id: customerId, action, reason }),
    onSuccess: (_v, vars) => {
      toast.success(vars.action === 'flag' ? 'Customer flagged.' : 'Customer unflagged.')
      setFlagOpen(false)
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const addPhoneMutation = useMutation({
    mutationFn: async (input: { phone: string; label?: string; is_primary: boolean }) =>
      api.post<{ phoneId: string }>(`/api/customers/${customerId}/phones`, input),
    onSuccess: () => {
      toast.success('Phone number added.')
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const removePhoneMutation = useMutation({
    mutationFn: async (phoneId: string) =>
      api.delete<{ ok: true }>(`/api/customers/${customerId}/phones/${phoneId}`),
    onSuccess: () => {
      toast.success('Phone number removed.')
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  // Set as Primary = DELETE the phone, then POST it back with is_primary:true.
  // The backend addCustomerPhone(is_primary:true) unsets the existing primary.
  const setPrimaryPhoneMutation = useMutation({
    mutationFn: async (phone: PhoneDTO) => {
      await api.delete(`/api/customers/${customerId}/phones/${phone.id}`)
      return api.post<{ phoneId: string }>(`/api/customers/${customerId}/phones`, {
        phone: phone.phoneRaw,
        label: phone.label ?? undefined,
        is_primary: true,
      })
    },
    onSuccess: () => {
      toast.success('Primary phone updated.')
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const addAddressMutation = useMutation({
    mutationFn: async (input: {
      label?: string
      address: string
      city: string
      is_default: boolean
    }) => api.post<{ addressId: string }>(`/api/customers/${customerId}/addresses`, input),
    onSuccess: () => {
      toast.success('Address added.')
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const updateAddressMutation = useMutation({
    mutationFn: async ({
      addressId,
      input,
    }: {
      addressId: string
      input: { label?: string; address: string; city: string; is_default: boolean }
    }) =>
      api.patch<{ addressId: string }>(
        `/api/customers/${customerId}/addresses/${addressId}`,
        input,
      ),
    onSuccess: () => {
      toast.success('Address updated.')
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const removeAddressMutation = useMutation({
    mutationFn: async (addressId: string) =>
      api.delete<{ ok: true }>(`/api/customers/${customerId}/addresses/${addressId}`),
    onSuccess: () => {
      toast.success('Address removed.')
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  // Set as Default = PATCH with is_default:true (backend unsets others).
  const setDefaultAddressMutation = useMutation({
    mutationFn: async (addressId: string) =>
      api.patch<{ addressId: string }>(
        `/api/customers/${customerId}/addresses/${addressId}`,
        { is_default: true },
      ),
    onSuccess: () => {
      toast.success('Default address updated.')
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  // ── Derived state ────────────────────────────────────────────────────────

  const customer = query.data

  const rtoRate = useMemo(() => {
    if (!customer || customer.totalOrdersCount === 0) return 0
    return Math.round((customer.totalRtoCount / customer.totalOrdersCount) * 100)
  }, [customer])

  const deliveryRate = useMemo(() => {
    if (!customer || customer.totalOrdersCount === 0) return 0
    return Math.round(
      ((customer.totalOrdersCount - customer.totalRtoCount) / customer.totalOrdersCount) * 100,
    )
  }, [customer])

  // Focus the inline name input when entering edit mode
  useEffect(() => {
    if (editingName !== null && nameInputRef.current) {
      nameInputRef.current.focus()
      nameInputRef.current.select()
    }
  }, [editingName])

  // ── Loading / error states ───────────────────────────────────────────────

  if (query.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Customer" description="Loading customer profile…" />
        <Card>
          <CardContent className="p-5 space-y-3">
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-24" />
            <Skeleton className="h-48" />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (query.isError || !customer) {
    return (
      <div className="space-y-6">
        <PageHeader title="Customer" />
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">
              {query.isError ? getErrorMessage(query.error) : 'Customer not found.'}
            </p>
            <div className="flex items-center justify-center gap-2">
              <Button variant="outline" onClick={() => query.refetch()}>
                <RefreshCw className="h-4 w-4" /> Try again
              </Button>
              <Button variant="ghost" onClick={() => navigate({ name: 'customers' })}>
                <ArrowLeft className="h-4 w-4" /> Back to customers
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Inline name handlers ─────────────────────────────────────────────────

  const commitName = () => {
    const trimmed = (editingName ?? '').trim()
    if (!trimmed) {
      toast.error('Name cannot be empty.')
      return
    }
    if (trimmed === customer.name) {
      setEditingName(null)
      return
    }
    updateNameMutation.mutate(trimmed)
  }

  const cancelName = () => setEditingName(null)

  return (
    <div className="space-y-6">
      <PageHeader
        title={customer.name}
        description={`Customer since ${formatDate(customer.createdAt)}`}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
              aria-label="Refresh"
            >
              <RefreshCw className={query.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate({ name: 'customers' })}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
          </div>
        }
      />

      {/* Profile header + stats row */}
      <Card>
        <CardContent className="p-5 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="flex items-center gap-3">
              <Avatar className="h-12 w-12">
                <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                  {initials(customer.name)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                {editingName === null ? (
                  <button
                    type="button"
                    onClick={() => canManage && setEditingName(customer.name)}
                    className={cn(
                      'group flex items-center gap-1.5 text-left',
                      canManage && 'cursor-text',
                    )}
                    title={canManage ? 'Click to edit name' : undefined}
                  >
                    <span className="text-lg font-semibold truncate">{customer.name}</span>
                    {canManage && (
                      <Pencil className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                    )}
                  </button>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <Input
                      ref={nameInputRef}
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          commitName()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          cancelName()
                        }
                      }}
                      onBlur={cancelName}
                      className="h-8 text-base font-semibold max-w-xs"
                      disabled={updateNameMutation.isPending}
                    />
                    {updateNameMutation.isPending && (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    )}
                  </div>
                )}
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  {customer.isFlagged ? (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>
                            <Badge
                              variant="outline"
                              className="bg-rose-50 text-rose-700 border-rose-200 cursor-help"
                            >
                              <Flag className="h-3 w-3 mr-1" /> Flagged
                            </Badge>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          {customer.flaggedReason ?? 'No reason provided.'}
                          {customer.flaggedAt && (
                            <span className="block text-[10px] opacity-80 mt-1">
                              Since {formatDate(customer.flaggedAt)}
                            </span>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    <Badge
                      variant="outline"
                      className="bg-emerald-50 text-emerald-700 border-emerald-200"
                    >
                      <ShieldCheck className="h-3 w-3 mr-1" /> Active
                    </Badge>
                  )}
                  {customer.totalRtoCount >= 3 && (
                    <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                      High RTO risk
                    </Badge>
                  )}
                  {customer.email && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Mail className="h-3 w-3" />
                      {customer.email}
                    </span>
                  )}
                </div>
              </div>
            </div>
            {canManage &&
              (customer.isFlagged ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                  onClick={() => flagMutation.mutate({ action: 'unflag' })}
                  disabled={flagMutation.isPending}
                >
                  <ShieldCheck className="h-3.5 w-3.5" /> Unflag
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                  onClick={() => setFlagOpen(true)}
                >
                  <Flag className="h-3.5 w-3.5" /> Flag
                </Button>
              ))}
          </div>

          {customer.isFlagged && customer.flaggedReason && (
            <div className="rounded-md bg-rose-50 border border-rose-200 p-3 text-sm">
              <p className="font-medium text-rose-800 mb-0.5">Flag reason</p>
              <p className="text-rose-700">{customer.flaggedReason}</p>
            </div>
          )}

          {/* Stats row */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <StatCard
              label="Total Orders"
              value={String(customer.totalOrdersCount)}
              icon={<ShoppingCart className="h-4 w-4" />}
            />
            <StatCard
              label="Total Value"
              value={formatPKR(customer.totalOrderValue)}
              icon={<Wallet className="h-4 w-4" />}
            />
            <StatCard
              label="RTO Count"
              value={String(customer.totalRtoCount)}
              icon={<RotateCcw className="h-4 w-4" />}
              tone={customer.totalRtoCount > 0 ? 'rose' : 'default'}
            />
            <StatCard
              label="RTO Rate"
              value={`${rtoRate}%`}
              icon={<TrendingUp className="h-4 w-4" />}
              tone={rtoRate >= 30 ? 'rose' : rtoRate > 0 ? 'amber' : 'emerald'}
            />
            <StatCard
              label="Delivery Rate"
              value={`${deliveryRate}%`}
              icon={<Truck className="h-4 w-4" />}
              tone={deliveryRate >= 80 ? 'emerald' : deliveryRate >= 50 ? 'amber' : 'rose'}
            />
          </div>
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs defaultValue="phones" className="space-y-4">
        <TabsList className="w-full sm:w-auto overflow-x-auto">
          <TabsTrigger value="phones" className="gap-1.5">
            <Phone className="h-3.5 w-3.5" />
            Phones
            <span className="ml-1 text-xs text-muted-foreground">({customer.phones.length})</span>
          </TabsTrigger>
          <TabsTrigger value="addresses" className="gap-1.5">
            <MapPin className="h-3.5 w-3.5" />
            Addresses
            <span className="ml-1 text-xs text-muted-foreground">({customer.addresses.length})</span>
          </TabsTrigger>
          <TabsTrigger value="platforms" className="gap-1.5">
            <Link2 className="h-3.5 w-3.5" />
            Platforms
            <span className="ml-1 text-xs text-muted-foreground">
              ({customer.externalIdentities.length})
            </span>
          </TabsTrigger>
          <TabsTrigger value="orders" className="gap-1.5">
            <ShoppingCart className="h-3.5 w-3.5" />
            Orders
            <span className="ml-1 text-xs text-muted-foreground">({customer.recentOrders.length})</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="phones">
          <PhoneNumbersTab
            phones={customer.phones}
            canManage={canManage}
            onAdd={(input) => addPhoneMutation.mutate(input)}
            onRemove={(id) => removePhoneMutation.mutate(id)}
            onSetPrimary={(phone) => setPrimaryPhoneMutation.mutate(phone)}
            adding={addPhoneMutation.isPending}
            removing={removePhoneMutation.isPending}
            settingPrimary={setPrimaryPhoneMutation.isPending}
          />
        </TabsContent>

        <TabsContent value="addresses">
          <AddressesTab
            addresses={customer.addresses}
            canManage={canManage}
            onAdd={(input) => addAddressMutation.mutate(input)}
            onUpdate={(addressId, input) =>
              updateAddressMutation.mutate({ addressId, input })
            }
            onRemove={(id) => removeAddressMutation.mutate(id)}
            onSetDefault={(id) => setDefaultAddressMutation.mutate(id)}
            adding={addAddressMutation.isPending}
            updating={updateAddressMutation.isPending}
            removing={removeAddressMutation.isPending}
            settingDefault={setDefaultAddressMutation.isPending}
          />
        </TabsContent>

        <TabsContent value="platforms">
          <LinkedPlatformsTab identities={customer.externalIdentities} />
        </TabsContent>

        <TabsContent value="orders">
          <OrderHistoryTab orders={customer.recentOrders} />
        </TabsContent>
      </Tabs>

      {/* Flag dialog */}
      {flagOpen && (
        <FlagDialog
          customerName={customer.name}
          open={flagOpen}
          onOpenChange={setFlagOpen}
          loading={flagMutation.isPending}
          onConfirm={(reason) => flagMutation.mutate({ action: 'flag', reason })}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Stat card
// ─────────────────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon,
  tone = 'default',
}: {
  label: string
  value: string
  icon: ReactNode
  tone?: 'default' | 'emerald' | 'rose' | 'amber'
}) {
  const valueClass =
    tone === 'emerald'
      ? 'text-emerald-700'
      : tone === 'rose'
        ? 'text-rose-700'
        : tone === 'amber'
          ? 'text-amber-700'
          : ''
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <span className="text-muted-foreground">{icon}</span>
      </div>
      <p className={cn('text-lg font-semibold tabular-nums mt-1', valueClass)}>{value}</p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Phones tab
// ─────────────────────────────────────────────────────────────────────────────

interface PhoneTabProps {
  phones: PhoneDTO[]
  canManage: boolean
  onAdd: (input: { phone: string; label?: string; is_primary: boolean }) => void
  onRemove: (phoneId: string) => void
  onSetPrimary: (phone: PhoneDTO) => void
  adding: boolean
  removing: boolean
  settingPrimary: boolean
}

function PhoneNumbersTab({
  phones,
  canManage,
  onAdd,
  onRemove,
  onSetPrimary,
  adding,
  removing,
  settingPrimary,
}: PhoneTabProps) {
  const [showAdd, setShowAdd] = useState(false)
  const [newPhone, setNewPhone] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newIsPrimary, setNewIsPrimary] = useState(false)
  const isLastPhone = phones.length <= 1
  const busy = adding || removing || settingPrimary

  const resetForm = () => {
    setNewPhone('')
    setNewLabel('')
    setNewIsPrimary(false)
    setShowAdd(false)
  }

  const handleSubmit = () => {
    const trimmed = newPhone.trim()
    if (!trimmed) {
      toast.error('Phone number is required.')
      return
    }
    onAdd({
      phone: trimmed,
      label: newLabel.trim() || undefined,
      is_primary: newIsPrimary,
    })
    resetForm()
  }

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Phone Numbers</h3>
            <p className="text-xs text-muted-foreground">
              All phone numbers on file for this customer. The primary number is used by default on new orders.
            </p>
          </div>
          {canManage && !showAdd && (
            <Button variant="outline" size="sm" onClick={() => setShowAdd(true)}>
              <Plus className="h-3.5 w-3.5" /> Add Phone
            </Button>
          )}
        </div>

        {/* Inline add form */}
        {showAdd && (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-3">
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Phone *</Label>
                <Input
                  placeholder="0300-1234567"
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleSubmit()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      resetForm()
                    }
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Label (optional)</Label>
                <Input
                  placeholder="Personal, Office…"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleSubmit()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      resetForm()
                    }
                  }}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={newIsPrimary}
                onCheckedChange={(v) => setNewIsPrimary(v === true)}
              />
              <span className="text-xs text-muted-foreground">
                Set as primary phone (will unset the current primary)
              </span>
            </label>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
              <Button variant="outline" size="sm" onClick={resetForm}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSubmit} disabled={adding}>
                {adding ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Adding…
                  </>
                ) : (
                  <>
                    <Check className="h-3.5 w-3.5" /> Add Phone
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Phone list */}
        <div className="space-y-2">
          {phones.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No phone numbers on file.
            </p>
          ) : (
            phones.map((p) => (
              <div
                key={p.id}
                className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-md border p-3 bg-muted/20"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
                    <p className="text-sm font-medium tabular-nums">{p.phoneRaw}</p>
                    {p.isPrimary && (
                      <Badge
                        variant="outline"
                        className="bg-primary/10 text-primary border-primary/20 text-[10px]"
                      >
                        <Star className="h-2.5 w-2.5 mr-0.5 fill-current" /> Primary
                      </Badge>
                    )}
                    {p.label && (
                      <Badge variant="outline" className="text-[10px]">
                        {p.label}
                      </Badge>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Added {formatDate(p.createdAt)}
                  </p>
                </div>
                {canManage && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    {!p.isPrimary && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => onSetPrimary(p)}
                        disabled={busy}
                      >
                        <Star className="h-3 w-3" /> Set as Primary
                      </Button>
                    )}
                    {isLastPhone ? (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                                disabled
                                aria-label="Cannot remove last phone"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>{LAST_PHONE_TOOLTIP}</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => onRemove(p.id)}
                        disabled={busy}
                        aria-label={`Remove phone ${p.phoneRaw}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Addresses tab
// ─────────────────────────────────────────────────────────────────────────────

interface AddressTabProps {
  addresses: AddressDTO[]
  canManage: boolean
  onAdd: (input: { label?: string; address: string; city: string; is_default: boolean }) => void
  onUpdate: (
    addressId: string,
    input: { label?: string; address: string; city: string; is_default: boolean },
  ) => void
  onRemove: (addressId: string) => void
  onSetDefault: (addressId: string) => void
  adding: boolean
  updating: boolean
  removing: boolean
  settingDefault: boolean
}

function AddressesTab({
  addresses,
  canManage,
  onAdd,
  onUpdate,
  onRemove,
  onSetDefault,
  adding,
  updating,
  removing,
  settingDefault,
}: AddressTabProps) {
  const [showAdd, setShowAdd] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newAddress, setNewAddress] = useState('')
  const [newCity, setNewCity] = useState('')
  const [newIsDefault, setNewIsDefault] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const isLastAddress = addresses.length <= 1
  const busy = adding || updating || removing || settingDefault

  const resetAddForm = () => {
    setNewLabel('')
    setNewAddress('')
    setNewCity('')
    setNewIsDefault(false)
    setShowAdd(false)
  }

  const handleAddSubmit = () => {
    const addr = newAddress.trim()
    const city = newCity.trim()
    if (!addr) {
      toast.error('Address is required.')
      return
    }
    if (!city) {
      toast.error('City is required.')
      return
    }
    onAdd({
      label: newLabel.trim() || undefined,
      address: addr,
      city,
      is_default: newIsDefault,
    })
    resetAddForm()
  }

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Addresses</h3>
            <p className="text-xs text-muted-foreground">
              All delivery addresses on file. The default address is pre-selected on new orders.
            </p>
          </div>
          {canManage && !showAdd && editingId === null && (
            <Button variant="outline" size="sm" onClick={() => setShowAdd(true)}>
              <Plus className="h-3.5 w-3.5" /> Add Address
            </Button>
          )}
        </div>

        {/* Inline add form */}
        {showAdd && (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-3">
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1 sm:col-span-2">
                <Label className="text-xs">Address *</Label>
                <Textarea
                  placeholder="House #, street, area"
                  value={newAddress}
                  onChange={(e) => setNewAddress(e.target.value)}
                  rows={2}
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">City *</Label>
                <Input
                  placeholder="e.g. Lahore"
                  value={newCity}
                  onChange={(e) => setNewCity(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Label (optional)</Label>
                <Input
                  placeholder="Home, Office…"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={newIsDefault}
                onCheckedChange={(v) => setNewIsDefault(v === true)}
              />
              <span className="text-xs text-muted-foreground">
                Set as default address (will unset the current default)
              </span>
            </label>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
              <Button variant="outline" size="sm" onClick={resetAddForm}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleAddSubmit} disabled={adding}>
                {adding ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Adding…
                  </>
                ) : (
                  <>
                    <Check className="h-3.5 w-3.5" /> Add Address
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Address cards */}
        <div className="grid sm:grid-cols-2 gap-3">
          {addresses.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6 sm:col-span-2">
              No addresses on file.
            </p>
          ) : (
            addresses.map((a) =>
              editingId === a.id ? (
                <AddressCardEdit
                  key={a.id}
                  address={a}
                  onCancel={() => setEditingId(null)}
                  onSave={(input) => {
                    onUpdate(a.id, input)
                    setEditingId(null)
                  }}
                />
              ) : (
                <AddressCardView
                  key={a.id}
                  address={a}
                  canManage={canManage}
                  isLast={isLastAddress}
                  busy={busy}
                  onEdit={() => setEditingId(a.id)}
                  onRemove={() => onRemove(a.id)}
                  onSetDefault={() => onSetDefault(a.id)}
                />
              ),
            )
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function AddressCardView({
  address,
  canManage,
  isLast,
  busy,
  onEdit,
  onRemove,
  onSetDefault,
}: {
  address: AddressDTO
  canManage: boolean
  isLast: boolean
  busy: boolean
  onEdit: () => void
  onRemove: () => void
  onSetDefault: () => void
}) {
  return (
    <div className="rounded-md border p-3 bg-muted/20 space-y-2 h-full">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {address.label && (
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              {address.label}
            </span>
          )}
          {address.isDefault && (
            <Badge
              variant="outline"
              className="bg-primary/10 text-primary border-primary/20 text-[10px] h-4 px-1.5"
            >
              <Star className="h-2 w-2 mr-0.5 fill-current" /> Default
            </Badge>
          )}
        </div>
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <Clock className="h-2.5 w-2.5" />
          Last used: {formatLastUsed(address.lastUsedAt)}
        </span>
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium">{address.address}</p>
        <p className="text-xs text-muted-foreground">{address.city}</p>
      </div>
      {canManage && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t">
          {!address.isDefault && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={onSetDefault}
              disabled={busy}
            >
              <Star className="h-3 w-3" /> Set as Default
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={onEdit}
            disabled={busy}
          >
            <Pencil className="h-3 w-3" /> Edit
          </Button>
          {isLast ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      disabled
                      aria-label="Cannot remove last address"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{LAST_ADDRESS_TOOLTIP}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              onClick={onRemove}
              disabled={busy}
              aria-label="Remove address"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function AddressCardEdit({
  address,
  onSave,
  onCancel,
}: {
  address: AddressDTO
  onSave: (input: { label?: string; address: string; city: string; is_default: boolean }) => void
  onCancel: () => void
}) {
  const [label, setLabel] = useState(address.label ?? '')
  const [addr, setAddr] = useState(address.address)
  const [city, setCity] = useState(address.city)
  const [isDefault, setIsDefault] = useState(address.isDefault)

  const handleSave = () => {
    const trimmedAddr = addr.trim()
    const trimmedCity = city.trim()
    if (!trimmedAddr) {
      toast.error('Address is required.')
      return
    }
    if (!trimmedCity) {
      toast.error('City is required.')
      return
    }
    onSave({
      label: label.trim() || undefined,
      address: trimmedAddr,
      city: trimmedCity,
      is_default: isDefault,
    })
  }

  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
          Editing address
        </span>
        {isDefault && (
          <Badge
            variant="outline"
            className="bg-primary/10 text-primary border-primary/20 text-[10px]"
          >
            <Star className="h-2 w-2 mr-0.5 fill-current" /> Default
          </Badge>
        )}
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Address *</Label>
        <Textarea
          placeholder="House #, street, area"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          rows={2}
          autoFocus
        />
      </div>
      <div className="grid sm:grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">City *</Label>
          <Input value={city} onChange={(e) => setCity(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Label (optional)</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
      </div>
      {!address.isDefault && (
        <label className="flex items-center gap-2 cursor-pointer">
          <Checkbox
            checked={isDefault}
            onCheckedChange={(v) => setIsDefault(v === true)}
          />
          <span className="text-xs text-muted-foreground">
            Set as default (will unset the current default)
          </span>
        </label>
      )}
      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={onCancel}>
          <X className="h-3.5 w-3.5" /> Cancel
        </Button>
        <Button size="sm" onClick={handleSave}>
          <Check className="h-3.5 w-3.5" /> Save
        </Button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Linked platforms tab
// ─────────────────────────────────────────────────────────────────────────────

function LinkedPlatformsTab({ identities }: { identities: ExternalIdentityDTO[] }) {
  if (identities.length === 0) {
    return (
      <Card>
        <CardContent className="p-10 text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-3">
            <Link2 className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="text-sm font-semibold">No linked external accounts</h3>
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            No linked external accounts yet — this customer was created directly in FlowOps.
            Customers synced from Shopify, Daraz, or Instagram will appear here.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Linked Platforms</h3>
          <p className="text-xs text-muted-foreground">
            External accounts this customer has been matched to across sales channels.
          </p>
        </div>
        <div className="space-y-2">
          {identities.map((id) => {
            const meta = PLATFORM_LABELS[id.platform] ?? {
              label: id.platform.charAt(0).toUpperCase() + id.platform.slice(1),
              color: 'bg-gray-100 text-gray-700 border-gray-200',
            }
            return (
              <div
                key={id.id}
                className="flex items-center justify-between gap-3 rounded-md border p-3 bg-muted/20"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className={cn('text-[10px]', meta.color)}>
                        {meta.label}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                        matched via {id.matchedVia.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <p className="text-sm font-medium mt-0.5 truncate">
                      {meta.label} Customer #{id.externalCustomerId}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Linked on {formatDate(id.createdAt)}
                    </p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Order history tab
// ─────────────────────────────────────────────────────────────────────────────

function OrderHistoryTab({ orders }: { orders: RecentOrderDTO[] }) {
  const navigate = useAppStore((s) => s.navigate)

  if (orders.length === 0) {
    return (
      <Card>
        <CardContent className="p-10 text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-3">
            <ShoppingCart className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="text-sm font-semibold">No orders yet</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Orders created for this customer will appear here.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total Value</TableHead>
                <TableHead>Recipient</TableHead>
                <TableHead>Address Used</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((o) => {
                const badge = badgeForStatus(o.status)
                const addressUsed =
                  o.deliveryAddress || o.deliveryCity
                    ? [o.deliveryAddress, o.deliveryCity].filter(Boolean).join(', ')
                    : null
                return (
                  <TableRow key={o.id}>
                    <TableCell>
                      <button
                        type="button"
                        className="text-sm font-medium text-primary hover:underline"
                        onClick={() => navigate({ name: 'order-detail', id: o.id })}
                      >
                        {o.flowopsOrderNumber}
                      </button>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatDate(o.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`text-[10px] ${badge.className}`}>
                        {badge.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium whitespace-nowrap">
                      {formatPKR(o.totalOrderValue)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {o.recipientName ? (
                        <span className="truncate">{o.recipientName}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {addressUsed ? (
                        <span className="inline-flex items-start gap-1 max-w-xs">
                          <MapPin className="h-3 w-3 mt-0.5 shrink-0" />
                          <span className="truncate">{addressUsed}</span>
                        </span>
                      ) : (
                        <span>—</span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-muted-foreground p-3">
          Showing last {orders.length} order{orders.length === 1 ? '' : 's'}
        </p>
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Flag dialog
// ─────────────────────────────────────────────────────────────────────────────

function FlagDialog({
  customerName,
  open,
  onOpenChange,
  loading,
  onConfirm,
}: {
  customerName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  loading: boolean
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState('')

  // Reset reason when dialog closes
  useEffect(() => {
    if (!open) setReason('')
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Flag {customerName}?</DialogTitle>
          <DialogDescription>
            Flagged customers are highlighted in the customer list and on every new order they
            place. Provide a clear reason for audit purposes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="cd-flag-reason">Reason</Label>
          <Textarea
            id="cd-flag-reason"
            placeholder="e.g. High RTO rate, payment fraud, abusive behavior"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            autoFocus
          />
          <p className="text-[10px] text-muted-foreground">Minimum 3 characters.</p>
        </div>
        <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={loading || reason.trim().length < 3}
            onClick={() => onConfirm(reason.trim())}
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Flagging…
              </>
            ) : (
              <>
                <Flag className="h-4 w-4" /> Flag customer
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
