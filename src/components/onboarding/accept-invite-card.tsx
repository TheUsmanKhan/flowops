'use client'

import { useState } from 'react'
import { Loader2, ArrowLeft, Check, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError, initials } from '@/lib/api-client'
import type { InvitationPublic, SessionResponse } from '@/lib/types'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

export function AcceptInviteCard({
  invitation,
  onBack,
  onAccepted,
}: {
  invitation: InvitationPublic
  onBack: () => void
  onAccepted: (s: SessionResponse) => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const setSession = useAppStore((s) => s.setSession)
  const navigate = useAppStore((s) => s.navigate)

  async function accept() {
    setSubmitting(true)
    try {
      const session = await api.post<SessionResponse>(
        '/api/onboarding/accept-invite',
        { token: invitation.token },
      )
      setSession({
        user: session.user,
        activeCompany: session.activeCompany,
        companies: session.companies,
        employee: session.employee ?? undefined,
      })
      toast.success(`You joined ${invitation.company.name}`)
      navigate({ name: 'dashboard' })
      onAccepted(session)
    } catch (err) {
      toast.error(
        err instanceof FetchError ? err.message : 'Failed to accept invitation.',
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

      <Card className="max-w-lg mx-auto">
        <CardHeader className="text-center items-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10 text-primary text-lg font-medium mx-auto">
            {initials(invitation.company.name)}
          </div>
          <CardTitle className="mt-3">Join {invitation.company.name}</CardTitle>
          <CardDescription>
            You&apos;ve been invited to join this company workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border divide-y">
            <Row label="Invited by" value={invitation.invitedBy.fullName} />
            <Row label="Sent to" value={invitation.invitedEmail} />
            <Row
              label="Role"
              value={
                <Badge variant="secondary" className="gap-1">
                  <ShieldCheck className="h-3 w-3" />
                  {invitation.role.name}
                </Badge>
              }
            />
            <Row
              label="Expires"
              value={new Date(invitation.expiresAt).toLocaleDateString()}
            />
          </div>

          {invitation.message && (
            <div className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground italic">
              &ldquo;{invitation.message}&rdquo;
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onBack} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={accept} disabled={submitting}>
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  Accept invitation <Check className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2.5">
      <span className="text-xs text-muted-foreground uppercase tracking-wide">
        {label}
      </span>
      <span className="text-sm font-medium text-right truncate">{value}</span>
    </div>
  )
}
