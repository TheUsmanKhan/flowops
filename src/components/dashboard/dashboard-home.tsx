'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/app-store'
import { api } from '@/lib/api-client'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Users, ShieldCheck, Mail, Activity, ArrowUpRight, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface DashboardData {
  stats: { employees: number; roles: number; pendingInvites: number; orgs: number }
  recentActivity: {
    id: string
    action: string
    entityType: string
    createdAt: string
    user: { id: string; fullName: string; email: string } | null
  }[]
  metrics: { key: string; value: number }[]
}

const STAT_CARDS = [
  { key: 'employees', label: 'Active employees', icon: Users, color: 'text-emerald-600 bg-emerald-50' },
  { key: 'roles', label: 'Active roles', icon: ShieldCheck, color: 'text-amber-600 bg-amber-50' },
  { key: 'pendingInvites', label: 'Pending invites', icon: Mail, color: 'text-rose-600 bg-rose-50' },
  { key: 'orgs', label: 'Organizations', icon: Activity, color: 'text-violet-600 bg-violet-50' },
] as const

export function DashboardHome() {
  const activeCompany = useAppStore((s) => s.activeCompany)
  const user = useAppStore((s) => s.user)
  const navigate = useAppStore((s) => s.navigate)
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .get<DashboardData>('/api/dashboard')
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [activeCompany?.id])

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome back, ${user?.fullName?.split(' ')[0] ?? ''}`}
        description={`Here's what's happening in ${activeCompany?.name} today.`}
        actions={
          <Button onClick={() => navigate({ name: 'employees-invite' })}>
            <Users className="h-4 w-4" /> Invite employee
          </Button>
        }
      />

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STAT_CARDS.map((card) => {
          const Icon = card.icon
          const value = data?.stats[card.key] ?? 0
          return (
            <Card key={card.key}>
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${card.color}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  {loading ? (
                    <div className="h-7 w-12 rounded bg-muted animate-pulse" />
                  ) : (
                    <span className="text-2xl font-semibold tracking-tight">
                      {value}
                    </span>
                  )}
                </div>
                <p className="mt-3 text-sm text-muted-foreground">{card.label}</p>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Recent activity */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" /> Recent activity
            </CardTitle>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={() => navigate({ name: 'audit' })}
            >
              View all <ArrowUpRight className="h-3 w-3" />
            </Button>
          </CardHeader>
          <CardContent className="pt-0">
            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-12 rounded bg-muted/50 animate-pulse" />
                ))}
              </div>
            ) : data?.recentActivity.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                No activity yet. Invite your first employee to get started.
              </div>
            ) : (
              <div className="space-y-1 max-h-80 overflow-y-auto scrollbar-thin">
                {data?.recentActivity.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/50"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-medium shrink-0">
                      {(a.user?.fullName ?? '?')[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm">
                        <span className="font-medium">
                          {a.user?.fullName ?? 'System'}
                        </span>{' '}
                        <span className="text-muted-foreground">
                          {describeAction(a.action)}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(a.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <Badge variant="outline" className="text-xs font-mono">
                      {a.entityType}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Quick actions + company info */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Quick actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 pt-0">
              <QuickAction label="Invite employee" hint="Add a team member" onClick={() => navigate({ name: 'employees-invite' })} />
              <QuickAction label="Manage roles" hint="Edit permissions" onClick={() => navigate({ name: 'roles' })} />
              <QuickAction label="Company settings" hint="Profile & tax info" onClick={() => navigate({ name: 'company-settings' })} />
              <QuickAction label="View audit log" hint="Immutable events" onClick={() => navigate({ name: 'audit' })} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Company</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 pt-0 text-sm">
              <InfoRow label="Name" value={activeCompany?.name ?? '—'} />
              <InfoRow label="Currency" value={activeCompany?.baseCurrency ?? '—'} />
              <InfoRow label="Country" value={activeCompany?.countryCode ?? '—'} />
              <InfoRow label="Timezone" value={activeCompany?.timezone ?? '—'} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function QuickAction({ label, hint, onClick }: { label: string; hint: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between rounded-md border px-3 py-2 text-left hover:bg-muted/50 transition-colors"
    >
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
    </button>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium truncate">{value}</span>
    </div>
  )
}

function describeAction(action: string): string {
  const map: Record<string, string> = {
    'auth.registered': 'registered',
    'auth.login': 'signed in',
    'auth.logout': 'signed out',
    'auth.password_reset': 'reset their password',
    'organization.created': 'created the organization',
    'company.created': 'created the company',
    'employee.joined': 'joined as an employee',
    'employee.invited': 'invited an employee',
    'employee.terminated': 'terminated an employee',
    'employee.suspended': 'suspended an employee',
    'employee.reactivated': 'reactivated an employee',
    'employee.role_changed': "changed an employee's role",
    'role.created': 'created a role',
    'role.updated': 'updated a role',
    'role.deleted': 'deleted a role',
    'invitation.accepted': 'accepted an invitation',
    'invitation.revoked': 'revoked an invitation',
    'company.updated': 'updated company settings',
    'workspace.switched': 'switched workspace',
  }
  return map[action] ?? action
}
