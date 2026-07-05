'use client'

import { cn } from '@/lib/utils'

/**
 * Deterministic-color initials avatar.
 * Used everywhere a company or org logo might be missing.
 * The same `id` always produces the same color (not random on reload).
 */

const COLOR_CLASSES = [
  'bg-blue-100 text-blue-700',
  'bg-emerald-100 text-emerald-700',
  'bg-purple-100 text-purple-700',
  'bg-orange-100 text-orange-700',
  'bg-rose-100 text-rose-700',
  'bg-teal-100 text-teal-700',
  'bg-pink-100 text-pink-700',
  'bg-amber-100 text-amber-700',
]

const SIZE_CLASSES: Record<NonNullable<SizeProp>, string> = {
  sm: 'h-6 w-6 text-[10px] rounded',
  md: 'h-10 w-10 text-sm rounded-md',
  lg: 'h-20 w-20 text-2xl rounded-lg',
}

type SizeProp = 'sm' | 'md' | 'lg' | undefined

function extractInitials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) {
    // Single word → first 2 letters uppercased
    return words[0].slice(0, 2).toUpperCase()
  }
  return (words[0][0] + words[1][0]).toUpperCase()
}

function colorIndex(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % COLOR_CLASSES.length
}

export function InitialsAvatar({
  name,
  id,
  size = 'md',
  className,
  rounded = false,
}: {
  name: string
  id: string
  size?: SizeProp
  className?: string
  /** rounded = full circle (for orgs); false = rounded square (for companies) */
  rounded?: boolean
}) {
  const initials = extractInitials(name)
  const color = COLOR_CLASSES[colorIndex(id)]
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center font-semibold shrink-0 select-none',
        SIZE_CLASSES[size],
        color,
        rounded ? 'rounded-full' : '',
        className,
      )}
      aria-label={name}
    >
      {initials}
    </span>
  )
}
