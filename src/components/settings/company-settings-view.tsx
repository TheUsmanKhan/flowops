'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CurrencySelector } from '@/components/ui/currency-selector'
import { CountrySelector } from '@/components/ui/country-selector'
import { LogoUpload } from '@/components/ui/logo-upload'
import { InitialsAvatar } from '@/components/ui/initials-avatar'
import { PAKISTAN_PROVINCES, MONTHS } from '@/lib/data/countries'
import { Loader2, Save, Lock, AlertTriangle, Archive, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface CompanyData {
  id: string
  name: string
  legalName: string | null
  slug: string
  logoUrl: string | null
  baseCurrency: string
  countryCode: string
  taxId: string | null
  taxIdType: string | null
  timezone: string
  email: string | null
  phone: string | null
  website: string | null
  addressStreet: string | null
  addressCity: string | null
  addressProvince: string | null
  addressPostalCode: string | null
  addressCountry: string | null
  fiscalYearStart: number
  organizationId: string
}

export function CompanySettingsView() {
  const activeCompany = useAppStore((s) => s.activeCompany)
  const user = useAppStore((s) => s.user)
  const setSession = useAppStore((s) => s.setSession)
  const navigate = useAppStore((s) => s.navigate)
  const [data, setData] = useState<CompanyData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState('profile')
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveConfirm, setArchiveConfirm] = useState('')
  const [currencyWarning, setCurrencyWarning] = useState<string | null>(null)

  // Form state for each tab
  const [profile, setProfile] = useState({ name: '', legalName: '', logoUrl: '' as string | null })
  const [tax, setTax] = useState({ taxId: '', taxIdType: 'NTN' as string })
  const [address, setAddress] = useState({ addressStreet: '', addressCity: '', addressProvince: '', addressPostalCode: '', addressCountry: 'PK', phone: '', email: '', website: '' })
  const [financial, setFinancial] = useState({ baseCurrency: 'PKR', fiscalYearStart: 1, timezone: 'Asia/Karachi' })

  useEffect(() => {
    api
      .get<{ company: CompanyData }>('/api/company')
      .then((d) => {
        setData(d.company)
        setProfile({ name: d.company.name, legalName: d.company.legalName ?? '', logoUrl: d.company.logoUrl })
        setTax({ taxId: d.company.taxId ?? '', taxIdType: d.company.taxIdType ?? 'NTN' })
        setAddress({
          addressStreet: d.company.addressStreet ?? '',
          addressCity: d.company.addressCity ?? '',
          addressProvince: d.company.addressProvince ?? '',
          addressPostalCode: d.company.addressPostalCode ?? '',
          addressCountry: d.company.addressCountry ?? d.company.countryCode,
          phone: d.company.phone ?? '',
          email: d.company.email ?? '',
          website: d.company.website ?? '',
        })
        setFinancial({
          baseCurrency: d.company.baseCurrency,
          fiscalYearStart: d.company.fiscalYearStart,
          timezone: d.company.timezone,
        })
      })
      .catch(() => toast.error('Failed to load company settings.'))
      .finally(() => setLoading(false))
  }, [activeCompany?.id])

  async function saveProfile() {
    setSaving(true)
    try {
      const session = await api.patch('/api/company', {
        name: profile.name,
        legalName: profile.legalName,
        logoUrl: profile.logoUrl,
      })
      setSession({ user, activeCompany: session.activeCompany, companies: session.companies, employee: session.employee ?? undefined })
      toast.success('Profile saved')
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to save.')
    } finally { setSaving(false) }
  }

  async function saveTax() {
    setSaving(true)
    try {
      await api.patch('/api/company', { taxId: tax.taxId, taxIdType: tax.taxIdType })
      toast.success('Tax information saved')
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to save.')
    } finally { setSaving(false) }
  }

  async function saveAddress() {
    setSaving(true)
    try {
      await api.patch('/api/company', {
        addressStreet: address.addressStreet,
        addressCity: address.addressCity,
        addressProvince: address.addressProvince,
        addressPostalCode: address.addressPostalCode,
        addressCountry: address.addressCountry,
        phone: address.phone,
        email: address.email,
        website: address.website,
      })
      toast.success('Address & contact saved')
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to save.')
    } finally { setSaving(false) }
  }

  async function saveFinancial() {
    setSaving(true)
    try {
      const session = await api.patch('/api/company', {
        baseCurrency: financial.baseCurrency,
        fiscalYearStart: financial.fiscalYearStart,
        timezone: financial.timezone,
      })
      setSession({ user, activeCompany: session.activeCompany, companies: session.companies, employee: session.employee ?? undefined })
      setCurrencyWarning(null)
      toast.success('Financial settings saved')
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to save.')
    } finally { setSaving(false) }
  }

  async function archiveCompany() {
    setSaving(true)
    try {
      const session = await api.post('/api/companies/' + data?.id + '/archive', { id: data?.id, confirmation_text: archiveConfirm })
      setSession({ user, activeCompany: session.activeCompany, companies: session.companies, employee: session.employee ?? undefined })
      toast.success('Company archived')
      setArchiveOpen(false)
      if (!session.activeCompany) {
        navigate({ name: 'onboarding' })
      } else {
        navigate({ name: 'dashboard' })
      }
    } catch (err) {
      toast.error(err instanceof FetchError ? err.message : 'Failed to archive.')
    } finally { setSaving(false) }
  }

  if (loading || !data) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="Company Settings" description="Manage your company profile, legal info, and preferences." />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-3 sm:grid-cols-5">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="tax">Tax &amp; Legal</TabsTrigger>
          <TabsTrigger value="address">Address</TabsTrigger>
          <TabsTrigger value="financial">Financial</TabsTrigger>
          <TabsTrigger value="danger" className="text-destructive">Danger</TabsTrigger>
        </TabsList>

        {/* TAB 1: PROFILE */}
        <TabsContent value="profile">
          <Card>
            <CardHeader><CardTitle className="text-base">Company Profile</CardTitle><CardDescription>Logo, name, and display info.</CardDescription></CardHeader>
            <CardContent className="space-y-5">
              <div className="flex justify-center">
                <LogoUpload type="companies" id={data.id} name={data.name} currentUrl={profile.logoUrl} onChange={(url) => setProfile((p) => ({ ...p, logoUrl: url }))} size={120} />
              </div>
              <div className="space-y-1.5">
                <Label>Company Display Name</Label>
                <Input value={profile.name} onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Legal / Registered Name (optional)</Label>
                <Input value={profile.legalName} onChange={(e) => setProfile((p) => ({ ...p, legalName: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Company Slug</Label>
                <div className="flex items-center gap-2">
                  <Input value={data.slug} readOnly className="bg-muted/50 font-mono text-sm" />
                  <Lock className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="text-xs text-muted-foreground">Cannot be changed after creation — used in URLs.</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="gap-1"><ShieldCheck className="h-3 w-3" /> Active</Badge>
              </div>
              <div className="flex justify-end"><Button onClick={saveProfile} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Profile</Button></div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 2: TAX & LEGAL */}
        <TabsContent value="tax">
          <Card>
            <CardHeader><CardTitle className="text-base">Tax &amp; Legal</CardTitle><CardDescription>Pakistan tax registration.</CardDescription></CardHeader>
            <CardContent className="space-y-5">
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>NTN (National Tax Number)</Label>
                  <Input value={tax.taxId} onChange={(e) => setTax((t) => ({ ...t, taxId: e.target.value }))} placeholder="1234567-8" />
                  <p className="text-xs text-muted-foreground">7-digit number + check digit, issued by FBR.</p>
                </div>
                <div className="space-y-1.5">
                  <Label>Tax ID Type</Label>
                  <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={tax.taxIdType} onChange={(e) => setTax((t) => ({ ...t, taxIdType: e.target.value }))}>
                    <option value="NTN">NTN</option>
                    <option value="STRN">STRN</option>
                    <option value="VAT">VAT Number</option>
                    <option value="GST">GST Number</option>
                    <option value="EIN">EIN</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>
              </div>
              <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                ℹ️ NTN is required for filing income tax returns with FBR. STRN is needed if you charge GST/Sales Tax on invoices.
              </div>
              <div className="flex justify-end"><Button onClick={saveTax} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Tax Info</Button></div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 3: ADDRESS & CONTACT */}
        <TabsContent value="address">
          <Card>
            <CardHeader><CardTitle className="text-base">Address &amp; Contact</CardTitle><CardDescription>Registered address and contact details.</CardDescription></CardHeader>
            <CardContent className="space-y-5">
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5 sm:col-span-2"><Label>Street Address</Label><Textarea value={address.addressStreet} onChange={(e) => setAddress((a) => ({ ...a, addressStreet: e.target.value }))} rows={2} /></div>
                <div className="space-y-1.5">
                  <Label>Country</Label>
                  <CountrySelector value={address.addressCountry} onChange={(c) => setAddress((a) => ({ ...a, addressCountry: c }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>Province / State</Label>
                  {address.addressCountry === 'PK' ? (
                    <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={address.addressProvince} onChange={(e) => setAddress((a) => ({ ...a, addressProvince: e.target.value }))}>
                      <option value="">Select…</option>
                      {PAKISTAN_PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  ) : (<Input value={address.addressProvince} onChange={(e) => setAddress((a) => ({ ...a, addressProvince: e.target.value }))} />)}
                </div>
                <div className="space-y-1.5"><Label>City</Label><Input value={address.addressCity} onChange={(e) => setAddress((a) => ({ ...a, addressCity: e.target.value }))} /></div>
                <div className="space-y-1.5"><Label>Postal Code</Label><Input value={address.addressPostalCode} onChange={(e) => setAddress((a) => ({ ...a, addressPostalCode: e.target.value }))} /></div>
                <div className="space-y-1.5"><Label>Phone</Label><Input value={address.phone} onChange={(e) => setAddress((a) => ({ ...a, phone: e.target.value }))} placeholder="+92 300 1234567" /></div>
                <div className="space-y-1.5"><Label>Email</Label><Input type="email" value={address.email} onChange={(e) => setAddress((a) => ({ ...a, email: e.target.value }))} /></div>
                <div className="space-y-1.5 sm:col-span-2"><Label>Website</Label><Input value={address.website} onChange={(e) => setAddress((a) => ({ ...a, website: e.target.value }))} placeholder="https://…" /></div>
              </div>
              <div className="flex justify-end"><Button onClick={saveAddress} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Address &amp; Contact</Button></div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 4: FINANCIAL */}
        <TabsContent value="financial">
          <Card>
            <CardHeader><CardTitle className="text-base">Financial Settings</CardTitle><CardDescription>Currency, fiscal year, and timezone.</CardDescription></CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-1.5">
                <Label>Base Currency</Label>
                <CurrencySelector value={financial.baseCurrency} onChange={(c) => {
                  if (c !== data.baseCurrency) setCurrencyWarning(c)
                  setFinancial((f) => ({ ...f, baseCurrency: c }))
                }} />
                <p className="text-xs text-muted-foreground">Primary currency for all financial reports.</p>
              </div>
              {currencyWarning && currencyWarning !== data.baseCurrency && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
                  <p className="font-medium text-amber-800 flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" /> Currency change warning</p>
                  <p className="text-xs text-amber-700 mt-1">Changing base currency does NOT convert existing monetary values — only the display label changes going forward. Are you sure?</p>
                  <div className="flex gap-2 mt-2">
                    <Button variant="outline" size="sm" onClick={() => { setFinancial((f) => ({ ...f, baseCurrency: data.baseCurrency })); setCurrencyWarning(null) }}>Cancel Change</Button>
                    <Button size="sm" onClick={() => setCurrencyWarning(null)}>Yes, Change Currency</Button>
                  </div>
                </div>
              )}
              <div className="space-y-1.5">
                <Label>Fiscal Year Starts In</Label>
                <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={financial.fiscalYearStart} onChange={(e) => setFinancial((f) => ({ ...f, fiscalYearStart: Number(e.target.value) }))}>
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
                <p className="text-xs text-muted-foreground">Fiscal year: {MONTHS[financial.fiscalYearStart - 1]} → {MONTHS[(financial.fiscalYearStart - 1 + 11) % 12]}</p>
              </div>
              <div className="space-y-1.5">
                <Label>Timezone</Label>
                <Input value={financial.timezone} onChange={(e) => setFinancial((f) => ({ ...f, timezone: e.target.value }))} />
              </div>
              <div className="flex justify-end"><Button onClick={saveFinancial} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Financial Settings</Button></div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 5: DANGER ZONE */}
        <TabsContent value="danger">
          <Card className="border-destructive/30">
            <CardHeader><CardTitle className="text-base text-destructive flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> Danger Zone</CardTitle><CardDescription>Irreversible actions.</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <p className="text-sm font-medium">Archive This Company</p>
                <p className="text-xs text-muted-foreground mt-1">Archiving permanently disables this company. All employees lose access immediately. Data is preserved but cannot be undone without support.</p>
                <Button variant="outline" className="mt-3 text-destructive border-destructive/40 hover:bg-destructive/10" onClick={() => setArchiveOpen(true)}>
                  <Archive className="h-4 w-4" /> Archive Company
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Archive confirmation dialog */}
      <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">Archive {data.name}?</DialogTitle>
            <DialogDescription>This will disable access for all employees, stop all operations, and preserve historical data. This cannot be undone.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>Type the company name to confirm:</Label>
            <Input value={archiveConfirm} onChange={(e) => setArchiveConfirm(e.target.value)} placeholder={data.name} />
            <p className="text-xs text-muted-foreground">Must type: <code className="font-mono">{data.name}</code></p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setArchiveOpen(false); setArchiveConfirm('') }}>Cancel</Button>
            <Button variant="destructive" onClick={archiveCompany} disabled={saving || archiveConfirm !== data.name}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />} Archive Company
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
