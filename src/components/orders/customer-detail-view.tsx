'use client'

import { useMemo, useState } from 'react'
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
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
} from 'lucide-react'
import { formatPKR, formatDate, getErrorMessage, badgeForStatus } from './_shared'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface CustomerAddress {
  label?: string
  address: string
  city: string
  province?: string
  is_default?: boolean
}

interface CustomerDetail {
  id: string
  name: string
  phone: string
  alternatePhone: string | null
  email: string | null
  addresses: CustomerAddress[]
  totalOrdersCount: number
  totalOrderValue: number
  totalRtoCount: number
  isFlagged: boolean
  flaggedReason: string | null
  createdAt: string
}

interface RecentOrder {
  id: string
  flowopsOrderNumber: string
  status: string
  totalOrderValue: number
  createdAt: string
}

interface CustomerDetailResponse {
  customer: CustomerDetail
  recentOrders: RecentOrder[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function CustomerDetailView({ customerId }: { customerId: string }) {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const queryClient = useQueryClient()
  const canManage = can(PERMISSIONS.ORDERS_MANAGE)
  const [flagOpen, setFlagOpen] = useState(false)

  const query = useQuery<CustomerDetailResponse>({
    queryKey: ['customer', customerId],
    queryFn: () => api.get<CustomerDetailResponse>(`/api/customers/${customerId}`),
    staleTime: 15_000,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['customer', customerId] })
    void queryClient.invalidateQueries({ queryKey: ['customers'] })
  }

  const flagMutation = useMutation({
    mutationFn: async ({
      action,
      reason,
    }: {
      action: 'flag' | 'unflag'
      reason?: string
    }) =>
      api.post('/api/customers', { customer_id: customerId, action, reason }),
    onSuccess: (_v, vars) => {
      toast.success(vars.action === 'flag' ? 'Customer flagged.' : 'Customer unflagged.')
      setFlagOpen(false)
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const customer = query.data?.customer
  const recentOrders = query.data?.recentOrders ?? []

  const rtoRate = useMemo(() => {
    if (!customer || customer.totalOrdersCount === 0) return 0
    return Math.round((customer.totalRtoCount / customer.totalOrdersCount) * 100)
  }, [customer])

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
            >
              <RefreshCw className={query.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate({ name: 'customers' })}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
          </div>
        }
      />

      {/* Profile + stats */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <Avatar className="h-12 w-12">
                  <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                    {initials(customer.name)}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <CardTitle className="text-base">{customer.name}</CardTitle>
                  <div className="flex items-center gap-2 mt-1">
                    {customer.isFlagged ? (
                      <Badge
                        variant="outline"
                        className="bg-rose-50 text-rose-700 border-rose-200"
                      >
                        <Flag className="h-3 w-3 mr-1" /> Flagged
                      </Badge>
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
          </CardHeader>
          <CardContent className="space-y-3">
            {customer.flaggedReason && (
              <div className="rounded-md bg-rose-50 border border-rose-200 p-3 text-sm">
                <p className="font-medium text-rose-800 mb-0.5">Flag reason</p>
                <p className="text-rose-700">{customer.flaggedReason}</p>
              </div>
            )}
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="flex items-center gap-2 text-sm">
                <Phone className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="font-medium">{customer.phone}</p>
                  {customer.alternatePhone && (
                    <p className="text-xs text-muted-foreground">
                      Alt: {customer.alternatePhone}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="font-medium">{customer.email ?? '—'}</p>
                  <p className="text-xs text-muted-foreground">Email</p>
                </div>
              </div>
            </div>

            {/* Addresses */}
            <div className="border-t pt-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1">
                <MapPin className="h-3 w-3" /> Saved addresses
              </p>
              {customer.addresses.length === 0 ? (
                <p className="text-sm text-muted-foreground">No addresses on file.</p>
              ) : (
                <ul className="space-y-2">
                  {customer.addresses.map((a, i) => (
                    <li
                      key={i}
                      className="text-sm rounded-md border p-2.5 bg-muted/30"
                    >
                      <div className="flex items-center justify-between">
                        <p className="font-medium">{a.label ?? a.city}</p>
                        {a.is_default && (
                          <Badge variant="outline" className="text-[10px]">
                            Default
                          </Badge>
                        )}
                      </div>
                      <p className="text-muted-foreground mt-0.5">
                        {a.address}
                        {a.province ? `, ${a.province}` : ''} — {a.city}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Stats */}
        <div className="space-y-3">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Total orders</p>
                <ShoppingCart className="h-4 w-4 text-muted-foreground" />
              </div>
              <p className="text-2xl font-semibold tabular-nums mt-1">
                {customer.totalOrdersCount}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Lifetime value</p>
                <Wallet className="h-4 w-4 text-muted-foreground" />
              </div>
              <p className="text-2xl font-semibold tabular-nums mt-1">
                {formatPKR(customer.totalOrderValue)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">RTO count</p>
                <RotateCcw className="h-4 w-4 text-muted-foreground" />
              </div>
              <p className="text-2xl font-semibold tabular-nums mt-1 text-rose-700">
                {customer.totalRtoCount}
              </p>
              {customer.totalOrdersCount > 0 && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {rtoRate}% RTO rate
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Order history */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Order history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {recentOrders.length === 0 ? (
            <p className="text-sm text-muted-foreground p-6 text-center">No orders yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total value</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentOrders.map((o) => {
                    const badge = badgeForStatus(o.status)
                    return (
                      <TableRow key={o.id}>
                        <TableCell className="font-medium text-sm">
                          {o.flowopsOrderNumber}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-[10px] ${badge.className}`}>
                            {badge.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {formatPKR(o.totalOrderValue)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDate(o.createdAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => navigate({ name: 'order-detail', id: o.id })}
                          >
                            View
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="text-xs text-muted-foreground p-3">
            Showing last {recentOrders.length} order{recentOrders.length === 1 ? '' : 's'}
          </p>
        </CardContent>
      </Card>

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Flag {customerName}?</DialogTitle>
          <DialogDescription>
            Flagged customers are highlighted in the customer list and on every new order they
            place.
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
        </div>
        <DialogFooter>
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
