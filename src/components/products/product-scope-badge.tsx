'use client'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { Lock, Globe, Users, Archive } from 'lucide-react'

const STYLES: Record<string, string> = {
  private: 'bg-gray-50 text-gray-700 border-gray-200',
  organization: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  selective: 'bg-amber-50 text-amber-700 border-amber-200',
  archived: 'bg-rose-50 text-rose-700 border-rose-200',
}

const ICONS: Record<string, typeof Lock> = {
  private: Lock,
  organization: Globe,
  selective: Users,
  archived: Archive,
}

const LABELS: Record<string, string> = {
  private: 'Private',
  organization: 'Organization',
  selective: 'Selective',
  archived: 'Archived',
}

export function ProductScopeBadge({
  scope,
  className,
}: {
  scope: string
  className?: string
}) {
  const Icon = ICONS[scope] ?? Lock
  return (
    <Badge
      variant="outline"
      className={cn('gap-1 text-xs capitalize', STYLES[scope] ?? STYLES.private, className)}
    >
      <Icon className="h-3 w-3" />
      {LABELS[scope] ?? scope}
    </Badge>
  )
}
