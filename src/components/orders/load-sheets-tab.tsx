/**
 * Load Sheets Tab — Booking Workbench
 *
 * Courier-agnostic pickup manifest system. Combines orders AND exchange
 * shipments into a single load sheet (a courier rider physically picks up
 * both types in one trip).
 *
 * Three sections:
 *   1. Toolbar: Courier dropdown + Pickup Address dropdown
 *   2. Checklist: All entities ready for load sheet (courierBookingStatus='booked',
 *      courierSubStatus='slip_generated', loadSheetId IS NULL) for the selected courier
 *   3. History: Previously generated load sheets with re-download PDF action
 */

'use client'

import { useState, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  FileText,
  Download,
  Loader2,
  Package,
  ArrowRight,
  Truck,
  CheckCircle2,
  Hash,
  User,
  Clock,
  AlertCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, FetchError } from '@/lib/api-client'
import { getErrorMessage, formatDateTime } from './_shared'

// ── Types ─────────────────────────────────────────────────────────────────────

interface LoadSheetReadyEntity {
  id: string
  entityType: 'order' | 'exchange_shipment'
  referenceNumber: string
  trackingNumber: string
  customerName: string
  bookedAt: string | null
  courierSubStatus: string | null
}

interface LoadSheetReadyResponse {
  orders: LoadSheetReadyEntity[]
  shipments: LoadSheetReadyEntity[]
}

interface LoadSheetHistoryItem {
  id: string
  providerKey: string
  itemCount: number
  pdfStoragePath: string | null
  generatedAt: string
  generatedByName: string | null
  items: Array<{ entityType: string; entityId: string; trackingNumber: string }>
}

interface LoadSheetHistoryResponse {
  loadSheets: LoadSheetHistoryItem[]
}

interface GenerateLoadSheetResponse {
  loadSheetId: string
  pdfPath: string
  itemCount: number
}

interface PickupAddress {
  id: string
  label: string
  providerAddressCode: string
  address: string
  isDefault: boolean
}

interface CompanyIntegration {
  id: string
  connectionName: string
  isActive: boolean
  provider: { providerKey: string; providerName: string; category: string }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function LoadSheetsTab({
  courierIntegrations,
}: {
  courierIntegrations: CompanyIntegration[]
}) {
  const queryClient = useQueryClient()
  const [selectedIntegrationId, setSelectedIntegrationId] = useState<string>('')
  const [selectedPickupAddressId, setSelectedPickupAddressId] = useState<string>('')
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())
  const [generatedPdfPath, setGeneratedPdfPath] = useState<string | null>(null)

  // Auto-select the first courier integration if none selected
  useEffect(() => {
    if (!selectedIntegrationId && courierIntegrations.length > 0) {
      setSelectedIntegrationId(courierIntegrations[0].id)
    }
  }, [courierIntegrations, selectedIntegrationId])

  // Reset pickup address when integration changes
  useEffect(() => {
    setSelectedPickupAddressId('')
    setCheckedIds(new Set())
    setGeneratedPdfPath(null)
  }, [selectedIntegrationId])

  // ── Data: load-sheet-ready entities ──
  const readyQuery = useQuery<LoadSheetReadyResponse>({
    queryKey: ['load-sheet-ready', selectedIntegrationId],
    queryFn: () =>
      api.get<LoadSheetReadyResponse>(
        `/api/booking-workbench/load-sheet-ready?companyIntegrationId=${selectedIntegrationId}`,
      ),
    enabled: !!selectedIntegrationId,
    staleTime: 15_000,
  })

  // ── Data: pickup addresses for the selected integration ──
  const addressesQuery = useQuery<{ addresses: PickupAddress[] }>({
    queryKey: ['pickup-addresses', selectedIntegrationId],
    queryFn: () =>
      api.get<{ addresses: PickupAddress[] }>(
        `/api/integrations/${selectedIntegrationId}/pickup-addresses`,
      ),
    enabled: !!selectedIntegrationId,
    staleTime: 30_000,
  })

  // ── Data: load sheet history ──
  const historyQuery = useQuery<LoadSheetHistoryResponse>({
    queryKey: ['load-sheets'],
    queryFn: () => api.get<LoadSheetHistoryResponse>('/api/booking-workbench/load-sheets'),
    staleTime: 15_000,
  })

