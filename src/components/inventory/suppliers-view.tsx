'use client'

import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { toast } from 'sonner'
import { api, FetchError, initials } from '@/lib/api-client'
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Avatar,
  AvatarFallback,
} from '@/components/ui/avatar'
import {
  Plus,
  Pencil,
  Truck,
  Eye,
  PowerOff,
  Search,
  Building2,
  Mail,
  Phone,
  Loader2,
  RefreshCw,
  Wallet,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types — match GET /api/suppliers
// ─────────────────────────────────────────────────────────────────────────────

type PaymentTerms = 'immediate' | 'net_15' | 'net_30' | 'net_45' | 'net_60'

interface Supplier {
  id: string
  name: string
  contactPerson: string | null
  phone: string | null
  email: string | null
  paymentTerms: PaymentTerms
  creditBalance: number
  isOrgLevel: boolean
  poCount: number
}

interface SuppliersResponse {
  suppliers: Supplier[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Display maps
// ─────────────────────────────────────────────────────────────────────────────

const PAYMENT_TERMS_LABEL: Record<PaymentTerms, string> = {
  immediate: 'Immediate',
  net_15: 'Net 15',
  net_30: 'Net 30',
  net_45: 'Net 45',
  net_60: 'Net 60',
}

const PAYMENT_TERMS_OPTIONS: { value: PaymentTerms; label: string }[] = [
  { value: 'immediate', label: 'Immediate' },
  { value: 'net_15', label: 'Net 15' },
  { value: 'net_30', label: 'Net 30' },
  { value: 'net_45', label: 'Net 45' },
  { value: 'net_60', label: 'Net 60' },
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
// Zod schema — matches POST /api/suppliers body
// ─────────────────────────────────────────────────────────────────────────────

const supplierFormSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100, 'Name is too long'),
  contactPerson: z.string().max(100).optional().or(z.literal('')),
  phone: z.string().max(40).optional().or(z.literal('')),
  email: z.string().email('Enter a valid email').optional().or(z.literal('')),
  paymentTerms: z.enum(['immediate', 'net_15', 'net_30', 'net_45', 'net_60']),
  isOrgLevel: z.boolean(),
})
type SupplierFormValues = z.infer<typeof supplierFormSchema>

const DEFAULT_FORM_VALUES: SupplierFormValues = {
  name: '',
  contactPerson: '',
  phone: '',
  email: '',
  paymentTerms: 'immediate',
  isOrgLevel: false,
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function SuppliersView() {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Supplier | null>(null)
  const [deactivateTarget, setDeactivateTarget] = useState<Supplier | null>(null)

  const canManage = can(PERMISSIONS.INVENTORY_MANAGE_SUPPLIERS)

  const suppliersQuery = useQuery<SuppliersResponse>({
    queryKey: ['suppliers'],
    queryFn: () => api.get<SuppliersResponse>('/api/suppliers'),
    staleTime: 30_000,
  })

  const suppliers = suppliersQuery.data?.suppliers ?? []

  const filtered = useMemo(() => {
    if (!search) return suppliers
    const q = search.toLowerCase()
    return suppliers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.contactPerson ?? '').toLowerCase().includes(q) ||
        (s.email ?? '').toLowerCase().includes(q) ||
        (s.phone ?? '').toLowerCase().includes(q),
    )
  }, [suppliers, search])

  // ── Mutations ────────────────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: async (payload: SupplierFormValues) =>
      api.post('/api/suppliers', {
        ...payload,
        // Normalize empty strings → undefined so the backend uses its defaults.
        contactPerson: payload.contactPerson || undefined,
        phone: payload.phone || undefined,
        email: payload.email || undefined,
      }),
    onSuccess: () => {
      toast.success('Supplier created.')
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      setCreateOpen(false)
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const editMutation = useMutation({
    mutationFn: async ({ id, payload }: { id: string; payload: SupplierFormValues }) =>
      api.patch(`/api/suppliers/${id}`, {
        ...payload,
        contactPerson: payload.contactPerson || undefined,
        phone: payload.phone || undefined,
        email: payload.email || undefined,
      }),
    onSuccess: () => {
      toast.success('Supplier updated.')
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      setEditTarget(null)
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const deactivateMutation = useMutation({
    mutationFn: async (id: string) => api.delete(`/api/suppliers/${id}`),
    onSuccess: () => {
      toast.success('Supplier deactivated.')
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      setDeactivateTarget(null)
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Suppliers"
        description="Vendors you purchase stock from. Manage contact details and payment terms."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => suppliersQuery.refetch()}
              disabled={suppliersQuery.isFetching}
            >
              <RefreshCw
                className={suppliersQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}
              />
              Refresh
            </Button>
            {canManage && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" /> Add Supplier
              </Button>
            )}
          </div>
        }
      />

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by name, contact, phone, or email…"
          className="pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {suppliersQuery.isLoading ? (
        <SuppliersTableSkeleton />
      ) : suppliersQuery.isError ? (
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">
              Couldn&apos;t load suppliers. Please try again.
            </p>
            <Button variant="outline" onClick={() => suppliersQuery.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <EmptyState
          hasSuppliers={suppliers.length > 0}
          canManage={canManage}
          onCreate={() => setCreateOpen(true)}
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead>Payment terms</TableHead>
                    <TableHead className="text-right">POs</TableHead>
                    <TableHead className="text-right">Credit balance</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => navigate({ name: 'inventory-supplier-detail', id: s.id })}
                          className="flex items-center gap-3 text-left group"
                        >
                          <Avatar className="h-9 w-9">
                            <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                              {initials(s.name)}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium text-sm group-hover:text-primary transition-colors">
                              {s.name}
                            </p>
                            <p className="text-xs text-muted-foreground">{s.email ?? 'No email'}</p>
                          </div>
                        </button>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm">{s.contactPerson ?? '—'}</span>
                          <span className="text-xs text-muted-foreground">{s.phone ?? '—'}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="text-[10px]">
                          {PAYMENT_TERMS_LABEL[s.paymentTerms] ?? s.paymentTerms}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{s.poCount}</TableCell>
                      <TableCell
                        className={`text-right tabular-nums font-medium ${
                          s.creditBalance > 0 ? 'text-amber-700' : 'text-muted-foreground'
                        }`}
                      >
                        {formatPKR(s.creditBalance)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px]">
                          {s.isOrgLevel ? (
                            <span className="flex items-center gap-1">
                              <Building2 className="h-3 w-3" /> Org
                            </span>
                          ) : (
                            'Company'
                          )}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              navigate({ name: 'inventory-supplier-detail', id: s.id })
                            }
                            aria-label={`View ${s.name}`}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          {canManage && (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditTarget(s)}
                                aria-label={`Edit ${s.name}`}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                                onClick={() => setDeactivateTarget(s)}
                                aria-label={`Deactivate ${s.name}`}
                              >
                                <PowerOff className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground p-3">
              Showing {filtered.length} of {suppliers.length} suppliers
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── Create dialog ──────────────────────────────────────────────────── */}
      <SupplierFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Add supplier"
        description="Vendors you purchase stock from. Org-level suppliers are shared across all companies."
        submitLabel="Create supplier"
        loading={createMutation.isPending}
        onSubmit={(values) => createMutation.mutate(values)}
      />

      {/* ── Edit dialog ────────────────────────────────────────────────────── */}
      {editTarget && (
        <SupplierFormDialog
          open={!!editTarget}
          onOpenChange={(open) => {
            if (!open) setEditTarget(null)
          }}
          title={`Edit ${editTarget.name}`}
          description="Update the supplier details."
          submitLabel="Save changes"
          loading={editMutation.isPending}
          defaultValues={{
            name: editTarget.name,
            contactPerson: editTarget.contactPerson ?? '',
            phone: editTarget.phone ?? '',
            email: editTarget.email ?? '',
            paymentTerms: editTarget.paymentTerms,
            isOrgLevel: editTarget.isOrgLevel,
          }}
          onSubmit={(values) => editMutation.mutate({ id: editTarget.id, payload: values })}
        />
      )}

      {/* ── Deactivate dialog ──────────────────────────────────────────────── */}
      <AlertDialog
        open={!!deactivateTarget}
        onOpenChange={(open) => {
          if (!open) setDeactivateTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate supplier?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deactivateTarget?.name}</strong> will be hidden from active lists. Existing
              purchase orders and audit logs are preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
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
// Form dialog
// ─────────────────────────────────────────────────────────────────────────────

function SupplierFormDialog({
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
  defaultValues?: SupplierFormValues
  onSubmit: (values: SupplierFormValues) => void
}) {
  const form = useForm<SupplierFormValues>({
    resolver: zodResolver(supplierFormSchema),
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

  useEffect(() => {
    if (open) reset(defaultValues ?? DEFAULT_FORM_VALUES)
  }, [open])

  const paymentTerms = watch('paymentTerms')
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
            <Label htmlFor="sup-name">Name</Label>
            <Input id="sup-name" placeholder="e.g. ABC Fabrics" {...register('name')} autoFocus />
            {errors.name && <p className="text-xs text-rose-600">{errors.name.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sup-contact">Contact person</Label>
            <Input id="sup-contact" placeholder="Optional" {...register('contactPerson')} />
            {errors.contactPerson && (
              <p className="text-xs text-rose-600">{errors.contactPerson.message}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="sup-phone">
                <span className="flex items-center gap-1">
                  <Phone className="h-3 w-3" /> Phone
                </span>
              </Label>
              <Input id="sup-phone" placeholder="+92…" {...register('phone')} />
              {errors.phone && <p className="text-xs text-rose-600">{errors.phone.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sup-email">
                <span className="flex items-center gap-1">
                  <Mail className="h-3 w-3" /> Email
                </span>
              </Label>
              <Input id="sup-email" type="email" placeholder="optional" {...register('email')} />
              {errors.email && <p className="text-xs text-rose-600">{errors.email.message}</p>}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sup-terms">Payment terms</Label>
            <Select
              value={paymentTerms}
              onValueChange={(v) =>
                setValue('paymentTerms', v as SupplierFormValues['paymentTerms'])
              }
            >
              <SelectTrigger id="sup-terms">
                <SelectValue placeholder="Select terms" />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_TERMS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.paymentTerms && (
              <p className="text-xs text-rose-600">{errors.paymentTerms.message}</p>
            )}
          </div>

          <label className="flex items-start justify-between gap-3 cursor-pointer pt-2 border-t">
            <div>
              <span className="text-sm font-medium flex items-center gap-1.5">
                <Building2 className="h-4 w-4 text-muted-foreground" /> Org-level supplier
              </span>
              <p className="text-xs text-muted-foreground">
                Available to every company in this organization. Otherwise private to your current
                company.
              </p>
            </div>
            <Switch
              checked={isOrgLevel}
              onCheckedChange={(v) => setValue('isOrgLevel', v)}
              aria-label="Org-level supplier"
            />
          </label>

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

function SuppliersTableSkeleton() {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="p-3 space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function EmptyState({
  hasSuppliers,
  canManage,
  onCreate,
}: {
  hasSuppliers: boolean
  canManage: boolean
  onCreate: () => void
}) {
  return (
    <Card>
      <CardContent className="p-10 sm:p-14 text-center">
        <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <Truck className="h-7 w-7 text-primary" />
        </div>
        <h3 className="text-lg font-semibold">
          {hasSuppliers ? 'No suppliers match your search' : 'No suppliers yet'}
        </h3>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
          {hasSuppliers
            ? 'Try a different search term.'
            : 'Add a vendor so you can create purchase orders and track payables.'}
        </p>
        {!hasSuppliers && canManage && (
          <Button className="mt-5" onClick={onCreate}>
            <Plus className="h-4 w-4" /> Add your first supplier
          </Button>
        )}
        {hasSuppliers && (
          <div className="mt-5 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <Wallet className="h-3.5 w-3.5" /> Tip: suppliers are listed by name
          </div>
        )}
      </CardContent>
    </Card>
  )
}
