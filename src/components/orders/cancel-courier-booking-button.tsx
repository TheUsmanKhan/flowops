'use client'

/**
 * CancelCourierBookingButton — shared component for cancelling a courier
 * booking on both the courier side (PostEx) and in FlowOps.
 *
 * Placement (4 locations, all using this ONE component):
 *   1. Orders list view — per-row action
 *   2. Order Detail page — in the Delivery/Courier card
 *   3. Exchange Detail page — in the Shipment Tracking card
 *   4. Booking Workbench — Booking Activity tab row actions
 *
 * Visibility: only shown when courierSubStatus is 'slip_generated' or
 * 'pickup_requested' (i.e. the package hasn't been physically picked up yet).
 * The server action independently enforces this guard.
 *
 * Behavior:
 *   - Click → confirmation dialog ("Cancel this order? This will cancel the
 *     courier booking and the order. This cannot be undone.")
 *   - While in flight: disabled + loading spinner
 *   - On success: toast + invalidate relevant query caches
 *   - On failure: toast with the specific error message, entity stays in prior state
 */

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, FetchError } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
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
import { Ban, Loader2 } from 'lucide-react'
import { isCancellableCourierStatus } from '@/lib/integrations/couriers/postex.status-labels'
import { getErrorMessage } from '@/components/orders/_shared'

export interface CancelCourierBookingButtonProps {
  entityType: 'order' | 'exchange_shipment'
  entityId: string
  courierSubStatus: string | null | undefined
  /** Optional: size variant (default 'sm') */
  size?: 'sm' | 'default'
  /** Optional: variant (default 'ghost') */
  variant?: 'ghost' | 'outline' | 'default'
}

export function CancelCourierBookingButton({
  entityType,
  entityId,
  courierSubStatus,
  size = 'sm',
  variant = 'ghost',
}: CancelCourierBookingButtonProps) {
  const queryClient = useQueryClient()
  const [showConfirm, setShowConfirm] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)

  // Hide the button entirely if the status is not cancellable
  if (!isCancellableCourierStatus(courierSubStatus)) {
    return null
  }

  async function handleCancel() {
    setIsCancelling(true)
    try {
      await api.post('/api/courier-cancel', { entityType, entityId })
      toast.success('Courier booking cancelled successfully. Stock has been released.')

      // Invalidate ALL relevant query caches so every UI surface reflects
      // the cancelled state immediately without manual refresh.
      queryClient.invalidateQueries({ queryKey: ['orders'] })
      queryClient.invalidateQueries({ queryKey: ['order', entityId] })
      queryClient.invalidateQueries({ queryKey: ['booking-workbench-bookable'] })
      queryClient.invalidateQueries({ queryKey: ['booking-workbench-activity'] })
      queryClient.invalidateQueries({ queryKey: ['exchanges'] })
      queryClient.invalidateQueries({ queryKey: ['exchange', entityId] })
      queryClient.invalidateQueries({ queryKey: ['inventory-pools'] })
    } catch (err) {
      const msg = err instanceof FetchError
        ? err.message
        : getErrorMessage(err)
      toast.error(`Failed to cancel: ${msg}`)
    } finally {
      setIsCancelling(false)
      setShowConfirm(false)
    }
  }

  return (
    <>
      <Button
        size={size}
        variant={variant}
        className="text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50"
        onClick={() => setShowConfirm(true)}
        disabled={isCancelling}
      >
        {isCancelling ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Ban className="h-3 w-3" />
        )}
        {' '}Cancel Courier
      </Button>

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this {entityType === 'order' ? 'order' : 'shipment'}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will cancel the courier booking on PostEx AND cancel the{' '}
              {entityType === 'order' ? 'order' : 'exchange shipment'} in FlowOps.
              Reserved stock will be released back to inventory.
              <br /><br />
              <strong>This action cannot be undone.</strong> The tracking number
              will be preserved for audit purposes, but the booking will be
              permanently cancelled on the courier side.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isCancelling}>Keep Order</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700 text-white"
              onClick={handleCancel}
              disabled={isCancelling}
            >
              {isCancelling ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Cancelling…</>
              ) : (
                <><Ban className="h-3.5 w-3.5" /> Cancel Booking & Order</>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
