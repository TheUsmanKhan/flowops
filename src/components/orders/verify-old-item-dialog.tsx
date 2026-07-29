'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, FetchError } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Loader2, CheckCircle2, AlertTriangle, Camera, Package } from 'lucide-react'
import { cn } from '@/lib/utils'

interface VerifyOldItemDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  exchangeId: string
  exchangeMethod: 'courier_replacement' | 'customer_self_return'
  dispatchLocationName?: string
  onVerified?: () => void
}

const CONDITIONS = [
  { value: 'perfect', label: 'Perfect', desc: 'Sealed / as-new', color: 'text-emerald-600' },
  { value: 'good', label: 'Good', desc: 'Used but resellable', color: 'text-sky-600' },
  { value: 'open_box', label: 'Open Box', desc: 'Opened, still resellable', color: 'text-amber-600' },
  { value: 'damaged', label: 'Damaged', desc: 'Cannot be resold', color: 'text-rose-600' },
] as const

export function VerifyOldItemDialog({
  open,
  onOpenChange,
  exchangeId,
  exchangeMethod,
  dispatchLocationName,
  onVerified,
}: VerifyOldItemDialogProps) {
  const queryClient = useQueryClient()
  const [condition, setCondition] = useState<'perfect' | 'good' | 'open_box' | 'damaged' | ''>('')
  const [notes, setNotes] = useState('')
  const [evidenceUrls, setEvidenceUrls] = useState<string[]>([])

  const isDamaged = condition === 'damaged'

  const verifyMutation = useMutation({
    mutationFn: () =>
      api.post(`/api/exchanges/${exchangeId}/verify-old-item`, {
        condition,
        evidence_urls: evidenceUrls,
        notes: notes.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success(
        isDamaged
          ? 'Old item verified as damaged — written off as a loss.'
          : `Old item verified (${condition}). ${exchangeMethod === 'customer_self_return' ? 'New item dispatched automatically.' : 'Exchange completed.'}`,
      )
      queryClient.invalidateQueries({ queryKey: ['exchanges'] })
      queryClient.invalidateQueries({ queryKey: ['exchange', exchangeId] })
      queryClient.invalidateQueries({ queryKey: ['inventory-pools'] })
      onVerified?.()
      handleClose()
    },
    onError: (err) => {
      toast.error(err instanceof FetchError ? err.message : 'Failed to verify old item')
    },
  })

  const handleClose = () => {
    setCondition('')
    setNotes('')
    setEvidenceUrls([])
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-4 w-4" /> Verify Old Item Received
          </DialogTitle>
          <DialogDescription>
            Manually confirm the old item has arrived and record its condition. This is the only action that processes the return in inventory.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Condition selector */}
          <div className="space-y-2">
            <Label className="text-xs">Condition *</Label>
            <div className="grid grid-cols-2 gap-2">
              {CONDITIONS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setCondition(c.value)}
                  className={cn(
                    'text-left rounded-md border p-2.5 transition-colors',
                    condition === c.value
                      ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                      : 'border-border hover:border-primary/30',
                  )}
                >
                  <p className={cn('text-sm font-medium', condition === c.value && c.color)}>{c.label}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{c.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Preview text based on condition */}
          {condition && (
            <div className={cn(
              'rounded-md border p-2.5 text-xs',
              isDamaged
                ? 'border-rose-200 bg-rose-50 text-rose-800'
                : 'border-emerald-200 bg-emerald-50 text-emerald-800',
            )}>
              {isDamaged ? (
                <span className="flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  This will be written off as a loss — no stock added.
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  This will add 1 unit back to inventory{dispatchLocationName ? ` at ${dispatchLocationName}` : ''}.
                </span>
              )}
            </div>
          )}

          {/* Customer self-return prominent note */}
          {exchangeMethod === 'customer_self_return' && condition && (
            <div className="rounded-md border border-sky-200 bg-sky-50 p-2.5 text-xs text-sky-800">
              <strong>Note:</strong> Confirming this will immediately dispatch the new item to the customer.
            </div>
          )}

          {/* Evidence photos (simplified — URLs for now) */}
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1">
              <Camera className="h-3 w-3" /> Evidence Photo URLs (optional)
            </Label>
            {evidenceUrls.map((url, i) => (
              <div key={i} className="flex gap-1">
                <Input
                  value={url}
                  onChange={(e) => {
                    const next = [...evidenceUrls]
                    next[i] = e.target.value
                    setEvidenceUrls(next)
                  }}
                  placeholder="https://…"
                  className="text-xs"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2 text-muted-foreground"
                  onClick={() => setEvidenceUrls(evidenceUrls.filter((_, idx) => idx !== i))}
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={() => setEvidenceUrls([...evidenceUrls, ''])}
            >
              + Add photo URL
            </Button>
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <Label className="text-xs">Notes (optional)</Label>
            <Textarea
              placeholder="Any observations about the returned item…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>Cancel</Button>
          <Button
            disabled={!condition || verifyMutation.isPending}
            onClick={() => verifyMutation.mutate()}
          >
            {verifyMutation.isPending ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Verifying…</>
            ) : (
              <>Confirm Verification</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
