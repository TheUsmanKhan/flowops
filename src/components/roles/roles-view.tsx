'use client'

import { useEffect, useState } from 'react'
import { useAppStore, useCan } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import type { RolePublic } from '@/lib/types'
import { PERMISSIONS } from '@/lib/permissions'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { ShieldCheck, Lock, Users, Pencil, Trash2, Plus, Loader2, Crown } from 'lucide-react'
import { toast } from 'sonner'
import { PermissionKeySelector } from '@/components/roles/permission-key-selector'

export function RolesView() {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const [roles, setRoles] = useState<RolePublic[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<RolePublic | null>(null)

  const canManage = can(PERMISSIONS.SETTINGS_ROLES_MANAGE)

  const refresh = () => {
    setLoading(true)
    api
      .get<{ roles: RolePublic[] }>('/api/roles')
      .then((r) => setRoles(r.roles))
      .catch(() => setRoles([]))
      .finally(() => setLoading(false))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refresh, [])

  async function deleteRole(role: RolePublic) {
    try {
      await api.delete(`/api/roles/${role.id}`)
      toast.success(`Role "${role.name}" deleted`)
      setDeleteTarget(null)
      refresh()
    } catch (err) {
      toast.error(
        err instanceof FetchError ? err.message : 'Failed to delete role.',
      )
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Roles & Permissions"
        description="System roles have elevated access and bypass all permission checks. Create custom roles with granular, per-module permissions."
        actions={
          canManage && (
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="h-4 w-4" /> New role
                </Button>
              </DialogTrigger>
              <CreateRoleDialog
                onCreated={() => {
                  setCreateOpen(false)
                  refresh()
                }}
              />
            </Dialog>
          )
        }
      />

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-5">
                <div className="h-20 rounded bg-muted/50 animate-pulse" />
              </CardContent>
            </Card>
          ))
        ) : (
          roles.map((r) => (
            <Card key={r.id} className="hover:border-primary/30 transition-colors">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div
                      className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                        r.roleTier === 'elevated'
                          ? 'bg-primary/10 text-primary'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {r.isSystemRole ? (
                        <Crown className="h-4 w-4" />
                      ) : (
                        <ShieldCheck className="h-4 w-4" />
                      )}
                    </div>
                    <div>
                      <CardTitle className="text-base flex items-center gap-1.5">
                        {r.name}
                        {r.isSystemRole && <Lock className="h-3 w-3 text-muted-foreground" />}
                      </CardTitle>
                      {r.systemRoleKey && (
                        <p className="text-xs text-muted-foreground font-mono">
                          {r.systemRoleKey}
                        </p>
                      )}
                    </div>
                  </div>
                  {r.roleTier === 'elevated' && (
                    <Badge variant="secondary" className="text-[10px]">
                      Elevated
                    </Badge>
                  )}
                </div>
                <CardDescription className="line-clamp-2 min-h-[2.5rem]">
                  {r.description ||
                    (r.roleTier === 'elevated'
                      ? 'Bypasses all permission checks. Full administrative access.'
                      : 'Custom role with specific module permissions.')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Users className="h-3.5 w-3.5" />
                    {r.employeeCount ?? 0} member{(r.employeeCount ?? 0) === 1 ? '' : 's'}
                  </span>
                  <span className="text-muted-foreground">
                    {r.roleTier === 'elevated'
                      ? 'All permissions'
                      : `${r.permissions.length} permission${r.permissions.length === 1 ? '' : 's'}`}
                  </span>
                </div>
                {r.roleTier !== 'elevated' && r.permissions.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {r.permissions.slice(0, 4).map((p) => (
                      <Badge key={p} variant="outline" className="text-[10px] font-mono">
                        {p}
                      </Badge>
                    ))}
                    {r.permissions.length > 4 && (
                      <Badge variant="outline" className="text-[10px]">
                        +{r.permissions.length - 4} more
                      </Badge>
                    )}
                  </div>
                )}
                <div className="flex items-center gap-2 pt-1">
                  {canManage && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => navigate({ name: 'role-edit', id: r.id })}
                    >
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </Button>
                  )}
                  {canManage && !r.isSystemRole && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteTarget(r)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Delete confirmation */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete role &ldquo;{deleteTarget?.name}&rdquo;?</DialogTitle>
            <DialogDescription>
              This permanently removes the role and its permission assignments.
              Active employees using this role must be reassigned first.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteRole(deleteTarget)}
            >
              <Trash2 className="h-4 w-4" /> Delete role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function CreateRoleDialog({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [permissions, setPermissions] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  async function create() {
    if (!name.trim()) {
      toast.error('Role name is required.')
      return
    }
    setSaving(true)
    try {
      await api.post('/api/roles', { name, description, permissions })
      toast.success(`Role "${name}" created`)
      onCreated()
    } catch (err) {
      toast.error(
        err instanceof FetchError ? err.message : 'Failed to create role.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>Create custom role</DialogTitle>
        <DialogDescription>
          Assign a name and pick the exact permissions this role should grant.
          You can adjust these anytime.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 max-h-[60vh] overflow-y-auto scrollbar-thin pr-1">
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="roleName">Role name</Label>
            <Input
              id="roleName"
              placeholder="Warehouse Manager"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="roleDesc">Description (optional)</Label>
            <Input
              id="roleDesc"
              placeholder="Manages inventory and stock adjustments"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Permissions</Label>
          <PermissionKeySelector selected={permissions} onChange={setPermissions} />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={create} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Create role
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
