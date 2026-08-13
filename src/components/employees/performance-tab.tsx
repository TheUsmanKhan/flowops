'use client'

/**
 * PerformanceTab — employee order funnel analytics.
 *
 * Shows KPI cards (total orders, cancellation rate, delivery rate, RTO rate,
 * items sold, damage/loss count) + a funnel chart visualizing
 * Created → Confirmed → Dispatched → Delivered/RTO/Cancelled.
 *
 * Supports a date range filter that re-runs computeOrderFunnelStats LIVE
 * (not from the cached EmployeeStats row — the cached row represents all-time
 * totals, but this tab may use custom date ranges).
 *
 * Visibility: an employee always sees their OWN Performance tab. Viewing
 * another employee's Performance tab requires employees.view or kpi.view
 * permission (enforced server-side in the API route).
 */

import { useState, useMemo } from 'react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Loader2, Calendar, TrendingUp, Package, Truck, CheckCircle2, XCircle, RotateCcw, AlertTriangle, DollarSign } from 'lucide-react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import { formatPKR } from '@/components/orders/_shared'

interface PerformanceData {
  employee: { id: string; name: string; designation: string | null; department: string | null }
  stats: {
    totalOrders: number
    cancelledCount: number
    cancellationRate: number
    dispatchedCount: number
    deliveredCount: number
    deliveryRate: number
    rtoCount: number
    rtoRate: number
    inTransitCount: number
    itemsSoldQty: number
    damageLossCount: number
    revenueGenerated: number
  }
  statusBreakdown: {
    pending: number
    confirmed: number
    dispatched: number
    delivered: number
    rto: number
    cancelled: number
  }
  cachedAllTime: {
    totalOrders: number
    cancelledCount: number
    cancellationRate: number
    dispatchedCount: number
    deliveredCount: number
    deliveryRate: number
    rtoCount: number
    rtoRate: number
    inTransitCount: number
    itemsSoldQty: number
    damageLossCount: number
    revenueGenerated: number
  } | null
}

const FUNNEL_COLORS: Record<string, string> = {
  Created: '#64748b',     // slate
  Confirmed: '#0ea5e9',   // sky
  Dispatched: '#7c3aed',  // violet
  Delivered: '#16a34a',   // green
  RTO: '#dc2626',         // red
  Cancelled: '#94a3b8',   // slate-light
}

