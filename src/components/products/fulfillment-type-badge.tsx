'use client'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { Package, Clock } from 'lucide-react'
import {
  FULFILLMENT_LABELS,
  STITCHING_LABELS,
} from '@/lib/constants/fulfillment-types'

/** Shows "Stock Based" (blue) or "Made to Order" (purple) clearly. */
export function FulfillmentTypeBadge({
  type,
  className,
}: {
  type: string
  className?: string
}) {
  const isStock = type === 'stock_based'
  return (
    <Badge
      variant="outline"
      className={cn(
        'gap-1 text-xs font-medium',
        isStock
          ? 'bg-sky-50 text-sky-700 border-sky-200'
          : 'bg-purple-50 text-purple-700 border-purple-200',
        className,
      )}
    >
      {isStock ? (
        <Package className="h-3 w-3" />
      ) : (
        <Clock className="h-3 w-3" />
      )}
      {FULFILLMENT_LABELS[type] ?? type}
    </Badge>
  )
}

/** Stitching type badge. */
export function StitchingTypeBadge({
  type,
  className,
}: {
  type: string | null | undefined
  className?: string
}) {
  if (!type) return null
  return (
    <Badge variant="outline" className={cn('text-xs', className)}>
      {STITCHING_LABELS[type] ?? type}
    </Badge>
  )
}
