'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAppStore } from '@/stores/app-store'
import { api } from '@/lib/api-client'
import { InitialsAvatar } from '@/components/ui/initials-avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  Check,
  ChevronsUpDown,
  Plus,
  Loader2,
  FolderIcon,
  Building2,
  RefreshCw,
} from 'lucide-react'
import { toast } from 'sonner'

interface WorkspaceCompany {
  company_id: string
  company_name: string
  company_logo_url: string | null
  company_slug: string
  base_currency: string
  role_name: string
  role_tier: string
  employee_count: number
  is_active_workspace: boolean
}
interface WorkspaceGroup {
  org_id: string
  org_name: string
  org_logo_url: string | null
  org_slug: string
  is_owner: boolean
  companies: WorkspaceCompany[]
}

export function WorkspaceSwitcher() {
  const navigate = useAppStore((s) => s.navigate)
  const setSession = useAppStore((s) => s.setSession)
  const user = useAppStore((s) => s.user)
  const activeCompany = useAppStore((s) => s.activeCompany)
  const companies = useAppStore((s) => s.companies)
  const employee = useAppStore((s) => s.employee)
  const [switching, setSwitching] = useState<string | null>(null)
  const queryClient = useQueryClient()

  // staleTime: 60s — the query is invalidated explicitly after create/switch,
  // so a long staleTime just prevents redundant refetches on re-renders.
  const { data, isLoading, isError, refetch } = useQuery<{
    workspaces: WorkspaceGroup[]
  }>({
    queryKey: ['workspaces'],
    queryFn: () => api.get('/api/workspaces'),
    staleTime: 60_000,
    refetchOnMount: false,
  })

  async function switchTo(companyId: string) {
    if (companyId === activeCompany?.id) return
    setSwitching(companyId)

    // OPTIMISTIC UPDATE: immediately mark the target company as active in
    // the cache so the UI shows the checkmark instantly, before the server
    // responds. This makes the switcher feel instantaneous.
    const prevData = queryClient.getQueryData<{ workspaces: WorkspaceGroup[] }>(['workspaces'])
    if (prevData) {
      queryClient.setQueryData<{ workspaces: WorkspaceGroup[] }>(['workspaces'], {
        workspaces: prevData.workspaces.map((g) => ({
          ...g,
          companies: g.companies.map((c) => ({
            ...c,
            is_active_workspace: c.company_id === companyId,
          })),
        })),
      })
    }

    try {
      const res = await api.post<{
        activeCompany: typeof activeCompany
        employee: typeof employee
      }>('/api/workspace/switch', { companyId })

      setSession({
        user,
        activeCompany: res.activeCompany,
        companies,
        employee: res.employee ?? undefined,
      })

      // TARGETED invalidation: only invalidate company-scoped queries, NOT
      // the entire cache. This preserves user/org-scoped data (workspaces
      // list, profile) and only forces company-scoped data (dashboard,
      // employees, roles) to refetch with the new RLS context.
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      queryClient.invalidateQueries({ queryKey: ['employees'] })
      queryClient.invalidateQueries({ queryKey: ['roles'] })
      queryClient.invalidateQueries({ queryKey: ['audit-logs'] })
      queryClient.invalidateQueries({ queryKey: ['company'] })

      // PREFETCH the dashboard data so it's ready before the user lands
      // on the dashboard page — eliminates the post-switch loading gap.
      queryClient.prefetchQuery({
        queryKey: ['dashboard'],
        queryFn: () => api.get('/api/dashboard'),
      })

      toast.success(`Switched to ${res.activeCompany?.name}`)
      navigate({ name: 'dashboard' })
    } catch {
      // Revert the optimistic update on failure.
      if (prevData) {
        queryClient.setQueryData(['workspaces'], prevData)
      }
      toast.error('Failed to switch workspace')
    } finally {
      setSwitching(null)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="gap-2 h-9 px-2 max-w-[220px] justify-between"
        >
          {activeCompany ? (
            <span className="flex items-center gap-2 min-w-0">
              {activeCompany.logoUrl ? (
                <Avatar className="h-6 w-6 rounded">
                  <AvatarImage src={activeCompany.logoUrl} />
                  <AvatarFallback className="rounded text-[10px]">
                    {activeCompany.name.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              ) : (
                <InitialsAvatar name={activeCompany.name} id={activeCompany.id} size="sm" />
              )}
              <span className="truncate text-sm font-medium">
                {activeCompany.name}
              </span>
            </span>
          ) : (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Building2 className="h-4 w-4" /> Select workspace
            </span>
          )}
          <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 max-h-[480px] overflow-y-auto scrollbar-thin">
        <DropdownMenuLabel className="text-xs text-muted-foreground uppercase tracking-wide">
          My Workspaces
        </DropdownMenuLabel>

        {isLoading && (
          <div className="px-2 py-6 space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-10 rounded bg-muted/50 animate-pulse" />
            ))}
          </div>
        )}

        {isError && (
          <div className="px-3 py-4 text-center">
            <p className="text-sm text-muted-foreground mb-2">Could not load workspaces.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        )}

        {data?.workspaces.length === 0 && (
          <div className="px-3 py-4 text-center text-sm text-muted-foreground">
            No workspaces yet.
          </div>
        )}

        {data?.workspaces.map((group) => (
          <div key={group.org_id}>
            <DropdownMenuSeparator />
            <div className="flex items-center gap-2 px-3 py-2">
              <FolderIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-semibold uppercase tracking-wide truncate">
                {group.org_name}
              </span>
              {!group.is_owner && (
                <span className="text-[10px] text-muted-foreground">(invited)</span>
              )}
            </div>
            {group.companies.map((c) => (
              <DropdownMenuItem
                key={c.company_id}
                onClick={() => switchTo(c.company_id)}
                className="gap-2.5 py-2 cursor-pointer"
              >
                {switching === c.company_id ? (
                  <Loader2 className="h-8 w-8 rounded-md animate-spin text-muted-foreground" />
                ) : c.company_logo_url ? (
                  <Avatar className="h-8 w-8 rounded-md">
                    <AvatarImage src={c.company_logo_url} />
                    <AvatarFallback className="rounded-md text-[10px]">
                      {c.company_name.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                ) : (
                  <InitialsAvatar name={c.company_name} id={c.company_id} size="sm" className="h-8 w-8" />
                )}
                <span className="flex-1 min-w-0">
                  <span className="block text-sm truncate">{c.company_name}</span>
                  <span className="block text-[11px] text-muted-foreground truncate">
                    {c.role_name} · {c.employee_count} emp
                  </span>
                </span>
                {c.is_active_workspace && (
                  <Check className="h-4 w-4 text-primary shrink-0" />
                )}
              </DropdownMenuItem>
            ))}
            {group.is_owner && (
              <DropdownMenuItem
                onClick={() => navigate({ name: 'create-company', orgId: group.org_id })}
                className="gap-2 text-primary cursor-pointer text-xs pl-9"
              >
                <Plus className="h-3.5 w-3.5" /> Add company to {group.org_name}
              </DropdownMenuItem>
            )}
          </div>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => navigate({ name: 'create-organization' })}
          className="gap-2 cursor-pointer font-medium"
        >
          <Plus className="h-4 w-4" /> Create New Organization
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Helper exported for other components (create-org/create-company wizards)
 * to invalidate the workspaces query so newly created companies appear
 * instantly in the switcher without waiting for staleTime to expire.
 */
export function useInvalidateWorkspaces() {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: ['workspaces'] })
  }
}
