'use client'

/**
 * Order Scan Module — Barcode scanning workflow + reporting.
 *
 * Two tabs:
 * 1. Scan Station — always-focused input, mode selector, instant feedback
 * 2. Reports — date range, summary cards, employee breakdown, PDF download
 *
 * Hardware: works with any USB/Bluetooth scanner in keyboard-emulation mode
 * (types the value + Enter key — the input submits on Enter automatically).
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, FetchError } from '@/lib/api-client'
import { useCan } from '@/stores/app-store'
import { PERMISSIONS } from '@/lib/permissions'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  ScanLine, CheckCircle2, XCircle, AlertCircle, Loader2, Download,
  Package, Truck, Ban, Search, ClipboardCheck, FileBarChart, Clock,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ─── Types ───

type ScanMode = 'mark_processing' | 'mark_packed' | 'warehouse_handover' | 'receive_return' | 'locate_cancelled' | 'cancel_via_scan'

interface ScanResult {
  scanResult: 'success' | 'rejected' | 'not_found'
  entity?: {
    entityType: 'order' | 'exchange_shipment'
    entityId: string
    trackingNumber: string
    status: string
    flowopsOrderNumber?: string
    exchangeShipmentNumber?: string
    customerName?: string
    courierSubStatus?: string | null
    physicalUnpackRequired?: boolean
    physicalUnpackConfirmedAt?: string | null
    items?: Array<{ sku: string; productTitle: string; quantity: number }>
  }
  rejectionReason?: string
  message?: string
}

const SCAN_MODES: { value: ScanMode; label: string; icon: typeof Package; color: string }[] = [
  { value: 'mark_processing', label: 'Mark Processing', icon: Clock, color: 'text-sky-600' },
  { value: 'mark_packed', label: 'Mark Packed', icon: Package, color: 'text-purple-600' },
  { value: 'warehouse_handover', label: 'Warehouse Handover', icon: Truck, color: 'text-indigo-600' },
  { value: 'receive_return', label: 'Receive Return', icon: ClipboardCheck, color: 'text-amber-600' },
  { value: 'locate_cancelled', label: 'Locate Cancelled', icon: Search, color: 'text-rose-600' },
  { value: 'cancel_via_scan', label: 'Cancel via Scan', icon: Ban, color: 'text-red-600' },
]

// ─── Main Component ───

export function OrderScanView() {
  const can = useCan()
  const canFulfill = can(PERMISSIONS.ORDERS_FULFILL)

  if (!canFulfill) {
    return (
      <div className="space-y-6">
        <PageHeader title="Order Scan" />
        <Card><CardContent className="p-10 text-center text-muted-foreground">
          You don&apos;t have permission to access the scan module.
        </CardContent></Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Order Scan"
        description="Scan courier tracking barcodes to trigger order actions."
      />
      <Tabs defaultValue="scan">
        <TabsList>
          <TabsTrigger value="scan" className="gap-1.5">
            <ScanLine className="h-3.5 w-3.5" /> Scan Station
          </TabsTrigger>
          <TabsTrigger value="reports" className="gap-1.5">
            <FileBarChart className="h-3.5 w-3.5" /> Reports
          </TabsTrigger>
        </TabsList>
        <TabsContent value="scan" className="mt-4">
          <ScanStation />
        </TabsContent>
        <TabsContent value="reports" className="mt-4">
          <ScanReports />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ─── Scan Station ───

function ScanStation() {
  const queryClient = useQueryClient()
  const [scanMode, setScanMode] = useState<ScanMode>('mark_processing')
  const [stationLabel, setStationLabel] = useState('')
  const [scanInput, setScanInput] = useState('')
  const [lastResult, setLastResult] = useState<ScanResult | null>(null)
  const [sessionCount, setSessionCount] = useState(0)
  const [confirmCancel, setConfirmCancel] = useState<ScanResult['entity'] | null>(null)
  const [confirmUnpack, setConfirmUnpack] = useState<ScanResult['entity'] | null>(null)
  const [confirmReturn, setConfirmReturn] = useState<ScanResult['entity'] | null>(null)
  const [returnCondition, setReturnCondition] = useState<'perfect' | 'good' | 'damaged'>('perfect')
  const [returnReason, setReturnReason] = useState('')
  const [returnNotes, setReturnNotes] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-focus the input — always refocus after any modal/action
  const refocus = useCallback(() => {
    setTimeout(() => inputRef.current?.focus(), 100)
  }, [])

  useEffect(() => {
    refocus()
  }, [refocus, scanMode, lastResult, confirmCancel, confirmUnpack, confirmReturn])

  const scanMutation = useMutation({
    mutationFn: (data: { trackingNumber: string; scanMode: ScanMode; scanStationLabel?: string }) =>
      api.post<ScanResult>('/api/scan', data),
    onSuccess: (data) => {
      setLastResult(data)
      setSessionCount((c) => c + 1)
      setScanInput('')

      // If cancel_via_scan and success → show confirmation
      if (data.scanResult === 'success' && data.entity && scanMode === 'cancel_via_scan') {
        setConfirmCancel(data.entity)
        // Invalidate so other tabs (order detail) reflect the change
        queryClient.invalidateQueries({ queryKey: ['orders'] })
        queryClient.invalidateQueries({ queryKey: ['order'] })
        return
      }

      // If receive_return and success → show return confirmation (condition + reason)
      if (data.scanResult === 'success' && data.entity && scanMode === 'receive_return') {
        setConfirmReturn(data.entity)
        setReturnCondition('perfect')
        setReturnReason('')
        setReturnNotes('')
        return
      }

      // If locate_cancelled and success + physicalUnpackRequired → show unpack confirmation
      if (data.scanResult === 'success' && data.entity && scanMode === 'locate_cancelled' && data.entity.physicalUnpackRequired && !data.entity.physicalUnpackConfirmedAt) {
        setConfirmUnpack(data.entity)
        queryClient.invalidateQueries({ queryKey: ['orders'] })
        queryClient.invalidateQueries({ queryKey: ['order'] })
        return
      }

      // Show toast
      if (data.scanResult === 'success') {
        toast.success(data.message || 'Scan successful')
        // Invalidate orders + order detail queries so any open order-detail
        // tab reflects the new status (packed → processing, audit log entry,
        // etc.). Previously this was MISSING — the scan worked backend-side
        // but the order detail page showed stale data until manual refresh.
        queryClient.invalidateQueries({ queryKey: ['orders'] })
        queryClient.invalidateQueries({ queryKey: ['order'] })
        queryClient.invalidateQueries({ queryKey: ['audit-logs'] })
      } else if (data.scanResult === 'rejected') {
        toast.warning(data.rejectionReason || 'Scan rejected')
      } else {
        toast.error(data.rejectionReason || 'Not found')
      }

      refocus()
    },
    onError: (err) => {
      toast.error(err instanceof FetchError ? err.message : 'Scan failed')
      setScanInput('')
      refocus()
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!scanInput.trim() || isProcessing) return
    setIsProcessing(true)
    scanMutation.mutate({
      trackingNumber: scanInput.trim(),
      scanMode,
      scanStationLabel: stationLabel.trim() || undefined,
    })
    setIsProcessing(false)
  }

  const confirmCancelMutation = useMutation({
    mutationFn: (entity: NonNullable<ScanResult['entity']>) =>
      api.post('/api/scan', { action: 'confirm_cancel', entityType: entity.entityType, entityId: entity.entityId }),
    onSuccess: () => {
      toast.success('Order cancelled successfully.')
      setConfirmCancel(null)
      queryClient.invalidateQueries({ queryKey: ['orders'] })
      refocus()
    },
    onError: (err) => toast.error(err instanceof FetchError ? err.message : 'Cancel failed'),
  })

  const confirmUnpackMutation = useMutation({
    mutationFn: (entity: NonNullable<ScanResult['entity']>) =>
      api.post('/api/scan', { action: 'confirm_unpack', entityType: entity.entityType, entityId: entity.entityId }),
    onSuccess: () => {
      toast.success('Physical unpack confirmed.')
      setConfirmUnpack(null)
      refocus()
    },
    onError: (err) => toast.error(err instanceof FetchError ? err.message : 'Failed to confirm'),
  })

  // Confirm return mutation — calls /api/scan/confirm-return which does
  // RTO confirmation + optional damage recording in one go (no module-hopping).
  const confirmReturnMutation = useMutation({
    mutationFn: (data: {
      orderId: string
      condition: 'perfect' | 'good' | 'damaged'
      returnReason: string
      notes?: string
    }) => api.post('/api/scan/confirm-return', data),
    onSuccess: (data: { message?: string; wasDuplicate?: boolean }) => {
      toast.success(data.message || 'Return confirmed.')
      if (data.wasDuplicate) {
        toast.info('Damage was already recorded for this order — no duplicate created.')
      }
      setConfirmReturn(null)
      setReturnReason('')
      setReturnNotes('')
      queryClient.invalidateQueries({ queryKey: ['orders'] })
      queryClient.invalidateQueries({ queryKey: ['order'] })
      queryClient.invalidateQueries({ queryKey: ['stock-loss'] })
      refocus()
    },
    onError: (err) => toast.error(err instanceof FetchError ? err.message : 'Failed to confirm return'),
  })

  return (
    <div className="space-y-4">
      {/* Mode selector + station label */}
      <div className="grid sm:grid-cols-3 gap-3">
        <div className="sm:col-span-2 space-y-1">
          <Label className="text-xs">Scan Mode</Label>
          <Select value={scanMode} onValueChange={(v) => { setScanMode(v as ScanMode); setLastResult(null); refocus() }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {SCAN_MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  <span className="flex items-center gap-2">
                    <m.icon className={cn('h-3.5 w-3.5', m.color)} /> {m.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Station Label (optional)</Label>
          <Input
            placeholder="e.g. Packing Station 1"
            value={stationLabel}
            onChange={(e) => setStationLabel(e.target.value)}
            className="text-sm"
          />
        </div>
      </div>

      {/* Scan input — ALWAYS focused */}
      <Card className={cn('border-2', lastResult?.scanResult === 'success' ? 'border-emerald-300' : lastResult?.scanResult === 'rejected' ? 'border-amber-300' : lastResult?.scanResult === 'not_found' ? 'border-rose-300' : 'border-primary/30')}>
        <CardContent className="p-6 space-y-4">
          <form onSubmit={handleSubmit}>
            <div className="flex items-center gap-2">
              <ScanLine className="h-5 w-5 text-primary shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                placeholder="Scan or type tracking number…"
                className="flex-1 h-12 text-lg font-mono border-0 outline-none bg-transparent"
                autoFocus
                autoComplete="off"
                disabled={isProcessing || !!confirmCancel || !!confirmUnpack}
              />
              {isProcessing && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
            </div>
          </form>

          {/* Last result feedback */}
          {lastResult && (
            <div className={cn(
              'rounded-lg p-3 flex items-start gap-2',
              lastResult.scanResult === 'success' ? 'bg-emerald-50 text-emerald-800' :
              lastResult.scanResult === 'rejected' ? 'bg-amber-50 text-amber-800' :
              'bg-rose-50 text-rose-800'
            )}>
              {lastResult.scanResult === 'success' ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5" />
              ) : lastResult.scanResult === 'rejected' ? (
                <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
              ) : (
                <XCircle className="h-5 w-5 shrink-0 mt-0.5" />
              )}
              <div className="flex-1 min-w-0">
                {lastResult.entity && (
                  <p className="text-sm font-medium">
                    {lastResult.entity.flowopsOrderNumber ?? lastResult.entity.exchangeShipmentNumber} · {lastResult.entity.customerName}
                  </p>
                )}
                <p className="text-xs">{lastResult.message || lastResult.rejectionReason}</p>
                {lastResult.entity?.items && lastResult.entity.items.length > 0 && (
                  <div className="mt-1 space-y-0.5">
                    {lastResult.entity.items.map((item, i) => (
                      <p key={i} className="text-[10px] font-mono">
                        {item.sku} · {item.productTitle} ×{item.quantity}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Session counter */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Scanned this session: <strong className="text-foreground">{sessionCount}</strong></span>
            <span>Mode: <strong className="text-foreground">{SCAN_MODES.find((m) => m.value === scanMode)?.label}</strong></span>
          </div>
        </CardContent>
      </Card>

      {/* Cancel confirmation dialog */}
      {confirmCancel && (
        <Card className="border-2 border-rose-300 bg-rose-50">
          <CardContent className="p-4 space-y-3">
            <p className="text-sm font-medium text-rose-900">Confirm Cancellation</p>
            <p className="text-xs text-rose-700">
              Cancel <strong>{confirmCancel.flowopsOrderNumber ?? confirmCancel.exchangeShipmentNumber}</strong> for{' '}
              <strong>{confirmCancel.customerName}</strong>? This will cancel the courier booking and the order.
              This cannot be undone.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                onClick={() => confirmCancelMutation.mutate(confirmCancel)}
                disabled={confirmCancelMutation.isPending}
              >
                {confirmCancelMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
                {' '}Confirm Cancel
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setConfirmCancel(null); refocus() }}>
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Physical unpack confirmation */}
      {confirmUnpack && (
        <Card className="border-2 border-amber-300 bg-amber-50">
          <CardContent className="p-4 space-y-3">
            <p className="text-sm font-medium text-amber-900">Confirm Physical Unpack</p>
            <p className="text-xs text-amber-700">
              Order <strong>{confirmUnpack.flowopsOrderNumber ?? confirmUnpack.exchangeShipmentNumber}</strong> was cancelled
              after packing. A physical parcel likely exists and needs to be taken apart.
              Confirm when you&apos;ve physically unpacked it.
            </p>
            {confirmUnpack.items && confirmUnpack.items.length > 0 && (
              <div className="text-xs space-y-0.5">
                {confirmUnpack.items.map((item, i) => (
                  <p key={i} className="font-mono">{item.sku} · {item.productTitle} ×{item.quantity}</p>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => confirmUnpackMutation.mutate(confirmUnpack)}
                disabled={confirmUnpackMutation.isPending}
              >
                {confirmUnpackMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                {' '}Confirm Unpacked
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setConfirmUnpack(null); refocus() }}>
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Return confirmation — shown when receive_return mode scans successfully.
          Lets the staff select the physical condition + return reason, then
          confirms RTO + (if damaged) records the damage — all in one go.
          This is the user's point #5: "when we scan a return, RTO confirmation
          should happen in one go, AND damage options should be available right there." */}
      {confirmReturn && (
        <Card className="border-2 border-amber-300 bg-amber-50">
          <CardContent className="p-4 space-y-3">
            <p className="text-sm font-medium text-amber-900">Confirm Return</p>
            <p className="text-xs text-amber-700">
              Order <strong>{confirmReturn.flowopsOrderNumber ?? confirmReturn.exchangeShipmentNumber}</strong> for{' '}
              <strong>{confirmReturn.customerName}</strong>. Select the physical condition + reason to confirm RTO.
            </p>
            {confirmReturn.items && confirmReturn.items.length > 0 && (
              <div className="text-xs space-y-0.5">
                {confirmReturn.items.map((item, i) => (
                  <p key={i} className="font-mono">{item.sku} · {item.productTitle} ×{item.quantity}</p>
                ))}
              </div>
            )}

            {/* Condition selector */}
            <div className="space-y-1.5">
              <Label className="text-xs text-amber-900">Physical condition</Label>
              <div className="grid grid-cols-3 gap-2">
                {(['perfect', 'good', 'damaged'] as const).map((cond) => (
                  <button
                    key={cond}
                    type="button"
                    onClick={() => setReturnCondition(cond)}
                    className={cn(
                      'rounded-md border p-2 text-xs font-medium capitalize transition-colors',
                      returnCondition === cond
                        ? cond === 'damaged'
                          ? 'border-rose-400 bg-rose-100 text-rose-900'
                          : 'border-emerald-400 bg-emerald-100 text-emerald-900'
                        : 'border-border bg-background hover:bg-muted/40',
                    )}
                  >
                    {cond === 'perfect' ? '✓ Perfect' : cond === 'good' ? '✓ Good' : '⚠ Damaged'}
                  </button>
                ))}
              </div>
            </div>

            {/* Return reason */}
            <div className="space-y-1.5">
              <Label className="text-xs text-amber-900">Return reason *</Label>
              <Input
                placeholder="e.g. Customer refused delivery, Wrong size, Defective…"
                value={returnReason}
                onChange={(e) => setReturnReason(e.target.value)}
                className="text-sm"
                autoFocus
              />
            </div>

            {/* Notes (optional) */}
            <div className="space-y-1.5">
              <Label className="text-xs text-amber-900">Notes (optional)</Label>
              <Input
                placeholder="Additional details…"
                value={returnNotes}
                onChange={(e) => setReturnNotes(e.target.value)}
                className="text-sm"
              />
            </div>

            {returnCondition === 'damaged' && (
              <p className="text-[10px] text-rose-700 bg-rose-50 rounded p-2">
                ⚠ Damaged condition: stock will be written off + a damage loss record will be created
                (linked to this order). If damage was already recorded, it will be deduped (no duplicate).
              </p>
            )}

            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() =>
                  confirmReturnMutation.mutate({
                    orderId: confirmReturn.entityId,
                    condition: returnCondition,
                    returnReason: returnReason.trim(),
                    notes: returnNotes.trim() || undefined,
                  })
                }
                disabled={confirmReturnMutation.isPending || !returnReason.trim()}
              >
                {confirmReturnMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                {' '}Confirm Return
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setConfirmReturn(null); refocus() }}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ─── Reports View ───

interface ReportData {
  dateFrom: string
  dateTo: string
  totalScans: number
  totalProcessingMarked: number
  totalPacked: number
  totalWarehouseHandover: number
  totalReturnsReceived: number
  totalCancellationsViaScan: number
  totalRejectedScans: number
  breakdownByEmployee: Array<{
    employeeId: string
    employeeName: string
    processingCount: number
    packedCount: number
    warehouseHandoverCount: number
    returnsCount: number
    cancellationsCount: number
    rejectedCount: number
    totalCount: number
  }>
}

const PRESETS = [
  { label: 'Today', getValue: () => { const d = new Date(); return [d, d] } },
  { label: 'This Week', getValue: () => { const d = new Date(); const start = new Date(d); start.setDate(d.getDate() - d.getDay()); return [start, d] } },
  { label: 'Previous Week', getValue: () => { const d = new Date(); const end = new Date(d); end.setDate(d.getDate() - d.getDay() - 1); const start = new Date(end); start.setDate(end.getDate() - 6); return [start, end] } },
  { label: 'This Month', getValue: () => { const d = new Date(); const start = new Date(d.getFullYear(), d.getMonth(), 1); return [start, d] } },
  { label: 'Previous Month', getValue: () => { const d = new Date(); const end = new Date(d.getFullYear(), d.getMonth(), 0); const start = new Date(d.getFullYear(), d.getMonth() - 1, 1); return [start, end] } },
  { label: 'This Year', getValue: () => { const d = new Date(); const start = new Date(d.getFullYear(), 0, 1); return [start, d] } },
]

function ScanReports() {
  const [dateFrom, setDateFrom] = useState(() => new Date().toISOString().slice(0, 10))
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10))

  const reportQuery = useQuery<ReportData>({
    queryKey: ['scan-reports', dateFrom, dateTo],
    queryFn: () => api.get<ReportData>(`/api/scan/reports?dateFrom=${dateFrom}&dateTo=${dateTo}`),
    staleTime: 30_000,
  })

  const pdfMutation = useMutation({
    mutationFn: () => api.post<{ pdfUrl: string | null }>('/api/scan/reports', { dateFrom, dateTo }),
    onSuccess: (data) => {
      if (data.pdfUrl) {
        window.open(data.pdfUrl, '_blank')
        toast.success('PDF downloaded.')
      } else {
        toast.error('Failed to generate PDF.')
      }
    },
    onError: () => toast.error('PDF generation failed.'),
  })

  function applyPreset(preset: typeof PRESETS[0]) {
    const [start, end] = preset.getValue()
    setDateFrom(start.toISOString().slice(0, 10))
    setDateTo(end.toISOString().slice(0, 10))
  }

  const data = reportQuery.data

  return (
    <div className="space-y-4">
      {/* Date range + presets */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <Button key={p.label} size="sm" variant="outline" onClick={() => applyPreset(p)}>
                {p.label}
              </Button>
            ))}
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">From</Label>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">To</Label>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="text-sm" />
            </div>
          </div>
          <Button size="sm" variant="default" onClick={() => pdfMutation.mutate()} disabled={pdfMutation.isPending}>
            {pdfMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {' '}Download PDF
          </Button>
        </CardContent>
      </Card>

      {reportQuery.isLoading && <Skeleton className="h-40" />}

      {data && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <SummaryCard label="Total Scans" value={data.totalScans} icon={ScanLine} color="text-primary" />
            <SummaryCard label="Processing" value={data.totalProcessingMarked} icon={Clock} color="text-sky-600" />
            <SummaryCard label="Packed" value={data.totalPacked} icon={Package} color="text-purple-600" />
            <SummaryCard label="Handover" value={data.totalWarehouseHandover} icon={Truck} color="text-indigo-600" />
            <SummaryCard label="Returns" value={data.totalReturnsReceived} icon={ClipboardCheck} color="text-amber-600" />
            <SummaryCard label="Cancellations" value={data.totalCancellationsViaScan} icon={Ban} color="text-red-600" />
            <SummaryCard label="Rejected" value={data.totalRejectedScans} icon={XCircle} color="text-rose-600" />
          </div>

          {/* Employee breakdown */}
          {data.breakdownByEmployee.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">Employee Breakdown</CardTitle></CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-xs">
                      <tr>
                        <th className="text-left p-3">Employee</th>
                        <th className="text-right p-3">Proc</th>
                        <th className="text-right p-3">Pack</th>
                        <th className="text-right p-3">Hand</th>
                        <th className="text-right p-3">Ret</th>
                        <th className="text-right p-3">Cancel</th>
                        <th className="text-right p-3">Reject</th>
                        <th className="text-right p-3">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.breakdownByEmployee.map((emp) => (
                        <tr key={emp.employeeId} className="border-t">
                          <td className="p-3 font-medium">{emp.employeeName}</td>
                          <td className="text-right p-3 tabular-nums">{emp.processingCount}</td>
                          <td className="text-right p-3 tabular-nums">{emp.packedCount}</td>
                          <td className="text-right p-3 tabular-nums">{emp.warehouseHandoverCount}</td>
                          <td className="text-right p-3 tabular-nums">{emp.returnsCount}</td>
                          <td className="text-right p-3 tabular-nums">{emp.cancellationsCount}</td>
                          <td className="text-right p-3 tabular-nums text-rose-600">{emp.rejectedCount}</td>
                          <td className="text-right p-3 tabular-nums font-bold">{emp.totalCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

function SummaryCard({ label, value, icon: Icon, color }: { label: string; value: number; icon: typeof Package; color: string }) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <Icon className={cn('h-5 w-5', color)} />
        <div>
          <p className="text-2xl font-bold tabular-nums">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  )
}
