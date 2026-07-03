'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, ArrowLeft, ArrowRight, Check, Building2, MapPin } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import {
  createCompanySchema,
  type CreateCompanyInput,
} from '@/lib/validations/company'
import type { SessionResponse } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { cn } from '@/lib/utils'

const STEPS = ['Organization', 'Company', 'Review'] as const

export function CreateCompanyWizard({
  onBack,
  onComplete,
}: {
  onBack: () => void
  onComplete: (s: SessionResponse) => void
}) {
  const [step, setStep] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const user = useAppStore((s) => s.user)

  const form = useForm<CreateCompanyInput>({
    resolver: zodResolver(createCompanySchema),
    defaultValues: {
      orgName: '',
      companyName: '',
      legalName: '',
      taxId: '',
      taxIdType: 'NTN',
      baseCurrency: 'PKR',
      countryCode: 'PK',
      province: '',
      city: '',
      addressStreet: '',
      postalCode: '',
      timezone: 'Asia/Karachi',
    },
    mode: 'onChange',
  })
  const values = form.watch()

  async function submit() {
    const valid = await form.trigger()
    if (!valid) {
      setStep(0)
      toast.error('Please fix the highlighted fields.')
      return
    }
    setSubmitting(true)
    try {
      const session = await api.post<SessionResponse>(
        '/api/onboarding/create-company',
        form.getValues(),
      )
      toast.success('Workspace created — welcome to FlowOps.')
      onComplete(session)
    } catch (err) {
      toast.error(
        err instanceof FetchError ? err.message : 'Failed to create workspace.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      {/* Stepper */}
      <div className="flex items-center gap-2">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center gap-2 flex-1">
            <div
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium shrink-0',
                i < step
                  ? 'bg-primary text-primary-foreground'
                  : i === step
                    ? 'bg-primary text-primary-foreground ring-4 ring-primary/15'
                    : 'bg-muted text-muted-foreground',
              )}
            >
              {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </div>
            <span
              className={cn(
                'text-sm font-medium hidden sm:block',
                i === step ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {label}
            </span>
            {i < STEPS.length - 1 && (
              <div
                className={cn(
                  'h-px flex-1',
                  i < step ? 'bg-primary' : 'bg-border',
                )}
              />
            )}
          </div>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {step === 0 && <><Building2 className="h-5 w-5 text-primary" /> Organization details</>}
            {step === 1 && <><MapPin className="h-5 w-5 text-primary" /> Company details</>}
            {step === 2 && <><Check className="h-5 w-5 text-primary" /> Review & create</>}
          </CardTitle>
          <CardDescription>
            {step === 0 && 'The umbrella organization that holds one or more companies.'}
            {step === 1 && 'Your first operating company — all business data lives here.'}
            {step === 2 && 'Confirm the details below and create your workspace.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {step === 0 && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="orgName">Organization name</Label>
                <Input
                  id="orgName"
                  placeholder="Khan Holdings"
                  {...form.register('orgName')}
                />
                {form.formState.errors.orgName && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.orgName.message}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  A slug will be auto-generated for URLs.
                </p>
              </div>
              <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                Owner: <span className="font-medium text-foreground">{user?.fullName}</span> ({user?.email})
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="companyName">Company name</Label>
                <Input
                  id="companyName"
                  placeholder="Khan Traders Pvt Ltd"
                  {...form.register('companyName')}
                />
                {form.formState.errors.companyName && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.companyName.message}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="legalName">Legal name (optional)</Label>
                <Input
                  id="legalName"
                  placeholder="Khan Traders (Pvt) Ltd"
                  {...form.register('legalName')}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="taxId">NTN / STRN (optional)</Label>
                <Input
                  id="taxId"
                  placeholder="1234567-8"
                  {...form.register('taxId')}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="province">Province</Label>
                <Input
                  id="province"
                  placeholder="Sindh"
                  {...form.register('province')}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  placeholder="Karachi"
                  {...form.register('city')}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="addressStreet">Street address</Label>
                <Input
                  id="addressStreet"
                  placeholder="Plot 12, Clifton, Block 5"
                  {...form.register('addressStreet')}
                />
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <ReviewRow label="Organization" value={values.orgName} />
              <ReviewRow label="Company" value={values.companyName} />
              <ReviewRow
                label="Legal name"
                value={values.legalName || '—'}
              />
              <ReviewRow label="NTN/STRN" value={values.taxId || '—'} />
              <ReviewRow
                label="Location"
                value={[values.city, values.province, values.countryCode]
                  .filter(Boolean)
                  .join(', ')}
              />
              <ReviewRow label="Currency" value={values.baseCurrency} />
              <ReviewRow label="Timezone" value={values.timezone} />
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs">
                <p className="font-medium text-primary mb-1">What happens next</p>
                <ul className="space-y-1 text-muted-foreground">
                  <li>• Organization + company are created</li>
                  <li>• 4 system roles seeded (Owner, Founder, Co-Founder, Investor)</li>
                  <li>• You&apos;re added as an Owner employee with elevated access</li>
                </ul>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          onClick={() => (step === 0 ? onBack() : setStep((s) => s - 1))}
          disabled={submitting}
        >
          <ArrowLeft className="h-4 w-4" /> {step === 0 ? 'Cancel' : 'Back'}
        </Button>
        {step < STEPS.length - 1 ? (
          <Button onClick={() => setStep((s) => s + 1)} disabled={submitting}>
            Continue <ArrowRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button onClick={submit} disabled={submitting}>
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                Create workspace <Check className="h-4 w-4" />
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  )
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 border-b last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-right truncate max-w-[60%]">
        {value || '—'}
      </span>
    </div>
  )
}
