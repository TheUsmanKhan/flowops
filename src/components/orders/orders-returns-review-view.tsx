'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api-client'
import { useAppStore } from '@/stores/app-store'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
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
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ClipboardCheck,
  Stethoscope,
} from 'lucide-react'
import { formatDate, getErrorMessage } from './_shared'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ReviewItemRow {
  id: string
  orderId: string
  flowopsOrderNumber: string
  variantId: string
  sku: string
  productTitle: string
  quantity: number
  fulfillmentTypeSnapshot: string
  autoProcessedAsPerfect: boolean
  autoProcessedCondition: 'perfect' | 'resellable'
  returnedAt: string | null
}

interface ReviewResponse {
  items: ReviewItemRow[]
  stats: { count: number }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function OrdersReturnsReviewView() {
  const navigate = useAppStore((s) => s.navigate)
  const queryClient = useQueryClient()
  const [correctTarget, setCorrectTarget] = useState<ReviewItemRow | null>(null)

  const query = useQuery<ReviewResponse>({
    queryKey: ['orders-returns-review'],
    queryFn: () => api.get<ReviewResponse>('/api/orders/returns/review'),
    staleTime: 15_000,
  })

  const items = query.data?.items ?? []
  const count = query.data?.stats.count ?? items.length

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['orders-returns-review'] })
    void queryClient.invalidateQueries({ queryKey: ['orders-returns'] })
    void queryClient.invalidateQueries({ queryKey: ['orders'] })
  }

  // Confirm as perfect — dismiss the review
  const dismissMutation = useMutation({
    mutationFn: async (item: ReviewItemRow) =>
      api.post(`/api/orders/${item.orderId}/returns/review/dismiss?item_id=${encodeURIComponent(item.id)}`),
    onSuccess: () => {
      toast.success('Item confirmed. Removed from review queue.')
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  // Correct to damaged — opens confirmation dialog
  const correctMutation = useMutation({
    mutationFn: async (item: ReviewItemRow) =>
      api.post(`/api/orders/${item.orderId}/returns/review/correct?item_id=${encodeURIComponent(item.id)}`),
    onSuccess: () => {
      toast.success('Item corrected to damaged. Stock-loss record created.')
      setCorrectTarget(null)
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const mtoCount = useMemo(
    () => items.filter((i) => i.fulfillmentTypeSnapshot === 'made_to_order').length,
    [items],
  )
  const stockCount = items.length - mtoCount

  return (
    <div className="space-y-6">
      <PageHeader
        title="Return Review Queue"
        description="Items auto-processed as perfect/resellable awaiting physical spot-check. Confirm or correct each item."
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

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Items in queue</p>
              <AlertTriangle className="h-4 w-4 text-amber-600" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1 text-amber-700">{count}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Made-to-order</p>
              <Stethoscope className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1">{mtoCount}</p>
            <p className="text-xs text-muted-foreground mt-0.5">auto: perfect (stitched received)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Stock-based</p>
              <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xl font-semibold tabular-nums mt-1">{stockCount}</p>
            <p className="text-xs text-muted-foreground mt-0.5">auto: resellable</p>
          </CardContent>
        </Card>
      </div>

      {query.isLoading ? (
        <Card>
          <CardContent className="p-3 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </CardContent>
        </Card>
      ) : query.isError ? (
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">
              Couldn&apos;t load review queue. {getErrorMessage(query.error)}
            </p>
            <Button variant="outline" onClick={() => query.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-10 sm:p-14 text-center">
            <div className="mx-auto h-14 w-14 rounded-full bg-emerald-50 flex items-center justify-center mb-4">
              <CheckCircle2 className="h-7 w-7 text-emerald-600" />
            </div>
            <h3 className="text-lg font-semibold">
              No items need review — all returns confirmed
            </h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
              Auto-processed return items will appear here for physical spot-checking. New RTO
              returns will create review items automatically.
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
                    <TableHead>Order</TableHead>
                    <TableHead>Variant</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead>Auto-processed as</TableHead>
                    <TableHead>Returned</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => navigate({ name: 'order-detail', id: item.orderId })}
                          className="text-left group"
                        >
                          <p className="font-medium text-sm group-hover:text-primary transition-colors">
                            {item.flowopsOrderNumber}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {item.fulfillmentTypeSnapshot === 'made_to_order'
                              ? 'Made-to-order'
                              : 'Stock-based'}
                          </p>
                        </button>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm">{item.productTitle}</p>
                        <p className="text-xs text-muted-foreground">{item.sku}</p>
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {item.quantity}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={
                            item.autoProcessedCondition === 'perfect'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : 'bg-sky-50 text-sky-700 border-sky-200'
                          }
                        >
                          {item.autoProcessedCondition === 'perfect' ? 'Perfect' : 'Resellable'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDate(item.returnedAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => dismissMutation.mutate(item)}
                            disabled={
                              dismissMutation.isPending &&
                              dismissMutation.variables?.id === item.id
                            }
                          >
                            {dismissMutation.isPending &&
                            dismissMutation.variables?.id === item.id ? (
                              <>
                                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Confirming…
                              </>
                            ) : (
                              <>
                                <CheckCircle2 className="h-3.5 w-3.5" /> Confirm Perfect
                              </>
                            )}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                            onClick={() => setCorrectTarget(item)}
                          >
                            <AlertTriangle className="h-3.5 w-3.5" /> Correct to Damaged
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground p-3">
              {items.length} item{items.length === 1 ? '' : 's'} awaiting review
            </p>
          </CardContent>
        </Card>
      )}

      {/* Correct-to-damaged confirmation */}
      <AlertDialog
        open={!!correctTarget}
        onOpenChange={(open) => {
          if (!open) setCorrectTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark item as damaged?</AlertDialogTitle>
            <AlertDialogDescription>
              {correctTarget && (
                <>
                  <strong>{correctTarget.productTitle}</strong> ({correctTarget.sku}) on order{' '}
                  <strong>{correctTarget.flowopsOrderNumber}</strong> was auto-processed as{' '}
                  {correctTarget.autoProcessedCondition}. Marking it as damaged will:
                  <ul className="list-disc pl-5 mt-2 space-y-1">
                    <li>Reverse the auto-processed return transaction (stock removed)</li>
                    <li>Create a stock-loss record for the damaged units</li>
                    <li>Open a damage investigation on the variant</li>
                  </ul>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={correctMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700"
              disabled={correctMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (correctTarget) correctMutation.mutate(correctTarget)
              }}
            >
              {correctMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Correcting…
                </>
              ) : (
                'Mark as Damaged'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
