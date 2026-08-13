'use client'

/**
 * SalaryTab — Employee salary profile + commission rules + live monthly preview.
 *
 * Visibility:
 *   - Employee always sees their OWN tab (view-only, cannot edit own salary/commission)
 *   - employees.view_salary required to VIEW another employee's tab
 *   - employees.manage_salary required to EDIT base salary or commission rules
 *
 * The "This Month So Far" preview is a LIVE estimate computed from real order
 * data — NOT an official payslip. Official figures only exist once Finance
 * finalizes a Payroll Run (Phase 8).
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, FetchError } from '@/lib/api-client'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Wallet,
  TrendingUp,
  Plus,
  Pencil,
  Loader2,
  Info,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatPKR } from '@/components/orders/_shared'
import { format } from 'date-fns'

interface SalaryData {
  profile: {
    baseSalary: number
    currency: string
    effectiveFrom: string
    status: string
  } | null
  revisions: Array<{
    id: string
    oldAmount: number | null
    newAmount: number
    effectiveFrom: string
    changedByName: string
    createdAt: string
  }>
  canEdit: boolean
}

interface CommissionRulesData {
  rules: Array<{
    id: string
    basisType: string
    rateValue: number
    triggerStatus: string
    isActive: boolean
    createdAt: string
  }>
  canEdit: boolean
}

interface CommissionPreviewData {
  isEstimate: boolean
  period: { start: string; end: string; label: string }
  baseSalary: number
  currency: string
  commission: {
    totalEarned: number
    qualifyingOrderCount: number
    qualifyingItemQty: number
    qualifyingRevenue: number
    rule: { id: string; basisType: string; rateValue: number; triggerStatus: string } | null
  }
  estimatedTotal: number
}

const BASIS_LABELS: Record<string, string> = {
  per_order: 'Per Order',
  per_item_sold: 'Per Item Sold',
  percentage_of_revenue: '% of Revenue',
}

const TRIGGER_STATUSES = [
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'dispatched', label: 'Dispatched' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'rto', label: 'RTO (Returned)' },
  { value: 'cancelled', label: 'Cancelled' },
]

export function SalaryTab({ employeeId, isSelf }: { employeeId: string; isSelf: boolean }) {
  const queryClient = useQueryClient()
  const [editSalaryOpen, setEditSalaryOpen] = useState(false)
  const [addRuleOpen, setAddRuleOpen] = useState(false)

  const { data: salaryData, isLoading: salaryLoading } = useQuery<SalaryData>({
    queryKey: ['employee-salary', employeeId],
    queryFn: () => api.get<SalaryData>(`/api/employees/${employeeId}/salary`),
  })

  const { data: rulesData, isLoading: rulesLoading } = useQuery<CommissionRulesData>({
    queryKey: ['employee-commission-rules', employeeId],
    queryFn: () => api.get<CommissionRulesData>(`/api/employees/${employeeId}/commission-rules`),
  })

  const { data: preview, isLoading: previewLoading } = useQuery<CommissionPreviewData>({
    queryKey: ['employee-commission-preview', employeeId],
    queryFn: () => api.get<CommissionPreviewData>(`/api/employees/${employeeId}/commission-preview`),
    staleTime: 60_000, // 1 min — don't hammer the live computation
  })

  if (salaryLoading || rulesLoading || previewLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const canEdit = salaryData?.canEdit ?? false

  return (
    <div className="space-y-6">
      {/* ─── This Month So Far — Live Preview ────────────────────── */}
      {preview && (
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              This Month So Far — {preview.period.label}
            </CardTitle>
            <CardDescription className="flex items-center gap-1.5">
              <Info className="h-3 w-3" />
              ESTIMATE only — official figures are set when Finance runs payroll.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="rounded-lg border bg-background p-3">
                <p className="text-xs text-muted-foreground">Base Salary</p>
                <p className="text-lg font-bold tabular-nums mt-1">
                  {formatPKR(preview.baseSalary)}
                </p>
              </div>
              <div className="rounded-lg border bg-background p-3">
                <p className="text-xs text-muted-foreground">Commission Earned</p>
                <p className="text-lg font-bold tabular-nums mt-1 text-emerald-600">
                  {formatPKR(preview.commission.totalEarned)}
                </p>
                {preview.commission.rule && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {BASIS_LABELS[preview.commission.rule.basisType]} @ {preview.commission.rule.rateValue}
                    {preview.commission.rule.basisType === 'percentage_of_revenue' ? '%' : ' PKR'}
                    {' on '}{preview.commission.rule.triggerStatus}
                  </p>
                )}
                {!preview.commission.rule && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">No active commission rule</p>
                )}
              </div>
              <div className="rounded-lg border bg-primary/10 p-3">
                <p className="text-xs text-muted-foreground">Estimated Total</p>
                <p className="text-lg font-bold tabular-nums mt-1 text-primary">
                  {formatPKR(preview.estimatedTotal)}
                </p>
              </div>
            </div>
            {preview.commission.rule && (
              <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
                <span>Qualifying orders: {preview.commission.qualifyingOrderCount}</span>
                <span>Items: {preview.commission.qualifyingItemQty}</span>
                <span>Revenue: {formatPKR(preview.commission.qualifyingRevenue)}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ─── Base Salary ──────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Wallet className="h-4 w-4 text-muted-foreground" />
                Base Salary
              </CardTitle>
              {canEdit && salaryData?.profile && (
                <Button variant="outline" size="sm" onClick={() => setEditSalaryOpen(true)}>
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {salaryData?.profile ? (
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-muted-foreground">Current amount</p>
                  <p className="text-2xl font-bold tabular-nums">
                    {formatPKR(salaryData.profile.baseSalary)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {salaryData.profile.currency} · Effective{' '}
                    {format(new Date(salaryData.profile.effectiveFrom), 'MMM d, yyyy')}
                  </p>
                </div>
                {salaryData.revisions.length > 0 && (
                  <div className="pt-2 border-t">
                    <p className="text-xs font-medium text-muted-foreground mb-2">
                      Revision history ({salaryData.revisions.length})
                    </p>
                    <div className="space-y-1.5 max-h-40 overflow-y-auto scrollbar-thin">
                      {salaryData.revisions.slice(0, 5).map((r) => (
                        <div key={r.id} className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">
                            {r.oldAmount !== null ? formatPKR(r.oldAmount) : '—'} →{' '}
                            <span className="font-medium text-foreground">{formatPKR(r.newAmount)}</span>
                          </span>
                          <span className="text-muted-foreground">
                            {format(new Date(r.createdAt), 'MMM d, yyyy')} · {r.changedByName}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-6">
                <p className="text-sm text-muted-foreground">No salary profile set.</p>
                {canEdit && (
                  <Button variant="outline" size="sm" className="mt-2" onClick={() => setEditSalaryOpen(true)}>
                    <Plus className="h-3.5 w-3.5" /> Set base salary
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ─── Commission Rules ────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
                Commission Rules
              </CardTitle>
              {canEdit && (
                <Button variant="outline" size="sm" onClick={() => setAddRuleOpen(true)}>
                  <Plus className="h-3.5 w-3.5" /> Add Rule
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {rulesData && rulesData.rules.length > 0 ? (
              <div className="space-y-2">
                {rulesData.rules.map((rule) => (
                  <div
                    key={rule.id}
                    className="flex items-center justify-between rounded-md border p-3"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                          {BASIS_LABELS[rule.basisType] ?? rule.basisType}
                        </Badge>
                        <span className="text-sm font-medium">
                          {rule.rateValue}
                          {rule.basisType === 'percentage_of_revenue' ? '%' : ' PKR'}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Trigger: {rule.triggerStatus}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {rule.isActive ? (
                        <Badge variant="secondary" className="text-[10px]">Active</Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">Inactive</Badge>
                      )}
                      {canEdit && rule.isActive && (
                        <DeleteRuleButton
                          employeeId={employeeId}
                          ruleId={rule.id}
                          onSuccess={() => {
                            queryClient.invalidateQueries({ queryKey: ['employee-commission-rules', employeeId] })
                            queryClient.invalidateQueries({ queryKey: ['employee-commission-preview', employeeId] })
                          }}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-6">
                <p className="text-sm text-muted-foreground">No commission rules configured.</p>
                {canEdit && (
                  <Button variant="outline" size="sm" className="mt-2" onClick={() => setAddRuleOpen(true)}>
                    <Plus className="h-3.5 w-3.5" /> Add commission rule
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ─── Edit Salary Dialog ────────────────────────────────────── */}
      {editSalaryOpen && (
        <EditSalaryDialog
          employeeId={employeeId}
          currentSalary={salaryData?.profile?.baseSalary}
          currency={salaryData?.profile?.currency ?? 'PKR'}
          onClose={() => setEditSalaryOpen(false)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['employee-salary', employeeId] })
            queryClient.invalidateQueries({ queryKey: ['employee-commission-preview', employeeId] })
            setEditSalaryOpen(false)
          }}
        />
      )}

      {/* ─── Add Commission Rule Dialog ────────────────────────────── */}
      {addRuleOpen && (
        <AddRuleDialog
          employeeId={employeeId}
          onClose={() => setAddRuleOpen(false)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['employee-commission-rules', employeeId] })
            queryClient.invalidateQueries({ queryKey: ['employee-commission-preview', employeeId] })
            setAddRuleOpen(false)
          }}
        />
      )}
    </div>
  )
}

// ─── Edit Salary Dialog ─────────────────────────────────────────────

function EditSalaryDialog({
  employeeId,
  currentSalary,
  currency,
  onClose,
  onSuccess,
}: {
  employeeId: string
  currentSalary?: number
  currency: string
  onClose: () => void
  onSuccess: () => void
}) {
  const [amount, setAmount] = useState(currentSalary?.toString() ?? '')
  const [saving, setSaving] = useState(false)

  async function save() {
    const num = parseFloat(amount)
    if (isNaN(num) || num < 0) {
      toast.error('Enter a valid salary amount')
      return
    }
    setSaving(true)
    try {
      await api.patch(`/api/employees/${employeeId}/salary`, { baseSalary: num, currency })
      toast.success('Salary updated')
      onSuccess()
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to update salary')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update base salary</DialogTitle>
          <DialogDescription>
            This creates a new salary profile and logs a revision record.
            The old profile is deactivated but retained for audit history.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="amount">New base salary ({currency})</Label>
            <Input
              id="amount"
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="50000"
            />
          </div>
          {currentSalary !== undefined && (
            <p className="text-xs text-muted-foreground">
              Current: {formatPKR(currentSalary)}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Add Commission Rule Dialog ─────────────────────────────────────

function AddRuleDialog({
  employeeId,
  onClose,
  onSuccess,
}: {
  employeeId: string
  onClose: () => void
  onSuccess: () => void
}) {
  const [basisType, setBasisType] = useState('per_item_sold')
  const [rateValue, setRateValue] = useState('')
  const [triggerStatus, setTriggerStatus] = useState('delivered')
  const [saving, setSaving] = useState(false)

  async function save() {
    const num = parseFloat(rateValue)
    if (isNaN(num) || num < 0) {
      toast.error('Enter a valid rate value')
      return
    }
    setSaving(true)
    try {
      await api.post(`/api/employees/${employeeId}/commission-rules`, {
        basisType,
        rateValue: num,
        triggerStatus,
      })
      toast.success('Commission rule added')
      onSuccess()
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to add rule')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add commission rule</DialogTitle>
          <DialogDescription>
            Configures how this employee earns commission. Only one active rule
            is supported — adding a new one deactivates the previous.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Basis type</Label>
            <Select value={basisType} onValueChange={setBasisType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="per_order">Per Order (fixed amount per qualifying order)</SelectItem>
                <SelectItem value="per_item_sold">Per Item Sold (amount × quantity)</SelectItem>
                <SelectItem value="percentage_of_revenue">% of Revenue (fraction of order value)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rate">
              Rate value {basisType === 'percentage_of_revenue' ? '(%, e.g. 2 for 2%)' : '(PKR amount)'}
            </Label>
            <Input
              id="rate"
              type="number"
              value={rateValue}
              onChange={(e) => setRateValue(e.target.value)}
              placeholder={basisType === 'percentage_of_revenue' ? '2' : '50'}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Trigger status</Label>
            <Select value={triggerStatus} onValueChange={setTriggerStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TRIGGER_STATUSES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Commission is earned when an order reaches this status. Once earned,
              it counts permanently (no clawback).
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Delete Rule Button ─────────────────────────────────────────────

function DeleteRuleButton({
  employeeId,
  ruleId,
  onSuccess,
}: {
  employeeId: string
  ruleId: string
  onSuccess: () => void
}) {
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    setDeleting(true)
    try {
      await api.delete(`/api/employees/${employeeId}/commission-rules?ruleId=${ruleId}`)
      toast.success('Rule deactivated')
      onSuccess()
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to deactivate rule')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleDelete} disabled={deleting}>
      {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
    </Button>
  )
}
