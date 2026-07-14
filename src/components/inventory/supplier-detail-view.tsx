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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  ArrowLeft,
  Pencil,
  Truck,
  Building2,
  Mail,
  Phone,
  User,
  ShoppingCart,
  Wallet,
  Receipt,
  Loader2,
  Package,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types
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

interface PurchaseOrderSummary {
  id: string
  poNumber: string
  status: string
  supplier: string
  deliveryLocation: string
  orderDate: string
  expectedDeliveryDate: string | null
  advancePayment: number
  itemCount: number
}

interface PurchaseOrdersResponse {
  orders: PurchaseOrderSummary[]
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

const PO_STATUS_BADGE: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700 border-gray-200',
  ordered: 'bg-sky-50 text-sky-700 border-sky-200',
  partially_received: 'bg-amber-50 text-amber-700 border-amber-200',
  received: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  cancelled: 'bg-rose-50 text-rose-700 border-rose-200',
}

const PO_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  ordered: 'Ordered',
  partially_received: 'Partially received',
  received: 'Received',
  cancelled: 'Cancelled',
}

const PKR = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 })
function formatPKR(n: number): string {
  return `Rs. ${PKR.format(n)}`
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('en-PK', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return iso
  }
}

function getErrorMessage(err: unknown): string {
  if (err instanceof FetchError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong. Please try again.'
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod schema (for inline edit)
// ─────────────────────────────────────────────────────────────────────────────

const supplierFormSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100, 'Name is too long'),
  contactPerson: z.string().max(100).optional().or(z.literal('')),
  phone: z.string().max(40).optional().or(z.literal('')),
  email: z.string().email('Enter a valid email').optional().or(z.literal('')),
  paymentTerms: z.enum(['immediate', 'net_15', 'net_30', 'net_45', 'net_60']),
})
type SupplierFormValues = z.infer<typeof supplierFormSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function SupplierDetailView({ supplierId }: { supplierId: string }) {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const queryClient = useQueryClient()

  const [editOpen, setEditOpen] = useState(false)

  const canManage = can(PERMISSIONS.INVENTORY_MANAGE_SUPPLIERS)

  // GET /api/suppliers/[id] doesn't exist — fetch list & filter.
  const suppliersQuery = useQuery<SuppliersResponse>({
    queryKey: ['suppliers'],
    queryFn: () => api.get<SuppliersResponse>('/api/suppliers'),
    staleTime: 30_000,
  })

  const poQuery = useQuery<PurchaseOrdersResponse>({
    queryKey: ['purchase-orders'],
    queryFn: () => api.get<PurchaseOrdersResponse>('/api/purchase-orders'),
    staleTime: 30_000,
  })

  const supplier = useMemo(
    () => suppliersQuery.data?.suppliers.find((s) => s.id === supplierId) ?? null,
    [suppliersQuery.data, supplierId],
  )

  // Filter POs to those belonging to this supplier (match on supplier name).
  const supplierPOs = useMemo(() => {
    if (!supplier) return []
    return poQuery.data?.orders.filter((po) => po.supplier === supplier.name) ?? []
  }, [poQuery.data, supplier])

  const totalAdvance = useMemo(
    () => supplierPOs.reduce((s, po) => s + po.advancePayment, 0),
    [supplierPOs],
  )

  const editMutation = useMutation({
    mutationFn: async (payload: SupplierFormValues) =>
      api.patch(`/api/suppliers/${supplierId}`, {
        ...payload,
        contactPerson: payload.contactPerson || undefined,
        phone: payload.phone || undefined,
        email: payload.email || undefined,
      }),
    onSuccess: () => {
      toast.success('Supplier updated.')
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      setEditOpen(false)
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const loading = suppliersQuery.isLoading

  return (
    <div className="space-y-6">
      <PageHeader
        title={supplier?.name ?? 'Supplier'}
        description={
          supplier
            ? `Payment terms: ${PAYMENT_TERMS_LABEL[supplier.paymentTerms] ?? supplier.paymentTerms}`
            : 'Loading supplier…'
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate({ name: 'inventory-suppliers' })}>
            <ArrowLeft className="h-4 w-4" /> Back to suppliers
          </Button>
        }
      />

      {/* ── Supplier profile + stats ─────────────────────────────────────── */}
      {loading ? (
        <Skeleton className="h-48" />
      ) : suppliersQuery.isError || !supplier ? (
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">
              {suppliersQuery.isError
                ? 'Couldn\'t load this supplier. Please try again.'
                : 'Supplier not found.'}
            </p>
            <Button variant="outline" onClick={() => suppliersQuery.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center justify-between gap-2">
                  <span>Profile</span>
                  {canManage && (
                    <Button size="sm" variant="ghost" onClick={() => setEditOpen(true)}>
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </Button>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-start gap-4">
                  <Avatar className="h-14 w-14">
                    <AvatarFallback className="bg-primary/10 text-primary text-base font-semibold">
                      {initials(supplier.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-lg font-semibold leading-tight">{supplier.name}</h2>
                      <Badge variant="outline" className="text-[10px]">
                        {supplier.isOrgLevel ? (
                          <span className="flex items-center gap-1">
                            <Building2 className="h-3 w-3" /> Org-level
                          </span>
                        ) : (
                          'Company'
                        )}
                      </Badge>
                    </div>
                    <div className="grid sm:grid-cols-2 gap-3 mt-3">
                      <InfoRow
                        icon={<User className="h-3.5 w-3.5" />}
                        label="Contact person"
                        value={supplier.contactPerson ?? '—'}
                      />
                      <InfoRow
                        icon={<Phone className="h-3.5 w-3.5" />}
                        label="Phone"
                        value={supplier.phone ?? '—'}
                      />
                      <InfoRow
                        icon={<Mail className="h-3.5 w-3.5" />}
                        label="Email"
                        value={supplier.email ?? '—'}
                      />
                      <InfoRow
                        icon={<Receipt className="h-3.5 w-3.5" />}
                        label="Payment terms"
                        value={PAYMENT_TERMS_LABEL[supplier.paymentTerms] ?? supplier.paymentTerms}
                      />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-3 lg:grid-cols-1 gap-3">
              <StatCard
                label="Total orders"
                value={String(supplier.poCount)}
                icon={<ShoppingCart className="h-4 w-4" />}
                tone="emerald"
                loading={poQuery.isLoading}
              />
              <StatCard
                label="Advance paid"
                value={formatPKR(totalAdvance)}
                icon={<Wallet className="h-4 w-4" />}
                tone="amber"
                loading={poQuery.isLoading}
              />
              <StatCard
                label="Credit balance"
                value={formatPKR(supplier.creditBalance)}
                icon={<Wallet className="h-4 w-4" />}
                tone={supplier.creditBalance > 0 ? 'rose' : 'gray'}
              />
            </div>
          </div>

          {/* ── Recent Purchase Orders table ─────────────────────────────── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Recent purchase orders</CardTitle>
            </CardHeader>
            <CardContent>
              {poQuery.isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-12" />
                  ))}
                </div>
              ) : poQuery.isError ? (
                <div className="text-center py-8">
                  <p className="text-sm text-muted-foreground mb-3">Couldn&apos;t load purchase orders.</p>
                  <Button variant="outline" size="sm" onClick={() => poQuery.refetch()}>
                    Try again
                  </Button>
                </div>
              ) : supplierPOs.length === 0 ? (
                <div className="text-center py-10">
                  <Package className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
                  <p className="text-sm text-muted-foreground">
                    No purchase orders from this supplier yet.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto max-h-96 overflow-y-auto scrollbar-thin">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>PO #</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Delivery to</TableHead>
                        <TableHead className="text-right">Items</TableHead>
                        <TableHead className="text-right">Advance</TableHead>
                        <TableHead>Ordered</TableHead>
                        <TableHead>Expected</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {supplierPOs.map((po) => (
                        <TableRow
                          key={po.id}
                          className="cursor-pointer hover:bg-muted/40"
                          onClick={() =>
                            navigate({ name: 'inventory-po-detail', id: po.id })
                          }
                        >
                          <TableCell className="font-mono text-xs">{po.poNumber}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={PO_STATUS_BADGE[po.status] ?? 'bg-gray-100 text-gray-700 border-gray-200'}>
                              {PO_STATUS_LABEL[po.status] ?? po.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm">{po.deliveryLocation}</TableCell>
                          <TableCell className="text-right tabular-nums">{po.itemCount}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {po.advancePayment > 0 ? formatPKR(po.advancePayment) : '—'}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {formatDate(po.orderDate)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {formatDate(po.expectedDeliveryDate)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* ── Edit dialog ────────────────────────────────────────────────────── */}
      {supplier && (
        <SupplierEditDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          loading={editMutation.isPending}
          defaultValues={{
            name: supplier.name,
            contactPerson: supplier.contactPerson ?? '',
            phone: supplier.phone ?? '',
            email: supplier.email ?? '',
            paymentTerms: supplier.paymentTerms,
          }}
          onSubmit={(values) => editMutation.mutate(values)}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        {icon}
        {label}
      </p>
      <p className="text-sm font-medium truncate">{value}</p>
    </div>
  )
}

type StatTone = 'emerald' | 'amber' | 'rose' | 'gray'

const STAT_TONE_CLASSES: Record<StatTone, string> = {
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  rose: 'bg-rose-50 text-rose-600',
  gray: 'bg-gray-100 text-gray-600',
}

function StatCard({
  label,
  value,
  icon,
  tone,
  loading,
}: {
  label: string
  value: string
  icon: React.ReactNode
  tone: StatTone
  loading?: boolean
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
          <div className={`flex h-7 w-7 items-center justify-center rounded ${STAT_TONE_CLASSES[tone]}`}>
            {icon}
          </div>
        </div>
        {loading ? (
          <Skeleton className="h-6 w-20" />
        ) : (
          <p className="text-lg font-semibold tabular-nums">{value}</p>
        )}
      </CardContent>
    </Card>
  )
}

function SupplierEditDialog({
  open,
  onOpenChange,
  loading,
  defaultValues,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  loading: boolean
  defaultValues: SupplierFormValues
  onSubmit: (values: SupplierFormValues) => void
}) {
  const form = useForm<SupplierFormValues>({
    resolver: zodResolver(supplierFormSchema),
    defaultValues,
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
    if (open) reset(defaultValues)
  }, [open])

  const paymentTerms = watch('paymentTerms')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle>Edit supplier</DialogTitle>
          <DialogDescription>Update the supplier&apos;s contact and payment details.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sd-name">Name</Label>
            <Input id="sd-name" {...register('name')} autoFocus />
            {errors.name && <p className="text-xs text-rose-600">{errors.name.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sd-contact">Contact person</Label>
            <Input id="sd-contact" {...register('contactPerson')} />
            {errors.contactPerson && (
              <p className="text-xs text-rose-600">{errors.contactPerson.message}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="sd-phone">Phone</Label>
              <Input id="sd-phone" {...register('phone')} />
              {errors.phone && <p className="text-xs text-rose-600">{errors.phone.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sd-email">Email</Label>
              <Input id="sd-email" type="email" {...register('email')} />
              {errors.email && <p className="text-xs text-rose-600">{errors.email.message}</p>}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sd-terms">Payment terms</Label>
            <Select
              value={paymentTerms}
              onValueChange={(v) =>
                setValue('paymentTerms', v as SupplierFormValues['paymentTerms'])
              }
            >
              <SelectTrigger id="sd-terms">
                <SelectValue placeholder="Select terms" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="immediate">Immediate</SelectItem>
                <SelectItem value="net_15">Net 15</SelectItem>
                <SelectItem value="net_30">Net 30</SelectItem>
                <SelectItem value="net_45">Net 45</SelectItem>
                <SelectItem value="net_60">Net 60</SelectItem>
              </SelectContent>
            </Select>
            {errors.paymentTerms && (
              <p className="text-xs text-rose-600">{errors.paymentTerms.message}</p>
            )}
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
                'Save changes'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
