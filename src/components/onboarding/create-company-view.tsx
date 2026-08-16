'use client'

import { useEffect, useState, useRef } from 'react'
import { Loader2, ArrowLeft, ArrowRight, Check, AlertCircle, Building2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import type { SessionResponse } from '@/lib/types'
import { useInvalidateWorkspaces } from '@/components/workspace/workspace-switcher'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { CurrencySelector } from '@/components/ui/currency-selector'
import { CountrySelector } from '@/components/ui/country-selector'
import { LogoUpload } from '@/components/ui/logo-upload'
import { PAKISTAN_PROVINCES, MONTHS } from '@/lib/data/countries'
import { cn } from '@/lib/utils'

const STEPS = ['Choose Org', 'Company Details', 'Review'] as const

interface OrgOption {
  org_id: string
  org_name: string
  org_logo_url: string | null
  company_count: number
}

interface CompanyFormState {
  organization_id: string
  company_name: string
  company_legal_name: string
  company_logo_url: string | null
  base_currency: string
  country_code: string
  province: string
  city: string
  address: string
  phone: string
  email: string
  website: string
  ntn: string
  strn: string
  timezone: string
  fiscal_year_start: number
}

export function CreateCompanyView({ orgId, onBack }: { orgId?: string; onBack: () => void }) {
  const navigate = useAppStore((s) => s.navigate)
  const user = useAppStore((s) => s.user)
  const setSession = useAppStore((s) => s.setSession)
  const invalidateWorkspaces = useInvalidateWorkspaces()
  const [step, setStep] = useState(orgId ? 1 : 0)
  const [orgs, setOrgs] = useState<OrgOption[]>([])
  const [loadingOrgs, setLoadingOrgs] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID())
  const [form, setForm] = useState<CompanyFormState>({
    organization_id: orgId ?? '',
    company_name: '',
    company_legal_name: '',
    company_logo_url: null,
    base_currency: 'PKR',
    country_code: 'PK',
    province: '',
    city: '',
    address: '',
    phone: '',
    email: '',
    website: '',
    ntn: '',
    strn: '',
    timezone: 'Asia/Karachi',
    fiscal_year_start: 1,
  })

  useEffect(() => {
    api
      .get<{ workspaces: { org_id: string; org_name: string; org_logo_url: string | null; is_owner: boolean; companies: unknown[] }[] }>('/api/workspaces')
      .then((r) => {
        const owned = r.workspaces.filter((w) => w.is_owner)
        setOrgs(owned.map((w) => ({ org_id: w.org_id, org_name: w.org_name, org_logo_url: w.org_logo_url, company_count: w.companies.length })))
      })
      .catch(() => setOrgs([]))
      .finally(() => setLoadingOrgs(false))
  }, [])

  const set = <K extends keyof CompanyFormState>(key: K, value: CompanyFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  function validateStep(s: number): string | null {
    if (s === 0 && !form.organization_id) return 'Select an organization'
    if (s === 1) {
      if (form.company_name.trim().length < 2) return 'Company name must be at least 2 characters'
      if (form.base_currency.length !== 3) return 'Select a base currency'
      if (form.country_code.length !== 2) return 'Select a country'
    }
    return null
  }

  function goNext() {
    setSubmitError(null)
    const err = validateStep(step)
    if (err) { setSubmitError(err); return }
    setStep((s) => Math.min(s + 1, STEPS.length - 1))
  }

  async function submit() {
    setSubmitError(null)
    const err0 = validateStep(0)
    const err1 = validateStep(1)
    if (err0 || err1) { setSubmitError(err0 || err1); setStep(err0 ? 0 : 1); return }
    setSubmitting(true)
    try {
      const session = await api.post<SessionResponse>('/api/companies/create', form, {
        'Idempotency-Key': idempotencyKeyRef.current,
      })
      setSession({
        user: session.user,
        activeCompany: session.activeCompany,
        companies: session.companies,
        employee: session.employee ?? undefined,
      })
      invalidateWorkspaces()
      toast.success(`${form.company_name} created!`)
      navigate({ name: 'dashboard' })
    } catch (err) {
      const msg = err instanceof FetchError ? err.message : 'Network error. Please try again.'
      setSubmitError(msg)
      toast.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  const selectedOrg = orgs.find((o) => o.org_id === form.organization_id)

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" disabled={submitting}>
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      <div className="text-center space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Create New Company</h1>
        <p className="text-sm text-muted-foreground">Add a company to an existing organization.</p>
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-2">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center gap-2 flex-1">
            <div className={cn(
              'flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium shrink-0 transition-colors',
              i < step ? 'bg-primary text-primary-foreground'
                : i === step ? 'bg-primary text-primary-foreground ring-4 ring-primary/15'
                : 'bg-muted text-muted-foreground',
            )}>
              {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </div>
            <span className={cn('text-sm font-medium hidden sm:block', i === step ? 'text-foreground' : 'text-muted-foreground')}>{label}</span>
            {i < STEPS.length - 1 && <div className={cn('h-px flex-1', i < step ? 'bg-primary' : 'bg-border')} />}
          </div>
        ))}
      </div>

      {submitError && (
        <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <div className="flex-1"><p className="font-medium">Couldn&apos;t create the company</p><p className="text-xs mt-0.5 opacity-90">{submitError}</p></div>
          <button onClick={() => setSubmitError(null)} className="text-destructive/60 hover:text-destructive text-xs">Dismiss</button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {step === 0 && <><Building2 className="h-5 w-5 text-primary" /> Choose Organization</>}
            {step === 1 && <><Building2 className="h-5 w-5 text-primary" /> Company Details</>}
            {step === 2 && <><Check className="h-5 w-5 text-primary" /> Review & Create</>}
          </CardTitle>
          <CardDescription>
            {step === 0 && 'Which organization should this company belong to?'}
            {step === 1 && 'Enter the details for your new company.'}
            {step === 2 && 'Confirm and create your new company.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {step === 0 && (
            <div className="space-y-2">
              {loadingOrgs ? (
                <div className="space-y-2">{[0, 1].map((i) => <div key={i} className="h-16 rounded-lg bg-muted/50 animate-pulse" />)}</div>
              ) : orgs.length === 0 ? (
                <div className="text-center py-6 text-sm text-muted-foreground">
                  You don&apos;t own any organizations yet.
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => navigate({ name: 'create-organization' })}>
                    <Plus className="h-4 w-4" /> Create one first
                  </Button>
                </div>
              ) : (
                orgs.map((o) => (
                  <button
                    key={o.org_id}
                    onClick={() => set('organization_id', o.org_id)}
                    className={cn(
                      'w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-colors',
                      form.organization_id === o.org_id ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/50',
                    )}
                  >
                    <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-sm font-medium text-primary shrink-0">
                      {o.org_name.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{o.org_name}</p>
                      <p className="text-xs text-muted-foreground">{o.company_count} compan{o.company_count === 1 ? 'y' : 'ies'} · Owner</p>
                    </div>
                    {form.organization_id === o.org_id && <Check className="h-4 w-4 text-primary" />}
                  </button>
                ))
              )}
            </div>
          )}

          {step === 1 && (
            <>
              <div className="flex justify-center">
                <LogoUpload type="companies" id={user?.id ?? 'temp'} name={form.company_name} currentUrl={form.company_logo_url} onChange={(url) => set('company_logo_url', url)} size={100} />
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Company name <span className="text-destructive">*</span></Label>
                  <Input value={form.company_name} onChange={(e) => set('company_name', e.target.value)} placeholder="Hafeez Online Store" autoFocus />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Legal name (optional)</Label>
                  <Input value={form.company_legal_name} onChange={(e) => set('company_legal_name', e.target.value)} placeholder="Hafeez E-Commerce Pvt Ltd" />
                </div>
              </div>
              <div className="rounded-lg border p-4 space-y-3">
                <p className="text-sm font-medium">Tax Registration (Pakistan)</p>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5"><Label className="text-xs">NTN</Label><Input value={form.ntn} onChange={(e) => set('ntn', e.target.value)} placeholder="1234567-8" /></div>
                  <div className="space-y-1.5"><Label className="text-xs">STRN</Label><Input value={form.strn} onChange={(e) => set('strn', e.target.value)} placeholder="03-04-9999-100-88" /></div>
                </div>
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5"><Label>Base currency <span className="text-destructive">*</span></Label><CurrencySelector value={form.base_currency} onChange={(c) => set('base_currency', c)} /></div>
                <div className="space-y-1.5"><Label>Country <span className="text-destructive">*</span></Label><CountrySelector value={form.country_code} onChange={(c) => set('country_code', c)} /></div>
                <div className="space-y-1.5">
                  <Label>Province / State</Label>
                  {form.country_code === 'PK' ? (
                    <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={form.province} onChange={(e) => set('province', e.target.value)}>
                      <option value="">Select…</option>
                      {PAKISTAN_PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  ) : (<Input value={form.province} onChange={(e) => set('province', e.target.value)} placeholder="State / Region" />)}
                </div>
                <div className="space-y-1.5"><Label>City</Label><Input value={form.city} onChange={(e) => set('city', e.target.value)} placeholder="Lahore" /></div>
                <div className="space-y-1.5 sm:col-span-2"><Label>Street address</Label><Textarea value={form.address} onChange={(e) => set('address', e.target.value)} rows={2} placeholder="Main Boulevard, Gulberg" /></div>
                <div className="space-y-1.5"><Label>Phone</Label><Input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+92 300 1234567" /></div>
                <div className="space-y-1.5"><Label>Email</Label><Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="info@hafeez.com" /></div>
                <div className="space-y-1.5"><Label>Fiscal year starts</Label>
                  <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={form.fiscal_year_start} onChange={(e) => set('fiscal_year_start', Number(e.target.value))}>
                    {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5"><Label>Timezone</Label><Input value={form.timezone} onChange={(e) => set('timezone', e.target.value)} placeholder="Asia/Karachi" /></div>
              </div>
            </>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="rounded-lg border p-4 space-y-2">
                <p className="text-xs font-medium uppercase text-muted-foreground">Organization</p>
                <p className="font-medium">{selectedOrg?.org_name ?? '—'}</p>
              </div>
              <div className="rounded-lg border p-4 space-y-2">
                <p className="text-xs font-medium uppercase text-muted-foreground">New Company</p>
                <div className="flex items-center gap-2">
                  {form.company_logo_url ? (
                     
                    <img src={form.company_logo_url} alt="" className="h-10 w-10 rounded-md object-cover" />
                  ) : (
                    <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center text-sm font-medium">{form.company_name.slice(0, 2).toUpperCase()}</div>
                  )}
                  <span className="font-medium">{form.company_name || '—'}</span>
                </div>
                <dl className="text-xs space-y-1">
                  <div className="flex justify-between"><dt className="text-muted-foreground">Currency</dt><dd>{form.base_currency}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted-foreground">Country</dt><dd>{form.country_code}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted-foreground">City</dt><dd>{form.city || '—'}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted-foreground">NTN</dt><dd>{form.ntn || '—'}</dd></div>
                </dl>
              </div>
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs space-y-1">
                <p className="font-medium text-primary">What will happen</p>
                <p className="text-muted-foreground">✓ Company &ldquo;{form.company_name}&rdquo; will be created under {selectedOrg?.org_name}</p>
                <p className="text-muted-foreground">✓ You will be set as Owner</p>
                <p className="text-muted-foreground">✓ 4 system roles will be seeded</p>
                <p className="text-muted-foreground">✓ Your active workspace will switch to this company</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={() => (step === 0 ? onBack() : setStep((s) => s - 1))} disabled={submitting}>
          <ArrowLeft className="h-4 w-4" /> {step === 0 ? 'Cancel' : 'Back'}
        </Button>
        {step < STEPS.length - 1 ? (
          <Button onClick={goNext} disabled={submitting}>Continue <ArrowRight className="h-4 w-4" /></Button>
        ) : (
          <Button onClick={submit} disabled={submitting}>
            {submitting ? (<><Loader2 className="h-4 w-4 animate-spin" /> Creating…</>) : (<>Create Company <Check className="h-4 w-4" /></>)}
          </Button>
        )}
      </div>
    </div>
  )
}
