'use client'

import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, ArrowLeft, Send, Mail } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import {
  inviteEmployeeSchema,
  type InviteEmployeeInput,
} from '@/lib/validations/employee'
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
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'

export function InviteEmployeeView() {
  const navigate = useAppStore((s) => s.navigate)
  const [roles, setRoles] = useState<RolePublic[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ roles: RolePublic[] }>('/api/roles')
      .then((r) => setRoles(r.roles))
      .catch(() => setRoles([]))
  }, [])

  const form = useForm<InviteEmployeeInput>({
    resolver: zodResolver(inviteEmployeeSchema),
    defaultValues: { email: '', roleId: '', department: '', designation: '', message: '' },
  })

  async function onSubmit(values: InviteEmployeeInput) {
    setSubmitting(true)
    try {
      await api.post('/api/employees', values)
      toast.success(`Invitation sent to ${values.email}`)
      setSentTo(values.email)
      form.reset()
    } catch (err) {
      toast.error(
        err instanceof FetchError ? err.message : 'Failed to send invitation.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <button
        onClick={() => navigate({ name: 'employees' })}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to employees
      </button>

      <PageHeader
        title="Invite employee"
        description="Send an invitation by email. The invitee joins your active company with the role you assign."
      />

      {sentTo && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="p-4 flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/15 text-primary">
              <Mail className="h-4 w-4" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium">Invitation sent to {sentTo}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                If they don&apos;t have an account yet, they can register with
                that email and will see the invitation on their onboarding
                screen.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setSentTo(null)}>
              Send another
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invitation details</CardTitle>
          <CardDescription>
            The invitation expires in 7 days. You can revoke it anytime from the
            audit log.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                placeholder="newhire@company.pk"
                {...form.register('email')}
              />
              {form.formState.errors.email && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.email.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="roleId">Role</Label>
              <Select
                value={form.watch('roleId')}
                onValueChange={(v) => form.setValue('roleId', v, { shouldValidate: true })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      <span className="flex items-center gap-2">
                        {r.name}
                        {r.roleTier === 'elevated' && (
                          <Badge variant="secondary" className="text-[10px]">
                            elevated
                          </Badge>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.formState.errors.roleId && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.roleId.message}
                </p>
              )}
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="department">Department (optional)</Label>
                <Input
                  id="department"
                  placeholder="Operations"
                  {...form.register('department')}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="designation">Designation (optional)</Label>
                <Input
                  id="designation"
                  placeholder="Sales Executive"
                  {...form.register('designation')}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="message">Personal message (optional)</Label>
              <Textarea
                id="message"
                rows={3}
                placeholder="Welcome to the team! We're excited to have you…"
                {...form.register('message')}
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => navigate({ name: 'employees' })}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Send className="h-4 w-4" /> Send invitation
                  </>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
