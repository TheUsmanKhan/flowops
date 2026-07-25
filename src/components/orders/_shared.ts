/**
 * Shared helpers for OMS queue views — badge maps, PKR/date formatting,
 * and the standard error-message extractor.
 *
 * Importing these avoids per-file duplication across the 10+ OMS queue views.
 */

import { FetchError } from '@/lib/api-client'

const PKR = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 })

export function formatPKR(n: number): string {
  return `Rs. ${PKR.format(n)}`
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('en-PK', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return iso
  }
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-PK', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof FetchError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong. Please try again.'
}

/** Badge classes for every Order status. */
export const ORDER_STATUS_BADGE: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-gray-100 text-gray-700 border-gray-200' },
  confirmed: { label: 'Confirmed', className: 'bg-sky-50 text-sky-700 border-sky-200' },
  partially_backordered: {
    label: 'Partially Backordered',
    className: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  processing: { label: 'Processing', className: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  dispatched: { label: 'Dispatched', className: 'bg-violet-50 text-violet-700 border-violet-200' },
  delivered: { label: 'Delivered', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  rto: { label: 'RTO', className: 'bg-rose-50 text-rose-700 border-rose-200' },
  cancelled: { label: 'Cancelled', className: 'bg-slate-100 text-slate-700 border-slate-200' },
  refunded: { label: 'Refunded', className: 'bg-slate-100 text-slate-700 border-slate-200' },
}

/** Production order status badges. */
export const PRODUCTION_STATUS_BADGE: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-gray-100 text-gray-700 border-gray-200' },
  fabric_reserved: {
    label: 'Fabric Reserved',
    className: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  in_production: {
    label: 'In Production',
    className: 'bg-sky-50 text-sky-700 border-sky-200',
  },
  completed: {
    label: 'Completed',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  dispatched: {
    label: 'Dispatched',
    className: 'bg-violet-50 text-violet-700 border-violet-200',
  },
  cancelled: { label: 'Cancelled', className: 'bg-rose-50 text-rose-700 border-rose-200' },
}

export function badgeForStatus(status: string): { label: string; className: string } {
  return (
    ORDER_STATUS_BADGE[status] ?? {
      label: status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' '),
      className: 'bg-gray-100 text-gray-700 border-gray-200',
    }
  )
}
