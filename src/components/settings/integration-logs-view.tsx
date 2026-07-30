'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api-client'
import { useAppStore } from '@/stores/app-store'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
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
import {
  Webhook,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  ArrowUp,
  ArrowDown,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDateTime, getErrorMessage } from '@/components/orders/_shared'

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface ActionLog {
  id: string
  actionType: string
  direction: string
  requestPayload: string | null
  responsePayload: string | null
  status: string
  errorMessage: string | null
  relatedEntityType: string | null
  relatedEntityId: string | null
  durationMs: number | null
  createdAt: string
  integration: {
    connectionName: string
    providerKey: string
    providerName: string
  }
}

interface LogsResponse {
  logs: ActionLog[]
}

// ──────────────────────────────────────────────────────────────
// Main view
// ──────────────────────────────────────────────────────────────

export function IntegrationLogsView() {
  const navigate = useAppStore((s) => s.navigate)
  const [providerFilter, setProviderFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const query = useQuery<LogsResponse>({
    queryKey: ['integration-logs', providerFilter, actionFilter, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams()
      if (providerFilter) params.set('provider_key', providerFilter)
      if (actionFilter) params.set('action_type', actionFilter)
      if (statusFilter) params.set('status', statusFilter)
      const qs = params.toString()
      return api.get<LogsResponse>(`/api/integrations/logs${qs ? `?${qs}` : ''}`)
    },
    staleTime: 10_000,
  })

  const logs = query.data?.logs ?? []

  // Build unique action types from the loaded logs for the filter dropdown
  const actionTypes = [...new Set(logs.map((l) => l.actionType))].sort()

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integration Logs"
        description="Debug log of every integration call — courier bookings, webhook receipts, sync events."
        actions={
          <Button variant="outline" size="sm" onClick={() => query.refetch()} disabled={query.isFetching}>
            <RefreshCw className={query.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            Refresh
          </Button>
        }
      />

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <Select value={providerFilter} onValueChange={(v) => setProviderFilter(v === 'all' ? '' : v)}>
          <SelectTrigger className="sm:w-44">
            <SelectValue placeholder="All providers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All providers</SelectItem>
            <SelectItem value="tcs">TCS</SelectItem>
            <SelectItem value="leopard">Leopard</SelectItem>
            <SelectItem value="postex">PostEx</SelectItem>
            <SelectItem value="shopify">Shopify</SelectItem>
            <SelectItem value="daraz">Daraz</SelectItem>
          </SelectContent>
        </Select>
        <Select value={actionFilter} onValueChange={(v) => setActionFilter(v === 'all' ? '' : v)}>
          <SelectTrigger className="sm:w-52">
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {actionTypes.map((a) => (
              <SelectItem key={a} value={a}>{a}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v === 'all' ? '' : v)}>
          <SelectTrigger className="sm:w-36">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="success">Success</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      {query.isLoading ? (
        <Card>
          <CardContent className="p-3 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
          </CardContent>
        </Card>
      ) : query.isError ? (
        <Card>
          <CardContent className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">{getErrorMessage(query.error)}</p>
            <Button variant="outline" onClick={() => query.refetch()}>Try again</Button>
          </CardContent>
        </Card>
      ) : logs.length === 0 ? (
        <Card>
          <CardContent className="p-10 sm:p-14 text-center">
            <div className="mx-auto h-14 w-14 rounded-full bg-muted flex items-center justify-center mb-4">
              <Webhook className="h-7 w-7 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold">No integration logs yet</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
              Logs appear here when integration calls are made — courier bookings, webhook
              receipts, connection tests, etc.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="max-h-[70vh] overflow-y-auto scrollbar-thin">
              <Table>
                <TableHeader className="sticky top-0 bg-background z-10">
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Provider</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Direction</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead>Entity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log) => {
                    const isExpanded = expandedId === log.id
                    return (
                      <>
                        <TableRow
                          key={log.id}
                          className="cursor-pointer hover:bg-muted/40"
                          onClick={() => setExpandedId(isExpanded ? null : log.id)}
                        >
                          <TableCell className="w-8">
                            {isExpanded ? (
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                          </TableCell>
                          <TableCell>
                            <p className="text-sm font-medium">{log.integration.providerName}</p>
                            <p className="text-[10px] text-muted-foreground">{log.integration.connectionName}</p>
                          </TableCell>
                          <TableCell>
                            <code className="text-xs">{log.actionType}</code>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-[10px]">
                              {log.direction === 'outbound' ? (
                                <><ArrowUp className="h-2.5 w-2.5 mr-0.5" /> Out</>
                              ) : (
                                <><ArrowDown className="h-2.5 w-2.5 mr-0.5" /> In</>
                              )}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {log.status === 'success' ? (
                              <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">
                                <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" /> Success
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-[10px] bg-rose-50 text-rose-700 border-rose-200">
                                <XCircle className="h-2.5 w-2.5 mr-0.5" /> Failed
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                            {log.durationMs != null ? `${log.durationMs}ms` : '—'}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {formatDateTime(log.createdAt)}
                          </TableCell>
                          <TableCell className="text-xs">
                            {log.relatedEntityType ? (
                              <span className="text-muted-foreground">{log.relatedEntityType}: {log.relatedEntityId?.slice(0, 8)}…</span>
                            ) : '—'}
                          </TableCell>
                        </TableRow>
                        {isExpanded && (
                          <TableRow key={`${log.id}-detail`}>
                            <TableCell colSpan={8} className="bg-muted/20 p-4">
                              <div className="space-y-3">
                                {log.errorMessage && (
                                  <div>
                                    <p className="text-[10px] uppercase tracking-wide text-rose-600 font-medium mb-1">Error</p>
                                    <pre className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2 whitespace-pre-wrap">
                                      {log.errorMessage}
                                    </pre>
                                  </div>
                                )}
                                {log.requestPayload && (
                                  <div>
                                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-1">Request</p>
                                    <pre className="text-xs bg-muted border rounded p-2 overflow-x-auto max-h-48 scrollbar-thin">
                                      {formatJson(log.requestPayload)}
                                    </pre>
                                  </div>
                                )}
                                {log.responsePayload && (
                                  <div>
                                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-1">Response</p>
                                    <pre className="text-xs bg-muted border rounded p-2 overflow-x-auto max-h-48 scrollbar-thin">
                                      {formatJson(log.responsePayload)}
                                    </pre>
                                  </div>
                                )}
                                {!log.errorMessage && !log.requestPayload && !log.responsePayload && (
                                  <p className="text-xs text-muted-foreground">No payload data recorded.</p>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground p-3">
              {logs.length} log {logs.length === 1 ? 'entry' : 'entries'}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

/** Format a JSON string for display (pretty-print). */
function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
