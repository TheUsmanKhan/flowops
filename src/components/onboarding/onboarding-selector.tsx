'use client'

import type { InvitationPublic } from '@/lib/types'
import { Building2, Mail, ArrowRight, CheckCircle2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { initials } from '@/lib/api-client'

export function OnboardingSelector({
  invitations,
  onCreate,
  onAccept,
}: {
  invitations: InvitationPublic[]
  onCreate: () => void
  onAccept: (inv: InvitationPublic) => void
}) {
  return (
    <div className="space-y-8">
      <div className="text-center space-y-3">
        <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
          <Sparkles className="h-3.5 w-3.5" /> Welcome to FlowOps
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Let&apos;s set up your workspace
        </h1>
        <p className="text-muted-foreground max-w-xl mx-auto">
          Create a new company workspace, or accept an invitation to join an
          existing team.
        </p>
      </div>

      {invitations.length > 0 && (
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-primary" />
              <CardTitle className="text-base">
                You have {invitations.length} pending{' '}
                {invitations.length === 1 ? 'invitation' : 'invitations'}
              </CardTitle>
            </div>
            <CardDescription>
              Accept to join the team as the assigned role.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {invitations.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center gap-3 rounded-lg border bg-background p-3"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted text-sm font-medium">
                  {initials(inv.company.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {inv.company.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Invited as{' '}
                    <span className="font-medium text-foreground">
                      {inv.role.name}
                    </span>{' '}
                    by {inv.invitedBy.fullName}
                  </p>
                </div>
                <Button size="sm" onClick={() => onAccept(inv)}>
                  Accept <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="relative overflow-hidden group hover:border-primary/40 transition-colors">
          <CardHeader>
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Building2 className="h-5 w-5" />
            </div>
            <CardTitle className="mt-3">Create a new company</CardTitle>
            <CardDescription>
              Set up an organization and your first operating company. You
              become the Owner with full elevated access.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" onClick={onCreate}>
              Start creation wizard <ArrowRight className="h-4 w-4" />
            </Button>
          </CardContent>
        </Card>

        <Card className={invitations.length === 0 ? 'opacity-60' : ''}>
          <CardHeader>
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Mail className="h-5 w-5" />
            </div>
            <CardTitle className="mt-3">Accept an invitation</CardTitle>
            <CardDescription>
              {invitations.length > 0
                ? 'Join a team that invited you via email.'
                : 'No pending invitations. Ask a team owner to invite your email.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {invitations.length > 0 ? (
              <div className="space-y-2">
                {invitations.slice(0, 2).map((inv) => (
                  <Button
                    key={inv.id}
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => onAccept(inv)}
                  >
                    <CheckCircle2 className="h-4 w-4 text-primary" />
                    <span className="flex-1 text-left truncate">
                      {inv.company.name}
                    </span>
                    <Badge variant="secondary" className="text-xs">
                      {inv.role.name}
                    </Badge>
                  </Button>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                Waiting for invitations to {`your email`}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
