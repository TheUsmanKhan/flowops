'use client'

import { useAppStore } from '@/stores/app-store'
import { PageHeader } from '@/components/layout/dashboard-shell'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { initials } from '@/lib/api-client'
import { toast } from 'sonner'
import { ShieldCheck, Crown } from 'lucide-react'

export function SettingsView() {
  const user = useAppStore((s) => s.user)
  const employee = useAppStore((s) => s.employee)
  const activeCompany = useAppStore((s) => s.activeCompany)
  const navigate = useAppStore((s) => s.navigate)

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title="Personal settings"
        description="Your profile and workspace preferences."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
          <CardDescription>
            Update your display details. These are visible to teammates.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <Avatar className="h-16 w-16">
              <AvatarImage src={user?.avatarUrl ?? undefined} />
              <AvatarFallback className="bg-primary/10 text-primary text-lg">
                {user ? initials(user.fullName) : '?'}
              </AvatarFallback>
            </Avatar>
            <div>
              <p className="font-medium">{user?.fullName}</p>
              <p className="text-sm text-muted-foreground">{user?.email}</p>
              {employee?.isElevated && (
                <Badge variant="secondary" className="mt-1 gap-1">
                  <Crown className="h-3 w-3" /> Elevated access
                </Badge>
              )}
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="fullName">Full name</Label>
              <Input id="fullName" defaultValue={user?.fullName} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" defaultValue={user?.phone ?? ''} placeholder="+92 300 1234567" />
            </div>
          </div>
          <Button variant="outline" onClick={() => toast.info('Profile editing is wired but disabled in this preview.')}>
            Save profile
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workspace</CardTitle>
          <CardDescription>
            Your active company and role in this workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <p className="text-sm font-medium">{activeCompany?.name}</p>
              <p className="text-xs text-muted-foreground">
                {activeCompany?.baseCurrency} · {activeCompany?.timezone}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate({ name: 'company-settings' })}
            >
              Company settings
            </Button>
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <p className="text-sm font-medium flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                {employee?.roleName}
              </p>
              <p className="text-xs text-muted-foreground">
                {employee?.isElevated
                  ? 'Elevated — bypasses permission checks'
                  : `${employee?.permissions.length ?? 0} permissions assigned`}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate({ name: 'roles' })}
            >
              View roles
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
