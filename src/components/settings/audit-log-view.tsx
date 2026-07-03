'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/app-store'
import { api, initials } from '@/lib/api-client'
import { PageHeader } from '@/components/layout/dashboard-shell'
import {
  Card,
  CardContent,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
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
import { Loader2, Search, ScrollText, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { format } from 'date-fns'

interface AuditRow {
  id: string
  action: string
  entityType: string
  entityId: string | null
  createdAt: string
  ipAddress: string | null
  metadata: Record<string, unknown>
  oldValues: Record<string, unknown> | null
  newValues: Record<string, unknown> | null
  user: { id: string; fullName: string; email: string } | null
}

const ENTITY_TYPES = ['', 'user', 'company', 'organization', 'employee', 'invitation', 'role', 'audit']

export function AuditLogView() {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [action, setAction] = useState('')
  const [entityType, setEntityType] = useState('')
  const pageSize = 25
  const activeCompany = useAppStore((s) => s.activeCompany)

  useEffect(() => {
    let active = true
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    })
    if (action) params.set('action', action)
    if (entityType) params.set('entityType', entityType)
    api
      .get<{ rows: AuditRow[]; total: number }>(`/api/audit-logs?${params}`)
      .then((r) => {
        if (!active) return
        setRows(r.rows)
        setTotal(r.total)
      })
      .catch(() => {
        if (active) setRows([])
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [page, action, entityType, activeCompany?.id])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="Immutable, append-only record of every action in this company. Foundation for KPIs and compliance."
      />

      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Filter by action (e.g. employee.invited)"
                className="pl-9"
                value={action}
                onChange={(e) => {
                  setAction(e.target.value)
                  setPage(1)
                }}
              />
            </div>
            <Select
              value={entityType || 'all'}
              onValueChange={(v) => {
                setEntityType(v === 'all' ? '' : v)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue placeholder="Entity type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All entities</SelectItem>
                {ENTITY_TYPES.filter(Boolean).map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[28%]">Action</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead className="hidden md:table-cell">Entity</TableHead>
                  <TableHead className="hidden lg:table-cell">Details</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-32 text-center">
                      <Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                      <ScrollText className="h-5 w-5 mx-auto mb-2 opacity-50" />
                      No audit entries match your filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <code className="text-xs font-mono text-foreground">
                          {r.action}
                        </code>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary text-[10px] font-medium">
                            {r.user?.fullName ? initials(r.user.fullName) : '?'}
                          </div>
                          <span className="text-sm truncate max-w-[140px]">
                            {r.user?.fullName ?? 'System'}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Badge variant="outline" className="text-xs">
                          {r.entityType}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-xs text-muted-foreground max-w-[280px] truncate">
                        {r.newValues
                          ? Object.entries(r.newValues)
                              .slice(0, 2)
                              .map(([k, v]) => `${k}: ${formatVal(v)}`)
                              .join(', ')
                          : '—'}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {format(new Date(r.createdAt), 'MMM d, p')}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {total} entr{total === 1 ? 'y' : 'ies'} · page {page} of {totalPages}
            </span>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function formatVal(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v.length > 40 ? v.slice(0, 40) + '…' : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 40) + '…'
  return String(v)
}
