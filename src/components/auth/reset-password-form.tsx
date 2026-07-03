'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, Lock, ArrowRight, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import { resetPasswordSchema } from '@/lib/validations/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function ResetPasswordForm({ token }: { token?: string }) {
  const navigate = useAppStore((s) => s.navigate)
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)
  const form = useForm({ resolver: zodResolver(resetPasswordSchema) })

  async function onSubmit(values: { password: string }) {
    setLoading(true)
    try {
      await api.post('/api/auth/reset-password', {
        password: values.password,
        token,
      })
      setDone(true)
    } catch (err) {
      toast.error(
        err instanceof FetchError ? err.message : 'Unable to reset password.',
      )
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <div className="space-y-5">
        <div className="flex flex-col items-center text-center gap-3 py-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <div>
            <p className="font-medium">Password updated</p>
            <p className="text-sm text-muted-foreground mt-1">
              You can now sign in with your new password.
            </p>
          </div>
        </div>
        <Button className="w-full" onClick={() => navigate({ name: 'login' })}>
          Continue to sign in
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="password">New password</Label>
        <div className="relative">
          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            id="password"
            type="password"
            placeholder="Min 8 characters"
            className="pl-9"
            {...form.register('password')}
          />
        </div>
        {form.formState.errors.password && (
          <p className="text-xs text-destructive">
            {form.formState.errors.password.message as string}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirmPassword">Confirm password</Label>
        <div className="relative">
          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            id="confirmPassword"
            type="password"
            placeholder="Repeat"
            className="pl-9"
            {...form.register('confirmPassword')}
          />
        </div>
        {form.formState.errors.confirmPassword && (
          <p className="text-xs text-destructive">
            {form.formState.errors.confirmPassword.message as string}
          </p>
        )}
      </div>
      <Button type="submit" disabled={loading} className="w-full">
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <>
            Update password <ArrowRight className="h-4 w-4" />
          </>
        )}
      </Button>
    </form>
  )
}
