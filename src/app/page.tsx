'use client'

import { useEffect } from 'react'
import { useAppStore } from '@/stores/app-store'
import { api, FetchError } from '@/lib/api-client'
import type { SessionResponse } from '@/lib/types'
import { Loader2 } from 'lucide-react'

import { AuthShell } from '@/components/auth/auth-shell'
import { LoginForm } from '@/components/auth/login-form'
import { RegisterForm } from '@/components/auth/register-form'
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form'
import { ResetPasswordForm } from '@/components/auth/reset-password-form'
import { OnboardingView } from '@/components/onboarding/onboarding-view'
import { DashboardShell, PageHeader } from '@/components/layout/dashboard-shell'
import { DashboardHome } from '@/components/dashboard/dashboard-home'
import { EmployeesView } from '@/components/employees/employees-view'
import { InviteEmployeeView } from '@/components/employees/invite-employee-view'
import { EmployeeDetailView } from '@/components/employees/employee-detail-view'
import { RolesView } from '@/components/roles/roles-view'
import { RoleEditView } from '@/components/roles/role-edit-view'
import { OrganizationView } from '@/components/settings/organization-view'
import { CompanySettingsView } from '@/components/settings/company-settings-view'
import { SettingsView } from '@/components/settings/settings-view'
import { AuditLogView } from '@/components/settings/audit-log-view'
import { Card, CardContent } from '@/components/ui/card'

export default function Page() {
  const { hydrated, loading, route, user, activeCompany, employee, setSession, setHydrated, navigate, reset } =
    useAppStore()

  // Hydrate session on first load.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const session = await api.get<SessionResponse>('/api/auth/me')
        if (cancelled) return
        setSession({
          user: session.user,
          activeCompany: session.activeCompany,
          companies: session.companies,
          employee: session.employee ?? undefined,
        })
      } catch {
        if (cancelled) return
        setHydrated(true)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Loading screen while hydrating.
  if (!hydrated && loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }
  if (!hydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  // ---- Unauthenticated views ----
  if (!user) {
    if (route.name === 'register') {
      return (
        <AuthShell
          title="Create your account"
          subtitle="Start managing your e-commerce operations in minutes."
        >
          <RegisterForm />
        </AuthShell>
      )
    }
    if (route.name === 'forgot') {
      return (
        <AuthShell
          title="Reset your password"
          subtitle="We'll email you a secure recovery link."
        >
          <ForgotPasswordForm />
        </AuthShell>
      )
    }
    if (route.name === 'reset') {
      return (
        <AuthShell
          title="Set a new password"
          subtitle="Choose a strong password for your account."
        >
          <ResetPasswordForm token={route.token} />
        </AuthShell>
      )
    }
    // default: login
    return (
      <AuthShell
        title="Welcome back"
        subtitle="Sign in to your FlowOps workspace."
      >
        <LoginForm />
      </AuthShell>
    )
  }

  // ---- Authenticated but not onboarded ----
  if (!user.isOnboarded || !activeCompany) {
    return <OnboardingView />
  }

  // ---- Authenticated + onboarded: dashboard shell ----
  return <DashboardShell>{renderRoute(route, employee)}</DashboardShell>
}

function renderRoute(
  route: ReturnType<typeof useAppStore.getState>['route'],
  employee: ReturnType<typeof useAppStore.getState>['employee'],
) {
  switch (route.name) {
    case 'dashboard':
      return <DashboardHome />
    case 'employees':
      return <EmployeesView />
    case 'employees-invite':
      return <InviteEmployeeView />
    case 'employee-detail':
      return <EmployeeDetailView employeeId={route.id} />
    case 'roles':
      return <RolesView />
    case 'role-edit':
      return <RoleEditView roleId={route.id} />
    case 'organization':
      return <OrganizationView />
    case 'company-settings':
      return <CompanySettingsView />
    case 'settings':
      return <SettingsView />
    case 'audit':
      return <AuditLogView />
    default:
      return <DashboardHome />
  }
}
