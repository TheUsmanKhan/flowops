'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, Mail, Lock, ArrowRight } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import { loginSchema, type LoginInput } from '@/lib/validations/auth'
import type { SessionResponse } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function LoginForm() {
  const setSession = useAppStore((s) => s.setSession)
  const navigate = useAppStore((s) => s.navigate)
  const [loading, setLoading] = useState(false)

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  })

  async function onSubmit(values: LoginInput) {
    setLoading(true)
    try {
      const session = await api.post<SessionResponse>('/api/auth/login', values)
      setSession({
        user: session.user,
        activeCompany: session.activeCompany,
        companies: session.companies,
        employee: session.employee ?? undefined,
      })
      if (!session.user?.isOnboarded || !session.activeCompany) {
        navigate({ name: 'onboarding' })
      } else {
        navigate({ name: 'dashboard' })
      }
      toast.success('Welcome back')
    } catch (err) {
      const msg =
        err instanceof FetchError ? err.message : 'Unable to sign in. Try again.'
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
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

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <button
            type="button"
            onClick={() => navigate({ name: 'forgot' })}
            className="text-xs text-primary hover:underline"
          >
            Forgot?
          </button>
        </div>
        <div className="relative">
          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
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

      <Button type="submit" disabled={loading} className="w-full">
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <>
            Sign in
            <ArrowRight className="h-4 w-4" />
          </>
        )}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        New to FlowOps?{' '}
        <button
          type="button"
          onClick={() => navigate({ name: 'register' })}
          className="font-medium text-foreground hover:text-primary"
        >
          Create an account
        </button>
      </p>
    </form>
  )
}