  // Auto-select default pickup address
  useEffect(() => {
    if (!selectedPickupAddressId && addressesQuery.data?.addresses) {
      const defaultAddr = addressesQuery.data.addresses.find((a) => a.isDefault)
      if (defaultAddr) {
        setSelectedPickupAddressId(defaultAddr.id)
      }
    }
  }, [addressesQuery.data, selectedPickupAddressId])

  // ── Mutation: generate load sheet ──
  const generateMutation = useMutation({
    mutationFn: (params: {
      providerKey: string
      entityRefs: Array<{ entityType: 'order' | 'exchange_shipment'; entityId: string }>
      pickupAddressId?: string
    }) =>
      api.post<GenerateLoadSheetResponse>('/api/booking-workbench/load-sheet', params),
    onSuccess: (data) => {
      toast.success(`Load sheet generated for ${data.itemCount} item(s).`)
      setGeneratedPdfPath(data.pdfPath || null)
      setCheckedIds(new Set())
      // Invalidate the ready list + history
      queryClient.invalidateQueries({ queryKey: ['load-sheet-ready', selectedIntegrationId] })
      queryClient.invalidateQueries({ queryKey: ['load-sheets'] })
      queryClient.invalidateQueries({ queryKey: ['booking-workbench-bookable'] })
      queryClient.invalidateQueries({ queryKey: ['booking-workbench-activity'] })
    },
    onError: (err) => {
      toast.error(getErrorMessage(err))
    },
  })

  // Combined ready entities (orders + shipments)
  const readyEntities = useMemo(() => {
    const data = readyQuery.data
    if (!data) return []
    return [...data.orders, ...data.shipments]
  }, [readyQuery.data])

  const selectedIntegration = courierIntegrations.find((i) => i.id === selectedIntegrationId)
  const providerKey = selectedIntegration?.provider?.providerKey ?? ''

  function toggleCheck(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (checkedIds.size === readyEntities.length) {
      setCheckedIds(new Set())
    } else {
      setCheckedIds(new Set(readyEntities.map((e) => e.id)))
    }
  }

  function handleGenerate() {
    if (!providerKey) {
      toast.error('No courier provider selected.')
      return
    }
    if (checkedIds.size === 0) {
      toast.error('Select at least one entity.')
      return
    }
    const entityRefs = readyEntities
      .filter((e) => checkedIds.has(e.id))
      .map((e) => ({ entityType: e.entityType, entityId: e.id }))
    setGeneratedPdfPath(null)
    generateMutation.mutate({
      providerKey,
      entityRefs,
      pickupAddressId: selectedPickupAddressId || undefined,
    })
  }

