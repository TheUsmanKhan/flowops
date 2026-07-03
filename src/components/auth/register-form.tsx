'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, Mail, Lock, User, ArrowRight } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import { registerSchema, type RegisterInput } from '@/lib/validations/auth'
import type { SessionResponse } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function RegisterForm() {
  const setSession = useAppStore((s) => s.setSession)
  const navigate = useAppStore((s) => s.navigate)
  const [loading, setLoading] = useState(false)

  const form = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      fullName: '',
      email: '',
      password: '',
      confirmPassword: '',
    },
  })

  async function onSubmit(values: RegisterInput) {
    setLoading(true)
    try {
      const session = await api.post<SessionResponse>('/api/auth/register', {
        fullName: values.fullName,
        email: values.email,
        password: values.password,
        confirmPassword: values.confirmPassword,
      })
      setSession({
        user: session.user,
        activeCompany: session.activeCompany,
        companies: session.companies,
        employee: session.employee ?? undefined,
      })
      toast.success('Account created — let’s set up your workspace.')
      navigate({ name: 'onboarding' })
    } catch (err) {
      const msg =
        err instanceof FetchError ? err.message : 'Unable to register. Try again.'
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="fullName">Full name</Label>
        <div className="relative">
          <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            id="fullName"
            placeholder="Usman Khan"
            className="pl-9"
            {...form.register('fullName')}
          />
        </div>
        {form.formState.errors.fullName && (
          <p className="text-xs text-destructive">
            {form.formState.errors.fullName.message}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email">Work email</Label>
        <div className="relative">
          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@company.pk"
            className="pl-9"
            {...form.register('email')}
          />
        </div>
        {form.formState.errors.email && (
          <p className="text-xs text-destructive">
            {form.formState.errors.email.message}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              placeholder="Min 8 chars"
              className="pl-9"
              {...form.register('password')}
            />
          </div>
          {form.formState.errors.password && (
            <p className="text-xs text-destructive">
              {form.formState.errors.password.message}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirmPassword">Confirm</Label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              placeholder="Repeat"
              className="pl-9"
              {...form.register('confirmPassword')}
            />
          </div>
          {form.formState.errors.confirmPassword && (
            <p className="text-xs text-destructive">
              {form.formState.errors.confirmPassword.message}
            </p>
          )}
        </div>
      </div>

      <Button type="submit" disabled={loading} className="w-full">
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <>
            Create account
            <ArrowRight className="h-4 w-4" />
          </>
        )}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <button
          type="button"
          onClick={() => navigate({ name: 'login' })}
          className="font-medium text-foreground hover:text-primary"
        >
          Sign in
        </button>
      </p>
    </form>
  )
}
