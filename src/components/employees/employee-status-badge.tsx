'use client'

import { Badge } from '@/components/ui/badge'

const STYLES: Record<string, string> = {
  active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  suspended: 'bg-amber-50 text-amber-700 border-amber-200',
  terminated: 'bg-rose-50 text-rose-700 border-rose-200',
  on_leave: 'bg-sky-50 text-sky-700 border-sky-200',
}

const LABELS: Record<string, string> = {
  active: 'Active',
  suspended: 'Suspended',
  terminated: 'Terminated',
  on_leave: 'On leave',
}

export function EmployeeStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={`text-xs font-medium capitalize ${STYLES[status] ?? 'bg-muted text-muted-foreground'}`}
    >
      <span className="mr-1 h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {LABELS[status] ?? status}
    </Badge>
  )
}
