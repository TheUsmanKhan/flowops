'use client'

/**
 * MyPayslipsTab — employee-facing personal payslip history.
 *
 * Distinct from the HR-side Salary & Commission tab (Phase 7 — policy/definition,
 * manager-visible). This tab is the employee's personal, read-only payslip history:
 *   - List of past payslips (finalized/paid only — never draft)
 *   - Click into a payslip for full breakdown
 *   - Download PDF button
 *   - Active advance balance display
 *
 * Access control: identity check only — an employee can only ever view/download
 * their OWN payslips. No permission toggle needed.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api-client'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Loader2, Download, Receipt, ChevronRight, Wallet, TrendingDown } from 'lucide-react'
import { formatPKR } from '@/components/orders/_shared'
import { format } from 'date-fns'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

interface OwnPayslip {
  id: string
  periodMonth: number
  periodYear: number
  runStatus: string
  baseSalary: number
  commissionEarned: number
  advanceDeduction: number
  otherDeductions: number
  otherAllowances: number
  grossPay: number
  netPay: number
  paymentStatus: string
  paymentDate: string | null
}

interface OwnAdvance {
  id: string
  amount: number
  reason: string
  dateGiven: string
  repaymentPlan: string
  installmentAmount: number | null
  remainingBalance: number
  status: string
}

export function MyPayslipsTab({ employeeId }: { employeeId: string }) {
  const [selectedPayslip, setSelectedPayslip] = useState<OwnPayslip | null>(null)
  const [downloading, setDownloading] = useState(false)

  const { data: payslipsData, isLoading: payslipsLoading } = useQuery<{ payslips: OwnPayslip[] }>({
    queryKey: ['own-payslips'],
    queryFn: () => api.get<{ payslips: OwnPayslip[] }>('/api/payroll/payslips/own'),
  })

  const { data: advancesData } = useQuery<{ advances: OwnAdvance[] }>({
    queryKey: ['own-advances'],
    queryFn: () => api.get<{ advances: OwnAdvance[] }>('/api/advances/own'),
  })

  const payslips = payslipsData?.payslips ?? []
  const activeAdvances = (advancesData?.advances ?? []).filter((a) => a.status === 'active')
  const totalAdvanceBalance = activeAdvances.reduce((s, a) => s + a.remainingBalance, 0)

  async function downloadPdf(payslipId: string) {
    setDownloading(true)
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_session_token') : null
      const response = await fetch(`/api/payroll/payslips/own/${payslipId}?format=pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!response.ok) throw new Error('Failed to download PDF')
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = window.document.createElement('a')
      a.href = url
      a.download = 'payslip.pdf'
      window.document.body.appendChild(a)
      a.click()
      window.document.body.removeChild(a)
      window.URL.revokeObjectURL(url)
    } catch (err) {
      console.error('PDF download failed:', err)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Active advance balance */}
      {totalAdvanceBalance > 0 && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-4 flex items-center gap-3">
            <TrendingDown className="h-5 w-5 text-amber-600" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-800">
                Outstanding salary advance: {formatPKR(totalAdvanceBalance)}
              </p>
              <p className="text-xs text-amber-700 mt-0.5">
                {activeAdvances.length} active advance{activeAdvances.length === 1 ? '' : 's'} ·
                Deducted automatically from future payroll runs
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Payslip history */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Receipt className="h-4 w-4 text-muted-foreground" />
            Payslip history
          </CardTitle>
          <CardDescription>
            Your official payslips from finalized payroll runs. Download as PDF for your records.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead className="text-right">Gross Pay</TableHead>
                <TableHead className="text-right">Deductions</TableHead>
                <TableHead className="text-right">Net Pay</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {payslipsLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center">
                    <Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ) : payslips.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    <Receipt className="h-8 w-8 mx-auto mb-2 opacity-40" />
                    No finalized payslips yet. Your payslips will appear here once
                    payroll is finalized.
                  </TableCell>
                </TableRow>
              ) : (
                payslips.map((p) => {
                  const totalDeductions = p.advanceDeduction + p.otherDeductions
                  return (
                    <TableRow
                      key={p.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => setSelectedPayslip(p)}
                    >
                      <TableCell className="font-medium">
                        {MONTHS[p.periodMonth - 1]} {p.periodYear}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-sm">
                        {formatPKR(p.grossPay)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-sm text-rose-600">
                        {totalDeductions > 0 ? `-${formatPKR(totalDeductions)}` : '—'}
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
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Payslip detail dialog */}
      {selectedPayslip && (
        <Dialog open onOpenChange={() => setSelectedPayslip(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                Payslip — {MONTHS[selectedPayslip.periodMonth - 1]} {selectedPayslip.periodYear}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {/* Earnings */}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">EARNINGS</p>
                <div className="space-y-1.5">
                  <DetailRow label="Base salary" value={formatPKR(selectedPayslip.baseSalary)} />
                  {selectedPayslip.commissionEarned > 0 && (
                    <DetailRow label="Commission" value={formatPKR(selectedPayslip.commissionEarned)} positive />
                  )}
                  {selectedPayslip.otherAllowances > 0 && (
                    <DetailRow label="Allowances / bonus" value={formatPKR(selectedPayslip.otherAllowances)} positive />
                  )}
                  <div className="flex justify-between border-t pt-1.5 mt-1.5">
                    <span className="text-sm font-medium">Gross pay</span>
                    <span className="text-sm font-bold tabular-nums">{formatPKR(selectedPayslip.grossPay)}</span>
                  </div>
                </div>
              </div>

              {/* Deductions */}
              {(selectedPayslip.advanceDeduction > 0 || selectedPayslip.otherDeductions > 0) && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">DEDUCTIONS</p>
                  <div className="space-y-1.5">
                    {selectedPayslip.advanceDeduction > 0 && (
                      <DetailRow label="Advance deduction" value={`-${formatPKR(selectedPayslip.advanceDeduction)}`} negative />
                    )}
                    {selectedPayslip.otherDeductions > 0 && (
                      <DetailRow label="Other deductions" value={`-${formatPKR(selectedPayslip.otherDeductions)}`} negative />
                    )}
                  </div>
                </div>
              )}

              {/* Net pay */}
              <div className="rounded-md bg-primary/10 p-3 flex justify-between items-center">
                <span className="text-sm font-bold">NET PAY</span>
                <span className="text-xl font-bold tabular-nums text-primary">
                  {formatPKR(selectedPayslip.netPay)}
                </span>
              </div>

              {/* Payment info */}
              <div className="text-xs text-muted-foreground space-y-1">
                <p>
                  Payment status:{' '}
                  <span className="font-medium">
                    {selectedPayslip.paymentStatus === 'paid' ? 'Paid' : 'Pending'}
                  </span>
                </p>
                {selectedPayslip.paymentDate && (
                  <p>
                    Paid on: {format(new Date(selectedPayslip.paymentDate), 'MMM d, yyyy')}
                  </p>
                )}
              </div>

              {/* Download button */}
              <Button
                className="w-full"
                variant="outline"
                onClick={() => downloadPdf(selectedPayslip.id)}
                disabled={downloading}
              >
                {downloading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Download className="h-4 w-4" /> Download PDF
                  </>
                )}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

function DetailRow({
  label,
  value,
  positive,
  negative,
}: {
  label: string
  value: string
  positive?: boolean
  negative?: boolean
}) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`tabular-nums font-medium ${
          positive ? 'text-emerald-600' : negative ? 'text-rose-600' : ''
        }`}
      >
        {value}
      </span>
    </div>
  )
}
