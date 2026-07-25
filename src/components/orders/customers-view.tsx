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
  DialogFooter,
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
} from 'lucide-react'
import { formatPKR, formatDate, getErrorMessage } from './_shared'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface CustomerRow {
  id: string
  name: string
  phone: string
  alternatePhone: string | null
  email: string | null
  totalOrdersCount: number
  totalOrderValue: number
  totalRtoCount: number
  isFlagged: boolean
  flaggedReason: string | null
  createdAt: string
}

interface CustomersResponse {
  customers: CustomerRow[]
  stats: { total: number; flagged: number }
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
  const [flagTarget, setFlagTarget] = useState<CustomerRow | null>(null)
  const [debounceTimer, setDebounceTimer] = useState<ReturnType<typeof setTimeout> | null>(null)
  const [querySearch, setQuerySearch] = useState('')

  // Debounce search
  const onSearchChange = (v: string) => {
    setSearch(v)
    if (debounceTimer) clearTimeout(debounceTimer)
    const t = setTimeout(() => setQuerySearch(v), 300)
    setDebounceTimer(t)
  }

  const query = useQuery<CustomersResponse>({
    queryKey: ['customers', querySearch, flaggedOnly],
    queryFn: () => {
      const params = new URLSearchParams()
      if (querySearch) params.set('search', querySearch)
      if (flaggedOnly) params.set('flagged', 'true')
      const qs = params.toString()
      return api.get<CustomersResponse>(`/api/customers${qs ? `?${qs}` : ''}`)
    },
    staleTime: 15_000,
  })

  const customers = query.data?.customers ?? []
  const stats = query.data?.stats

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

  const totalCustomers = useMemo(() => stats?.total ?? customers.length, [stats, customers])
  const flaggedCount = useMemo(() => stats?.flagged ?? customers.filter((c) => c.isFlagged).length, [stats, customers])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customers"
        description="Lightweight customer directory. Tracks order history, RTO rate, and fraud flags."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={query.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            Refresh
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Total customers</p>
              <Users className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1">{totalCustomers}</p>
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
      </div>

      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, phone, or email…"
            className="pl-9"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        <Button
          variant={flaggedOnly ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFlaggedOnly((v) => !v)}
        >
          <Flag className="h-3.5 w-3.5" />
          {flaggedOnly ? 'Showing flagged' : 'Show flagged only'}
        </Button>
      </div>

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
            <h3 className="text-lg font-semibold">No customers yet</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
              Customers are created automatically when you create manual orders or sync from Shopify.
            </p>
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
                    <TableHead>Email</TableHead>
                    <TableHead className="text-right">Orders</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead className="text-right">RTO</TableHead>
                    <TableHead>Status</TableHead>
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
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar className="h-9 w-9">
                            <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                              {initials(c.name)}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium text-sm">{c.name}</p>
                            <p className="text-xs text-muted-foreground">
                              Since {formatDate(c.createdAt)}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm">{c.phone}</p>
                        {c.alternatePhone && (
                          <p className="text-xs text-muted-foreground">{c.alternatePhone}</p>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">{c.email ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {c.totalOrdersCount}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {formatPKR(c.totalOrderValue)}
                      </TableCell>
                      <TableCell className="text-right">
                        {c.totalRtoCount > 0 ? (
                          <span className="text-rose-600 font-medium tabular-nums">
                            {c.totalRtoCount}
                          </span>
                        ) : (
                          <span className="tabular-nums text-muted-foreground">0</span>
                        )}
                      </TableCell>
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
              {customers.length} customer{customers.length === 1 ? '' : 's'}
            </p>
          </CardContent>
        </Card>
      )}

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
  customer: CustomerRow
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
