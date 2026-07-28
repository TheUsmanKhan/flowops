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
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
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
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  RefreshCw,
  Search,
  Eye,
  Flag,
  Users,
  AlertTriangle,
  Loader2,
  ShieldCheck,
  Plus,
  CalendarDays,
  MapPin,
} from 'lucide-react'
import { formatPKR, formatDate, getErrorMessage } from './_shared'
import type { CustomerSummary } from '@/components/customers/types'
import { CreateCustomerForm } from '@/components/customers'

// ─────────────────────────────────────────────────────────────────────────────
// API response shape
// ─────────────────────────────────────────────────────────────────────────────

interface CustomersListResponse {
  customers: CustomerSummary[]
  total: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns true if the ISO date string falls within the current calendar month. */
function isThisMonth(iso: string): boolean {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return false
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function CustomersView() {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const queryClient = useQueryClient()
  const canManage = can(PERMISSIONS.ORDERS_MANAGE)

  const [search, setSearch] = useState('')
  const [flaggedOnly, setFlaggedOnly] = useState(false)
  const [flagTarget, setFlagTarget] = useState<CustomerSummary | null>(null)
  const [debounceTimer, setDebounceTimer] = useState<ReturnType<typeof setTimeout> | null>(null)
  const [querySearch, setQuerySearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)

  // Debounce search input
  const onSearchChange = (v: string) => {
    setSearch(v)
    if (debounceTimer) clearTimeout(debounceTimer)
    const t = setTimeout(() => setQuerySearch(v), 300)
    setDebounceTimer(t)
  }

  const query = useQuery<CustomersListResponse>({
    queryKey: ['customers', querySearch, flaggedOnly],
    queryFn: () => {
      const params = new URLSearchParams()
      if (querySearch) params.set('search', querySearch)
      if (flaggedOnly) params.set('is_flagged', 'true')
      const qs = params.toString()
      return api.get<CustomersListResponse>(`/api/customers${qs ? `?${qs}` : ''}`)
    },
    staleTime: 15_000,
  })

  const customers = query.data?.customers ?? []
  const totalCount = query.data?.total ?? 0

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['customers'] })
  }

  const flagMutation = useMutation({
    mutationFn: async ({
      id,
      action,
      reason,
    }: {
      id: string
      action: 'flag' | 'unflag'
      reason?: string
    }) => api.post('/api/customers', { customer_id: id, action, reason }),
    onSuccess: (_v, vars) => {
      toast.success(vars.action === 'flag' ? 'Customer flagged.' : 'Customer unflagged.')
      setFlagTarget(null)
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  // Compute stats from the loaded list (per spec).
  const flaggedCount = useMemo(
    () => customers.filter((c) => c.isFlagged).length,
    [customers],
  )
  const newThisMonthCount = useMemo(
    () => customers.filter((c) => isThisMonth(c.createdAt)).length,
    [customers],
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customers"
        description="Lightweight customer directory. Tracks order history, RTO rate, and fraud flags."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw className={query.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              Add Customer
            </Button>
          </div>
        }
      />

      {/* Stats cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Total customers</p>
              <Users className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1">
              {totalCount}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {customers.length} shown in this view
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Flagged customers</p>
              <AlertTriangle className="h-4 w-4 text-rose-600" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1 text-rose-700">{flaggedCount}</p>
            <p className="text-xs text-muted-foreground mt-0.5">RTO risk / fraud watch</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">New this month</p>
              <CalendarDays className="h-4 w-4 text-emerald-600" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1 text-emerald-700">
              {newThisMonthCount}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">Joined in {new Date().toLocaleDateString('en-PK', { month: 'long', year: 'numeric' })}</p>
          </CardContent>
        </Card>
      </div>

      {/* Search + flag filter */}
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or phone…"
            className="pl-9"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            aria-label="Search customers"
          />
        </div>
        <Button
          variant={flaggedOnly ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFlaggedOnly((v) => !v)}
          aria-pressed={flaggedOnly}
        >
          <Flag className="h-3.5 w-3.5" />
          {flaggedOnly ? 'Showing flagged' : 'Show flagged only'}
        </Button>
      </div>

      {/* Table / states */}
      {query.isLoading ? (
        <Card>
          <CardContent className="p-3 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </CardContent>
        </Card>
      ) : query.isError ? (
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">
              Couldn&apos;t load customers. {getErrorMessage(query.error)}
            </p>
            <Button variant="outline" onClick={() => query.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : customers.length === 0 ? (
        <Card>
          <CardContent className="p-10 sm:p-14 text-center">
            <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Users className="h-7 w-7 text-primary" />
            </div>
            <h3 className="text-lg font-semibold">
              {querySearch || flaggedOnly ? 'No customers match your filters' : 'No customers yet'}
            </h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
              {querySearch || flaggedOnly
                ? 'Try adjusting your search or clearing the flagged-only filter.'
                : 'Create a customer manually, or customers will be created automatically when you create orders or sync from Shopify.'}
            </p>
            {!querySearch && !flaggedOnly && (
              <Button className="mt-4" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" />
                Add Customer
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>City</TableHead>
                    <TableHead className="text-right">Orders</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead className="text-right">RTO</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Joined</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {customers.map((c) => (
                    <TableRow
                      key={c.id}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => navigate({ name: 'customer-detail', id: c.id })}
                    >
                      {/* Customer (name + avatar) */}
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar className="h-9 w-9">
                            <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                              {initials(c.name)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <p className="font-medium text-sm truncate">{c.name}</p>
                            {c.email && (
                              <p className="text-xs text-muted-foreground truncate">{c.email}</p>
                            )}
                          </div>
                        </div>
                      </TableCell>

                      {/* Primary phone */}
                      <TableCell>
                        {c.primaryPhone ? (
                          <p className="text-sm tabular-nums">{c.primaryPhone}</p>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>

                      {/* Default address city */}
                      <TableCell>
                        {c.defaultAddress?.city ? (
                          <span className="inline-flex items-center gap-1 text-sm">
                            <MapPin className="h-3 w-3 text-muted-foreground" />
                            {c.defaultAddress.city}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>

                      {/* Total orders */}
                      <TableCell className="text-right tabular-nums">
                        {c.totalOrdersCount}
                      </TableCell>

                      {/* Total order value */}
                      <TableCell className="text-right tabular-nums font-medium">
                        {formatPKR(c.totalOrderValue)}
                      </TableCell>

                      {/* RTO count */}
                      <TableCell className="text-right">
                        {c.totalRtoCount > 0 ? (
                          <span className="text-rose-600 font-medium tabular-nums">
                            {c.totalRtoCount}
                          </span>
                        ) : (
                          <span className="tabular-nums text-muted-foreground">0</span>
                        )}
                      </TableCell>

                      {/* Flag status */}
                      <TableCell>
                        {c.isFlagged ? (
                          <Badge
                            variant="outline"
                            className="bg-rose-50 text-rose-700 border-rose-200"
                            title={c.flaggedReason ?? ''}
                          >
                            <Flag className="h-3 w-3 mr-1" /> Flagged
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="bg-emerald-50 text-emerald-700 border-emerald-200"
                          >
                            <ShieldCheck className="h-3 w-3 mr-1" /> OK
                          </Badge>
                        )}
                      </TableCell>

                      {/* Created date */}
                      <TableCell>
                        <p className="text-sm text-muted-foreground">{formatDate(c.createdAt)}</p>
                      </TableCell>

                      {/* Actions */}
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation()
                              navigate({ name: 'customer-detail', id: c.id })
                            }}
                            aria-label={`View ${c.name}`}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          {canManage &&
                            (c.isFlagged ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  flagMutation.mutate({ id: c.id, action: 'unflag' })
                                }}
                                disabled={flagMutation.isPending}
                                aria-label={`Unflag ${c.name}`}
                                title="Unflag"
                              >
                                <ShieldCheck className="h-3.5 w-3.5" />
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setFlagTarget(c)
                                }}
                                aria-label={`Flag ${c.name}`}
                                title="Flag"
                              >
                                <Flag className="h-3.5 w-3.5" />
                              </Button>
                            ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground p-3">
              Showing {customers.length} of {totalCount} customer{totalCount === 1 ? '' : 's'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Add customer dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add new customer</DialogTitle>
            <DialogDescription>
              Create a customer with one or more phone numbers and addresses. Exactly one phone
              must be marked primary and one address marked default.
            </DialogDescription>
          </DialogHeader>
          <CreateCustomerForm
            compact
            submitLabel="Create Customer"
            onCreated={(customerId) => {
              setCreateOpen(false)
              invalidate()
              toast.success('Customer created — opening profile.')
              // Navigate to the new customer's detail page
              navigate({ name: 'customer-detail', id: customerId })
            }}
          />
        </DialogContent>
      </Dialog>

      {/* Flag dialog */}
      {flagTarget && (
        <FlagDialog
          customer={flagTarget}
          open={!!flagTarget}
          onOpenChange={(open) => {
            if (!open) setFlagTarget(null)
          }}
          loading={flagMutation.isPending}
          onConfirm={(reason) =>
            flagMutation.mutate({ id: flagTarget.id, action: 'flag', reason })
          }
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Flag dialog
// ─────────────────────────────────────────────────────────────────────────────

function FlagDialog({
  customer,
  open,
  onOpenChange,
  loading,
  onConfirm,
}: {
  customer: CustomerSummary
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
          <DialogTitle>Flag {customer.name}?</DialogTitle>
          <DialogDescription>
            Flagged customers are highlighted in the customer list and on every new order they
            place. Provide a clear reason for audit purposes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="flag-reason">Reason</Label>
          <Textarea
            id="flag-reason"
            placeholder="e.g. High RTO rate, payment fraud, abusive behavior"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            autoFocus
          />
        </div>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
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
        </div>
      </DialogContent>
    </Dialog>
  )
}
