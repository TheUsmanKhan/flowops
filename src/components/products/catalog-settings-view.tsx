'use client'

import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { toast } from 'sonner'
import { api, FetchError } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import { useCan } from '@/stores/app-store'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  Folder,
  Tag,
  Palette,
  ChevronRight,
  AlertCircle,
  Check,
  X,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Category {
  id: string
  name: string
  slug: string
  imageUrl: string | null
  parentId: string | null
  productCount: number
}

interface Brand {
  id: string
  name: string
  slug: string
  logoUrl: string | null
  productCount: number
}

interface AttributeValue {
  id: string
  value: string
  displayValue: string
  colorHex: string | null
  displayOrder: number
}

interface Attribute {
  id: string
  name: string
  displayName: string
  attributeType: 'select' | 'color'
  displayOrder: number
  values: AttributeValue[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod schemas (inline — scoped to this view)
// ─────────────────────────────────────────────────────────────────────────────

const categoryFormSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100, 'Name is too long'),
  parentId: z.string().optional().or(z.literal('')),
  imageUrl: z
    .string()
    .url('Enter a valid image URL')
    .optional()
    .or(z.literal('')),
  displayOrder: z.number().int('Must be a whole number').min(0, 'Must be 0 or greater').optional(),
})
type CategoryFormValues = z.infer<typeof categoryFormSchema>

const brandFormSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100, 'Name is too long'),
  logoUrl: z
    .string()
    .url('Enter a valid logo URL')
    .optional()
    .or(z.literal('')),
  isActive: z.boolean(),
})
type BrandFormValues = z.infer<typeof brandFormSchema>

const attributeFormSchema = z.object({
  name: z
    .string()
    .min(2, 'Key must be at least 2 characters')
    .max(50, 'Key is too long')
    .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores'),
  displayName: z
    .string()
    .min(2, 'Display name must be at least 2 characters')
    .max(100, 'Display name is too long'),
  attributeType: z.enum(['select', 'color']),
  displayOrder: z.number().int().min(0).optional(),
})
type AttributeFormValues = z.infer<typeof attributeFormSchema>

const attributeValueFormSchema = z.object({
  value: z.string().min(1, 'Value is required').max(100),
  displayValue: z.string().min(1, 'Display value is required').max(50),
  colorHex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use #RRGGBB format')
    .optional()
    .or(z.literal('')),
  displayOrder: z.number().int().min(0).optional(),
})
type AttributeValueFormValues = z.infer<typeof attributeValueFormSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function CatalogSettingsView() {
  const can = useCan()

  if (!can('products.manage_catalog')) {
    return <InsufficientPermissions />
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Catalog Settings"
        description="Manage the categories, brands, and attributes that organize your product catalog."
      />
      <Tabs defaultValue="categories" className="space-y-4">
        <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
          <TabsTrigger value="categories" className="gap-1.5">
            <Folder className="h-3.5 w-3.5" /> Categories
          </TabsTrigger>
          <TabsTrigger value="brands" className="gap-1.5">
            <Tag className="h-3.5 w-3.5" /> Brands
          </TabsTrigger>
          <TabsTrigger value="attributes" className="gap-1.5">
            <Palette className="h-3.5 w-3.5" /> Attributes
          </TabsTrigger>
        </TabsList>
        <TabsContent value="categories" className="mt-0">
          <CategoriesTab />
        </TabsContent>
        <TabsContent value="brands" className="mt-0">
          <BrandsTab />
        </TabsContent>
        <TabsContent value="attributes" className="mt-0">
          <AttributesTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────────────────────────────────────

function InsufficientPermissions() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <Card className="max-w-md w-full">
        <CardContent className="p-8 text-center space-y-3">
          <div className="mx-auto h-12 w-12 rounded-full bg-amber-100 dark:bg-amber-950/50 flex items-center justify-center">
            <AlertCircle className="h-6 w-6 text-amber-600 dark:text-amber-500" />
          </div>
          <h2 className="text-lg font-semibold">Insufficient permissions</h2>
          <p className="text-sm text-muted-foreground">
            You need the <code className="text-xs rounded bg-muted px-1.5 py-0.5">products.manage_catalog</code> permission to
            manage catalog settings. Ask an elevated employee to grant it via
            Roles &amp; Permissions.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <Card>
      <CardContent className="p-10 text-center space-y-3">
        <div className="mx-auto h-11 w-11 rounded-full bg-destructive/10 flex items-center justify-center">
          <AlertCircle className="h-5 w-5 text-destructive" />
        </div>
        <p className="text-sm text-muted-foreground">
          Couldn&apos;t load this data. The server may have restarted.
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
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
  actionLabel,
  onAction,
}: {
  icon: typeof Folder
  title: string
  description: string
  actionLabel: string
  onAction: () => void
}) {
  return (
    <Card>
      <CardContent className="p-10 sm:p-14 text-center space-y-3">
        <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center">
          <Icon className="h-7 w-7 text-primary" />
        </div>
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto">
          {description}
        </p>
        <Button className="mt-2" onClick={onAction}>
          <Plus className="h-4 w-4" /> {actionLabel}
        </Button>
      </CardContent>
    </Card>
  )
}

/** Standardised delete-confirmation dialog that surfaces 409 reference errors inline. */
function DeleteConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Delete',
  itemName,
  isPending,
  error,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  itemName: string
  isPending: boolean
  error: string | null
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !isPending && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm font-medium">
          {itemName}
        </div>
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Categories tab
// ─────────────────────────────────────────────────────────────────────────────

