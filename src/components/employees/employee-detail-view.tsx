'use client'

import { useEffect, useState } from 'react'
import { useAppStore, useCan } from '@/stores/app-store'
import { api, FetchError, initials } from '@/lib/api-client'
import type { EmployeePublic, RolePublic } from '@/lib/types'
import { PERMISSIONS } from '@/lib/permissions'
import { PageHeader } from '@/components/layout/dashboard-shell'
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
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import {
  ArrowLeft,
  Loader2,
  Mail,
  Phone,
  Calendar,
  ShieldCheck,
  Ban,
  UserX,
  RotateCcw,
  Save,
  Building2,
} from 'lucide-react'
import { EmployeeStatusBadge } from '@/components/employees/employee-status-badge'
import { toast } from 'sonner'
import { format } from 'date-fns'

interface EmployeeDetail extends EmployeePublic {
  role: EmployeePublic['role'] & { permissions: string[] }
  subordinates: { id: string; name: string; designation: string | null }[]
  invitedBy: { id: string; fullName: string } | null
  terminatedBy: { id: string; fullName: string } | null
}

export function EmployeeDetailView({ employeeId }: { employeeId: string }) {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const currentUser = useAppStore((s) => s.user)
  const [emp, setEmp] = useState<EmployeeDetail | null>(null)
  const [roles, setRoles] = useState<RolePublic[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [roleId, setRoleId] = useState('')
  const [department, setDepartment] = useState('')
  const [designation, setDesignation] = useState('')
  const [employeeCode, setEmployeeCode] = useState('')
  const [termDialog, setTermDialog] = useState<'suspend' | 'terminate' | 'reactivate' | null>(null)
  const [termReason, setTermReason] = useState('')

  const load = () => {
    setLoading(true)
    api
      .get<{ employee: EmployeeDetail }>(`/api/employees/${employeeId}`)
      .then((r) => {
        setEmp(r.employee)
        setRoleId(r.employee.role.id)
        setDepartment(r.employee.department ?? '')
        setDesignation(r.employee.designation ?? '')
        setEmployeeCode(r.employee.employeeCode ?? '')
      })
      .catch(() => {
        toast.error('Employee not found.')
        navigate({ name: 'employees' })
      })
      .finally(() => setLoading(false))
  }
  useEffect(load, [employeeId])

  useEffect(() => {
    api.get<{ roles: RolePublic[] }>('/api/roles').then((r) => setRoles(r.roles)).catch(() => {})
  }, [])

  const isSelf = emp?.user.id === currentUser?.id
  const canManage =
    can(PERMISSIONS.EMPLOYEES_MANAGE) ||
    useAppStore.getState().employee?.isElevated
  const canTerminate = can(PERMISSIONS.EMPLOYEES_TERMINATE)

  async function saveChanges() {
    setSaving(true)
    try {
      await api.patch(`/api/employees/${employeeId}`, {
        roleId,
        department,
        designation,
        employeeCode,
      })
      toast.success('Employee updated')
      load()
    } catch (err) {
      toast.error(
        err instanceof FetchError ? err.message : 'Failed to update employee.',
      )
    } finally {
      setSaving(false)
    }
  }

  async function doStatusAction() {
    if (!termDialog) return
    setSaving(true)
    try {
      await api.post(`/api/employees/${employeeId}/terminate`, {
        action: termDialog,
        reason: termReason || undefined,
      })
      toast.success(`Employee ${termDialog}d`)
      setTermDialog(null)
      setTermReason('')
      load()
    } catch (err) {
      toast.error(
        err instanceof FetchError ? err.message : 'Action failed.',
      )
    } finally {
      setSaving(false)
    }
  }

  if (loading || !emp) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <button
        onClick={() => navigate({ name: 'employees' })}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to employees
      </button>

      <PageHeader
        title={emp.user.fullName}
        description={emp.designation ?? emp.role.name}
        actions={<EmployeeStatusBadge status={emp.status} />}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Profile card */}
        <Card className="lg:col-span-1">
          <CardContent className="p-6 flex flex-col items-center text-center">
            <Avatar className="h-20 w-20">
              <AvatarImage src={emp.user.avatarUrl ?? undefined} />
              <AvatarFallback className="bg-primary/10 text-primary text-xl">
                {initials(emp.user.fullName)}
              </AvatarFallback>
            </Avatar>
            <h3 className="mt-3 font-semibold text-lg">{emp.user.fullName}</h3>
            <p className="text-sm text-muted-foreground">{emp.user.email}</p>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
              <Badge variant="secondary" className="gap-1">
                {emp.role.isSystemRole && <ShieldCheck className="h-3 w-3" />}
                {emp.role.name}
              </Badge>
              {emp.role.roleTier === 'elevated' && (
                <Badge variant="outline" className="text-xs">
                  Elevated
                </Badge>
              )}
            </div>
            <div className="mt-5 w-full space-y-2.5 text-sm text-left">
              <InfoLine icon={Mail} label="Email" value={emp.user.email} />
              {emp.user.phone && (
                <InfoLine icon={Phone} label="Phone" value={emp.user.phone} />
              )}
              <InfoLine
                icon={Calendar}
                label="Joined"
                value={format(new Date(emp.joinedAt), 'MMM d, yyyy')}
              />
              {emp.department && (
                <InfoLine icon={Building2} label="Department" value={emp.department} />
              )}
              {emp.employeeCode && (
                <InfoLine icon={ShieldCheck} label="Code" value={emp.employeeCode} />
              )}
            </div>
            {emp.terminatedAt && (
              <div className="mt-4 w-full rounded-md bg-rose-50 border border-rose-200 p-3 text-left">
                <p className="text-xs font-medium text-rose-700">Terminated</p>
                <p className="text-xs text-rose-600 mt-0.5">
                  {format(new Date(emp.terminatedAt), 'MMM d, yyyy')}
                  {emp.terminatedBy && ` by ${emp.terminatedBy.fullName}`}
                </p>
                {emp.terminationReason && (
                  <p className="text-xs text-rose-600 mt-1 italic">
                    &ldquo;{emp.terminationReason}&rdquo;
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Edit + actions */}
        <div className="lg:col-span-2 space-y-6">
          {(canManage || isSelf) && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Employment details</CardTitle>
                <CardDescription>
                  {isSelf && !canManage
                    ? 'You can edit your own department and designation.'
                    : 'Update role, department, and HR metadata.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="employeeCode">Employee code</Label>
                    <Input
                      id="employeeCode"
                      value={employeeCode}
                      onChange={(e) => setEmployeeCode(e.target.value)}
                      placeholder="EMP-001"
                      disabled={!canManage}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="roleId">Role</Label>
                    <Select
                      value={roleId}
                      onValueChange={setRoleId}
                      disabled={!canManage}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {roles.map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="department">Department</Label>
                    <Input
                      id="department"
                      value={department}
                      onChange={(e) => setDepartment(e.target.value)}
                      placeholder="Operations"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="designation">Designation</Label>
                    <Input
                      id="designation"
                      value={designation}
                      onChange={(e) => setDesignation(e.target.value)}
                      placeholder="Sales Executive"
                    />
                  </div>
                </div>
                {canManage && (
                  <div className="flex justify-end">
                    <Button onClick={saveChanges} disabled={saving}>
                      {saving ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <>
                          <Save className="h-4 w-4" /> Save changes
                        </>
                      )}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Status actions */}
          {canManage && !isSelf && emp.status !== 'terminated' && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Employment status</CardTitle>
                <CardDescription>
                  Suspend temporarily or terminate this employee. Terminated
                  employees lose workspace access immediately.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {emp.status === 'active' && (
                  <Button
                    variant="outline"
                    onClick={() => setTermDialog('suspend')}
                  >
                    <Ban className="h-4 w-4" /> Suspend
                  </Button>
                )}
                {emp.status === 'suspended' && (
                  <Button
                    variant="outline"
                    onClick={() => setTermDialog('reactivate')}
                  >
                    <RotateCcw className="h-4 w-4" /> Reactivate
                  </Button>
                )}
                {canTerminate && (
                  <Button
                    variant="destructive"
                    onClick={() => setTermDialog('terminate')}
                  >
                    <UserX className="h-4 w-4" /> Terminate
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          {/* Subordinates */}
          {emp.subordinates.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Direct reports ({emp.subordinates.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {emp.subordinates.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => navigate({ name: 'employee-detail', id: s.id })}
                    className="w-full flex items-center gap-3 rounded-md border px-3 py-2 hover:bg-muted/50 text-left"
                  >
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="bg-muted text-xs">
                        {initials(s.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{s.name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {s.designation ?? '—'}
                      </p>
                    </div>
                  </button>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Status action dialog */}
      <Dialog open={!!termDialog} onOpenChange={(o) => !o && setTermDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {termDialog === 'terminate'
                ? 'Terminate employee'
                : termDialog === 'suspend'
                  ? 'Suspend employee'
                  : 'Reactivate employee'}
            </DialogTitle>
            <DialogDescription>
              {termDialog === 'terminate'
                ? `This will permanently revoke ${emp.user.fullName}'s workspace access. A reason is required for the audit log.`
                : termDialog === 'suspend'
                  ? `${emp.user.fullName} will lose access until reactivated.`
                  : `${emp.user.fullName} will regain workspace access.`}
            </DialogDescription>
          </DialogHeader>
          {termDialog === 'terminate' && (
            <div className="space-y-1.5">
              <Label htmlFor="reason">Reason</Label>
              <Textarea
                id="reason"
                rows={3}
                value={termReason}
                onChange={(e) => setTermReason(e.target.value)}
                placeholder="e.g. End of probation period"
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTermDialog(null)}>
              Cancel
            </Button>
            <Button
              variant={termDialog === 'reactivate' ? 'default' : 'destructive'}
              onClick={doStatusAction}
              disabled={saving || (termDialog === 'terminate' && !termReason.trim())}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : termDialog === 'terminate' ? (
                <>
                  <UserX className="h-4 w-4" /> Terminate
                </>
              ) : termDialog === 'suspend' ? (
                <>
                  <Ban className="h-4 w-4" /> Suspend
                </>
              ) : (
                <>
                  <RotateCcw className="h-4 w-4" /> Reactivate
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function InfoLine({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Mail
  label: string
  value: string
}) {
  return (
    <div className="flex items-center gap-2.5">
      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground text-xs w-16 shrink-0">{label}</span>
      <span className="font-medium truncate">{value}</span>
    </div>
  )
}
