'use client'

import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, FetchError } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { ProductScopeBadge } from '@/components/products/product-scope-badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Alert,
  AlertDescription,
} from '@/components/ui/alert'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Loader2,
  Globe,
  Lock,
  Users,
  ChevronRight,
  AlertTriangle,
  Check,
  X,
  Plus,
  Building2,
  ArrowUpRight,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types — match the /api/org/catalog response shape
// ─────────────────────────────────────────────────────────────────────────────

interface CompanyRef {
  id: string
  name: string
}

interface Subscriber {
  id: string
  company: CompanyRef
  isActive: boolean
  status: string // 'active' | 'paused' | 'revoked'
}

interface SharedProduct {
  id: string
  title: string
  slug: string
  productScope: string // 'organization' | 'selective'
  productType: string
  isStitchable: boolean
  sourceCompany: CompanyRef
  variantCount: number
  subscribers: Subscriber[]
  subscriberCount: number
}

interface PromotableProduct {
  id: string
  title: string
  slug: string
  productType: string
  isStitchable: boolean
  sourceCompany: CompanyRef
  variantCount: number
  imageCount: number
  readyToPromote: boolean
}

interface OrgCatalogResponse {
  shared: SharedProduct[]
  promotable: PromotableProduct[]
  companies: CompanyRef[]
}

interface DemoteResponse {
  success: boolean
  affected_companies: string[]
  warnings: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function subscriberStatusMeta(status: string): {
  label: string
  className: string
} {
  switch (status) {
    case 'active':
      return {
        label: 'Active',
        className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      }
    case 'paused':
      return {
        label: 'Paused',
        className: 'bg-amber-50 text-amber-700 border-amber-200',
      }
    case 'revoked':
      return {
        label: 'Revoked',
        className: 'bg-rose-50 text-rose-700 border-rose-200',
      }
    default:
      return {
        label: status,
        className: 'bg-muted text-muted-foreground border-border',
      }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Permission / Error states
// ─────────────────────────────────────────────────────────────────────────────

function PermissionMessage() {
  return (
    <Card className="border-dashed">
      <CardContent className="py-12 flex flex-col items-center text-center">
        <div className="h-12 w-12 rounded-full bg-amber-50 dark:bg-amber-950/40 flex items-center justify-center mb-4">
          <Lock className="h-6 w-6 text-amber-600 dark:text-amber-400" />
        </div>
        <h3 className="text-lg font-semibold mb-1">Elevated access required</h3>
        <p className="text-sm text-muted-foreground max-w-md">
          The Org Catalog is only available to elevated employees (admins / managers).
          Contact an administrator if you believe you should have access.
        </p>
      </CardContent>
    </Card>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="border-dashed border-rose-200">
      <CardContent className="py-12 flex flex-col items-center text-center">
        <div className="h-12 w-12 rounded-full bg-rose-50 dark:bg-rose-950/40 flex items-center justify-center mb-4">
          <AlertTriangle className="h-6 w-6 text-rose-600 dark:text-rose-400" />
        </div>
        <h3 className="text-lg font-semibold mb-1">Failed to load catalog</h3>
        <p className="text-sm text-muted-foreground max-w-md mb-4">{message}</p>
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </CardContent>
    </Card>
  )
}

function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Globe
  title: string
  description: string
}) {
  return (
    <Card className="border-dashed">
      <CardContent className="py-12 flex flex-col items-center text-center">
        <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
          <Icon className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-semibold mb-1">{title}</h3>
        <p className="text-sm text-muted-foreground max-w-md">{description}</p>
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading skeletons
// ─────────────────────────────────────────────────────────────────────────────

function SharedProductSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2 flex-1">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
          </div>
          <Skeleton className="h-6 w-24 rounded-full" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4 text-sm">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-24" />
        </div>
      </CardContent>
    </Card>
  )
}

function PromotableProductSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2 flex-1">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
          </div>
          <Skeleton className="h-9 w-24" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4 text-sm">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-24" />
        </div>
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Demote Dialog
// ─────────────────────────────────────────────────────────────────────────────

function DemoteDialog({
  product,
  open,
  onOpenChange,
}: {
  product: SharedProduct | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const qc = useQueryClient()
  const [newScope, setNewScope] = useState<'private' | 'selective'>('private')
  const [reason, setReason] = useState('')
  const [warnings, setWarnings] = useState<string[] | null>(null)

  const mutation = useMutation({
    mutationFn: async () => {
      if (!product) throw new Error('No product')
      return api.post<DemoteResponse>(`/api/products/${product.id}/demote`, {
        new_scope: newScope,
        reason,
      })
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['org-catalog'] })
      if (data.warnings && data.warnings.length > 0) {
        // Keep dialog open with warnings surfaced as an Alert
        setWarnings(data.warnings)
        toast.warning('Product demoted', {
          description: data.warnings.join(' '),
        })
      } else {
        toast.success('Product demoted', {
          description: `Scope changed to ${newScope}. ${
            data.affected_companies.length > 0
              ? `${data.affected_companies.length} subscription(s) revoked.`
              : ''
          }`,
        })
        handleClose()
      }
    },
    onError: (err: unknown) => {
      const message =
        err instanceof FetchError ? err.message : 'Failed to demote product.'
      toast.error('Demote failed', { description: message })
    },
  })

