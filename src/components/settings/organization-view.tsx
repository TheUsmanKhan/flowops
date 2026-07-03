'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/app-store'
import { api } from '@/lib/api-client'
import { PageHeader } from '@/components/layout/dashboard-shell'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Building2, ChevronRight, Plus, Loader2 } from 'lucide-react'
import { initials } from '@/lib/api-client'
import type { CompanyPublic, OrganizationPublic } from '@/lib/types'

export function OrganizationView() {
  const navigate = useAppStore((s) => s.navigate)
  const activeCompany = useAppStore((s) => s.activeCompany)
  const companies = useAppStore((s) => s.companies)
  const [org, setOrg] = useState<OrganizationPublic | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .get<{ organization: OrganizationPublic | null }>('/api/company')
      .then((d) => setOrg(d.organization))
      .catch(() => setOrg(null))
      .finally(() => setLoading(false))
  }, [activeCompany?.id])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Organization"
        description="The umbrella organization that holds your operating companies."
        actions={
          <Button onClick={() => navigate({ name: 'onboarding' })}>
            <Plus className="h-4 w-4" /> New company
          </Button>
        }
      />

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Building2 className="h-6 w-6" />
                </div>
                <div>
                  <CardTitle>{org?.name ?? '—'}</CardTitle>
                  <CardDescription className="font-mono">
                    {org?.slug}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid sm:grid-cols-3 gap-4 text-sm">
              <Field label="Subscription plan" value={<Badge variant="secondary" className="capitalize">{org?.subscriptionPlan}</Badge>} />
              <Field label="Subscription status" value={<Badge variant="outline" className="capitalize">{org?.subscriptionStatus}</Badge>} />
              <Field label="Companies" value={String(companies.length)} />
            </CardContent>
          </Card>

          <div className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Companies in this organization
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {companies.map((c: CompanyPublic) => (
                <Card key={c.id} className="hover:border-primary/30 transition-colors">
                  <CardContent className="p-4 flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted text-sm font-medium">
                      {initials(c.name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{c.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {c.baseCurrency} · {c.countryCode}
                      </p>
                    </div>
                    {c.id === activeCompany?.id && (
                      <Badge variant="secondary" className="text-[10px]">Active</Badge>
                    )}
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <div className="font-medium">{value}</div>
    </div>
  )
}
