'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import { PageHeader } from '@/components/layout/dashboard-shell'
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
import { Loader2, Plus, Receipt, ChevronRight, Calendar } from 'lucide-react'
import { toast } from 'sonner'
import { formatPKR } from '@/components/orders/_shared'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

interface PayrollRun {
  id: string
  periodMonth: number
  periodYear: number
  status: string
  generatedAt: string | null
  finalizedAt: string | null
  payslipCount: number
  totalNetPay: number
}

interface PayrollListData {
  runs: PayrollRun[]
}

export function PayrollView() {
  const navigate = useAppStore((s) => s.navigate)
  const queryClient = useQueryClient()
  const [generateOpen, setGenerateOpen] = useState(false)

  const { data, isLoading } = useQuery<PayrollListData>({
    queryKey: ['payroll-runs'],
    queryFn: () => api.get<PayrollListData>('/api/payroll'),
  })

  const statusBadge = (status: string) => {
    switch (status) {
      case 'draft': return <Badge variant="outline" className="text-amber-700 border-amber-200 bg-amber-50">Draft</Badge>
      case 'finalized': return <Badge variant="outline" className="text-sky-700 border-sky-200 bg-sky-50">Finalized</Badge>
      case 'paid': return <Badge variant="outline" className="text-emerald-700 border-emerald-200 bg-emerald-50">Paid</Badge>
      default: return <Badge variant="outline">{status}</Badge>
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payroll"
        description="Generate payroll runs, review payslips, finalize, and mark as paid."
        actions={
          <Button onClick={() => setGenerateOpen(true)}>
            <Plus className="h-4 w-4" /> Generate Run
          </Button>
        }
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Payslips</TableHead>
                <TableHead className="text-right">Total Net Pay</TableHead>
                <TableHead>Generated</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center">
                    <Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ) : !data?.runs?.length ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    <Receipt className="h-8 w-8 mx-auto mb-2 opacity-40" />
                    No payroll runs yet. Generate your first run.
                  </TableCell>
                </TableRow>
              ) : (
                data.runs.map((run) => (
                  <TableRow
                    key={run.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => navigate({ name: 'payroll-run-detail', id: run.id })}
                  >
                    <TableCell className="font-medium">
                      {MONTHS[run.periodMonth - 1]} {run.periodYear}
                    </TableCell>
                    <TableCell>{statusBadge(run.status)}</TableCell>
                    <TableCell className="text-right tabular-nums">{run.payslipCount}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatPKR(run.totalNetPay)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {run.generatedAt
                        ? new Date(run.generatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                        : '—'}
                    </TableCell>
                    <TableCell>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {generateOpen && (
        <GenerateRunDialog
          onClose={() => setGenerateOpen(false)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['payroll-runs'] })
            setGenerateOpen(false)
          }}
        />
      )}
    </div>
  )
}

function GenerateRunDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const now = new Date()
  const [month, setMonth] = useState((now.getMonth() + 1).toString())
  const [year, setYear] = useState(now.getFullYear().toString())
  const [saving, setSaving] = useState(false)

  async function generate() {
    setSaving(true)
    try {
      const result = await api.post<{ runId: string; payslipCount: number }>('/api/payroll', {
        periodMonth: parseInt(month),
        periodYear: parseInt(year),
      })
      toast.success(`Payroll run generated: ${result.payslipCount} payslips`)
      onSuccess()
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to generate payroll run')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calendar className="h-4 w-4" /> Generate payroll run
          </DialogTitle>
          <DialogDescription>
            Creates a draft payroll run with one payslip per active employee
            who has a salary profile. Commission is computed from real order
            data for the selected period.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Month</Label>
            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => (
                  <SelectItem key={i} value={(i + 1).toString()}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Year</Label>
            <Input type="number" value={year} onChange={(e) => setYear(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={generate} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Generate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
