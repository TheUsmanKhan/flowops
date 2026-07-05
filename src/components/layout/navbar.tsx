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
import { LogOut, Settings, User as UserIcon } from 'lucide-react'
import { api } from '@/lib/api-client'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'

// Re-export the rebuilt WorkspaceSwitcher so existing imports keep working.
export { WorkspaceSwitcher } from '@/components/workspace/workspace-switcher'

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
        <DropdownMenuItem
          onClick={() => navigate({ name: 'organization' })}
          className="gap-2 cursor-pointer"
        >
          <Settings className="h-4 w-4" /> Organization settings
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
