'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { ArrowLeft, Loader2, Lock, CheckCircle2, DollarSign, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { formatPKR } from '@/components/orders/_shared'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

interface Payslip {
  id: string
  employeeId: string
  employeeName: string
  designation: string | null
  baseSalary: number
  commissionEarned: number
  advanceDeduction: number
  otherDeductions: number
  otherAllowances: number
  grossPay: number
  netPay: number
  paymentStatus: string
  paymentDate: string | null
  paymentMethod: string | null
  paymentReference: string | null
}

interface RunDetail {
  run: {
    id: string
    periodMonth: number
    periodYear: number
    status: string
    generatedAt: string | null
    finalizedAt: string | null
  }
  payslips: Payslip[]
}

export function PayrollRunDetailView({ runId }: { runId: string }) {
  const navigate = useAppStore((s) => s.navigate)
  const queryClient = useQueryClient()
  const [adjustPayslip, setAdjustPayslip] = useState<Payslip | null>(null)
  const [payDialog, setPayDialog] = useState<Payslip | null>(null)

  const { data, isLoading } = useQuery<RunDetail>({
    queryKey: ['payroll-run', runId],
    queryFn: () => api.get<RunDetail>(`/api/payroll/${runId}`),
  })

  const isDraft = data?.run.status === 'draft'
  const isFinalized = data?.run.status === 'finalized'

  const finalizeMutation = useMutation({
    mutationFn: () => api.patch(`/api/payroll/${runId}`, { action: 'finalize' }),
    onSuccess: () => {
      toast.success('Payroll run finalized — payslips are now locked')
      queryClient.invalidateQueries({ queryKey: ['payroll-run', runId] })
      queryClient.invalidateQueries({ queryKey: ['payroll-runs'] })
    },
    onError: (err) => toast.error(err instanceof FetchError ? err.message : 'Failed to finalize'),
  })

  const markAllPaidMutation = useMutation({
    mutationFn: () => api.patch(`/api/payroll/${runId}`, { action: 'mark_all_paid', paymentMethod: 'bank_transfer' }),
    onSuccess: (r: any) => {
      toast.success(`${r.markedCount} payslips marked as paid`)
      queryClient.invalidateQueries({ queryKey: ['payroll-run', runId] })
      queryClient.invalidateQueries({ queryKey: ['payroll-runs'] })
    },
    onError: (err) => toast.error(err instanceof FetchError ? err.message : 'Failed to mark as paid'),
  })

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const { run, payslips } = data
  const totalNet = payslips.reduce((s, p) => s + p.netPay, 0)
  const totalCommission = payslips.reduce((s, p) => s + p.commissionEarned, 0)
  const pendingCount = payslips.filter((p) => p.paymentStatus === 'pending').length

  return (
    <div className="space-y-6">
      <button
        onClick={() => navigate({ name: 'payroll' })}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to payroll
      </button>

      <PageHeader
        title={`${MONTHS[run.periodMonth - 1]} ${run.periodYear}`}
        description={`${payslips.length} payslips · Total net pay: ${formatPKR(totalNet)}`}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={run.status} />
            {isDraft && (
              <Button
                onClick={() => finalizeMutation.mutate()}
                disabled={finalizeMutation.isPending}
              >
                {finalizeMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Lock className="h-4 w-4" /> Finalize
                  </>
                )}
              </Button>
            )}
            {isFinalized && pendingCount > 0 && (
              <Button
                variant="outline"
                onClick={() => markAllPaidMutation.mutate()}
                disabled={markAllPaidMutation.isPending}
              >
                {markAllPaidMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4" /> Mark All Paid
                  </>
                )}
              </Button>
            )}
          </div>
        }
      />

      {isDraft && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-3 flex items-center gap-2">
            <Lock className="h-4 w-4 text-amber-600" />
            <p className="text-xs text-amber-800">
              Draft mode — payslips are editable. Once finalized, amounts become
              immutable. Corrections after finalization must be made in a later run.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard label="Payslips" value={payslips.length.toString()} />
        <SummaryCard label="Total Net Pay" value={formatPKR(totalNet)} />
        <SummaryCard label="Total Commission" value={formatPKR(totalCommission)} />
        <SummaryCard label="Pending Payment" value={pendingCount.toString()} />
      </div>

      {/* Payslips table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead className="text-right">Base</TableHead>
                  <TableHead className="text-right">Commission</TableHead>
                  <TableHead className="text-right">Allowances</TableHead>
                  <TableHead className="text-right">Deductions</TableHead>
                  <TableHead className="text-right">Net Pay</TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {payslips.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <p className="text-sm font-medium">{p.employeeName}</p>
                      {p.designation && (
                        <p className="text-xs text-muted-foreground">{p.designation}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {formatPKR(p.baseSalary)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm text-emerald-600">
                      {p.commissionEarned > 0 ? formatPKR(p.commissionEarned) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {p.otherAllowances > 0 ? formatPKR(p.otherAllowances) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm text-rose-600">
                      {p.otherDeductions > 0 ? formatPKR(p.otherDeductions) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatPKR(p.netPay)}
                    </TableCell>
                    <TableCell>
                      {p.paymentStatus === 'paid' ? (
                        <Badge variant="outline" className="text-emerald-700 border-emerald-200 bg-emerald-50 text-xs">
                          Paid
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-amber-700 border-amber-200 bg-amber-50 text-xs">
                          Pending
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {isDraft && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setAdjustPayslip(p)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {isFinalized && p.paymentStatus === 'pending' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPayDialog(p)}
                        >
                          <DollarSign className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Adjust dialog */}
      {adjustPayslip && (
        <AdjustDialog
          payslip={adjustPayslip}
          runId={runId}
          onClose={() => setAdjustPayslip(null)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['payroll-run', runId] })
            setAdjustPayslip(null)
          }}
        />
      )}

      {/* Mark paid dialog */}
      {payDialog && (
        <MarkPaidDialog
          payslip={payDialog}
          runId={runId}
          onClose={() => setPayDialog(null)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['payroll-run', runId] })
            setPayDialog(null)
          }}
        />
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'draft': return <Badge variant="outline" className="text-amber-700 border-amber-200 bg-amber-50">Draft</Badge>
    case 'finalized': return <Badge variant="outline" className="text-sky-700 border-sky-200 bg-sky-50">Finalized</Badge>
    case 'paid': return <Badge variant="outline" className="text-emerald-700 border-emerald-200 bg-emerald-50">Paid</Badge>
    default: return <Badge variant="outline">{status}</Badge>
  }
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-bold tabular-nums mt-1">{value}</p>
      </CardContent>
    </Card>
  )
}

