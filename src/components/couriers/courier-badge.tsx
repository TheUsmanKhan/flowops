'use client'

/**
 * CourierBadge — compact courier provider badge.
 *
 * Renders a small pill-shaped badge with the courier's display name.
 * Used in the CityAutocomplete dropdown to show which couriers cover
 * a given city (e.g. "Leopard" + "PostEx" side by side).
 *
 * Color-coding per provider for quick visual scanning:
 *   - leopard  → amber (Leopard's brand color)
 *   - postex   → violet
 *   - tcs      → red
 *   - shopify  → green
 *   - daraz    → orange
 *   - <other>  → slate (neutral fallback)
 *
 * Usage:
 *   <CourierBadge providerKey="leopard" />
 *   <CourierBadge providerKey="postex" size="xs" />
 */

import { cn } from '@/lib/utils'

/**
 * Map a providerKey to its compact display name + brand color classes.
 * Kept in sync with the courier registry
 * (src/lib/integrations/registry.ts).
 */
const PROVIDER_META: Record<string, { name: string; className: string }> = {
  leopard: {
    name: 'Leopard',
    className: 'bg-amber-50 text-amber-800 border-amber-200',
  },
  postex: {
    name: 'PostEx',
    className: 'bg-violet-50 text-violet-800 border-violet-200',
  },
  tcs: {
    name: 'TCS',
    className: 'bg-rose-50 text-rose-800 border-rose-200',
  },
  shopify: {
    name: 'Shopify',
    className: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  },
  daraz: {
    name: 'Daraz',
    className: 'bg-orange-50 text-orange-800 border-orange-200',
  },
}

const DEFAULT_META = {
  name: 'Unknown',
  className: 'bg-slate-50 text-slate-700 border-slate-200',
}

/**
 * Get the display name for a providerKey (e.g. "leopard" → "Leopard").
 * Falls back to a capitalized version of the key for unknown providers.
 */
export function getProviderDisplayName(providerKey: string): string {
  const meta = PROVIDER_META[providerKey]
  if (meta) return meta.name
  // Capitalize first letter, keep rest as-is
  return providerKey.charAt(0).toUpperCase() + providerKey.slice(1)
}

export interface CourierBadgeProps {
  providerKey: string
  /** Visual size: 'xs' (default, compact) or 'sm' */
  size?: 'xs' | 'sm'
  className?: string
}

export function CourierBadge({
  providerKey,
  size = 'xs',
  className,
}: CourierBadgeProps) {
  const meta = PROVIDER_META[providerKey] ?? DEFAULT_META
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border font-medium leading-none',
        size === 'xs' && 'text-[9px] px-1 py-0.5',
        size === 'sm' && 'text-[10px] px-1.5 py-0.5',
        meta.className,
        className,
      )}
      title={`Available on ${meta.name}`}
    >
      {meta.name}
    </span>
  )
}

/**
 * CourierBadges — render a row of CourierBadge components for a list of
 * providerKeys. Sorts them by a stable order (leopard, postex, tcs, ...)
 * so the badge order is consistent across cities.
 *
 * Usage:
 *   <CourierBadges providers={['leopard', 'postex']} />
 */
export function CourierBadges({
  providers,
  size = 'xs',
  className,
}: {
  providers: string[]
  size?: 'xs' | 'sm'
  className?: string
}) {
  if (!providers || providers.length === 0) return null

  // Sort by a stable priority order (known providers first, then alpha)
  const PRIORITY = ['leopard', 'postex', 'tcs', 'shopify', 'daraz']
  const sorted = [...providers].sort((a, b) => {
    const ia = PRIORITY.indexOf(a)
    const ib = PRIORITY.indexOf(b)
    if (ia !== -1 && ib !== -1) return ia - ib
    if (ia !== -1) return -1
    if (ib !== -1) return 1
    return a.localeCompare(b)
  })

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {sorted.map((p) => (
        <CourierBadge key={p} providerKey={p} size={size} />
      ))}
    </div>
  )
}
