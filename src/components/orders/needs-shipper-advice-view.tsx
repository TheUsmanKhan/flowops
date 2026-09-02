'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, FetchError } from '@/lib/api-client'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Loader2, AlertCircle, Send, Truck, ArrowRight } from 'lucide-react'
import { formatDate, getErrorMessage } from './_shared'
import { getCourierSubStatusLabel } from '@/lib/integrations/couriers/postex.status-labels'

interface AdviceQueueItem {
  id: string
  referenceNumber: string
  trackingNumber: string
  customerName: string
  status: string
  courierSubStatus: string | null
  courierName: string | null
  providerKey: string
  lastShipperAdviceSubmittedAt: string | null
  lastShipperAdviceType: string | null
}

interface AdviceQueueResponse {
  orders: AdviceQueueItem[]
  shipments: AdviceQueueItem[]
}

export function NeedsShipperAdviceView() {
  const queryClient = useQueryClient()
  const [respondTarget, setRespondTarget] = useState<(AdviceQueueItem & { entityType: 'order' | 'exchange_shipment' }) | null>(null)

  const queueQuery = useQuery<AdviceQueueResponse>({
    queryKey: ['shipper-advice-queue'],
    queryFn: () => api.get<AdviceQueueResponse>('/api/shipper-advice/queue'),
    staleTime: 30_000,
  })

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['shipper-advice-queue'] })
  }

  const allItems = [
    ...(queueQuery.data?.orders ?? []).map((o) => ({ ...o, entityType: 'order' as const })),
    ...(queueQuery.data?.shipments ?? []).map((s) => ({ ...s, entityType: 'exchange_shipment' as const })),
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Needs Shipper Advice"
        description="Orders and exchange shipments flagged by the courier as needing shipper input (failed delivery attempts, under review, etc.). Clear this queue each morning."
      />

      {queueQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : queueQuery.isError ? (
        <Card><CardContent className="p-6 text-center text-sm text-rose-600">
          Failed to load: {getErrorMessage(queueQuery.error)}
        </CardContent></Card>
      ) : allItems.length === 0 ? (
        <Card><CardContent className="p-12 text-center">
          <AlertCircle className="h-10 w-10 text-emerald-500 mx-auto mb-3" />
          <p className="text-sm font-medium text-emerald-700">All clear!</p>
          <p className="text-xs text-muted-foreground mt-1">No shipments currently need shipper advice.</p>
        </CardContent></Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-rose-600" />
              {allItems.length} item{allItems.length === 1 ? '' : 's'} need attention
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y">
              {allItems.map((item) => (
                <div key={`${item.entityType}-${item.id}`} className="flex items-center gap-3 p-3">
                  <Badge
                    variant="outline"
                    className={
                      item.entityType === 'order'
                        ? 'text-[10px] bg-sky-50 text-sky-700 border-sky-200'
                        : 'text-[10px] bg-violet-50 text-violet-700 border-violet-200'
                    }
                  >
                    {item.entityType === 'order' ? <><Truck className="h-2.5 w-2.5 mr-0.5" /> ORD</> : <><ArrowRight className="h-2.5 w-2.5 mr-0.5" /> EXCH</>}
                  </Badge>
                  <div className="flex-1 min-w-0 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div className="min-w-0">
                      <p className="text-muted-foreground text-[10px]">Reference</p>
                      <p className="font-mono font-medium truncate">{item.referenceNumber}</p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-muted-foreground text-[10px]">Tracking #</p>
                      <p className="font-mono truncate">{item.trackingNumber}</p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-muted-foreground text-[10px]">Customer</p>
                      <p className="truncate">{item.customerName}</p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-muted-foreground text-[10px]">Status / Courier</p>
                      <p className="truncate">
                        {getCourierSubStatusLabel(item.courierSubStatus)}
                        <span className="text-muted-foreground"> · {item.courierName ?? '—'}</span>
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {item.lastShipperAdviceType && (
                      <span className="text-[10px] text-muted-foreground hidden sm:inline">
                        Last: {item.lastShipperAdviceType === 'RA' ? 'Re-Attempt' : 'Return'}
                      </span>
                    )}
                    <Badge variant="outline" className="text-[9px] capitalize">{item.providerKey}</Badge>
                    {item.providerKey === 'leopard' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs border-rose-300 text-rose-700 hover:bg-rose-100"
                        onClick={() => setRespondTarget({ ...item })}
                      >
                        <Send className="h-3 w-3" /> Respond
                      </Button>
                    ) : (
                      <span className="text-[10px] text-muted-foreground italic">Read-only</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Shipper Advice Dialog */}
      {respondTarget && (
        <ShipperAdviceQueueDialog
          target={respondTarget}
          onClose={() => setRespondTarget(null)}
          onSuccess={() => {
            setRespondTarget(null)
            invalidate()
          }}
        />
      )}
    </div>
  )
}

function ShipperAdviceQueueDialog({
  target,
  onClose,
  onSuccess,
}: {
  target: AdviceQueueItem & { entityType: 'order' | 'exchange_shipment' }
  onClose: () => void
  onSuccess: () => void
}) {
  const [adviceType, setAdviceType] = useState<string>('')
  const [notes, setNotes] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const adviceOptions = [
    { value: 'RA', label: 'Re-Attempt Delivery', description: 'Request the courier to retry delivery to the consignee' },
    { value: 'RT', label: 'Return Shipment', description: 'Instruct the courier to return the shipment to origin' },
  ]

  async function handleSubmit() {
    if (!adviceType) {
      toast.error('Please select an advice type.')
      return
    }
    setIsSubmitting(true)
    try {
      await api.post('/api/shipper-advice', {
        entityType: target.entityType,
        entityId: target.id,
        adviceType,
        notes: notes.trim() || undefined,
      })
      toast.success('Shipper advice submitted successfully.')
      onSuccess()
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to submit advice')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !isSubmitting && !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send Shipper Advice to Leopard</DialogTitle>
          <DialogDescription>
            {target.referenceNumber} · Tracking: <span className="font-mono">{target.trackingNumber}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label className="text-xs font-medium">Advice Type *</Label>
            <RadioGroup value={adviceType} onValueChange={setAdviceType}>
              {adviceOptions.map((opt) => (
                <label
                  key={opt.value}
                  className={`flex items-start gap-2 p-2.5 rounded-md border cursor-pointer transition-colors ${
                    adviceType === opt.value ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
                  }`}
                >
                  <RadioGroupItem value={opt.value} className="mt-0.5" />
                  <div>
                    <p className="text-sm font-medium">{opt.label}</p>
                    <p className="text-[10px] text-muted-foreground">{opt.description}</p>
                  </div>
                </label>
              ))}
            </RadioGroup>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Notes (optional)</Label>
            <Textarea
              placeholder="Any additional remarks for the courier…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="text-xs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || !adviceType}>
            {isSubmitting ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Submitting…</>
            ) : (
              <><Send className="h-3.5 w-3.5" /> Submit Advice</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
