'use client'

import { useAppStore } from '@/stores/app-store'
import { initials } from '@/lib/api-client'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Check,
  ChevronsUpDown,
  Building2,
  Plus,
  LogOut,
  Settings,
  User as UserIcon,
} from 'lucide-react'
import { api } from '@/lib/api-client'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'

export function WorkspaceSwitcher() {
  const companies = useAppStore((s) => s.companies)
  const activeCompany = useAppStore((s) => s.activeCompany)
  const navigate = useAppStore((s) => s.navigate)
  const setSession = useAppStore((s) => s.setSession)
  const user = useAppStore((s) => s.user)
  const employee = useAppStore((s) => s.employee)

  async function switchCompany(companyId: string) {
    if (companyId === activeCompany?.id) return
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
      toast.success(`Switched to ${res.activeCompany?.name}`)
      navigate({ name: 'dashboard' })
    } catch (err) {
      toast.error('Failed to switch workspace')
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="gap-2 h-9 px-2.5 max-w-[220px] justify-between"
        >
          <span className="flex items-center gap-2 min-w-0">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary shrink-0">
              <Building2 className="h-3.5 w-3.5" />
            </span>
            <span className="truncate text-sm font-medium">
              {activeCompany?.name ?? 'Select company'}
            </span>
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Your companies
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {companies.length === 0 && (
          <div className="px-2 py-3 text-sm text-muted-foreground">
            No companies yet.
          </div>
        )}
        {companies.map((c) => (
          <DropdownMenuItem
            key={c.id}
            onClick={() => switchCompany(c.id)}
            className="gap-2 cursor-pointer"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-xs font-medium shrink-0">
              {initials(c.name)}
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm truncate">{c.name}</span>
              <span className="block text-xs text-muted-foreground truncate">
                {c.baseCurrency} · {c.countryCode}
              </span>
            </span>
            {c.id === activeCompany?.id && (
              <Check className="h-4 w-4 text-primary" />
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => navigate({ name: 'onboarding' })}
          className="gap-2 cursor-pointer text-primary"
        >
          <Plus className="h-4 w-4" />
          Create new company
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function UserMenu() {
  const user = useAppStore((s) => s.user)
  const employee = useAppStore((s) => s.employee)
  const reset = useAppStore((s) => s.reset)
  const navigate = useAppStore((s) => s.navigate)
  const router = useRouter()

  async function logout() {
    try {
      await api.post('/api/auth/logout')
    } catch {
      /* ignore */
    }
    reset()
    toast.success('Signed out')
    navigate({ name: 'login' })
    router.refresh()
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2 h-9 px-1.5">
          <Avatar className="h-7 w-7">
            <AvatarImage src={user?.avatarUrl ?? undefined} />
            <AvatarFallback className="bg-primary/10 text-primary text-xs">
              {user ? initials(user.fullName) : '?'}
            </AvatarFallback>
          </Avatar>
          <span className="hidden sm:flex flex-col items-start leading-tight">
            <span className="text-sm font-medium max-w-[120px] truncate">
              {user?.fullName}
            </span>
            {employee && (
              <span className="text-[11px] text-muted-foreground max-w-[120px] truncate">
                {employee.roleName}
              </span>
            )}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <div className="px-2 py-1.5">
          <p className="text-sm font-medium truncate">{user?.fullName}</p>
          <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
          {employee?.isElevated && (
            <Badge variant="secondary" className="mt-1 text-[10px]">
              Elevated access
            </Badge>
          )}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => navigate({ name: 'settings' })}
          className="gap-2 cursor-pointer"
        >
          <UserIcon className="h-4 w-4" /> Personal settings
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => navigate({ name: 'company-settings' })}
          className="gap-2 cursor-pointer"
        >
          <Settings className="h-4 w-4" /> Company settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={logout}
          className="gap-2 cursor-pointer text-destructive focus:text-destructive"
        >
          <LogOut className="h-4 w-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
