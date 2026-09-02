'use client'

import { useState, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useIdempotentMutation } from '@/hooks/use-idempotent-mutation'
import { toast } from 'sonner'
import { api, FetchError } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Loader2, Search, Package, ArrowRight, Truck, UserCheck, Check, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface VariantOption {
  variantId: string
  sku: string
  productTitle: string
  costPrice: number
  salePrice: number | null
  fulfillmentType: string
}

interface ProductsResponse {
  products: Array<{
    id: string
    title: string
    variants: Array<{
      id: string
      sku: string
      costPrice: number
      salePrice: number | null
      fulfillmentType: string
    }>
  }>
}

interface RequestExchangeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  orderItemId: string
  orderItemSku: string
  orderItemTitle: string
  orderItemPrice: number
  orderId: string
}

// ──────────────────────────────────────────────────────────────
// Main dialog component
// ──────────────────────────────────────────────────────────────

export function RequestExchangeDialog({
  open,
  onOpenChange,
  orderItemId,
  orderItemSku,
  orderItemTitle,
  orderItemPrice,
  orderId,
}: RequestExchangeDialogProps) {
  const queryClient = useQueryClient()
  const [newVariantId, setNewVariantId] = useState('')
  const [variantSearch, setVariantSearch] = useState('')
  const [exchangeMethod, setExchangeMethod] = useState<'courier_replacement' | 'customer_self_return'>('courier_replacement')
  const [reason, setReason] = useState('')
  const [createdExchangeId, setCreatedExchangeId] = useState<string | null>(null)

  // Fetch products for variant search
  const productsQuery = useQuery<ProductsResponse>({
    queryKey: ['products-exchange'],
    queryFn: () => api.get<ProductsResponse>('/api/products?pageSize=100'),
    enabled: open,
    staleTime: 30_000,
  })

  const variantOptions = useMemo(() => {
    const list: VariantOption[] = []
    for (const p of productsQuery.data?.products ?? []) {
      for (const v of p.variants) {
        list.push({
          variantId: v.id,
          sku: v.sku,
          productTitle: p.title,
          costPrice: v.costPrice,
          salePrice: v.salePrice,
          fulfillmentType: v.fulfillmentType,
        })
      }
    }
    return list
  }, [productsQuery.data])

  const searchResults = useMemo(() => {
    if (!variantSearch.trim()) return []
    const q = variantSearch.toLowerCase()
    return variantOptions
      .filter((v) => v.sku.toLowerCase().includes(q) || v.productTitle.toLowerCase().includes(q))
      .slice(0, 8)
  }, [variantOptions, variantSearch])

  const selectedVariant = variantOptions.find((v) => v.variantId === newVariantId)
  const newItemPrice = selectedVariant?.salePrice ?? selectedVariant?.costPrice ?? 0
  const priceDifference = newItemPrice - orderItemPrice

  // Create exchange mutation
  const createMutation = useIdempotentMutation<{ exchangeId: string }, {
    original_order_item_id: string
    new_org_variant_id: string
    exchange_method: string
    reason: string
  }>({
    url: '/api/exchanges',
    mutationOptions: {
      onSuccess: (data) => {
        toast.success('Exchange requested.')
        setCreatedExchangeId(data.exchangeId)
        invalidateAll(data.exchangeId)
      },
      onError: (err) => {
        toast.error(err instanceof FetchError ? err.message : 'Failed to create exchange')
      },
    },
  })

  // Dispatch new item mutation (courier_replacement follow-up)
  const dispatchMutation = useMutation({
    mutationFn: () => api.post(`/api/exchanges/${createdExchangeId}/dispatch-new-item`),
    onSuccess: () => {
      toast.success('New item dispatched. Courier will collect the old item during delivery.')
      invalidateAll(createdExchangeId!)
      handleClose()
    },
    onError: (err) => {
      toast.error(err instanceof FetchError ? err.message : 'Failed to dispatch new item')
    },
  })

  const invalidateAll = (exchangeId: string) => {
    queryClient.invalidateQueries({ queryKey: ['exchanges'] })
    queryClient.invalidateQueries({ queryKey: ['exchange', exchangeId] })
    queryClient.invalidateQueries({ queryKey: ['order', orderId] })
    queryClient.invalidateQueries({ queryKey: ['inventory-pools'] })
  }

  const handleClose = () => {
    setNewVariantId('')
    setVariantSearch('')
    setExchangeMethod('courier_replacement')
    setReason('')
    setCreatedExchangeId(null)
    onOpenChange(false)
  }

  const canSubmit = newVariantId && reason.trim().length >= 3 && !createMutation.isPending

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4" /> Request Exchange
          </DialogTitle>
          <DialogDescription>
            Exchange an item from a delivered order.
          </DialogDescription>
        </DialogHeader>

        {createdExchangeId ? (
          // ── Success state ──
          <div className="space-y-4 py-2">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 space-y-2">
              <div className="flex items-center gap-2 text-emerald-700">
                <Check className="h-4 w-4" />
                <p className="text-sm font-medium">Exchange request created</p>
              </div>
              {exchangeMethod === 'courier_replacement' ? (
                <div className="space-y-3">
                  <p className="text-xs text-emerald-700">
                    The new item is ready to dispatch. The courier will collect the old item during the same delivery trip.
                  </p>
                  <Button
                    onClick={() => dispatchMutation.mutate()}
                    disabled={dispatchMutation.isPending}
                    className="w-full"
                  >
                    {dispatchMutation.isPending ? (
                      <><Loader2 className="h-4 w-4 animate-spin" /> Dispatching…</>
                    ) : (
                      <><Truck className="h-4 w-4" /> Dispatch New Item Now</>
                    )}
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-emerald-700">
                  Waiting for the customer to ship the old item back. You&apos;ll need to confirm receipt and verify it before the new item is dispatched.
                </p>
              )}
            </div>
            <Button variant="outline" onClick={handleClose} className="w-full">
              Close
            </Button>
          </div>
        ) : (
          // ── Form state ──
          <div className="space-y-4 py-2">
            {/* Old item (read-only) */}
            <div className="rounded-md border bg-muted/30 p-3 space-y-1">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Item being exchanged</p>
              <p className="text-sm font-medium">{orderItemTitle}</p>
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground font-mono">{orderItemSku}</p>
                <p className="text-sm font-medium tabular-nums">Rs. {orderItemPrice.toLocaleString('en-PK')}</p>
              </div>
            </div>

            {/* New variant search */}
            <div className="space-y-1.5">
              <Label className="text-xs">New Item *</Label>
              {newVariantId && selectedVariant ? (
                <div className="rounded-md border border-primary/30 bg-primary/5 p-2.5 flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{selectedVariant.productTitle}</p>
                    <p className="text-xs text-muted-foreground font-mono">{selectedVariant.sku}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <p className="text-sm font-medium tabular-nums">
                      Rs. {(selectedVariant.salePrice ?? selectedVariant.costPrice).toLocaleString('en-PK')}
                    </p>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => { setNewVariantId(''); setVariantSearch('') }}
                    >
                      Change
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                  <Input
                    placeholder="Search by SKU or product name…"
                    className="pl-9"
                    value={variantSearch}
                    onChange={(e) => setVariantSearch(e.target.value)}
                  />
                  {searchResults.length > 0 && (
                    <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md max-h-52 overflow-y-auto scrollbar-thin">
                      {searchResults.map((v) => (
                        <button
                          key={v.variantId}
                          type="button"
                          onClick={() => { setNewVariantId(v.variantId); setVariantSearch('') }}
                          className="w-full text-left px-3 py-2 hover:bg-muted/60 transition-colors flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{v.productTitle}</p>
                            <p className="text-xs text-muted-foreground font-mono">{v.sku}</p>
                          </div>
                          <p className="text-xs tabular-nums shrink-0">
                            Rs. {(v.salePrice ?? v.costPrice).toLocaleString('en-PK')}
                          </p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Live price difference preview */}
            {newVariantId && selectedVariant && (
              <div className={cn(
                'rounded-md border p-2.5 text-sm',
                priceDifference > 0
                  ? 'border-amber-200 bg-amber-50 text-amber-800'
                  : priceDifference < 0
                    ? 'border-sky-200 bg-sky-50 text-sky-800'
                    : 'border-muted bg-muted/30 text-muted-foreground',
              )}>
                {priceDifference > 0 ? (
                  <>New item <strong>Rs. {newItemPrice.toLocaleString('en-PK')}</strong> vs current <strong>Rs. {orderItemPrice.toLocaleString('en-PK')}</strong> — customer owes <strong>Rs. {priceDifference.toLocaleString('en-PK')}</strong></>
                ) : priceDifference < 0 ? (
                  <>New item <strong>Rs. {newItemPrice.toLocaleString('en-PK')}</strong> vs current <strong>Rs. {orderItemPrice.toLocaleString('en-PK')}</strong> — refund due <strong>Rs. {Math.abs(priceDifference).toLocaleString('en-PK')}</strong></>
                ) : (
                  <>No price difference — both items are Rs. {orderItemPrice.toLocaleString('en-PK')}</>
                )}
              </div>
            )}

            {/* Exchange method selector */}
            <div className="space-y-1.5">
              <Label className="text-xs">Exchange Method *</Label>
              <div className="grid grid-cols-1 gap-2">
                <button
                  type="button"
                  onClick={() => setExchangeMethod('courier_replacement')}
                  className={cn(
                    'text-left rounded-md border p-2.5 transition-colors',
                    exchangeMethod === 'courier_replacement'
                      ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                      : 'border-border hover:border-primary/30',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Truck className={cn('h-4 w-4', exchangeMethod === 'courier_replacement' ? 'text-primary' : 'text-muted-foreground')} />
                    <span className="text-sm font-medium">Courier Replacement</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 ml-6">Courier will deliver the new item and collect the old one in the same trip</p>
                </button>
                <button
                  type="button"
                  onClick={() => setExchangeMethod('customer_self_return')}
                  className={cn(
                    'text-left rounded-md border p-2.5 transition-colors',
                    exchangeMethod === 'customer_self_return'
                      ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                      : 'border-border hover:border-primary/30',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <UserCheck className={cn('h-4 w-4', exchangeMethod === 'customer_self_return' ? 'text-primary' : 'text-muted-foreground')} />
                    <span className="text-sm font-medium">Customer Self-Return</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 ml-6">Customer will send the old item back first. The new item ships only after we receive and verify it.</p>
                </button>
              </div>
            </div>

            {/* Reason */}
            <div className="space-y-1.5">
              <Label className="text-xs">Reason *</Label>
              <Textarea
                placeholder="e.g. Customer needs a different size"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
              />
            </div>
          </div>
        )}

        {!createdExchangeId && (
          <DialogFooter>
            <Button variant="outline" onClick={handleClose}>Cancel</Button>
            <Button
              disabled={!canSubmit}
              onClick={() => createMutation.mutate({
                original_order_item_id: orderItemId,
                new_org_variant_id: newVariantId,
                exchange_method: exchangeMethod,
                reason: reason.trim(),
              })}
            >
              {createMutation.isPending ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Submitting…</>
              ) : (
                <><RefreshCw className="h-4 w-4" /> Submit Request</>
              )}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