  function handleClose() {
    onOpenChange(false)
    setNewScope('private')
    setReason('')
    setWarnings(null)
    mutation.reset()
  }

  // Reset internal state whenever a new product is targeted
  function handleOpenChange(v: boolean) {
    if (!v) {
      handleClose()
    } else {
      onOpenChange(true)
    }
  }

  if (!product) return null

  const canSubmit = reason.trim().length >= 3 && !mutation.isPending && !warnings

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowUpRight className="h-4 w-4 rotate-90 text-amber-600" />
            Demote product
          </DialogTitle>
          <DialogDescription>
            Reduce the visibility of <span className="font-medium text-foreground">{product.title}</span>.
            Non-source company subscriptions will be revoked.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Current scope */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Current scope</Label>
            <div className="flex items-center gap-2">
              <ProductScopeBadge scope={product.productScope} />
              <span className="text-xs text-muted-foreground">
                {product.subscriberCount} subscriber{product.subscriberCount === 1 ? '' : 's'}
              </span>
            </div>
          </div>

          {/* Target scope */}
          <div className="space-y-1.5">
            <Label htmlFor="demote-scope">Target scope</Label>
            <Select
              value={newScope}
              onValueChange={(v) => setNewScope(v as 'private' | 'selective')}
              disabled={!!warnings}
            >
              <SelectTrigger id="demote-scope" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">
                  <span className="flex items-center gap-2">
                    <Lock className="h-3.5 w-3.5" />
                    Private — only source company
                  </span>
                </SelectItem>
                <SelectItem value="selective">
                  <span className="flex items-center gap-2">
                    <Users className="h-3.5 w-3.5" />
                    Selective — chosen companies only
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Reason */}
          <div className="space-y-1.5">
            <Label htmlFor="demote-reason">
              Reason <span className="text-rose-500">*</span>
            </Label>
            <Textarea
              id="demote-reason"
              placeholder="Explain why this product is being demoted (min 3 chars)…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              disabled={!!warnings}
            />
            <p className="text-xs text-muted-foreground">
              {reason.length}/500 — recorded in the audit log.
            </p>
          </div>

          {/* Warnings Alert (shown after demote if any) */}
          {warnings && warnings.length > 0 && (
            <Alert className="border-amber-200 bg-amber-50 dark:bg-amber-950/40">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <AlertDescription>
                <div className="text-sm font-medium text-amber-900 dark:text-amber-200 mb-1">
                  Demotion completed with warnings
                </div>
                <ul className="list-disc pl-4 space-y-0.5 text-amber-800 dark:text-amber-300">
                  {warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="gap-2">
          {warnings ? (
            <Button onClick={handleClose} className="w-full sm:w-auto">
              <Check className="h-4 w-4 mr-1" />
              Acknowledge & close
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={handleClose} disabled={mutation.isPending}>
                Cancel
              </Button>
              <Button
                onClick={() => mutation.mutate()}
                disabled={!canSubmit}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {mutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    Demoting…
                  </>
                ) : (
                  <>
                    <ArrowUpRight className="h-4 w-4 mr-1 rotate-90" />
                    Demote product
                  </>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Promote Dialog
// ─────────────────────────────────────────────────────────────────────────────

function PromoteDialog({
  product,
  companies,
  open,
  onOpenChange,
}: {
  product: PromotableProduct | null
  companies: CompanyRef[]
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const qc = useQueryClient()
  const [targetScope, setTargetScope] = useState<'organization' | 'selective'>('organization')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const mutation = useMutation({
    mutationFn: async () => {
      if (!product) throw new Error('No product')
      return api.post<{ success: boolean }>(`/api/products/${product.id}/promote`, {
        target_scope: targetScope,
        selected_company_ids: targetScope === 'selective' ? Array.from(selectedIds) : [],
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-catalog'] })
      toast.success('Product promoted', {
        description: `Now visible as ${targetScope === 'organization' ? 'Organization-wide' : 'Selective'}.`,
      })
      handleClose()
    },
    onError: (err: unknown) => {
      const message =
        err instanceof FetchError ? err.message : 'Failed to promote product.'
      toast.error('Promote failed', { description: message })
    },
  })

  function handleClose() {
    onOpenChange(false)
    setTargetScope('organization')
    setSelectedIds(new Set())
    mutation.reset()
  }

  function handleOpenChange(v: boolean) {
    if (!v) handleClose()
    else onOpenChange(true)
  }

  function toggleCompany(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (!product) return null

  // Exclude the source company from the selective list
  const selectableCompanies = companies.filter(
    (c) => c.id !== product.sourceCompany.id,
  )

  const canSubmit =
    !mutation.isPending &&
    (targetScope === 'organization' || selectedIds.size > 0)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-emerald-600" />
            Promote product
          </DialogTitle>
          <DialogDescription>
            Share <span className="font-medium text-foreground">{product.title}</span> with other
            companies in your organization.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Source company info */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Building2 className="h-3.5 w-3.5" />
            Source: <span className="text-foreground font-medium">{product.sourceCompany.name}</span>
          </div>

          {/* Target scope — radio cards */}
          <div className="space-y-2">
            <Label>Target scope</Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setTargetScope('organization')}
                className={cn(
                  'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                  targetScope === 'organization'
                    ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 ring-1 ring-emerald-500/30'
                    : 'border-border hover:border-emerald-400/60 hover:bg-muted/40',
                )}
              >
                <div
                  className={cn(
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                    targetScope === 'organization'
                      ? 'border-emerald-500 bg-emerald-500'
                      : 'border-muted-foreground/40',
                  )}
                >
                  {targetScope === 'organization' && (
                    <Check className="h-3 w-3 text-white" />
                  )}
                </div>
                <div className="space-y-0.5 min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <Globe className="h-3.5 w-3.5" />
                    Organization
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Visible to every active company in the org.
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setTargetScope('selective')}
                className={cn(
                  'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                  targetScope === 'selective'
                    ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30 ring-1 ring-amber-500/30'
                    : 'border-border hover:border-amber-400/60 hover:bg-muted/40',
                )}
              >
                <div
                  className={cn(
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                    targetScope === 'selective'
                      ? 'border-amber-500 bg-amber-500'
                      : 'border-muted-foreground/40',
                  )}
                >
                  {targetScope === 'selective' && (
                    <Check className="h-3 w-3 text-white" />
                  )}
                </div>
                <div className="space-y-0.5 min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <Users className="h-3.5 w-3.5" />
                    Selective
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Hand-pick which companies get access.
                  </p>
                </div>
              </button>
            </div>
          </div>

          {/* Selective company picker */}
          {targetScope === 'selective' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Companies to grant access</Label>
                <span className="text-xs text-muted-foreground">
                  {selectedIds.size} selected
                </span>
              </div>
              {selectableCompanies.length === 0 ? (
                <p className="text-sm text-muted-foreground rounded-md border border-dashed p-3 text-center">
                  No other companies available in this organization.
                </p>
              ) : (
                <div className="max-h-56 overflow-y-auto scrollbar-thin rounded-md border">
                  {selectableCompanies.map((c) => {
                    const checked = selectedIds.has(c.id)
                    return (
                      <label
                        key={c.id}
                        className={cn(
                          'flex items-center gap-3 px-3 py-2.5 cursor-pointer border-b last:border-b-0 transition-colors',
                          checked ? 'bg-amber-50/60 dark:bg-amber-950/20' : 'hover:bg-muted/40',
                        )}
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleCompany(c.id)}
                        />
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm font-medium truncate">{c.name}</span>
                      </label>
                    )
                  })}
                </div>
              )}
              {selectedIds.size === 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Select at least one company to enable selective promotion.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!canSubmit}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {mutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                Promoting…
              </>
            ) : (
              <>
                <ArrowUpRight className="h-4 w-4 mr-1" />
                Promote to {targetScope === 'organization' ? 'Organization' : 'Selective'}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared product card (with expandable subscribers table)
// ─────────────────────────────────────────────────────────────────────────────

function SharedProductCard({
  product,
  expanded,
  onToggle,
  onDemote,
  onRevoke,
  revokingId,
}: {
  product: SharedProduct
  expanded: boolean
  onToggle: () => void
  onDemote: () => void
  onRevoke: (subscriber: Subscriber) => void
  revokingId: string | null
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="space-y-1 min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-base leading-tight">{product.title}</CardTitle>
              <ProductScopeBadge scope={product.productScope} />
            </div>
            <CardDescription className="flex items-center gap-1.5">
              <Building2 className="h-3.5 w-3.5" />
              {product.sourceCompany.name}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              className="border-amber-300 text-amber-700 hover:bg-amber-50 hover:text-amber-800 dark:border-amber-800 dark:text-amber-400 dark:hover:bg-amber-950/40"
              onClick={onDemote}
            >
              <ArrowUpRight className="h-3.5 w-3.5 rotate-90" />
              Demote
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onToggle}
              aria-expanded={expanded}
              aria-controls={`subscribers-${product.id}`}
            >
              {expanded ? 'Hide' : 'View'}
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 transition-transform',
                  expanded && 'rotate-90',
                )}
              />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" />
            {product.subscriberCount} subscriber{product.subscriberCount === 1 ? '' : 's'}
          </span>
          <span className="flex items-center gap-1.5">
            <PackageIcon />
            {product.variantCount} variant{product.variantCount === 1 ? '' : 's'}
          </span>
        </div>

        {expanded && (
          <div
            id={`subscribers-${product.id}`}
            className="mt-4 rounded-md border"
          >
            {product.subscribers.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No companies are currently subscribed to this product.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Company</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Their price</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {product.subscribers.map((s) => {
                    const meta = subscriberStatusMeta(s.status)
                    const canRevoke =
                      product.productScope === 'selective' &&
                      s.status !== 'revoked'
                    const isRevoking = revokingId === s.id
                    return (
                      <TableRow key={s.id}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                            {s.company.name}
                            {s.company.id === product.sourceCompany.id && (
                              <Badge variant="outline" className="text-[10px] py-0 px-1">
                                source
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={cn('text-xs', meta.className)}
                          >
                            {meta.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">N/A</TableCell>
                        <TableCell className="text-right">
                          {canRevoke ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 text-rose-600 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                              disabled={isRevoking}
                              onClick={() => onRevoke(s)}
                            >
                              {isRevoking ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <X className="h-3.5 w-3.5" />
                              )}
                              Revoke
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// Small inline package icon (avoids importing another lucide icon — keeps imports tidy)
function PackageIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m7.5 4.27 9 5.15" />
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Promotable product card
// ─────────────────────────────────────────────────────────────────────────────

function PromotableProductCard({
  product,
  onPromote,
}: {
  product: PromotableProduct
  onPromote: () => void
}) {
  const missing: string[] = []
  if (product.variantCount === 0) missing.push('at least one active variant')
  if (product.imageCount === 0) missing.push('at least one image')

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="space-y-1 min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-base leading-tight">{product.title}</CardTitle>
              <ProductScopeBadge scope="private" />
              {!product.readyToPromote && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Badge
                        variant="outline"
                        className="text-xs bg-muted text-muted-foreground border-border cursor-help"
                      >
                        <AlertTriangle className="h-3 w-3" />
                        Not ready
                      </Badge>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[260px]">
                    <div className="space-y-1">
                      <div className="font-medium">Cannot promote yet</div>
                      <div className="text-xs opacity-90">
                        Missing: {missing.join(', ')}.
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            <CardDescription className="flex items-center gap-1.5">
              <Building2 className="h-3.5 w-3.5" />
              {product.sourceCompany.name}
            </CardDescription>
          </div>
          <div className="shrink-0">
            {product.readyToPromote ? (
              <Button
                size="sm"
                onClick={onPromote}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                <Plus className="h-3.5 w-3.5" />
                Promote
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button size="sm" disabled>
                      <Plus className="h-3.5 w-3.5" />
                      Promote
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px]">
                  <div className="space-y-1">
                    <div className="font-medium">Not ready to promote</div>
                    <div className="text-xs opacity-90">
                      Add {missing.join(' and ')} to enable promotion.
                    </div>
                  </div>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <PackageIcon />
            {product.variantCount} variant{product.variantCount === 1 ? '' : 's'}
          </span>
          <span className="flex items-center gap-1.5">
            <ImageIcon />
            {product.imageCount} image{product.imageCount === 1 ? '' : 's'}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

function ImageIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function OrgCatalogView() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'shared' | 'promotable'>('shared')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [demoteTarget, setDemoteTarget] = useState<SharedProduct | null>(null)
  const [demoteOpen, setDemoteOpen] = useState(false)
  const [promoteTarget, setPromoteTarget] = useState<PromotableProduct | null>(null)
  const [promoteOpen, setPromoteOpen] = useState(false)

  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<OrgCatalogResponse>({
    queryKey: ['org-catalog'],
    queryFn: () => api.get<OrgCatalogResponse>('/api/org/catalog'),
    staleTime: 30_000,
    retry: (failureCount, err) => {
      // Don't retry 403s — they won't self-heal
      if (err instanceof FetchError && err.status === 403) return false
      return failureCount < 2
    },
  })

  // Revoke selective access mutation
  const revokeMutation = useMutation({
    mutationFn: async ({ productId, companyId }: { productId: string; companyId: string }) => {
      return api.delete<{ success: boolean }>(
        `/api/products/${productId}/selective-access?company_id=${encodeURIComponent(companyId)}`,
      )
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['org-catalog'] })
      toast.success('Access revoked', {
        description: 'The company will no longer see this product.',
      })
      // Collapse nothing — keep the table open. Just clear revoking state via query refetch.
      void variables
    },
    onError: (err: unknown) => {
      const message =
        err instanceof FetchError ? err.message : 'Failed to revoke access.'
      toast.error('Revoke failed', { description: message })
    },
  })

  const isForbidden =
    isError && error instanceof FetchError && error.status === 403

  const shared = data?.shared ?? []
  const promotable = data?.promotable ?? []
  const companies = data?.companies ?? []

  const sharedCount = shared.length
  const promotableCount = promotable.length
  const readyToPromoteCount = useMemo(
    () => promotable.filter((p) => p.readyToPromote).length,
    [promotable],
  )

  function handleToggleExpand(id: string) {
    setExpandedId((prev) => (prev === id ? null : id))
  }

  function handleDemoteClick(p: SharedProduct) {
    setDemoteTarget(p)
    setDemoteOpen(true)
  }

  function handlePromoteClick(p: PromotableProduct) {
    setPromoteTarget(p)
    setPromoteOpen(true)
  }

  function handleRevoke(productId: string, subscriber: Subscriber) {
    revokeMutation.mutate({ productId, companyId: subscriber.company.id })
  }

  // Track which subscriber is currently being revoked (for row-level spinner)
  const revokingId =
    revokeMutation.isPending && revokeMutation.variables
      ? revokeMutation.variables.companyId
      : null

  return (
    <div className="space-y-6">
      <PageHeader
        title="Org Catalog"
        description="Manage organization-wide and selective product sharing across all companies in your org."
      />

      {/* Permission gate */}
      {isForbidden ? (
        <PermissionMessage />
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'shared' | 'promotable')}>
          <TabsList>
            <TabsTrigger value="shared" className="gap-1.5">
              <Globe className="h-3.5 w-3.5" />
              Org Catalog
              {sharedCount > 0 && (
                <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                  {sharedCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="promotable" className="gap-1.5">
              <Lock className="h-3.5 w-3.5" />
              Promotable Products
              {promotableCount > 0 && (
                <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                  {promotableCount}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          {/* ───────────────────── Tab 1: Org Catalog ───────────────────── */}
          <TabsContent value="shared" className="mt-4 space-y-4">
            {isLoading ? (
              <>
                <SharedProductSkeleton />
                <SharedProductSkeleton />
                <SharedProductSkeleton />
              </>
            ) : isError ? (
              <ErrorState
                message={error instanceof Error ? error.message : 'Unknown error.'}
                onRetry={() => refetch()}
              />
            ) : shared.length === 0 ? (
              <EmptyState
                icon={Globe}
                title="No shared products yet"
                description="Promote private products to organization or selective scope to make them appear here. Use the “Promotable Products” tab to get started."
              />
            ) : (
              shared.map((p) => (
                <SharedProductCard
                  key={p.id}
                  product={p}
                  expanded={expandedId === p.id}
                  onToggle={() => handleToggleExpand(p.id)}
                  onDemote={() => handleDemoteClick(p)}
                  onRevoke={(s) => handleRevoke(p.id, s)}
                  revokingId={revokingId}
                />
              ))
            )}
          </TabsContent>

          {/* ───────────────────── Tab 2: Promotable ───────────────────── */}
          <TabsContent value="promotable" className="mt-4 space-y-4">
            {isLoading ? (
              <>
                <PromotableProductSkeleton />
                <PromotableProductSkeleton />
                <PromotableProductSkeleton />
              </>
            ) : isError ? (
              <ErrorState
                message={error instanceof Error ? error.message : 'Unknown error.'}
                onRetry={() => refetch()}
              />
            ) : promotable.length === 0 ? (
              <EmptyState
                icon={Lock}
                title="No private products to promote"
                description="Private products created by any company in your org will appear here once they have at least one variant and one image."
              />
            ) : (
              <>
                {promotable.length > 0 && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Check className="h-3.5 w-3.5 text-emerald-600" />
                    <span>
                      <span className="font-medium text-foreground">{readyToPromoteCount}</span>
                      {' / '}
                      {promotable.length} ready to promote
                    </span>
                  </div>
                )}
                {promotable.map((p) => (
                  <PromotableProductCard
                    key={p.id}
                    product={p}
                    onPromote={() => handlePromoteClick(p)}
                  />
                ))}
              </>
            )}
          </TabsContent>
        </Tabs>
      )}

      {/* Dialogs (rendered outside tabs so they overlay correctly) */}
      <DemoteDialog
        product={demoteTarget}
        open={demoteOpen}
        onOpenChange={setDemoteOpen}
      />
      <PromoteDialog
        product={promoteTarget}
        companies={companies}
        open={promoteOpen}
        onOpenChange={setPromoteOpen}
      />
    </div>
  )
}
