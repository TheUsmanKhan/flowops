'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api-client'
import { AlertCircle, Package } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Reusable banner that checks for available returned stitched stock
 * for a given variant. Shows a prompt to use existing stock before
 * stitching fresh. Can be dropped into any future order-creation screen.
 */
export function ReturnedStockBanner({
  variantId,
  className,
}: {
  variantId: string
  className?: string
}) {
  const { data, isLoading } = useQuery<{ count: number; totalValue: number }>({
    queryKey: ['returned-stock', variantId],
    queryFn: async () => {
      const res = await api.get<{ items: { quantity: number; totalCost: number; status: string }[] }>(
        `/api/returned-stitched?org_variant_id=${variantId}&status=available`,
      )
      const available = res.items.filter((i) => i.status === 'available')
      return {
        count: available.reduce((sum, i) => sum + i.quantity, 0),
        totalValue: available.reduce((sum, i) => sum + i.totalCost, 0),
      }
    },
    staleTime: 30_000,
  })

  if (isLoading || !data || data.count === 0) return null

  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800',
        className,
      )}
    >
      <Package className="h-4 w-4 shrink-0 mt-0.5" />
      <div className="flex-1">
        <p className="font-medium">
          {data.count} returned piece{data.count === 1 ? '' : 's'} available
        </p>
        <p className="text-xs mt-0.5 opacity-90">
          Consider using returned stock before stitching fresh — saves the stitching cost. Total value: Rs. {data.totalValue.toLocaleString()}
        </p>
      </div>
    </div>
  )
}
