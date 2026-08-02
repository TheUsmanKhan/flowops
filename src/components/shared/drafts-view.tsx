'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api-client'
import { useAppStore } from '@/stores/app-store'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  FileText,
  Trash2,
  RotateCcw,
  Package,
  ShoppingCart,
  Loader2,
  RefreshCw,
  Clock,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDateTime, getErrorMessage } from '@/components/orders/_shared'

interface DraftItem {
  id: string
  draftType: string
  draftTitle: string | null
  draftData: string
  createdAt: string
  updatedAt: string
  createdBy: string | null
  createdByEmployee: { user: { fullName: string } } | null
}

interface DraftsResponse {
  drafts: DraftItem[]
}

export function DraftsView() {
  const navigate = useAppStore((s) => s.navigate)
  const queryClient = useQueryClient()
  const [discardTarget, setDiscardTarget] = useState<DraftItem | null>(null)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['drafts'] })
    queryClient.invalidateQueries({ queryKey: ['draft-count'] })
  }

  const orderDraftsQuery = useQuery<DraftsResponse>({
    queryKey: ['drafts', 'order'],
    queryFn: () => api.get<DraftsResponse>('/api/drafts?draftType=order'),
    staleTime: 15_000,
  })

  const productDraftsQuery = useQuery<DraftsResponse>({
    queryKey: ['drafts', 'product'],
    queryFn: () => api.get<DraftsResponse>('/api/drafts?draftType=product&scope=all'),
    staleTime: 15_000,
  })

  const discardMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/drafts?id=${id}`),
    onSuccess: () => {
      toast.success('Draft discarded.')
      setDiscardTarget(null)
      invalidate()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const orderDrafts = orderDraftsQuery.data?.drafts ?? []
  const productDrafts = productDraftsQuery.data?.drafts ?? []

  return (
    <div className="space-y-6">
      <PageHeader
        title="Drafts"
        description="Saved-in-progress orders and products. Resume to continue editing, or discard to remove."
        actions={
          <Button variant="outline" size="sm" onClick={() => { orderDraftsQuery.refetch(); productDraftsQuery.refetch() }}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        }
      />

      <Tabs defaultValue="orders">
        <TabsList>
          <TabsTrigger value="orders" className="gap-1.5">
            <ShoppingCart className="h-3.5 w-3.5" /> Order Drafts
            {orderDrafts.length > 0 && (
              <span className="ml-1 text-xs bg-primary/10 text-primary rounded-full px-1.5 py-0.5 font-medium">
                {orderDrafts.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="products" className="gap-1.5">
            <Package className="h-3.5 w-3.5" /> Product Drafts
            {productDrafts.length > 0 && (
              <span className="ml-1 text-xs bg-primary/10 text-primary rounded-full px-1.5 py-0.5 font-medium">
                {productDrafts.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="orders" className="mt-4">
          <DraftList
            drafts={orderDrafts}
            isLoading={orderDraftsQuery.isLoading}
            isError={orderDraftsQuery.isError}
            error={orderDraftsQuery.error}
            onRetry={() => orderDraftsQuery.refetch()}
            onResume={(d) => navigate({ name: 'order-create', draftId: d.id })}
            onDiscard={setDiscardTarget}
            typeLabel="Order"
          />
        </TabsContent>

        <TabsContent value="products" className="mt-4">
          <DraftList
            drafts={productDrafts}
            isLoading={productDraftsQuery.isLoading}
            isError={productDraftsQuery.isError}
            error={productDraftsQuery.error}
            onRetry={() => productDraftsQuery.refetch()}
            onResume={(d) => navigate({ name: 'product-create', draftId: d.id })}
            onDiscard={setDiscardTarget}
            typeLabel="Product"
          />
        </TabsContent>
      </Tabs>

      {/* Discard confirmation */}
      {discardTarget && (
        <Dialog open={!!discardTarget} onOpenChange={(v) => !v && setDiscardTarget(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Discard draft?</DialogTitle>
              <DialogDescription>
                "{discardTarget.draftTitle || 'Untitled draft'}" will be permanently deleted. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDiscardTarget(null)}>Cancel</Button>
              <Button
                variant="destructive"
                disabled={discardMutation.isPending}
                onClick={() => discardMutation.mutate(discardTarget.id)}
              >
                {discardMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Discard
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Draft list sub-component
// ──────────────────────────────────────────────────────────────

function DraftList({
  drafts,
  isLoading,
  isError,
  error,
  onRetry,
  onResume,
  onDiscard,
  typeLabel,
}: {
  drafts: DraftItem[]
  isLoading: boolean
  isError: boolean
  error: unknown
  onRetry: () => void
  onResume: (draft: DraftItem) => void
  onDiscard: (draft: DraftItem) => void
  typeLabel: string
}) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-3 space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16" />)}
        </CardContent>
      </Card>
    )
  }

  if (isError) {
    return (
      <Card>
        <CardContent className="p-10 text-center">
          <p className="text-sm text-muted-foreground mb-4">{getErrorMessage(error)}</p>
          <Button variant="outline" onClick={onRetry}>Try again</Button>
        </CardContent>
      </Card>
    )
  }

  if (drafts.length === 0) {
    return (
      <Card>
        <CardContent className="p-10 sm:p-14 text-center">
          <div className="mx-auto h-14 w-14 rounded-full bg-muted flex items-center justify-center mb-4">
            <FileText className="h-7 w-7 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold">No {typeLabel.toLowerCase()} drafts</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
            When you save a {typeLabel.toLowerCase()} as a draft while creating it, it will appear here for you to resume later.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {drafts.map((draft) => {
        let parsedData: Record<string, unknown> = {}
        try { parsedData = JSON.parse(draft.draftData) } catch { /* ignore */ }

        return (
          <Card key={draft.id}>
            <CardContent className="p-4 flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium truncate">
                    {draft.draftTitle || `Untitled ${typeLabel} Draft`}
                  </p>
                  <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200 shrink-0">
                    <Clock className="h-2.5 w-2.5 mr-0.5" /> Draft
                  </Badge>
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                  <span>Last saved: {formatDateTime(draft.updatedAt)}</span>
                  {draft.createdByEmployee && (
                    <span>by {draft.createdByEmployee.user.fullName}</span>
                  )}
                </div>
                {/* Show summary of what's in the draft */}
                {draft.draftType === 'order' && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {Array.isArray(parsedData.cart) ? `${parsedData.cart.length} item(s)` : 'No items yet'}
                    {parsedData.selectedCustomer ? ` · customer selected` : ' · no customer'}
                  </p>
                )}
                {draft.draftType === 'product' && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {typeof parsedData.title === 'string' ? parsedData.title : 'No title'}
                    {typeof parsedData.productType === 'string' ? ` · ${parsedData.productType}` : ''}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={() => onResume(draft)}
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Resume
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                  onClick={() => onDiscard(draft)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
