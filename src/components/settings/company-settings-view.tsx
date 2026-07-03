'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import { PageHeader } from '@/components/layout/dashboard-shell'
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
import { Loader2, Save, Building2, MapPin, Receipt } from 'lucide-react'
import { toast } from 'sonner'
import { updateCompanySchema } from '@/lib/validations/company'

interface CompanyData {
  company: {
    id: string
    name: string
    legalName: string | null
    slug: string
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
  organization: {
    id: string
    name: string
    slug: string
    subscriptionPlan: string
    subscriptionStatus: string
    ownerId: string
  } | null
}

export function CompanySettingsView() {
  const activeCompany = useAppStore((s) => s.activeCompany)
  const [data, setData] = useState<CompanyData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})

  useEffect(() => {
    api
      .get<CompanyData>('/api/company')
      .then((d) => {
        setData(d)
        setForm({
          name: d.company.name,
          legalName: d.company.legalName ?? '',
          taxId: d.company.taxId ?? '',
          taxIdType: d.company.taxIdType ?? 'NTN',
          baseCurrency: d.company.baseCurrency,
          email: d.company.email ?? '',
          phone: d.company.phone ?? '',
          website: d.company.website ?? '',
          addressStreet: d.company.addressStreet ?? '',
          addressCity: d.company.addressCity ?? '',
          addressProvince: d.company.addressProvince ?? '',
          addressPostalCode: d.company.addressPostalCode ?? '',
          addressCountry: d.company.addressCountry ?? '',
        })
      })
      .catch(() => toast.error('Failed to load company settings.'))
      .finally(() => setLoading(false))
  }, [activeCompany?.id])

  async function save() {
    setSaving(true)
    try {
      const parsed = updateCompanySchema.safeParse(form)
      if (!parsed.success) {
        throw new Error(parsed.error.issues[0]?.message ?? 'Invalid input')
      }
      await api.patch('/api/company', parsed.data)
      toast.success('Company settings saved')
    } catch (err) {
      toast.error(
        err instanceof FetchError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to save.',
      )
    } finally {
      setSaving(false)
    }
  }

  if (loading || !data) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title="Company settings"
        description="Manage your company profile, tax information, and address."
        actions={
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save changes
          </Button>
        }
      />

      {/* Organization context */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" /> Organization
          </CardTitle>
          <CardDescription>
            This company belongs to the organization below.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-3 gap-4 text-sm">
          <Field label="Organization" value={data.organization?.name ?? '—'} />
          <Field label="Plan" value={<Badge variant="secondary" className="capitalize">{data.organization?.subscriptionPlan}</Badge>} />
          <Field label="Status" value={<Badge variant="outline" className="capitalize">{data.organization?.subscriptionStatus}</Badge>} />
        </CardContent>
      </Card>

      {/* Company profile */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" /> Company profile
          </CardTitle>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-4">
          <FieldInput label="Company name" value={form.name ?? ''} onChange={(v) => setForm({ ...form, name: v })} />
          <FieldInput label="Legal name" value={form.legalName ?? ''} onChange={(v) => setForm({ ...form, legalName: v })} />
          <FieldInput label="Base currency" value={form.baseCurrency ?? ''} onChange={(v) => setForm({ ...form, baseCurrency: v })} />
          <FieldInput label="Country code" value={form.addressCountry ?? ''} onChange={(v) => setForm({ ...form, addressCountry: v })} />
          <FieldInput label="Email" value={form.email ?? ''} onChange={(v) => setForm({ ...form, email: v })} />
          <FieldInput label="Phone" value={form.phone ?? ''} onChange={(v) => setForm({ ...form, phone: v })} />
          <FieldInput label="Website" value={form.website ?? ''} onChange={(v) => setForm({ ...form, website: v })} />
          <div className="space-y-1.5">
            <Label>Timezone</Label>
            <Input value={data.company.timezone} disabled />
          </div>
        </CardContent>
      </Card>

      {/* Tax info */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Receipt className="h-4 w-4 text-muted-foreground" /> Tax information
          </CardTitle>
          <CardDescription>NTN or STRN for Pakistani tax compliance.</CardDescription>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Tax ID type</Label>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              value={form.taxIdType ?? 'NTN'}
              onChange={(e) => setForm({ ...form, taxIdType: e.target.value })}
            >
              <option value="NTN">NTN</option>
              <option value="STRN">STRN</option>
            </select>
          </div>
          <FieldInput label="Tax ID number" value={form.taxId ?? ''} onChange={(v) => setForm({ ...form, taxId: v })} />
        </CardContent>
      </Card>

      {/* Address */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <MapPin className="h-4 w-4 text-muted-foreground" /> Address
          </CardTitle>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <FieldInput label="Street" value={form.addressStreet ?? ''} onChange={(v) => setForm({ ...form, addressStreet: v })} />
          </div>
          <FieldInput label="City" value={form.addressCity ?? ''} onChange={(v) => setForm({ ...form, addressCity: v })} />
          <FieldInput label="Province" value={form.addressProvince ?? ''} onChange={(v) => setForm({ ...form, addressProvince: v })} />
          <FieldInput label="Postal code" value={form.addressPostalCode ?? ''} onChange={(v) => setForm({ ...form, addressPostalCode: v })} />
        </CardContent>
      </Card>
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

function FieldInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}
