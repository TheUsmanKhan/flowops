'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, Mail, ArrowRight, ArrowLeft, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import { forgotPasswordSchema } from '@/lib/validations/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function ForgotPasswordForm() {
  const navigate = useAppStore((s) => s.navigate)
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const form = useForm({ resolver: zodResolver(forgotPasswordSchema) })

  async function onSubmit(values: { email: string }) {
    setLoading(true)
    try {
      // Local-only fallback: there's no SMTP in the sandbox, so we record
      // the request and surface a confirmation. In production this would
      // call Supabase resetPasswordForEmail().
      await api.post('/api/auth/forgot-password', values)
      setSent(true)
    } catch (err) {
      toast.error(
        err instanceof FetchError ? err.message : 'Unable to send reset email.',
      )
    } finally {
      setLoading(false)
    }
  }

  if (sent) {
    return (
      <div className="space-y-5">
        <div className="flex flex-col items-center text-center gap-3 py-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <div>
            <p className="font-medium">Check your email</p>
            <p className="text-sm text-muted-foreground mt-1">
              If an account exists for that address, a recovery link is on its
              way.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          className="w-full"
          onClick={() => navigate({ name: 'login' })}
        >
          <ArrowLeft className="h-4 w-4" /> Back to sign in
        </Button>
      </div>
    )
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
            placeholder="you@company.pk"
            className="pl-9"
            {...form.register('email')}
          />
        </div>
        {form.formState.errors.email && (
          <p className="text-xs text-destructive">
            {form.formState.errors.email.message as string}
          </p>
        )}
      </div>
      <Button type="submit" disabled={loading} className="w-full">
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <>
            Send recovery link <ArrowRight className="h-4 w-4" />
          </>
        )}
      </Button>
      <button
        type="button"
        onClick={() => navigate({ name: 'login' })}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground w-full justify-center"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
      </button>
    </form>
  )
}
