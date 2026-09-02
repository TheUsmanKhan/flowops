'use client'

import type { ReactNode } from 'react'
import { FlowOpsLogo } from '@/components/layout/brand'

/** Split-screen shell for unauthenticated views (login / register / etc). */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string
  subtitle: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="min-h-screen w-full grid lg:grid-cols-2">
      {/* Brand panel */}
      <div className="relative hidden lg:flex flex-col justify-between p-12 bg-sidebar text-sidebar-foreground overflow-hidden">
        <div className="absolute inset-0 bg-grid opacity-40" />
        <div className="absolute -top-24 -right-24 h-96 w-96 rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute -bottom-32 -left-20 h-96 w-96 rounded-full bg-primary/10 blur-3xl" />

        <div className="relative z-10 flex items-center gap-2.5">
          <FlowOpsLogo className="h-9 w-9" />
          <span className="text-xl font-semibold tracking-tight">FlowOps</span>
        </div>

        <div className="relative z-10 space-y-6 max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            The operating system for Pakistani e-commerce.
          </h2>
          <p className="text-sidebar-foreground/70 leading-relaxed">
            Inventory, orders, CRM, courier dispatch, warehouse management,
            KPIs and ad performance — unified across every company you run,
            with audit-ready role-based access.
          </p>
          <ul className="space-y-3 text-sm text-sidebar-foreground/80">
            {[
              'Multi-company workspaces with one-click switching',
              'Custom roles & granular, dot-notation permissions',
              'Immutable audit log — the foundation of every KPI',
            ].map((f) => (
              <li key={f} className="flex items-start gap-2.5">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative z-10 text-xs text-sidebar-foreground/50">
          © {new Date().getFullYear()} FlowOps. Built for scale.
        </div>
      </div>

      {/* Form panel */}
      <div className="flex items-center justify-center p-6 sm:p-10 bg-background">
        <div className="w-full max-w-sm space-y-7">
          <div className="lg:hidden flex items-center gap-2.5">
            <FlowOpsLogo className="h-8 w-8" />
            <span className="text-lg font-semibold tracking-tight">FlowOps</span>
          </div>
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
          {children}
          {footer}
        </div>
      </div>
    </div>
  )
}
