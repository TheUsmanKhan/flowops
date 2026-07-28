'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import type { InvitationPublic, SessionResponse } from '@/lib/types'
import { OnboardingSelector } from '@/components/onboarding/onboarding-selector'
import { CreateCompanyWizard } from '@/components/onboarding/create-company-wizard'
import { AcceptInviteCard } from '@/components/onboarding/accept-invite-card'
import { FlowOpsLogo } from '@/components/layout/brand'
import { Loader2 } from 'lucide-react'

export function OnboardingView() {
  const user = useAppStore((s) => s.user)
  const setSession = useAppStore((s) => s.setSession)
  const navigate = useAppStore((s) => s.navigate)
  const [invitations, setInvitations] = useState<InvitationPublic[]>([])
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<'selector' | 'create' | 'accept'>('selector')
  const [activeInvite, setActiveInvite] = useState<InvitationPublic | null>(null)

  useEffect(() => {
    api
      .get<{ invitations: InvitationPublic[] }>('/api/onboarding/invitations')
      .then((r) => setInvitations(r.invitations))
      .catch(() => setInvitations([]))
      .finally(() => setLoading(false))
  }, [])

  function handleDone(session: SessionResponse) {
    setSession({
      user: session.user,
      activeCompany: session.activeCompany,
      companies: session.companies,
      employee: session.employee ?? undefined,
    })
    navigate({ name: 'dashboard' })
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="flex items-center gap-2.5 h-16 px-6 border-b">
        <FlowOpsLogo className="h-7 w-7 text-primary" />
        <span className="font-semibold tracking-tight">FlowOps</span>
        <span className="ml-auto text-sm text-muted-foreground">
          Signed in as {user?.email}
        </span>
      </header>
      <main className="flex-1 flex items-start justify-center px-4 py-10 sm:py-16">
        <div className="w-full max-w-3xl">
          {loading ? (
            <div className="flex items-center justify-center py-20 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : mode === 'create' ? (
            <CreateCompanyWizard
              onBack={() => setMode('selector')}
              onComplete={handleDone}
            />
          ) : mode === 'accept' && activeInvite ? (
            <AcceptInviteCard
              invitation={activeInvite}
              onBack={() => {
                setMode('selector')
                setActiveInvite(null)
              }}
              onAccepted={handleDone}
            />
          ) : (
            <OnboardingSelector
              invitations={invitations}
              onCreate={() => setMode('create')}
              onAccept={(inv) => {
                setActiveInvite(inv)
                setMode('accept')
              }}
            />
          )}
        </div>
      </main>
    </div>
  )
}
