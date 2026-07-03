'use client'

import type { ReactNode } from 'react'
import { Sidebar } from '@/components/layout/sidebar'
import { WorkspaceSwitcher, UserMenu } from '@/components/layout/navbar'
import { MobileNav } from '@/components/layout/mobile-nav'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'

export function DashboardShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex bg-background">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-background/80 backdrop-blur px-4 sm:px-6">
          <MobileNav />
          <WorkspaceSwitcher />
          <div className="hidden lg:flex items-center relative max-w-xs flex-1">
            <Search className="absolute left-3 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search…"
              className="pl-9 h-9 bg-muted/50 border-transparent focus-visible:bg-background"
            />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto scrollbar-thin">
          <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground max-w-2xl">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
