'use client'

import { useState } from 'react'
import { PERMISSION_GROUPS, ALL_PERMISSION_KEYS } from '@/lib/permissions'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import * as Icons from 'lucide-react'

export function PermissionKeySelector({
  selected,
  onChange,
  disabled,
}: {
  selected: string[]
  onChange: (keys: string[]) => void
  disabled?: boolean
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  function toggle(key: string) {
    if (disabled) return
    if (selected.includes(key)) {
      onChange(selected.filter((k) => k !== key))
    } else {
      onChange([...selected, key])
    }
  }

  function toggleGroup(groupName: string, keys: string[]) {
    if (disabled) return
    const allSelected = keys.every((k) => selected.includes(k))
    if (allSelected) {
      onChange(selected.filter((k) => !keys.includes(k)))
    } else {
      onChange(Array.from(new Set([...selected, ...keys])))
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {selected.length} of {ALL_PERMISSION_KEYS.length} permissions selected
        </span>
        <button
          type="button"
          onClick={() =>
            onChange(selected.length === ALL_PERMISSION_KEYS.length ? [] : [...ALL_PERMISSION_KEYS])
          }
          className="text-primary hover:underline"
          disabled={disabled}
        >
          {selected.length === ALL_PERMISSION_KEYS.length ? 'Clear all' : 'Select all'}
        </button>
      </div>
      <div className="rounded-md border divide-y max-h-[420px] overflow-y-auto scrollbar-thin">
        {PERMISSION_GROUPS.map((group) => {
          const keys = group.permissions.map((p) => p.key)
          const selectedCount = keys.filter((k) => selected.includes(k)).length
          const allSelected = selectedCount === keys.length
          const isCollapsed = collapsed.has(group.group)
          // dynamic icon
          const IconComp = (Icons as unknown as Record<string, Icons.LucideIcon>)[group.icon] ?? Icons.Circle
          return (
            <div key={group.group}>
              <div className="flex items-center gap-2 px-3 py-2.5 bg-muted/30">
                <button
                  type="button"
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev)
                      if (next.has(group.group)) next.delete(group.group)
                      else next.add(group.group)
                      return next
                    })
                  }
                  className="flex items-center gap-2 flex-1 text-left"
                >
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 text-muted-foreground transition-transform',
                      isCollapsed && '-rotate-90',
                    )}
                  />
                  <IconComp className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{group.group}</span>
                </button>
                <Badge variant="outline" className="text-[10px]">
                  {selectedCount}/{keys.length}
                </Badge>
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={() => toggleGroup(group.group, keys)}
                  disabled={disabled}
                />
              </div>
              {!isCollapsed && (
                <div className="px-3 py-2 space-y-1">
                  {group.permissions.map((p) => (
                    <label
                      key={p.key}
                      className="flex items-start gap-3 rounded-md px-2 py-1.5 hover:bg-muted/40 cursor-pointer"
                    >
                      <Checkbox
                        checked={selected.includes(p.key)}
                        onCheckedChange={() => toggle(p.key)}
                        disabled={disabled}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{p.label}</span>
                          <code className="text-[10px] text-muted-foreground font-mono">
                            {p.key}
                          </code>
                        </div>
                        <p className="text-xs text-muted-foreground">{p.description}</p>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