function AdjustDialog({
  payslip, runId, onClose, onSuccess,
}: {
  payslip: Payslip
  runId: string
  onClose: () => void
  onSuccess: () => void
}) {
  const [allowances, setAllowances] = useState(payslip.otherAllowances.toString())
  const [deductions, setDeductions] = useState(payslip.otherDeductions.toString())
  const [saving, setSaving] = useState(false)

  const liveGross = payslip.baseSalary + payslip.commissionEarned + (parseFloat(allowances) || 0)
  const liveNet = liveGross - payslip.advanceDeduction - (parseFloat(deductions) || 0)

  async function save() {
    setSaving(true)
    try {
      await api.put(`/api/payroll/${runId}`, {
        payslipId: payslip.id,
        action: 'adjust',
        otherAllowances: parseFloat(allowances) || 0,
        otherDeductions: parseFloat(deductions) || 0,
      })
      toast.success('Payslip adjusted')
      onSuccess()
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to adjust')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust payslip — {payslip.employeeName}</DialogTitle>
          <DialogDescription>
            Adjust allowances (bonus) or deductions. Base salary and commission
            are fixed — they reflect the order data for this period.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Base salary</p>
              <p className="font-medium">{formatPKR(payslip.baseSalary)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Commission</p>
              <p className="font-medium text-emerald-600">{formatPKR(payslip.commissionEarned)}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="allowances">Other allowances (bonus)</Label>
              <Input id="allowances" type="number" value={allowances} onChange={(e) => setAllowances(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="deductions">Other deductions</Label>
              <Input id="deductions" type="number" value={deductions} onChange={(e) => setDeductions(e.target.value)} />
            </div>
          </div>
          <div className="rounded-md border bg-muted/30 p-3 space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Gross pay</span>
              <span className="font-medium tabular-nums">{formatPKR(liveGross)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Net pay</span>
              <span className="font-bold tabular-nums text-primary">{formatPKR(liveNet)}</span>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save adjustment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MarkPaidDialog({
  payslip, runId, onClose, onSuccess,
}: {
  payslip: Payslip
  runId: string
  onClose: () => void
  onSuccess: () => void
}) {
  const [method, setMethod] = useState('bank_transfer')
  const [reference, setReference] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      await api.put(`/api/payroll/${runId}`, {
        payslipId: payslip.id,
        action: 'mark_paid',
        paymentMethod: method,
        paymentReference: reference || undefined,
      })
      toast.success('Payslip marked as paid')
      onSuccess()
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to mark as paid')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark as paid — {payslip.employeeName}</DialogTitle>
          <DialogDescription>
            Net pay: {formatPKR(payslip.netPay)}. Record the payment details.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Payment method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="cheque">Cheque</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reference">Payment reference (optional)</Label>
            <Input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Transaction ID / cheque number" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Mark as paid'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
