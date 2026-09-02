'use client'

import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError, initials } from '@/lib/api-client'
import type { SessionResponse } from '@/lib/types'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LogoUpload } from '@/components/ui/logo-upload'
import { Loader2, Save, AlertTriangle, Archive, Plus, ChevronRight, Building2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface OrgData {
  id: string
  name: string
  slug: string
  logoUrl: string | null
  subscriptionPlan: string
  subscriptionStatus: string
  ownerId: string
}

interface CompanyRow {
  id: string
  name: string
  baseCurrency: string
  logoUrl: string | null
  isActive: boolean
  _count: { employees: number }
}

interface WorkspacesResponse {
  workspaces: {
    org_id: string
    companies: {
      company_id: string
      company_name: string
      company_logo_url: string | null
      base_currency: string
    }[]
  }[]
}

export function OrganizationView() {
  const activeCompany = useAppStore((s) => s.activeCompany)
  const user = useAppStore((s) => s.user)
  const setSession = useAppStore((s) => s.setSession)
  const navigate = useAppStore((s) => s.navigate)
  const queryClient = useQueryClient()

  const companyQuery = useQuery<{ company: { organizationId: string }; organization: OrgData | null }>({
    queryKey: ['company', activeCompany?.id],
    queryFn: () => api.get<{ company: { organizationId: string }; organization: OrgData | null }>('/api/company'),
    staleTime: 60_000,
  })

  const workspacesQuery = useQuery<WorkspacesResponse>({
    queryKey: ['workspaces'],
    queryFn: () => api.get<WorkspacesResponse>('/api/workspaces'),
    staleTime: 60_000,
    enabled: !!companyQuery.data?.organization,
  })

  const org = companyQuery.data?.organization ?? null

  const [companies, setCompanies] = useState<CompanyRow[]>([])
  const [tab, setTab] = useState('profile')
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveConfirm, setArchiveConfirm] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [website, setWebsite] = useState('')
  const [logoUrl, setLogoUrl] = useState<string | null>(null)

  // Sync form state + derived companies list when org / workspaces data arrives
  useEffect(() => {
    if (org) {
      setName(org.name)
      setLogoUrl(org.logoUrl)
    }
  }, [org?.id, org?.name, org?.logoUrl])

  useEffect(() => {
    if (!org) {
      setCompanies([])
      return
    }
    const group = workspacesQuery.data?.workspaces.find((g) => g.org_id === org.id)
    if (group) {
      setCompanies(group.companies.map((c) => ({
        id: c.company_id,
        name: c.company_name,
        baseCurrency: c.base_currency,
        logoUrl: c.company_logo_url,
        isActive: true,
        _count: { employees: 0 },
      })))
    } else {
      setCompanies([])
    }
  }, [org?.id, workspacesQuery.data])

  const saveProfileMutation = useMutation({
    mutationFn: async (input: { orgId: string; name: string; description: string; website: string; logoUrl: string | null }) =>
      api.patch<SessionResponse>('/api/organizations/' + input.orgId, {
        org_id: input.orgId,
        name: input.name,
        description: input.description,
        website: input.website,
        logoUrl: input.logoUrl,
      }),
    onSuccess: (session) => {
      setSession({ user, activeCompany: session.activeCompany, companies: session.companies, employee: session.employee ?? undefined })
      toast.success('Organization profile saved')
      void queryClient.invalidateQueries({ queryKey: ['company', activeCompany?.id] })
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] })
    },
    onError: (err) => toast.error(err instanceof FetchError ? err.message : 'Failed to save.'),
  })

  const archiveMutation = useMutation({
    mutationFn: async (input: { orgId: string; confirmationText: string }) =>
      api.post<SessionResponse>('/api/organizations/' + input.orgId, { id: input.orgId, confirmation_text: input.confirmationText }),
    onSuccess: (session) => {
      setSession({ user, activeCompany: session.activeCompany, companies: session.companies, employee: session.employee ?? undefined })
      toast.success('Organization archived')
      setArchiveOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['company', activeCompany?.id] })
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] })
      if (!session.activeCompany) navigate({ name: 'onboarding' })
      else navigate({ name: 'dashboard' })
    },
    onError: (err) => toast.error(err instanceof FetchError ? err.message : 'Failed to archive.'),
  })

  const loading = companyQuery.isLoading || !org
  const savePending = saveProfileMutation.isPending
  const archivePending = archiveMutation.isPending

  function saveProfile() {
    if (!org) return
    saveProfileMutation.mutate({ orgId: org.id, name, description, website, logoUrl })
  }

  function archiveOrg() {
    if (!org) return
    archiveMutation.mutate({ orgId: org.id, confirmationText: archiveConfirm })
  }

  if (loading || !org) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="Organization Settings" description={`Manage ${org.name} — companies, subscription, and profile.`} />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="companies">Companies</TabsTrigger>
          <TabsTrigger value="subscription">Subscription</TabsTrigger>
          <TabsTrigger value="danger" className="text-destructive">Danger</TabsTrigger>
        </TabsList>

        {/* TAB 1: PROFILE */}
        <TabsContent value="profile">
          <Card>
            <CardHeader><CardTitle className="text-base">Organization Profile</CardTitle></CardHeader>
            <CardContent className="space-y-5">
              <div className="flex justify-center">
                <LogoUpload type="organizations" id={org.id} name={org.name} currentUrl={logoUrl} onChange={setLogoUrl} size={120} />
              </div>
              <div className="space-y-1.5">
                <Label>Organization Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Slug</Label>
                <Input value={org.slug} readOnly className="bg-muted/50 font-mono text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label>Description (optional)</Label>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={500} />
                <p className="text-xs text-muted-foreground text-right">{description.length}/500</p>
              </div>
              <div className="space-y-1.5">
                <Label>Website (optional)</Label>
                <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://…" />
              </div>
              <div className="flex justify-end"><Button onClick={saveProfile} disabled={savePending}>{savePending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Profile</Button></div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 2: COMPANIES */}
        <TabsContent value="companies">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div><CardTitle className="text-base">Companies in {org.name}</CardTitle><CardDescription>{companies.length} compan{companies.length === 1 ? 'y' : 'ies'}</CardDescription></div>
              <Button size="sm" onClick={() => navigate({ name: 'create-company', orgId: org.id })}><Plus className="h-4 w-4" /> Add Company</Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {companies.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  No companies yet. Add one to expand {org.name}.
                  <Button variant="outline" size="sm" className="mt-3 block mx-auto" onClick={() => navigate({ name: 'create-company', orgId: org.id })}><Plus className="h-4 w-4" /> Add Company</Button>
                </div>
              ) : (
                companies.map((c) => (
                  <button key={c.id} onClick={() => { navigate({ name: 'company-settings' }) }} className="w-full flex items-center gap-3 rounded-md border p-3 hover:bg-muted/50 text-left">
                    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-xs font-medium shrink-0">{initials(c.name)}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{c.name}</p>
                      <p className="text-xs text-muted-foreground">{c.baseCurrency} · Active</p>
                    </div>
                    <Badge variant="outline" className="text-[10px]">Manage</Badge>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </button>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 3: SUBSCRIPTION */}
        <TabsContent value="subscription">
          <Card>
            <CardHeader><CardTitle className="text-base">Subscription</CardTitle><CardDescription>Current plan and usage.</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-lg font-semibold uppercase">{org.subscriptionPlan} Plan</span>
                  <Badge variant="secondary" className="capitalize gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> {org.subscriptionStatus}</Badge>
                </div>
                <dl className="text-sm space-y-2">
                  <div className="flex justify-between"><dt className="text-muted-foreground">Companies</dt><dd>{companies.length} used</dd></div>
                  <div className="flex justify-between"><dt className="text-muted-foreground">Employees (across all)</dt><dd>—</dd></div>
                </dl>
                <Button className="mt-4 w-full" variant="outline">Upgrade Plan</Button>
                <p className="text-xs text-muted-foreground text-center mt-2">Need more? Contact support@flowops.com</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 4: DANGER ZONE */}
        <TabsContent value="danger">
          <Card className="border-destructive/30">
            <CardHeader><CardTitle className="text-base text-destructive flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> Danger Zone</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <p className="text-sm font-medium">Archive This Organization</p>
                <p className="text-xs text-muted-foreground mt-1">This will archive ALL {companies.length} compan{companies.length === 1 ? 'y' : 'ies'} under {org.name}. All employees across all companies will lose access. Data is preserved.</p>
                <Button variant="outline" className="mt-3 text-destructive border-destructive/40 hover:bg-destructive/10" onClick={() => setArchiveOpen(true)}>
                  <Archive className="h-4 w-4" /> Archive Organization
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">Archive {org.name}?</DialogTitle>
            <DialogDescription>This will archive all {companies.length} companies and revoke access for all employees. This cannot be undone.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>Type the organization name to confirm:</Label>
            <Input value={archiveConfirm} onChange={(e) => setArchiveConfirm(e.target.value)} placeholder={org.name} />
            <p className="text-xs text-muted-foreground">Must type: <code className="font-mono">{org.name}</code></p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setArchiveOpen(false); setArchiveConfirm('') }}>Cancel</Button>
            <Button variant="destructive" onClick={archiveOrg} disabled={archivePending || archiveConfirm !== org.name}>
              {archivePending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />} Archive Organization
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
