'use client'

/**
 * ShipmentTrackingCard
 * -------------------
 * Compact card summarising a single ExchangeShipment row (EXCH-{year}-{NNNNN}).
 *
 * Used inside ExchangeDetailView to surface each shipment linked to an
 * OrderExchange (1-N relation — multiple shipments may exist over the
 * exchange's lifecycle if the first is cancelled).
 *
 * Shows:
 *   - EXCH-##### shipment number + status badge (6-state lifecycle)
 *   - tracking number (if dispatched, with copy affordance)
 *   - dispatched/delivered timestamps
 *   - invoice amount (PKR-formatted)
 *   - amber "Queued — will be fulfilled when stock arrives" callout when
 *     status='backordered'
 *
 * Read-only — no mutations. The parent owns the dispatch/track actions.
 */

import {
  Package,
  Truck,
  CheckCircle2,
  Clock,
  Banknote,
  Hash,
  AlertTriangle,
  Copy,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { formatPKR, formatDateTime } from './_shared'
import { CancelCourierBookingButton } from './cancel-courier-booking-button'

export interface ShipmentTrackingCardProps {
  shipment: {
    id: string
    exchangeShipmentNumber: string
    status: string
    quantity: number
    invoiceAmount: number
    trackingNumber: string | null
    dispatchedAt: string | null
    deliveredAt: string | null
    returnedAt: string | null
    createdAt: string
    courierSubStatus?: string | null
  }
}

// 6-state simplified ExchangeShipment lifecycle (mirrors migration 008 CHECK).
const SHIPMENT_STATUS_BADGE: Record<
  string,
  { label: string; className: string }
> = {
  pending: {
    label: 'Pending',
    className: 'bg-gray-100 text-gray-700 border-gray-200',
  },
  confirmed: {
    label: 'Confirmed',
    className: 'bg-sky-50 text-sky-700 border-sky-200',
  },
  backordered: {
    label: 'Backordered',
    className: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  dispatched: {
    label: 'Dispatched',
    className: 'bg-violet-50 text-violet-700 border-violet-200',
  },
  delivered: {
    label: 'Delivered',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  rto: {
    label: 'Returned (RTO)',
    className: 'bg-rose-50 text-rose-700 border-rose-200',
  },
  cancelled: {
    label: 'Cancelled',
    className: 'bg-slate-100 text-slate-500 border-slate-200',
  },
}

export function ShipmentTrackingCard({ shipment }: ShipmentTrackingCardProps) {
  const badge =
    SHIPMENT_STATUS_BADGE[shipment.status] ?? {
      label:
        shipment.status.charAt(0).toUpperCase() +
        shipment.status.slice(1).replace(/_/g, ' '),
      className: 'bg-gray-100 text-gray-700 border-gray-200',
    }

  const isBackordered = shipment.status === 'backordered'
  const isCancelled = shipment.status === 'cancelled'
  const isRto = shipment.status === 'rto'

  async function handleCopyTracking() {
    if (!shipment.trackingNumber) return
    try {
      await navigator.clipboard.writeText(shipment.trackingNumber)
      toast.success('Tracking number copied')
    } catch {
      toast.error('Could not copy tracking number')
    }
  }

  return (
    <Card
      className={cn(
        'overflow-hidden',
        isBackordered && 'border-amber-200',
        isCancelled && 'opacity-70',
      )}
    >
      <CardContent className="p-4 space-y-3">
        {/* Header: shipment number + status */}
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Package className="h-3 w-3 shrink-0" />
              <span className="uppercase tracking-wide">Exchange Shipment</span>
            </div>
            <p className="font-mono text-sm font-semibold truncate">
              {shipment.exchangeShipmentNumber}
            </p>
          </div>
          <Badge variant="outline" className={cn('text-[10px] shrink-0', badge.className)}>
            {badge.label}
          </Badge>
        </div>

        {/* Backorder notice */}
        {isBackordered && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              <strong className="font-semibold">Queued</strong> — will be
              fulfilled when stock arrives. Priority backorder (fulfilled ahead
              of regular order items).
            </span>
          </div>
        )}

        {/* RTO notice — replacement item was returned, requires manual follow-up */}
        {isRto && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              <strong className="font-semibold">Replacement item was returned</strong> — the
              courier returned this shipment. Inventory has been restored. This
              requires <strong className="font-semibold">manual follow-up</strong> (re-send,
              refund, or contact customer). No automatic re-exchange is triggered.
            </span>
          </div>
        )}

        {/* Tracking + timestamps grid */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          {/* Quantity */}
          <div className="space-y-0.5">
            <p className="text-muted-foreground flex items-center gap-1">
              <Package className="h-3 w-3" /> Quantity
            </p>
            <p className="font-medium tabular-nums">{shipment.quantity}</p>
          </div>

          {/* Invoice amount */}
          <div className="space-y-0.5">
            <p className="text-muted-foreground flex items-center gap-1">
              <Banknote className="h-3 w-3" /> Invoice
            </p>
            <p className="font-medium tabular-nums">
              {formatPKR(Number(shipment.invoiceAmount) || 0)}
            </p>
          </div>

          {/* Tracking number */}
          <div className="space-y-0.5 col-span-2">
            <p className="text-muted-foreground flex items-center gap-1">
              <Hash className="h-3 w-3" /> Tracking #
            </p>
            {shipment.trackingNumber ? (
              <div className="flex items-center gap-1.5">
                <span className="font-mono font-medium text-xs">
                  {shipment.trackingNumber}
                </span>
                <button
                  type="button"
                  onClick={handleCopyTracking}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Copy tracking number"
                >
                  <Copy className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <span className="text-muted-foreground italic">
                Not yet assigned
              </span>
            )}
          </div>

          {/* Dispatched at */}
          <div className="space-y-0.5">
            <p className="text-muted-foreground flex items-center gap-1">
              <Truck className="h-3 w-3" /> Dispatched
            </p>
            <p
              className={cn(
                'text-xs',
                shipment.dispatchedAt
                  ? 'font-medium'
                  : 'text-muted-foreground italic',
              )}
            >
              {formatDateTime(shipment.dispatchedAt)}
            </p>
          </div>

          {/* Delivered at */}
          <div className="space-y-0.5">
            <p className="text-muted-foreground flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" /> Delivered
            </p>
            <p
              className={cn(
                'text-xs',
                shipment.deliveredAt
                  ? 'font-medium text-emerald-700'
                  : 'text-muted-foreground italic',
              )}
            >
              {formatDateTime(shipment.deliveredAt)}
            </p>
          </div>

          {/* Returned at (only shown when RTO) */}
          {isRto && (
            <div className="space-y-0.5 col-span-2">
              <p className="text-muted-foreground flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> Returned
              </p>
              <p className="text-xs font-medium text-rose-700">
                {formatDateTime(shipment.returnedAt)}
              </p>
            </div>
          )}

          {/* Created at */}
          <div className="space-y-0.5 col-span-2">
            <p className="text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" /> Created
            </p>
            <p className="text-xs text-muted-foreground">
              {formatDateTime(shipment.createdAt)}
            </p>
          </div>
        </div>

        {/* Cancel courier booking button — only shown when cancellable (slip_generated / pickup_requested) */}
        {shipment.trackingNumber && !isCancelled && (
          <CancelCourierBookingButton
            entityType="exchange_shipment"
            entityId={shipment.id}
            courierSubStatus={shipment.courierSubStatus}
          />
        )}
      </CardContent>
    </Card>
  )
}
