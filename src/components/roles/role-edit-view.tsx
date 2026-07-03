'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import type { RolePublic } from '@/lib/types'
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
import { PermissionKeySelector } from '@/components/roles/permission-key-selector'
import {
  ArrowLeft,
  Save,
  Loader2,
  Lock,
  Crown,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'

export function RoleEditView({ roleId }: { roleId: string }) {
  const navigate = useAppStore((s) => s.navigate)
  const [role, setRole] = useState<RolePublic | null>(null)
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [permissions, setPermissions] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api
      .get<{ roles: RolePublic[] }>('/api/roles')
      .then((r) => {
        const found = r.roles.find((x) => x.id === roleId)
        if (!found) {
          toast.error('Role not found.')
          navigate({ name: 'roles' })
          return
        }
        setRole(found)
        setName(found.name)
        setDescription(found.description ?? '')
        setPermissions(found.permissions)
      })
      .catch(() => navigate({ name: 'roles' }))
      .finally(() => setLoading(false))
  }, [roleId, navigate])

  async function save() {
    setSaving(true)
    try {
      await api.patch(`/api/roles/${roleId}`, { name, description, permissions })
      toast.success('Role updated')
      navigate({ name: 'roles' })
    } catch (err) {
      toast.error(
        err instanceof FetchError ? err.message : 'Failed to update role.',
      )
    } finally {
      setSaving(false)
    }
  }

  if (loading || !role) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <button
        onClick={() => navigate({ name: 'roles' })}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to roles
      </button>

      <PageHeader
        title={role.name}
        description={role.description || 'Edit this role and its permissions.'}
        actions={
          <div className="flex items-center gap-2">
            {role.isSystemRole && (
              <Badge variant="secondary" className="gap-1">
                <Lock className="h-3 w-3" /> System
              </Badge>
            )}
            {role.roleTier === 'elevated' && (
              <Badge variant="secondary" className="gap-1">
                <Crown className="h-3 w-3" /> Elevated
              </Badge>
            )}
            <Button onClick={save} disabled={saving}>
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Save className="h-4 w-4" /> Save
                </>
              )}
            </Button>
          </div>
        }
      />

      {role.roleTier === 'elevated' ? (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="p-5 flex items-start gap-3">
            <ShieldCheck className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Elevated role — full access</p>
              <p className="text-xs text-muted-foreground">
                Elevated roles (Owner, Founder, Co-Founder, Investor) bypass all
                permission checks and have unrestricted administrative access.
                No permission assignments are needed.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Role details</CardTitle>
            <CardDescription>
              Rename the role and fine-tune which actions it can perform.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">Role name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Permissions ({permissions.length} selected)</Label>
              <PermissionKeySelector
                selected={permissions}
                onChange={setPermissions}
              />
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            Members with this role
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {role.employeeCount ?? 0} active member{(role.employeeCount ?? 0) === 1 ? '' : 's'}{' '}
            currently hold this role.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