  const allChecked = readyEntities.length > 0 && checkedIds.size === readyEntities.length
  const pickupAddresses = addressesQuery.data?.addresses ?? []

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Courier</label>
              <Select value={selectedIntegrationId} onValueChange={setSelectedIntegrationId}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Select courier…" />
                </SelectTrigger>
                <SelectContent>
                  {courierIntegrations.map((ci) => (
                    <SelectItem key={ci.id} value={ci.id}>
                      {ci.provider.providerName} ({ci.connectionName})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Pickup Address</label>
              <Select value={selectedPickupAddressId} onValueChange={setSelectedPickupAddressId}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Select pickup address…" />
                </SelectTrigger>
                <SelectContent>
                  {pickupAddresses.length === 0 ? (
                    <SelectItem value="_none" disabled>
                      No addresses synced — use default
                    </SelectItem>
                  ) : (
                    pickupAddresses.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.isDefault ? '★ ' : ''}{a.label} ({a.providerAddressCode})
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Success banner with PDF download */}
      {generatedPdfPath && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm text-emerald-800">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span><strong>Load sheet generated.</strong> PDF is ready for download.</span>
          </div>
          <a href={generatedPdfPath} download target="_blank" rel="noopener noreferrer">
            <Button size="sm" variant="outline" className="h-7 text-xs">
              <Download className="h-3 w-3" /> Download PDF
            </Button>
          </a>
        </div>
      )}

      {/* Checklist */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              Ready for Load Sheet
              <Badge variant="secondary" className="ml-1 text-[10px] h-4 px-1">
                {readyEntities.length}
              </Badge>
            </CardTitle>
            {readyEntities.length > 0 && (
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <Checkbox checked={allChecked} onCheckedChange={toggleSelectAll} />
                  <span className="text-muted-foreground">Select all</span>
                </label>
                <Button
                  size="sm"
                  onClick={handleGenerate}
                  disabled={checkedIds.size === 0 || generateMutation.isPending}
                >
                  {generateMutation.isPending ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Generating…</>
                  ) : (
                    <>Generate Load Sheet ({checkedIds.size})</>
                  )}
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {readyQuery.isLoading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
              Loading ready entities…
            </div>
          ) : readyQuery.isError ? (
            <div className="p-8 text-center text-sm text-rose-600">
              <AlertCircle className="h-5 w-5 mx-auto mb-2" />
              Failed to load: {getErrorMessage(readyQuery.error)}
            </div>
          ) : readyEntities.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              <FileText className="h-8 w-8 mx-auto mb-2 opacity-40" />
              No entities ready for load sheet.
              <p className="text-xs mt-1">
                Entities appear here when they have courierBookingStatus=&lsquo;booked&rsquo; and
                courierSubStatus=&lsquo;slip_generated&rsquo;.
              </p>
            </div>
          ) : (
            <div className="divide-y max-h-96 overflow-y-auto">
              {readyEntities.map((e) => (
                <label
                  key={e.id}
                  className="flex items-center gap-3 p-3 hover:bg-muted/30 cursor-pointer"
                >
                  <Checkbox
                    checked={checkedIds.has(e.id)}
                    onCheckedChange={() => toggleCheck(e.id)}
                  />
                  <Badge
                    variant="outline"
                    className={
                      e.entityType === 'order'
                        ? 'text-[10px] bg-sky-50 text-sky-700 border-sky-200'
                        : 'text-[10px] bg-violet-50 text-violet-700 border-violet-200'
                    }
                  >
                    {e.entityType === 'order' ? (
                      <><Truck className="h-2.5 w-2.5 mr-0.5" /> ORD</>
                    ) : (
                      <><ArrowRight className="h-2.5 w-2.5 mr-0.5" /> EXCH</>
                    )}
                  </Badge>
                  <div className="flex-1 min-w-0 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div className="min-w-0">
                      <p className="text-muted-foreground text-[10px]">Reference</p>
                      <p className="font-mono font-medium truncate">{e.referenceNumber}</p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-muted-foreground text-[10px]">Tracking #</p>
                      <p className="font-mono truncate flex items-center gap-0.5">
                        <Hash className="h-2.5 w-2.5" />{e.trackingNumber}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-muted-foreground text-[10px]">Customer</p>
                      <p className="truncate flex items-center gap-0.5">
                        <User className="h-2.5 w-2.5" />{e.customerName}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-muted-foreground text-[10px]">Booked</p>
                      <p className="text-muted-foreground">
                        {e.bookedAt ? formatDateTime(e.bookedAt) : '—'}
                      </p>
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* History */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Load Sheet History
            <Badge variant="secondary" className="ml-1 text-[10px] h-4 px-1">
              {historyQuery.data?.loadSheets.length ?? 0}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {historyQuery.isLoading ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
              Loading history…
            </div>
          ) : historyQuery.isError ? (
            <div className="p-6 text-center text-sm text-rose-600">
              Failed to load history.
            </div>
          ) : (historyQuery.data?.loadSheets ?? []).length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No load sheets generated yet.
            </div>
          ) : (
            <div className="divide-y">
              {(historyQuery.data?.loadSheets ?? []).map((ls) => (
                <div key={ls.id} className="flex items-center justify-between gap-3 p-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <Package className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium capitalize">
                        {ls.providerKey} · {ls.itemCount} item{ls.itemCount === 1 ? '' : 's'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(ls.generatedAt)}
                        {ls.generatedByName && ` · by ${ls.generatedByName}`}
                      </p>
                    </div>
                  </div>
                  {ls.pdfStoragePath ? (
                    <a href={ls.pdfStoragePath} download target="_blank" rel="noopener noreferrer">
                      <Button size="sm" variant="outline" className="h-7 text-xs">
                        <Download className="h-3 w-3" /> PDF
                      </Button>
                    </a>
                  ) : (
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      No PDF
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
