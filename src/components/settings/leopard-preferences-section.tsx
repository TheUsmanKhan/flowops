'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Loader2, Save } from 'lucide-react'

// Mirrors the server-side LeopardPreferences type (kept in sync manually to
// avoid pulling server-only imports into the client bundle).
interface TransactionNotePrefs {
  enabled: boolean
  includeProductName: boolean
  includeProductCode: boolean
  includeColor: boolean
  includeQuantity: boolean
  position: 'start' | 'end'
  separator: string
}

interface LeopardPreferences {
  transactionNote: TransactionNotePrefs
}

const DEFAULTS: TransactionNotePrefs = {
  enabled: false,
  includeProductName: true,
  includeProductCode: true,
  includeColor: true,
  includeQuantity: true,
  position: 'start',
  separator: ' | ',
}

/**
 * Leopard Preferences — courier-integration-scoped settings for how order line
 * items should be summarized into the Leopard "special instructions" / transaction
 * note field at booking time.
 *
 * The preferences are stored as JSON on CompanyIntegration.preferencesJson and
 * consumed by booking.actions.ts when booking with a Leopard integration.
 */
export function LeopardPreferencesSection({ integrationId }: { integrationId: string }) {
  const queryClient = useQueryClient()
  const [prefs, setPrefs] = useState<TransactionNotePrefs>(DEFAULTS)
  const [userNotesExample, setUserNotesExample] = useState('Please call before delivery')

  const queryKey = useMemo(() => ['leopard-preferences', integrationId] as const, [integrationId])

  const { data, isLoading } = useQuery<LeopardPreferences>({
    queryKey,
    queryFn: () => api.get<LeopardPreferences>(`/api/integrations/${integrationId}/preferences`),
  })

  // Sync server state into local form state once loaded.
  useEffect(() => {
    if (data?.transactionNote) {
      setPrefs({ ...DEFAULTS, ...data.transactionNote })
    }
  }, [data])

  const saveMutation = useMutation({
    mutationFn: (next: TransactionNotePrefs) =>
      api.put<{ ok: boolean }>(`/api/integrations/${integrationId}/preferences`, {
        transactionNote: next,
      }),
    onSuccess: () => {
      toast.success('Leopard preferences saved.')
      queryClient.invalidateQueries({ queryKey })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to save preferences'
      toast.error(msg)
    },
  })

  // Build a live preview mirroring buildLeopardSpecialInstructions() on the server.
  const preview = useMemo(() => {
    if (!prefs.enabled) return userNotesExample.trim()
    const exampleItems = [
      {
        productTitle: 'Cotton Kurta',
        sku: 'CK-001',
        attributeValues: JSON.stringify({ Color: 'Blue', Size: 'M' }),
        quantity: 2,
      },
      {
        productTitle: 'Linen Shirt',
        sku: 'LS-014',
        attributeValues: JSON.stringify({ Color: 'White' }),
        quantity: 1,
      },
    ]
    const parts: string[] = []
    for (const item of exampleItems) {
      const segments: string[] = []
      if (prefs.includeProductName) segments.push(item.productTitle)
      if (prefs.includeProductCode) segments.push(item.sku)
      if (prefs.includeColor) {
        let color: string | null = null
        try {
          const attrs = JSON.parse(item.attributeValues) as Record<string, string>
          const key = Object.keys(attrs).find((k) => k.toLowerCase() === 'color')
          color = key ? attrs[key] : null
        } catch {
          color = null
        }
        if (color) segments.push(`Color: ${color}`)
      }
      if (prefs.includeQuantity) segments.push(`×${item.quantity}`)
      parts.push(segments.join(', '))
    }
    const productSummary = parts.join(' | ')
    const trimmedNotes = userNotesExample.trim()
    const sep = prefs.separator || ' | '
    if (!productSummary) return trimmedNotes
    if (!trimmedNotes) return productSummary
    return prefs.position === 'start'
      ? `${productSummary}${sep}${trimmedNotes}`
      : `${trimmedNotes}${sep}${productSummary}`
  }, [prefs, userNotesExample])

  const dirty = useMemo(
    () => JSON.stringify(prefs) !== JSON.stringify(data?.transactionNote ?? DEFAULTS),
    [prefs, data],
  )

  function update<K extends keyof TransactionNotePrefs>(key: K, value: TransactionNotePrefs[K]) {
    setPrefs((p) => ({ ...p, [key]: value }))
  }

  return (
    <Card className="mt-3">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Leopard Preferences</CardTitle>
        <CardDescription className="text-xs">
          Configure how order item details are appended to the Leopard transaction note at booking time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Master toggle */}
            <div className="flex items-start justify-between gap-3 rounded-md border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="leopard-prefs-enabled" className="text-sm font-medium">
                  Auto-append product details to transaction note
                </Label>
                <p className="text-xs text-muted-foreground">
                  When enabled, a summary of the order&apos;s line items is appended to (or prepended before) the courier note sent to Leopard.
                </p>
              </div>
              <Switch
                id="leopard-prefs-enabled"
                checked={prefs.enabled}
                onCheckedChange={(v) => update('enabled', v)}
              />
            </div>

            {prefs.enabled && (
              <div className="space-y-4 rounded-md border p-3">
                {/* Field selection */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Included fields
                  </Label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={prefs.includeProductName}
                        onCheckedChange={(v) => update('includeProductName', v === true)}
                      />
                      Product Name
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={prefs.includeProductCode}
                        onCheckedChange={(v) => update('includeProductCode', v === true)}
                      />
                      Product Code / SKU
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={prefs.includeColor}
                        onCheckedChange={(v) => update('includeColor', v === true)}
                      />
                      Color (from variant attributes)
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={prefs.includeQuantity}
                        onCheckedChange={(v) => update('includeQuantity', v === true)}
                      />
                      Quantity
                    </label>
                  </div>
                </div>

                {/* Position */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Position relative to user note
                  </Label>
                  <RadioGroup
                    value={prefs.position}
                    onValueChange={(v) => update('position', v === 'end' ? 'end' : 'start')}
                    className="grid grid-cols-2 gap-2"
                  >
                    <label className="flex items-center gap-2 text-sm">
                      <RadioGroupItem value="start" id="leopard-pos-start" />
                      Start (prepend)
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <RadioGroupItem value="end" id="leopard-pos-end" />
                      End (append)
                    </label>
                  </RadioGroup>
                </div>

                {/* Separator */}
                <div className="space-y-2">
                  <Label htmlFor="leopard-separator" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Separator between product summary and user note
                  </Label>
                  <Input
                    id="leopard-separator"
                    value={prefs.separator}
                    onChange={(e) => update('separator', e.target.value)}
                    placeholder=" | "
                    className="max-w-xs"
                  />
                </div>
              </div>
            )}

            {/* Live preview */}
            <div className="space-y-2 rounded-md bg-muted/50 p-3">
              <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Live preview
              </Label>
              <Input
                value={userNotesExample}
                onChange={(e) => setUserNotesExample(e.target.value)}
                placeholder="Example user note (from order.notesForCourier)"
                className="bg-background"
              />
              <div className="rounded border border-dashed bg-background p-2">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Resulting transaction note</p>
                <p className="mt-1 break-words text-sm font-mono">
                  {preview || <span className="text-muted-foreground italic">(empty)</span>}
                </p>
              </div>
            </div>

            {/* Save */}
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={() => saveMutation.mutate(prefs)}
                disabled={!dirty || saveMutation.isPending}
              >
                {saveMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                Save preferences
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