function CategoriesTab() {
  const queryClient = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [addSubParentId, setAddSubParentId] = useState<string | null>(null)
  const [editTarget, setEditTarget] = useState<Category | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Category | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const { data, isLoading, isError, refetch, isFetching } = useQuery<{
    categories: Category[]
  }>({
    queryKey: ['categories'],
    queryFn: () => api.get<{ categories: Category[] }>('/api/categories'),
    staleTime: 30_000,
  })

  const categories = data?.categories ?? []

  // Build a 2-level tree: roots + their direct children.
  const { roots, childrenByParent } = useMemo(() => {
    const roots = categories.filter((c) => !c.parentId)
    const childrenByParent = new Map<string, Category[]>()
    for (const c of categories) {
      if (c.parentId) {
        const arr = childrenByParent.get(c.parentId) ?? []
        arr.push(c)
        childrenByParent.set(c.parentId, arr)
      }
    }
    // Sort children by name for stable ordering.
    childrenByParent.forEach((arr) => arr.sort((a, b) => a.name.localeCompare(b.name)))
    roots.sort((a, b) => a.name.localeCompare(b.name))
    return { roots, childrenByParent }
  }, [categories])

  const createMutation = useMutation({
    mutationFn: (values: CategoryFormValues) =>
      api.post('/api/categories', {
        name: values.name,
        parentId: values.parentId || undefined,
        imageUrl: values.imageUrl || undefined,
        displayOrder: values.displayOrder ?? 0,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categories'] })
      toast.success('Category created')
      setAddOpen(false)
      setAddSubParentId(null)
    },
    onError: (err) => {
      toast.error(
        err instanceof FetchError ? err.message : 'Failed to create category.',
      )
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, values }: { id: string; values: CategoryFormValues }) =>
      api.patch(`/api/catalog/categories/${id}`, {
        name: values.name,
        parentId: values.parentId || null,
        imageUrl: values.imageUrl || null,
        displayOrder: values.displayOrder ?? 0,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categories'] })
      toast.success('Category updated')
      setEditTarget(null)
    },
    onError: (err) => {
      toast.error(
        err instanceof FetchError ? err.message : 'Failed to update category.',
      )
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/catalog/categories/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categories'] })
      toast.success('Category deleted')
      setDeleteTarget(null)
      setDeleteError(null)
    },
    onError: (err) => {
      if (err instanceof FetchError && err.status === 409) {
        setDeleteError(err.message)
      } else {
        toast.error(
          err instanceof FetchError ? err.message : 'Failed to delete category.',
        )
      }
    },
  })

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (isLoading) return <CategoriesSkeleton />

  if (isError) return <ErrorState onRetry={() => refetch()} />

  if (categories.length === 0) {
    return (
      <>
        <EmptyState
          icon={Folder}
          title="No categories yet"
          description="Categories help you group products into a browsable hierarchy. Create your first one to get started."
          actionLabel="Add Root Category"
          onAction={() => setAddOpen(true)}
        />
        <CategoryDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          mode="create"
          categories={categories}
          isPending={createMutation.isPending}
          onSubmit={(v) => createMutation.mutate(v)}
        />
      </>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {isFetching ? 'Refreshing…' : `${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}`}
        </p>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" /> Add Root Category
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <ul className="divide-y">
            {roots.map((root) => {
              const kids = childrenByParent.get(root.id) ?? []
              const isOpen = expanded.has(root.id)
              return (
                <li key={root.id}>
                  <CategoryRow
                    category={root}
                    isRoot
                    hasChildren={kids.length > 0}
                    expanded={isOpen}
                    onToggle={() => toggleExpand(root.id)}
                    onEdit={() => setEditTarget(root)}
                    onDelete={() => {
                      setDeleteTarget(root)
                      setDeleteError(null)
                    }}
                    onAddSub={() => setAddSubParentId(root.id)}
                  />
                  {isOpen && kids.length > 0 && (
                    <ul className="divide-y bg-muted/20">
                      {kids.map((kid) => (
                        <li key={kid.id}>
                          <CategoryRow
                            category={kid}
                            isRoot={false}
                            onEdit={() => setEditTarget(kid)}
                            onDelete={() => {
                              setDeleteTarget(kid)
                              setDeleteError(null)
                            }}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        </CardContent>
      </Card>

      <CategoryDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        mode="create"
        categories={categories}
        isPending={createMutation.isPending}
        onSubmit={(v) => createMutation.mutate(v)}
      />

      {editTarget && (
        <CategoryDialog
          open={!!editTarget}
          onOpenChange={(v) => !v && setEditTarget(null)}
          mode="edit"
          category={editTarget}
          categories={categories}
          isPending={updateMutation.isPending}
          onSubmit={(v) =>
            updateMutation.mutate({ id: editTarget.id, values: v })
          }
        />
      )}

      <CategoryDialog
        open={addSubParentId !== null}
        onOpenChange={(v) => !v && setAddSubParentId(null)}
        mode="create"
        lockedParentId={addSubParentId}
        categories={categories}
        isPending={createMutation.isPending}
        onSubmit={(v) => createMutation.mutate(v)}
      />

      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => {
          if (!v) {
            setDeleteTarget(null)
            setDeleteError(null)
          }
        }}
        title="Delete category"
        description="This permanently removes the category. Products will not be deleted but will lose this category assignment."
        itemName={deleteTarget?.name ?? ''}
        isPending={deleteMutation.isPending}
        error={deleteError}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
      />
    </div>
  )
}

function CategoryRow({
  category,
  isRoot,
  hasChildren,
  expanded,
  onToggle,
  onEdit,
  onDelete,
  onAddSub,
}: {
  category: Category
  isRoot: boolean
  hasChildren?: boolean
  expanded?: boolean
  onToggle?: () => void
  onEdit: () => void
  onDelete: () => void
  onAddSub?: () => void
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-2.5 sm:px-4 transition-colors hover:bg-muted/30',
        !isRoot && 'pl-10 sm:pl-12',
      )}
    >
      {/* Expand toggle (roots only) */}
      {isRoot ? (
        <button
          onClick={onToggle}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
          aria-label={expanded ? 'Collapse' : 'Expand'}
          disabled={!hasChildren}
        >
          {hasChildren ? (
            <ChevronRight
              className={cn(
                'h-4 w-4 transition-transform',
                expanded && 'rotate-90',
              )}
            />
          ) : (
            <span className="h-1 w-1 rounded-full bg-muted-foreground/30" />
          )}
        </button>
      ) : (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground/40">
          <ChevronRight className="h-3 w-3 rotate-90" />
        </span>
      )}

      <Folder
        className={cn(
          'h-4 w-4 shrink-0',
          isRoot ? 'text-primary' : 'text-muted-foreground',
        )}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium truncate">{category.name}</span>
          <Badge variant="secondary" className="text-[10px] gap-1">
            {category.productCount} product
            {category.productCount === 1 ? '' : 's'}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground font-mono truncate">
          {category.slug}
        </p>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {isRoot && onAddSub && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 text-xs"
            onClick={onAddSub}
            title="Add subcategory"
          >
            <Plus className="h-3.5 w-3.5" /> Sub
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onEdit}
          title="Edit"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-destructive hover:text-destructive"
          onClick={onDelete}
          title="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

function CategoryDialog({
  open,
  onOpenChange,
  mode,
  category,
  categories,
  lockedParentId,
  isPending,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  mode: 'create' | 'edit'
  category?: Category
  categories: Category[]
  lockedParentId?: string | null
  isPending: boolean
  onSubmit: (values: CategoryFormValues) => void
}) {
  // Roots that can act as a parent (exclude the category being edited).
  const parentOptions = useMemo(() => {
    return categories.filter(
      (c) => !c.parentId && (!category || c.id !== category.id),
    )
  }, [categories, category])

  const form = useForm<CategoryFormValues>({
    resolver: zodResolver(categoryFormSchema),
    defaultValues: {
      name: '',
      parentId: '',
      imageUrl: '',
      displayOrder: 0,
    },
  })

  // Reset form when the dialog opens / target changes.
  useEffect(() => {
    if (!open) return
    if (mode === 'edit' && category) {
      form.reset({
        name: category.name,
        parentId: category.parentId ?? '',
        imageUrl: category.imageUrl ?? '',
        displayOrder: 0,
      })
    } else {
      form.reset({
        name: '',
        parentId: lockedParentId ?? '',
        imageUrl: '',
        displayOrder: 0,
      })
    }
  }, [open, mode, category, lockedParentId, form])

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = form
  const parentId = watch('parentId')

  return (
    <Dialog open={open} onOpenChange={(v) => !isPending && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === 'create'
              ? lockedParentId
                ? 'Add subcategory'
                : 'Add root category'
              : 'Edit category'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? 'Categories organize products into a browsable hierarchy.'
              : 'Update the category details below.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cat-name">Name</Label>
            <Input
              id="cat-name"
              placeholder="e.g. Fabrics"
              autoFocus
              disabled={isPending}
              {...register('name')}
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cat-parent">Parent category (optional)</Label>
            <Select
              value={parentId}
              onValueChange={(v) => setValue('parentId', v)}
              disabled={isPending || !!lockedParentId}
            >
              <SelectTrigger id="cat-parent">
                <SelectValue placeholder="No parent — root category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">No parent — root category</SelectItem>
                {parentOptions.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {lockedParentId && (
              <p className="text-xs text-muted-foreground">
                Subcategory of{' '}
                <span className="font-medium">
                  {categories.find((c) => c.id === lockedParentId)?.name}
                </span>
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cat-image">Image URL (optional)</Label>
            <Input
              id="cat-image"
              placeholder="https://…"
              disabled={isPending}
              {...register('imageUrl')}
            />
            {errors.imageUrl && (
              <p className="text-xs text-destructive">
                {errors.imageUrl.message}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cat-order">Display order</Label>
            <Input
              id="cat-order"
              type="number"
              min={0}
              disabled={isPending}
              {...register('displayOrder', {
                setValueAs: (v) => {
                  if (v === '' || v === null || v === undefined) return undefined
                  const n = typeof v === 'number' ? v : parseInt(String(v), 10)
                  return Number.isNaN(n) ? undefined : n
                },
              })}
            />
            <p className="text-xs text-muted-foreground">
              Lower numbers appear first.
            </p>
            {errors.displayOrder && (
              <p className="text-xs text-destructive">
                {errors.displayOrder.message}
              </p>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === 'create' ? 'Create category' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function CategoriesSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Skeleton className="h-9 w-40" />
      </div>
      <Card>
        <CardContent className="p-0">
          <div className="divide-y">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <Skeleton className="h-6 w-6 rounded" />
                <Skeleton className="h-4 w-4 rounded" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-56" />
                </div>
                <Skeleton className="h-8 w-8 rounded" />
                <Skeleton className="h-8 w-8 rounded" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Brands tab
// ─────────────────────────────────────────────────────────────────────────────

function BrandsTab() {
  const queryClient = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Brand | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Brand | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const { data, isLoading, isError, refetch, isFetching } = useQuery<{
    brands: Brand[]
  }>({
    queryKey: ['brands'],
    queryFn: () => api.get<{ brands: Brand[] }>('/api/brands'),
    staleTime: 30_000,
  })

  const brands = data?.brands ?? []

  const createMutation = useMutation({
    mutationFn: (values: BrandFormValues) =>
      api.post('/api/brands', { name: values.name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brands'] })
      toast.success('Brand created')
      setAddOpen(false)
    },
    onError: (err) => {
      toast.error(
        err instanceof FetchError ? err.message : 'Failed to create brand.',
      )
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, values }: { id: string; values: BrandFormValues }) =>
      api.patch(`/api/catalog/brands/${id}`, {
        name: values.name,
        logoUrl: values.logoUrl || null,
        isActive: values.isActive,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brands'] })
      toast.success('Brand updated')
      setEditTarget(null)
    },
    onError: (err) => {
      toast.error(
        err instanceof FetchError ? err.message : 'Failed to update brand.',
      )
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/catalog/brands/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brands'] })
      toast.success('Brand deleted')
      setDeleteTarget(null)
      setDeleteError(null)
    },
    onError: (err) => {
      if (err instanceof FetchError && err.status === 409) {
        setDeleteError(err.message)
      } else {
        toast.error(
          err instanceof FetchError ? err.message : 'Failed to delete brand.',
        )
      }
    },
  })

  if (isLoading) return <BrandsSkeleton />

  if (isError) return <ErrorState onRetry={() => refetch()} />

  if (brands.length === 0) {
    return (
      <>
        <EmptyState
          icon={Tag}
          title="No brands yet"
          description="Brands let you attribute products to a manufacturer or label. Add your first brand to get started."
          actionLabel="Add Brand"
          onAction={() => setAddOpen(true)}
        />
        <BrandDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          mode="create"
          isPending={createMutation.isPending}
          onSubmit={(v) => createMutation.mutate(v)}
        />
      </>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {isFetching ? 'Refreshing…' : `${brands.length} brand${brands.length === 1 ? '' : 's'}`}
        </p>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" /> Add Brand
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {/* Header (desktop) */}
          <div className="hidden sm:grid grid-cols-[1.5fr_2fr_1fr_1fr_auto] gap-3 border-b px-4 py-2.5 text-xs font-medium text-muted-foreground">
            <span>Brand</span>
            <span>Slug</span>
            <span>Products</span>
            <span>Status</span>
            <span className="text-right">Actions</span>
          </div>
          <ul className="divide-y">
            {brands.map((brand) => (
              <li
                key={brand.id}
                className="grid grid-cols-1 sm:grid-cols-[1.5fr_2fr_1fr_1fr_auto] gap-2 sm:gap-3 px-4 py-3 items-center"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <BrandAvatar brand={brand} />
                  <span className="text-sm font-medium truncate">
                    {brand.name}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground font-mono truncate">
                  {brand.slug}
                </p>
                <Badge variant="secondary" className="text-[10px] w-fit">
                  {brand.productCount} product
                  {brand.productCount === 1 ? '' : 's'}
                </Badge>
                <Badge
                  variant="outline"
                  className="w-fit gap-1 border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400"
                >
                  <Check className="h-3 w-3" /> Active
                </Badge>
                <div className="flex items-center gap-1 sm:justify-end">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setEditTarget(brand)}
                    title="Edit"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    onClick={() => {
                      setDeleteTarget(brand)
                      setDeleteError(null)
                    }}
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <BrandDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        mode="create"
        isPending={createMutation.isPending}
        onSubmit={(v) => createMutation.mutate(v)}
      />

      {editTarget && (
        <BrandDialog
          open={!!editTarget}
          onOpenChange={(v) => !v && setEditTarget(null)}
          mode="edit"
          brand={editTarget}
          isPending={updateMutation.isPending}
          onSubmit={(v) =>
            updateMutation.mutate({ id: editTarget.id, values: v })
          }
        />
      )}

      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => {
          if (!v) {
            setDeleteTarget(null)
            setDeleteError(null)
          }
        }}
        title="Delete brand"
        description="This permanently removes the brand. Products will not be deleted but will lose this brand assignment."
        itemName={deleteTarget?.name ?? ''}
        isPending={deleteMutation.isPending}
        error={deleteError}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
      />
    </div>
  )
}

function BrandAvatar({ brand }: { brand: Brand }) {
  const initials = brand.name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
  if (brand.logoUrl) {
    return (
      <img
        src={brand.logoUrl}
        alt={brand.name}
        className="h-8 w-8 rounded-md object-cover border bg-muted"
      />
    )
  }
  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary text-xs font-semibold">
      {initials || '?'}
    </div>
  )
}

function BrandDialog({
  open,
  onOpenChange,
  mode,
  brand,
  isPending,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  mode: 'create' | 'edit'
  brand?: Brand
  isPending: boolean
  onSubmit: (values: BrandFormValues) => void
}) {
  const form = useForm<BrandFormValues>({
    resolver: zodResolver(brandFormSchema),
    defaultValues: { name: '', logoUrl: '', isActive: true },
  })

  useEffect(() => {
    if (!open) return
    if (mode === 'edit' && brand) {
      form.reset({
        name: brand.name,
        logoUrl: brand.logoUrl ?? '',
        isActive: true,
      })
    } else {
      form.reset({ name: '', logoUrl: '', isActive: true })
    }
  }, [open, mode, brand, form])

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = form
  const isActive = watch('isActive')

  return (
    <Dialog open={open} onOpenChange={(v) => !isPending && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Add brand' : 'Edit brand'}</DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? 'Brands attribute products to a manufacturer or label.'
              : 'Update the brand details below.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="brand-name">Name</Label>
            <Input
              id="brand-name"
              placeholder="e.g. Gul Ahmed"
              autoFocus
              disabled={isPending}
              {...register('name')}
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            )}
          </div>

          {mode === 'edit' && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="brand-logo">Logo URL (optional)</Label>
                <Input
                  id="brand-logo"
                  placeholder="https://…"
                  disabled={isPending}
                  {...register('logoUrl')}
                />
                {errors.logoUrl && (
                  <p className="text-xs text-destructive">
                    {errors.logoUrl.message}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-between rounded-md border p-3">
                <div className="space-y-0.5">
                  <Label htmlFor="brand-active" className="text-sm">
                    Active
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Inactive brands are hidden from the catalog list.
                  </p>
                </div>
                <Switch
                  id="brand-active"
                  checked={isActive}
                  onCheckedChange={(v) => setValue('isActive', v)}
                  disabled={isPending}
                />
              </div>
            </>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === 'create' ? 'Create brand' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function BrandsSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Skeleton className="h-9 w-32" />
      </div>
      <Card>
        <CardContent className="p-0">
          <div className="divide-y">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="grid grid-cols-[1.5fr_2fr_1fr_1fr_auto] gap-3 px-4 py-3 items-center"
              >
                <div className="flex items-center gap-2.5">
                  <Skeleton className="h-8 w-8 rounded-md" />
                  <Skeleton className="h-4 w-28" />
                </div>
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-5 w-16 rounded-full" />
                <div className="flex gap-1 justify-end">
                  <Skeleton className="h-8 w-8 rounded" />
                  <Skeleton className="h-8 w-8 rounded" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Attributes tab — two-panel layout
// ─────────────────────────────────────────────────────────────────────────────

function AttributesTab() {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [addAttrOpen, setAddAttrOpen] = useState(false)
  const [editAttrTarget, setEditAttrTarget] = useState<Attribute | null>(null)
  const [deleteAttrTarget, setDeleteAttrTarget] = useState<Attribute | null>(null)
  const [deleteAttrError, setDeleteAttrError] = useState<string | null>(null)

  const { data, isLoading, isError, refetch, isFetching } = useQuery<{
    attributes: Attribute[]
  }>({
    queryKey: ['attributes'],
    queryFn: () => api.get<{ attributes: Attribute[] }>('/api/catalog/attributes'),
    staleTime: 30_000,
  })

  const attributes = data?.attributes ?? []

  // Keep selection valid: clear if the selected attribute was deleted.
  useEffect(() => {
    if (selectedId && !attributes.some((a) => a.id === selectedId)) {
      setSelectedId(null)
    }
  }, [attributes, selectedId])

  const selected = useMemo(
    () => attributes.find((a) => a.id === selectedId) ?? null,
    [attributes, selectedId],
  )

  const createAttrMutation = useMutation({
    mutationFn: (values: AttributeFormValues) =>
      api.post('/api/catalog/attributes', {
        name: values.name,
        displayName: values.displayName,
        attributeType: values.attributeType,
        displayOrder: values.displayOrder ?? 0,
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['attributes'] })
      toast.success('Attribute created')
      setAddAttrOpen(false)
      // Pre-select the new attribute once the list refreshes.
      // We can't know the new id yet, but selecting by name is a good UX hint.
      // The actual selection will happen on next render via the find-by-name fallback.
      void variables
    },
    onError: (err) => {
      toast.error(
        err instanceof FetchError ? err.message : 'Failed to create attribute.',
      )
    },
  })

  const updateAttrMutation = useMutation({
    mutationFn: ({ id, values }: { id: string; values: AttributeFormValues }) =>
      api.patch(`/api/catalog/attributes/${id}`, {
        displayName: values.displayName,
        attributeType: values.attributeType,
        displayOrder: values.displayOrder ?? 0,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attributes'] })
      toast.success('Attribute updated')
      setEditAttrTarget(null)
    },
    onError: (err) => {
      toast.error(
        err instanceof FetchError ? err.message : 'Failed to update attribute.',
      )
    },
  })

  const deleteAttrMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/catalog/attributes/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attributes'] })
      toast.success('Attribute deleted')
      setDeleteAttrTarget(null)
      setDeleteAttrError(null)
      if (selectedId === deleteAttrTarget?.id) setSelectedId(null)
    },
    onError: (err) => {
      toast.error(
        err instanceof FetchError ? err.message : 'Failed to delete attribute.',
      )
    },
  })

  if (isLoading) return <AttributesSkeleton />

  if (isError) return <ErrorState onRetry={() => refetch()} />

  if (attributes.length === 0) {
    return (
      <>
        <EmptyState
          icon={Palette}
          title="No attributes yet"
          description="Attributes define variant options like size, color, or material. Create your first attribute to enable product variants."
          actionLabel="Add Attribute"
          onAction={() => setAddAttrOpen(true)}
        />
        <AttributeDialog
          open={addAttrOpen}
          onOpenChange={setAddAttrOpen}
          mode="create"
          isPending={createAttrMutation.isPending}
          onSubmit={(v) => createAttrMutation.mutate(v)}
        />
      </>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {isFetching ? 'Refreshing…' : `${attributes.length} attribute${attributes.length === 1 ? '' : 's'}`}
        </p>
        <Button size="sm" onClick={() => setAddAttrOpen(true)}>
          <Plus className="h-4 w-4" /> Add Attribute
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.6fr]">
        {/* Left panel: attribute cards */}
        <div className="space-y-2">
          {attributes.map((attr) => {
            const isSelected = attr.id === selectedId
            return (
              <Card
                key={attr.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId(attr.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setSelectedId(attr.id)
                  }
                }}
                className={cn(
                  'cursor-pointer transition-all hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isSelected
                    ? 'border-primary ring-1 ring-primary/30 bg-primary/5'
                    : 'hover:border-primary/30',
                )}
              >
                <CardContent className="p-4 flex items-start gap-3">
                  <div
                    className={cn(
                      'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                      attr.attributeType === 'color'
                        ? 'bg-gradient-to-br from-rose-400 via-amber-400 to-sky-500 text-white'
                        : 'bg-primary/10 text-primary',
                    )}
                  >
                    {attr.attributeType === 'color' ? (
                      <Palette className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">
                        {attr.displayName}
                      </span>
                      <Badge
                        variant="outline"
                        className="text-[10px] capitalize"
                      >
                        {attr.attributeType}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground font-mono truncate">
                      {attr.name}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {attr.values.length} value
                      {attr.values.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditAttrTarget(attr)
                      }}
                      title="Edit attribute"
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleteAttrTarget(attr)
                        setDeleteAttrError(null)
                      }}
                      title="Delete attribute"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>

        {/* Right panel: selected attribute's values */}
        <AttributeValuesPanel attribute={selected} />
      </div>

      <AttributeDialog
        open={addAttrOpen}
        onOpenChange={setAddAttrOpen}
        mode="create"
        isPending={createAttrMutation.isPending}
        onSubmit={(v) => createAttrMutation.mutate(v)}
      />

      {editAttrTarget && (
        <AttributeDialog
          open={!!editAttrTarget}
          onOpenChange={(v) => !v && setEditAttrTarget(null)}
          mode="edit"
          attribute={editAttrTarget}
          isPending={updateAttrMutation.isPending}
          onSubmit={(v) =>
            updateAttrMutation.mutate({ id: editAttrTarget.id, values: v })
          }
        />
      )}

      <DeleteConfirmDialog
        open={!!deleteAttrTarget}
        onOpenChange={(v) => {
          if (!v) {
            setDeleteAttrTarget(null)
            setDeleteAttrError(null)
          }
        }}
        title="Delete attribute"
        description="This permanently removes the attribute and all of its values. Variants referencing these values may need to be updated."
        itemName={deleteAttrTarget?.displayName ?? ''}
        isPending={deleteAttrMutation.isPending}
        error={deleteAttrError}
        onConfirm={() =>
          deleteAttrTarget && deleteAttrMutation.mutate(deleteAttrTarget.id)
        }
      />
    </div>
  )
}

function AttributeDialog({
  open,
  onOpenChange,
  mode,
  attribute,
  isPending,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  mode: 'create' | 'edit'
  attribute?: Attribute
  isPending: boolean
  onSubmit: (values: AttributeFormValues) => void
}) {
  const form = useForm<AttributeFormValues>({
    resolver: zodResolver(attributeFormSchema),
    defaultValues: {
      name: '',
      displayName: '',
      attributeType: 'select',
      displayOrder: 0,
    },
  })

  useEffect(() => {
    if (!open) return
    if (mode === 'edit' && attribute) {
      form.reset({
        name: attribute.name,
        displayName: attribute.displayName,
        attributeType: attribute.attributeType,
        displayOrder: attribute.displayOrder,
      })
    } else {
      form.reset({
        name: '',
        displayName: '',
        attributeType: 'select',
        displayOrder: 0,
      })
    }
  }, [open, mode, attribute, form])

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = form
  const attributeType = watch('attributeType')

  return (
    <Dialog open={open} onOpenChange={(v) => !isPending && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === 'create' ? 'Add attribute' : 'Edit attribute'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? 'Attributes define variant options such as size, color, or material.'
              : 'Update the attribute display details and type.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="attr-name">Key</Label>
            <Input
              id="attr-name"
              placeholder="e.g. size"
              autoFocus
              disabled={isPending || mode === 'edit'}
              className="font-mono lowercase"
              {...register('name')}
            />
            {errors.name ? (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Lowercase, no spaces. Used as the variant key.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="attr-display">Display name</Label>
            <Input
              id="attr-display"
              placeholder="e.g. Size"
              disabled={isPending}
              {...register('displayName')}
            />
            {errors.displayName && (
              <p className="text-xs text-destructive">
                {errors.displayName.message}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="attr-type">Type</Label>
            <Select
              value={attributeType}
              onValueChange={(v) =>
                setValue('attributeType', v as 'select' | 'color')
              }
              disabled={isPending}
            >
              <SelectTrigger id="attr-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="select">
                  <span className="flex items-center gap-2">
                    <ChevronRight className="h-3.5 w-3.5" /> Select
                    <span className="text-xs text-muted-foreground">
                      — plain text values
                    </span>
                  </span>
                </SelectItem>
                <SelectItem value="color">
                  <span className="flex items-center gap-2">
                    <Palette className="h-3.5 w-3.5" /> Color
                    <span className="text-xs text-muted-foreground">
                      — values carry a hex swatch
                    </span>
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            {errors.attributeType && (
              <p className="text-xs text-destructive">
                {errors.attributeType.message}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="attr-order">Display order</Label>
            <Input
              id="attr-order"
              type="number"
              min={0}
              disabled={isPending}
              {...register('displayOrder', {
                setValueAs: (v) => {
                  if (v === '' || v === null || v === undefined) return undefined
                  const n = typeof v === 'number' ? v : parseInt(String(v), 10)
                  return Number.isNaN(n) ? undefined : n
                },
              })}
            />
            {errors.displayOrder && (
              <p className="text-xs text-destructive">
                {errors.displayOrder.message}
              </p>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === 'create' ? 'Create attribute' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Attribute values panel (right side of attributes tab)
// ─────────────────────────────────────────────────────────────────────────────

function AttributeValuesPanel({ attribute }: { attribute: Attribute | null }) {
  const queryClient = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<AttributeValue | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AttributeValue | null>(null)

  const createValueMutation = useMutation({
    mutationFn: ({ attrId, values }: { attrId: string; values: AttributeValueFormValues }) =>
      api.post(`/api/catalog/attributes/${attrId}/values`, {
        value: values.value,
        displayValue: values.displayValue,
        colorHex: values.colorHex || undefined,
        displayOrder: values.displayOrder ?? 0,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attributes'] })
      toast.success('Value added')
      setAddOpen(false)
    },
    onError: (err) => {
      toast.error(
        err instanceof FetchError ? err.message : 'Failed to add value.',
      )
    },
  })

  const updateValueMutation = useMutation({
    mutationFn: ({ id, values }: { id: string; values: AttributeValueFormValues }) =>
      api.patch(`/api/catalog/attribute-values/${id}`, {
        value: values.value,
        displayValue: values.displayValue,
        colorHex: values.colorHex || null,
        displayOrder: values.displayOrder ?? 0,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attributes'] })
      toast.success('Value updated')
      setEditTarget(null)
    },
    onError: (err) => {
      toast.error(
        err instanceof FetchError ? err.message : 'Failed to update value.',
      )
    },
  })

  const deleteValueMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/catalog/attribute-values/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attributes'] })
      toast.success('Value deleted')
      setDeleteTarget(null)
    },
    onError: (err) => {
      toast.error(
        err instanceof FetchError ? err.message : 'Failed to delete value.',
      )
    },
  })

  if (!attribute) {
    return (
      <Card className="h-full">
        <CardContent className="p-10 text-center space-y-3 flex flex-col items-center justify-center min-h-[300px]">
          <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center">
            <ChevronRight className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="text-sm font-medium">No attribute selected</h3>
          <p className="text-xs text-muted-foreground max-w-xs">
            Select an attribute from the left to manage its values.
          </p>
        </CardContent>
      </Card>
    )
  }

  const isColor = attribute.attributeType === 'color'

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base flex items-center gap-2">
              {isColor ? (
                <Palette className="h-4 w-4 text-primary" />
              ) : (
                <ChevronRight className="h-4 w-4 text-primary" />
              )}
              {attribute.displayName}
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              {attribute.name} · {attribute.attributeType} ·{' '}
              {attribute.values.length} value
              {attribute.values.length === 1 ? '' : 's'}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {attribute.values.length === 0 ? (
          <div className="rounded-md border border-dashed p-8 text-center space-y-2">
            <p className="text-sm text-muted-foreground">
              No values yet for this attribute.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAddOpen(true)}
            >
              <Plus className="h-4 w-4" /> Add the first value
            </Button>
          </div>
        ) : (
          <>
            {/* Values header (desktop) */}
            <div
              className={cn(
                'hidden sm:grid gap-2 border-b pb-2 text-xs font-medium text-muted-foreground',
                isColor
                  ? 'grid-cols-[1fr_1.4fr_auto_auto]'
                  : 'grid-cols-[1fr_1.4fr_auto]',
              )}
            >
              <span>Value</span>
              <span>Display value</span>
              {isColor && <span>Color</span>}
              <span className="text-right">Actions</span>
            </div>
            <ul className="divide-y">
              {attribute.values.map((v) => (
                <li
                  key={v.id}
                  className={cn(
                    'grid gap-2 py-2.5 items-center',
                    isColor
                      ? 'sm:grid-cols-[1fr_1.4fr_auto_auto]'
                      : 'sm:grid-cols-[1fr_1.4fr_auto]',
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {isColor && v.colorHex && (
                      <span
                        className="h-4 w-4 shrink-0 rounded border"
                        style={{ backgroundColor: v.colorHex }}
                        aria-hidden
                      />
                    )}
                    <code className="text-xs truncate">{v.value}</code>
                  </div>
                  <span className="text-sm truncate">{v.displayValue}</span>
                  {isColor && (
                    <span className="hidden sm:inline text-xs font-mono text-muted-foreground">
                      {v.colorHex ?? '—'}
                    </span>
                  )}
                  <div className="flex items-center gap-0.5 sm:justify-end">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setEditTarget(v)}
                      title="Edit value"
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={() => setDeleteTarget(v)}
                      title="Delete value"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="pt-1">
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={() => setAddOpen(true)}
          >
            <Plus className="h-4 w-4" /> Add Value
          </Button>
        </div>
      </CardContent>

      <AttributeValueDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        mode="create"
        attributeType={attribute.attributeType}
        isPending={createValueMutation.isPending}
        onSubmit={(v) =>
          createValueMutation.mutate({ attrId: attribute.id, values: v })
        }
      />

      {editTarget && (
        <AttributeValueDialog
          open={!!editTarget}
          onOpenChange={(v) => !v && setEditTarget(null)}
          mode="edit"
          attributeType={attribute.attributeType}
          value={editTarget}
          isPending={updateValueMutation.isPending}
          onSubmit={(v) =>
            updateValueMutation.mutate({ id: editTarget.id, values: v })
          }
        />
      )}

      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null)
        }}
        title="Delete attribute value"
        description="This permanently removes the value. Variants referencing it may need to be updated."
        itemName={deleteTarget?.displayValue ?? ''}
        isPending={deleteValueMutation.isPending}
        error={null}
        onConfirm={() =>
          deleteTarget && deleteValueMutation.mutate(deleteTarget.id)
        }
      />
    </Card>
  )
}

function AttributeValueDialog({
  open,
  onOpenChange,
  mode,
  attributeType,
  value,
  isPending,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  mode: 'create' | 'edit'
  attributeType: 'select' | 'color'
  value?: AttributeValue
  isPending: boolean
  onSubmit: (values: AttributeValueFormValues) => void
}) {
  const form = useForm<AttributeValueFormValues>({
    resolver: zodResolver(attributeValueFormSchema),
    defaultValues: {
      value: '',
      displayValue: '',
      colorHex: '',
      displayOrder: 0,
    },
  })

  useEffect(() => {
    if (!open) return
    if (mode === 'edit' && value) {
      form.reset({
        value: value.value,
        displayValue: value.displayValue,
        colorHex: value.colorHex ?? '',
        displayOrder: value.displayOrder,
      })
    } else {
      form.reset({
        value: '',
        displayValue: '',
        colorHex: attributeType === 'color' ? '#000000' : '',
        displayOrder: 0,
      })
    }
  }, [open, mode, value, attributeType, form])

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = form
  const colorHex = watch('colorHex')
  const isColor = attributeType === 'color'

  return (
    <Dialog open={open} onOpenChange={(v) => !isPending && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === 'create' ? 'Add value' : 'Edit value'}
          </DialogTitle>
          <DialogDescription>
            {isColor
              ? 'Each color value carries a display name and a hex swatch.'
              : 'Each value is an option customers can select for this attribute.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="val-value">Value</Label>
            <Input
              id="val-value"
              placeholder={isColor ? 'e.g. #FF0000' : 'e.g. S'}
              autoFocus
              disabled={isPending}
              {...register('value')}
            />
            {errors.value ? (
              <p className="text-xs text-destructive">{errors.value.message}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                The internal value stored on each variant.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="val-display">Display value</Label>
            <Input
              id="val-display"
              placeholder={isColor ? 'e.g. Crimson Red' : 'e.g. Small'}
              disabled={isPending}
              {...register('displayValue')}
            />
            {errors.displayValue && (
              <p className="text-xs text-destructive">
                {errors.displayValue.message}
              </p>
            )}
          </div>

          {isColor && (
            <div className="space-y-1.5">
              <Label htmlFor="val-color">Color hex</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={colorHex || '#000000'}
                  onChange={(e) => setValue('colorHex', e.target.value)}
                  disabled={isPending}
                  className="h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-background p-1"
                  aria-label="Pick color"
                />
                <Input
                  id="val-color"
                  placeholder="#RRGGBB"
                  disabled={isPending}
                  className="font-mono"
                  {...register('colorHex')}
                />
                {colorHex && (
                  <span
                    className="h-9 w-9 shrink-0 rounded-md border"
                    style={{ backgroundColor: colorHex }}
                    aria-hidden
                  />
                )}
              </div>
              {errors.colorHex && (
                <p className="text-xs text-destructive">
                  {errors.colorHex.message}
                </p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="val-order">Display order</Label>
            <Input
              id="val-order"
              type="number"
              min={0}
              disabled={isPending}
              {...register('displayOrder', {
                setValueAs: (v) => {
                  if (v === '' || v === null || v === undefined) return undefined
                  const n = typeof v === 'number' ? v : parseInt(String(v), 10)
                  return Number.isNaN(n) ? undefined : n
                },
              })}
            />
            {errors.displayOrder && (
              <p className="text-xs text-destructive">
                {errors.displayOrder.message}
              </p>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              <X className="h-4 w-4" /> Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              {mode === 'create' ? 'Add value' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AttributesSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Skeleton className="h-9 w-36" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_1.6fr]">
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4 flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-md" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-32" />
                </div>
                <Skeleton className="h-7 w-7 rounded" />
                <Skeleton className="h-7 w-7 rounded" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3 w-56" />
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="grid grid-cols-[1fr_1.4fr_auto] gap-2 py-2.5"
              >
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-28" />
                <div className="flex gap-1">
                  <Skeleton className="h-7 w-7 rounded" />
                  <Skeleton className="h-7 w-7 rounded" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
