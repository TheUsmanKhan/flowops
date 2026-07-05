'use client'

import { useState } from 'react'
import { Loader2, ArrowLeft, ArrowRight, Check, Building2, MapPin, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import type { SessionResponse } from '@/lib/types'
import { slugify } from '@/lib/slugify'
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

const STEPS = ['Organization', 'First Company', 'Review'] as const

interface OrgFormState {
  org_name: string
  org_logo_url: string | null
  org_description: string
  org_website: string
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

export function CreateOrganizationView({ onBack }: { onBack: () => void }) {
  const navigate = useAppStore((s) => s.navigate)
  const user = useAppStore((s) => s.user)
  const setSession = useAppStore((s) => s.setSession)
  const [step, setStep] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [form, setForm] = useState<OrgFormState>({
    org_name: '',
    org_logo_url: null,
    org_description: '',
    org_website: '',
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

  const set = <K extends keyof OrgFormState>(key: K, value: OrgFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  function validateStep(s: number): string | null {
    if (s === 0) {
      if (form.org_name.trim().length < 2) return 'Organization name must be at least 2 characters'
    }
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
    if (err) {
      setSubmitError(err)
      return
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1))
  }

  async function submit() {
    setSubmitError(null)
    const err0 = validateStep(0)
    const err1 = validateStep(1)
    if (err0 || err1) {
      setSubmitError(err0 || err1)
      setStep(err0 ? 0 : 1)
      return
    }
    setSubmitting(true)
    try {
      const session = await api.post<SessionResponse>(
        '/api/organizations/create',
        form,
      )
      setSession({
        user: session.user,
        activeCompany: session.activeCompany,
        companies: session.companies,
        employee: session.employee ?? undefined,
      })
      toast.success(`${form.org_name} created! Welcome to your new workspace.`)
      navigate({ name: 'dashboard' })
    } catch (err) {
      const msg =
        err instanceof FetchError
          ? err.message
          : 'Network error — the server may have restarted. Please try again.'
      setSubmitError(msg)
      toast.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        disabled={submitting}
      >
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      <div className="text-center space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Create New Organization</h1>
        <p className="text-sm text-muted-foreground">
          Set up a new business umbrella with its first company.
        </p>
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
            <span className={cn('text-sm font-medium hidden sm:block', i === step ? 'text-foreground' : 'text-muted-foreground')}>
              {label}
            </span>
            {i < STEPS.length - 1 && <div className={cn('h-px flex-1', i < step ? 'bg-primary' : 'bg-border')} />}
          </div>
        ))}
      </div>

      {submitError && (
        <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-medium">Couldn&apos;t create the organization</p>
            <p className="text-xs mt-0.5 opacity-90">{submitError}</p>
          </div>
          <button onClick={() => setSubmitError(null)} className="text-destructive/60 hover:text-destructive text-xs">Dismiss</button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {step === 0 && <><Building2 className="h-5 w-5 text-primary" /> Organization Info</>}
            {step === 1 && <><MapPin className="h-5 w-5 text-primary" /> First Company</>}
            {step === 2 && <><Check className="h-5 w-5 text-primary" /> Review & Create</>}
          </CardTitle>
          <CardDescription>
            {step === 0 && 'The umbrella organization that holds one or more companies.'}
            {step === 1 && 'Every organization needs at least one company — your main legal entity.'}
            {step === 2 && 'Confirm the details below and create your workspace.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {step === 0 && (
            <>
              <div className="flex justify-center">
                <LogoUpload
                  type="organizations"
                  id={user?.id ?? 'temp'}
                  name={form.org_name}
                  currentUrl={form.org_logo_url}
                  onChange={(url) => set('org_logo_url', url)}
                  size={120}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Organization name <span className="text-destructive">*</span></Label>
                <Input value={form.org_name} onChange={(e) => set('org_name', e.target.value)} placeholder="Hafeez Group" autoFocus />
                {form.org_name && (
                  <p className="text-xs text-muted-foreground">URL slug: <code className="font-mono">{slugify(form.org_name) || 'workspace'}</code></p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>Description (optional)</Label>
                <Textarea value={form.org_description} onChange={(e) => set('org_description', e.target.value)} rows={2} maxLength={500} placeholder="A holding company for our e-commerce brands…" />
                <p className="text-xs text-muted-foreground text-right">{form.org_description.length}/500</p>
              </div>
              <div className="space-y-1.5">
                <Label>Website (optional)</Label>
                <Input value={form.org_website} onChange={(e) => set('org_website', e.target.value)} placeholder="https://hafeezgroup.com" />
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="flex justify-center">
                <LogoUpload
                  type="companies"
                  id={user?.id ?? 'temp'}
                  name={form.company_name}
                  currentUrl={form.company_logo_url}
                  onChange={(url) => set('company_logo_url', url)}
                  size={100}
                />
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Company name <span className="text-destructive">*</span></Label>
                  <Input value={form.company_name} onChange={(e) => set('company_name', e.target.value)} placeholder="Hafeez Textiles Pvt Ltd" autoFocus />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Legal name (optional)</Label>
                  <Input value={form.company_legal_name} onChange={(e) => set('company_legal_name', e.target.value)} placeholder="Hafeez Textiles Private Limited" />
                </div>
              </div>

              <div className="rounded-lg border p-4 space-y-3">
                <p className="text-sm font-medium">Tax Registration (Pakistan)</p>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">NTN</Label>
                    <Input value={form.ntn} onChange={(e) => set('ntn', e.target.value)} placeholder="1234567-8" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">STRN</Label>
                    <Input value={form.strn} onChange={(e) => set('strn', e.target.value)} placeholder="03-04-9999-100-88" />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">ℹ️ You can add these later in Company Settings. Both are required for legal invoicing.</p>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Base currency <span className="text-destructive">*</span></Label>
                  <CurrencySelector value={form.base_currency} onChange={(c) => set('base_currency', c)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Country <span className="text-destructive">*</span></Label>
                  <CountrySelector value={form.country_code} onChange={(c) => set('country_code', c)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Province / State</Label>
                  {form.country_code === 'PK' ? (
                    <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={form.province} onChange={(e) => set('province', e.target.value)}>
                      <option value="">Select…</option>
                      {PAKISTAN_PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  ) : (
                    <Input value={form.province} onChange={(e) => set('province', e.target.value)} placeholder="State / Region" />
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>City</Label>
                  <Input value={form.city} onChange={(e) => set('city', e.target.value)} placeholder="Karachi" />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Street address</Label>
                  <Textarea value={form.address} onChange={(e) => set('address', e.target.value)} rows={2} placeholder="Plot 12, Clifton, Block 5" />
                </div>
                <div className="space-y-1.5">
                  <Label>Phone</Label>
                  <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+92 300 1234567" />
                </div>
                <div className="space-y-1.5">
                  <Label>Email</Label>
                  <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="info@hafeez.com" />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Website</Label>
                  <Input value={form.website} onChange={(e) => set('website', e.target.value)} placeholder="https://hafeez.com" />
                </div>
                <div className="space-y-1.5">
                  <Label>Fiscal year starts</Label>
                  <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={form.fiscal_year_start} onChange={(e) => set('fiscal_year_start', Number(e.target.value))}>
                    {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Fiscal year: {MONTHS[form.fiscal_year_start - 1]} → {MONTHS[(form.fiscal_year_start - 1 + 11) % 12]}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>Timezone</Label>
                  <Input value={form.timezone} onChange={(e) => set('timezone', e.target.value)} placeholder="Asia/Karachi" />
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="rounded-lg border p-4 space-y-2">
                <p className="text-xs font-medium uppercase text-muted-foreground">Organization</p>
                <div className="flex items-center gap-2">
                  {form.org_logo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={form.org_logo_url} alt="" className="h-10 w-10 rounded-full object-cover" />
                  ) : (
                    <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-sm font-medium text-primary">
                      {form.org_name.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <span className="font-medium">{form.org_name || '—'}</span>
                </div>
                {form.org_description && <p className="text-xs text-muted-foreground">{form.org_description}</p>}
              </div>
              <div className="rounded-lg border p-4 space-y-2">
                <p className="text-xs font-medium uppercase text-muted-foreground">Company</p>
                <div className="flex items-center gap-2">
                  {form.company_logo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={form.company_logo_url} alt="" className="h-10 w-10 rounded-md object-cover" />
                  ) : (
                    <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center text-sm font-medium">
                      {form.company_name.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <span className="font-medium">{form.company_name || '—'}</span>
                </div>
                <dl className="text-xs space-y-1">
                  <div className="flex justify-between"><dt className="text-muted-foreground">Currency</dt><dd>{form.base_currency}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted-foreground">Country</dt><dd>{form.country_code}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted-foreground">City</dt><dd>{form.city || '—'}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted-foreground">NTN</dt><dd>{form.ntn || '—'}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted-foreground">Fiscal year</dt><dd>{MONTHS[form.fiscal_year_start - 1]}</dd></div>
                </dl>
              </div>
              <div className="sm:col-span-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs space-y-1">
                <p className="font-medium text-primary">What will happen</p>
                <p className="text-muted-foreground">✓ Organization &ldquo;{form.org_name}&rdquo; will be created</p>
                <p className="text-muted-foreground">✓ Company &ldquo;{form.company_name}&rdquo; will be created under it</p>
                <p className="text-muted-foreground">✓ You will be set as Owner automatically</p>
                <p className="text-muted-foreground">✓ Owner, Founder, Co-Founder, Investor roles will be created</p>
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
          <Button onClick={goNext} disabled={submitting}>
            Continue <ArrowRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button onClick={submit} disabled={submitting}>
            {submitting ? (<><Loader2 className="h-4 w-4 animate-spin" /> Creating…</>) : (<>Create Organization & Company <Check className="h-4 w-4" /></>)}
          </Button>
        )}
      </div>
    </div>
  )
}