export function PerformanceTab({ employeeId, isSelf }: { employeeId: string; isSelf: boolean }) {
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [appliedRange, setAppliedRange] = useState<{ from?: string; to?: string }>({})

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    if (appliedRange.from) params.set('date_from', appliedRange.from)
    if (appliedRange.to) params.set('date_to', appliedRange.to)
    return params.toString()
  }, [appliedRange])

  const { data, isLoading, isError } = useQuery<PerformanceData>({
    queryKey: ['employee-performance', employeeId, queryString],
    queryFn: () =>
      api.get<PerformanceData>(
        `/api/employees/${employeeId}/performance${queryString ? '?' + queryString : ''}`,
      ),
    staleTime: 30_000,
  })

  function applyDateRange() {
    setAppliedRange({ from: dateFrom || undefined, to: dateTo || undefined })
  }

  function clearDateRange() {
    setDateFrom('')
    setDateTo('')
    setAppliedRange({})
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-10 text-center">
          <AlertTriangle className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">
            {isSelf
              ? 'Failed to load your performance stats. Try refreshing.'
              : 'Failed to load performance stats. You may lack permission to view this employee\'s performance.'}
          </p>
        </CardContent>
      </Card>
    )
  }

  const { stats, statusBreakdown } = data

  // Build funnel chart data
  const funnelData = [
    { stage: 'Created', count: stats.totalOrders },
    { stage: 'Confirmed', count: statusBreakdown.confirmed },
    { stage: 'Dispatched', count: stats.dispatchedCount },
    { stage: 'Delivered', count: stats.deliveredCount },
    { stage: 'RTO', count: stats.rtoCount },
    { stage: 'Cancelled', count: stats.cancelledCount },
  ]

  return (
    <div className="space-y-6">
      {/* Date range filter */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            Date range filter
          </CardTitle>
          <CardDescription>
            Filter funnel stats by date range. Leave empty for all-time totals.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="date-from" className="text-xs">From</Label>
            <Input
              id="date-from"
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-40"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="date-to" className="text-xs">To</Label>
            <Input
              id="date-to"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-40"
            />
          </div>
          <Button size="sm" onClick={applyDateRange}>Apply</Button>
          {(appliedRange.from || appliedRange.to) && (
            <Button size="sm" variant="ghost" onClick={clearDateRange}>Clear</Button>
          )}
          {(appliedRange.from || appliedRange.to) && (
            <Badge variant="outline" className="text-xs">
              {appliedRange.from || 'Start'} → {appliedRange.to || 'Now'}
            </Badge>
          )}
        </CardContent>
      </Card>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard
          icon={Package}
          label="Total Orders"
          value={stats.totalOrders.toString()}
          color="text-slate-600"
        />
        <KpiCard
          icon={Truck}
          label="Dispatched"
          value={stats.dispatchedCount.toString()}
          sublabel={`${stats.inTransitCount} in transit`}
          color="text-violet-600"
        />
        <KpiCard
          icon={CheckCircle2}
          label="Delivered"
          value={stats.deliveredCount.toString()}
          sublabel={`${(stats.deliveryRate * 100).toFixed(1)}% delivery rate`}
          color="text-emerald-600"
        />
        <KpiCard
          icon={XCircle}
          label="Cancelled"
          value={stats.cancelledCount.toString()}
          sublabel={`${(stats.cancellationRate * 100).toFixed(1)}% rate`}
          color="text-slate-500"
        />
        <KpiCard
          icon={RotateCcw}
          label="RTO"
          value={stats.rtoCount.toString()}
          sublabel={`${(stats.rtoRate * 100).toFixed(1)}% rate`}
          color="text-rose-600"
        />
        <KpiCard
          icon={Package}
          label="Items Sold"
          value={stats.itemsSoldQty.toString()}
          sublabel="qty dispatched+delivered"
          color="text-sky-600"
        />
        <KpiCard
          icon={AlertTriangle}
          label="Damage/Loss"
          value={stats.damageLossCount.toString()}
          sublabel="tracking only"
          color="text-amber-600"
        />
        <KpiCard
          icon={DollarSign}
          label="Revenue"
          value={formatPKR(stats.revenueGenerated)}
          sublabel="dispatched+delivered"
          color="text-emerald-600"
        />
      </div>

      {/* Funnel chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            Order funnel
          </CardTitle>
          <CardDescription>
            Visualizes the order lifecycle: Created → Confirmed → Dispatched → Delivered / RTO / Cancelled.
            Rates are calculated against dispatched orders (not total) for delivery and RTO.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {stats.totalOrders === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No orders in this date range.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={funnelData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="stage" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip
                  cursor={{ fill: 'hsl(var(--muted) / 0.3)' }}
                  contentStyle={{ borderRadius: '8px', border: '1px solid hsl(var(--border))', fontSize: '12px' }}
                />
                <Bar dataKey="count" radius={[4, 4, 0, 0]} name="Orders">
                  {funnelData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={FUNNEL_COLORS[entry.stage] ?? '#64748b'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Rate definitions */}
      <Card>
        <CardContent className="p-4">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">Rate definitions:</span>{' '}
            Cancellation Rate = Cancelled ÷ Total Orders.{' '}
            Delivery Rate = Delivered ÷ Dispatched (not total).{' '}
            RTO Rate = RTO ÷ Dispatched (not total).{' '}
            In Transit = Dispatched − Delivered − RTO.{' '}
            Revenue = sum of order value for dispatched + delivered orders.
            Damage/Loss count is tracking-only and never affects monetary figures.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function KpiCard({
  icon: Icon,
  label,
  value,
  sublabel,
  color,
}: {
  icon: typeof Package
  label: string
  value: string
  sublabel?: string
  color: string
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Icon className={`h-4 w-4 ${color}`} />
        </div>
        <p className="text-xl font-bold tabular-nums">{value}</p>
        {sublabel && (
          <p className="text-[11px] text-muted-foreground mt-0.5">{sublabel}</p>
        )}
      </CardContent>
    </Card>
  )
}
