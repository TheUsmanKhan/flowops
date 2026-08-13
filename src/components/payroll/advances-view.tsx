'use client'

/**
 * AdvancesView — list + record salary advances.
 *
 * Requires payroll.manage_advances permission.
 * Shows amount, remaining balance, repayment plan, status, and a "Record Advance" dialog.
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, FetchError } from '@/lib/api-client'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Loader2, Plus, Wallet, TrendingDown } from 'lucide-react'
import { toast } from 'sonner'
import { formatPKR } from '@/components/orders/_shared'
import { format } from 'date-fns'

interface Advance {
  id: string
  employeeId: string
  employeeName: string
  designation: string | null
  amount: number
  reason: string
  dateGiven: string
  repaymentPlan: string
  installmentAmount: number | null
  remainingBalance: number
  status: string
  createdAt: string
}

interface EmployeeOption {
  id: string
  fullName: string
  designation: string | null
}

export function AdvancesView({ employees }: { employees: EmployeeOption[] }) {
  const queryClient = useQueryClient()
  const [recordOpen, setRecordOpen] = useState(false)
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const { data, isLoading } = useQuery<{ advances: Advance[] }>({
    queryKey: ['advances', statusFilter],
    queryFn: () => {
      const params = new URLSearchParams()
      if (statusFilter !== 'all') params.set('status', statusFilter)
      return api.get<{ advances: Advance[] }>(`/api/advances${params.toString() ? '?' + params.toString() : ''}`)
    },
  })

  const advances = data?.advances ?? []
  const totalActive = advances.filter((a) => a.status === 'active').reduce((s, a) => s + a.remainingBalance, 0)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Filter" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All advances</SelectItem>
              <SelectItem value="active">Active only</SelectItem>
              <SelectItem value="settled">Settled only</SelectItem>
            </SelectContent>
          </Select>
          {totalActive > 0 && (
            <Badge variant="outline" className="text-amber-700 border-amber-200 bg-amber-50">
              <TrendingDown className="h-3 w-3 mr-1" />
              {formatPKR(totalActive)} outstanding
            </Badge>
          )}
        </div>
        <Button onClick={() => setRecordOpen(true)}>
          <Plus className="h-4 w-4" /> Record Advance
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Remaining</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Date Given</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center">
                    <Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ) : advances.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                    <Wallet className="h-8 w-8 mx-auto mb-2 opacity-40" />
                    No advances recorded yet.
                  </TableCell>
                </TableRow>
              ) : (
                advances.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <p className="text-sm font-medium">{a.employeeName}</p>
                      {a.designation && (
                        <p className="text-xs text-muted-foreground">{a.designation}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {formatPKR(a.amount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm font-medium">
                      {a.remainingBalance > 0 ? formatPKR(a.remainingBalance) : '—'}
                    </TableCell>
                    <TableCell>
                      {a.repaymentPlan === 'lump_sum' ? (
                        <Badge variant="outline" className="text-xs">Lump sum</Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs">
                          {formatPKR(a.installmentAmount ?? 0)}/run
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                      {a.reason}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {format(new Date(a.dateGiven), 'MMM d, yyyy')}
                    </TableCell>
                    <TableCell>
                      {a.status === 'active' ? (
                        <Badge variant="outline" className="text-amber-700 border-amber-200 bg-amber-50 text-xs">Active</Badge>
                      ) : (
                        <Badge variant="outline" className="text-emerald-700 border-emerald-200 bg-emerald-50 text-xs">Settled</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {recordOpen && (
        <RecordAdvanceDialog
          employees={employees}
          onClose={() => setRecordOpen(false)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['advances'] })
            setRecordOpen(false)
          }}
        />
      )}
    </div>
  )
}

function RecordAdvanceDialog({
  employees,
  onClose,
  onSuccess,
}: {
  employees: EmployeeOption[]
  onClose: () => void
  onSuccess: () => void
}) {
  const [employeeId, setEmployeeId] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [repaymentPlan, setRepaymentPlan] = useState<'lump_sum' | 'installments'>('lump_sum')
  const [installmentAmount, setInstallmentAmount] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!employeeId || !amount || !reason) {
      toast.error('Employee, amount, and reason are required')
      return
    }
    const numAmount = parseFloat(amount)
    if (isNaN(numAmount) || numAmount <= 0) {
      toast.error('Enter a valid amount')
      return
    }
    if (repaymentPlan === 'installments') {
      const inst = parseFloat(installmentAmount)
      if (isNaN(inst) || inst <= 0) {
        toast.error('Enter a valid installment amount')
        return
      }
    }

    setSaving(true)
    try {
      await api.post('/api/advances', {
        employeeId,
        amount: numAmount,
        reason,
        repaymentPlan,
        installmentAmount: repaymentPlan === 'installments' ? parseFloat(installmentAmount) : undefined,
      })
      toast.success('Advance recorded')
      onSuccess()
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to record advance')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4" /> Record salary advance
          </DialogTitle>
          <DialogDescription>
            The advance will be automatically deducted from future payroll runs
            based on the repayment plan.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Employee</Label>
            <Select value={employeeId} onValueChange={setEmployeeId}>
              <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
              <SelectContent>
                {employees.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.fullName}{e.designation ? ` (${e.designation})` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="amount">Amount (PKR)</Label>
              <Input id="amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10000" />
            </div>
            <div className="space-y-1.5">
              <Label>Repayment plan</Label>
              <Select value={repaymentPlan} onValueChange={(v: 'lump_sum' | 'installments') => setRepaymentPlan(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="lump_sum">Lump sum (next payroll)</SelectItem>
                  <SelectItem value="installments">Installments (per payroll run)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {repaymentPlan === 'installments' && (
            <div className="space-y-1.5">
              <Label htmlFor="installment">Installment amount per payroll run (PKR)</Label>
              <Input id="installment" type="number" value={installmentAmount} onChange={(e) => setInstallmentAmount(e.target.value)} placeholder="2500" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="reason">Reason</Label>
            <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Medical emergency" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Record advance'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
