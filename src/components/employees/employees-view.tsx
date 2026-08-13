'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore, useCan } from '@/stores/app-store'
import { api, initials } from '@/lib/api-client'
import type { EmployeePublic } from '@/lib/types'
import { PERMISSIONS } from '@/lib/permissions'
import { PageHeader } from '@/components/layout/dashboard-shell'
import {
  Card,
  CardContent,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Loader2, Search, UserPlus, ShieldCheck, ChevronRight } from 'lucide-react'
import { EmployeeStatusBadge } from '@/components/employees/employee-status-badge'
import { format } from 'date-fns'

export function EmployeesView() {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const [employees, setEmployees] = useState<EmployeePublic[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [roleFilter, setRoleFilter] = useState<string>('all')
  const [designationFilter, setDesignationFilter] = useState<string>('all')
  const [departmentFilter, setDepartmentFilter] = useState<string>('all')

  const refresh = () => {
    setLoading(true)
    api
      .get<{ employees: EmployeePublic[] }>('/api/employees')
      .then((r) => setEmployees(r.employees))
      .catch(() => setEmployees([]))
      .finally(() => setLoading(false))
  }
  useEffect(refresh, [])

  const roles = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of employees) m.set(e.role.id, e.role.name)
    return Array.from(m.entries())
  }, [employees])

  // Unique designations + departments present in the data (for filter dropdowns)
  const designations = useMemo(() => {
    const s = new Set<string>()
    for (const e of employees) if (e.designation) s.add(e.designation)
    return Array.from(s).sort()
  }, [employees])

  const departments = useMemo(() => {
    const s = new Set<string>()
    for (const e of employees) if (e.department) s.add(e.department)
    return Array.from(s).sort()
  }, [employees])

  const filtered = useMemo(() => {
    return employees.filter((e) => {
      if (statusFilter !== 'all' && e.status !== statusFilter) return false
      if (roleFilter !== 'all' && e.role.id !== roleFilter) return false
      if (designationFilter !== 'all' && e.designation !== designationFilter) return false
      if (departmentFilter !== 'all' && e.department !== departmentFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return (
          e.user.fullName.toLowerCase().includes(q) ||
          e.user.email.toLowerCase().includes(q) ||
          (e.designation ?? '').toLowerCase().includes(q) ||
          (e.department ?? '').toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [employees, search, statusFilter, roleFilter, designationFilter, departmentFilter])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Employees"
        description="Manage your company directory, roles, and employment status."
        actions={
          can(PERMISSIONS.EMPLOYEES_INVITE) && (
            <Button onClick={() => navigate({ name: 'employees-invite' })}>
              <UserPlus className="h-4 w-4" /> Invite employee
            </Button>
          )
        }
      />

      <Card>
        <CardContent className="p-4 space-y-4">
          {/* Filters */}
          <div className="flex flex-col sm:flex-row gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name, email, designation…"
                className="pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full sm:w-36">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
                <SelectItem value="terminated">Terminated</SelectItem>
                <SelectItem value="on_leave">On leave</SelectItem>
              </SelectContent>
            </Select>
            <Select value={roleFilter} onValueChange={setRoleFilter}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All roles</SelectItem>
                {roles.map(([id, name]) => (
                  <SelectItem key={id} value={id}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={designationFilter} onValueChange={setDesignationFilter}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Designation" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All designations</SelectItem>
                {designations.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Department" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All departments</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Table */}
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[28%]">Employee</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="hidden md:table-cell">Designation</TableHead>
                  <TableHead className="hidden md:table-cell">Department</TableHead>
                  <TableHead className="hidden lg:table-cell">Joined</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-32 text-center">
                      <Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                      {employees.length === 0
                        ? 'No employees yet. Invite your first team member.'
                        : 'No employees match your filters.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((e) => (
                    <TableRow
                      key={e.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => navigate({ name: 'employee-detail', id: e.id })}
                    >
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar className="h-9 w-9">
                            <AvatarImage src={e.user.avatarUrl ?? undefined} />
                            <AvatarFallback className="bg-primary/10 text-primary text-xs">
                              {initials(e.user.fullName)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate flex items-center gap-1.5">
                              {e.user.fullName}
                              {e.role.isSystemRole && (
                                <ShieldCheck className="h-3 w-3 text-primary" />
                              )}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">
                              {e.user.email}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm">{e.role.name}</p>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                        {e.designation ?? '—'}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                        {e.department ?? '—'}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">
                        {format(new Date(e.joinedAt), 'MMM d, yyyy')}
                      </TableCell>
                      <TableCell>
                        <EmployeeStatusBadge status={e.status} />
                      </TableCell>
                      <TableCell>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            {filtered.length} of {employees.length} employee{employees.length === 1 ? '' : 's'}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
