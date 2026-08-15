'use client'

import { useCallback, useEffect, useMemo, useRef, useState , memo} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, FetchError, getSessionToken } from '@/lib/api-client'
import { useAppStore, useCan } from '@/stores/app-store'
import { PERMISSIONS } from '@/lib/permissions'
import { useFormGuard } from '@/hooks/form-guard/use-form-guard'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ArrowLeft,
  Plus,
  Trash2,
  Search,
  AlertCircle,
  Loader2,
  User,
  Phone,
  MapPin,
  Package,
  CreditCard,
  Truck,
  CheckCircle2,
  Check,
  Upload,
  X,
  ShoppingBag,
  History,
  PackageCheck,
  FileImage,
  RotateCcw,
  Save,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { createManualOrderSchema } from '@/lib/validations/order.schemas'

// Shared customer components (the entire customer-search + create + address
// selection flow lives in these — order-create-view just orchestrates them).
import { CustomerSearchAutocomplete } from '@/components/customers/CustomerSearchAutocomplete'
import { CreateCustomerForm } from '@/components/customers/CreateCustomerForm'
import {
  AddressSelector,
  type AddressSelectorValue,
} from '@/components/customers/AddressSelector'
import type {
  CustomerSearchResult,
  CustomerDetail,
} from '@/components/customers/types'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface InventoryLocation {
  id: string
  name: string
  locationType: string
  city: string
  isOrgLevel: boolean
  isDefault: boolean
}

interface LocationsResponse {
  locations: InventoryLocation[]
}

/**
 * The customer shape returned by CustomerSearchAutocomplete.onSelect —
 * matches `NonNullable<CustomerSearchResult['customer']>`.
 */
type SelectedCustomer = NonNullable<CustomerSearchResult['customer']>

interface VariantOption {
  variantId: string
  sku: string
  productTitle: string
  costPrice: number
  salePrice: number | null
  fulfillmentType: string
  primaryImage: string | null
  attributeValues: Record<string, string>
}

interface ProductsResponse {
  products: Array<{
    id: string
    title: string
    primaryImage: string | null
    variants: Array<{
      id: string
      sku: string
      costPrice: number
      salePrice: number | null
      fulfillmentType: string
      attributeValues: Record<string, string>
    }>
  }>
}

interface CartItem {
  variantId: string
  sku: string
  productTitle: string
  primaryImage: string | null
  unitPrice: number
  quantity: number
  fulfillmentType: string
}

interface CreateOrderResponse {
  orderId: string
  flowopsOrderNumber: string
  orderItems: Array<{ id: string; orgVariantId: string; quantity: number }>
  /** Auto-booking is now ASYNC — bookingAttempted=true means it's running in the background. */
  bookingAttempted: boolean
  bookingSucceeded?: boolean
  bookingError?: string
  bookingTrackingNumber?: string
}

type PaymentType = 'full_cod' | 'partial_advance' | 'fully_prepaid'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const PKR = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 })

function formatPKR(n: number): string {
  return `Rs. ${PKR.format(n)}`
}

function getErrorMessage(err: unknown): string {
  if (err instanceof FetchError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong. Please try again.'
}

function parseQty(v: string): number {
  if (v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

function parsePrice(v: string): number {
  if (v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

const PAYMENT_METHODS = [
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'easy_paisa', label: 'EasyPaisa' },
  { value: 'jazz_cash', label: 'JazzCash' },
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'other', label: 'Other' },
]

/** Stock badge for a variant based on fulfillmentType. */
function stockBadgeFor(
  fulfillmentType: string,
): { label: string; className: string } {
  if (fulfillmentType === 'made_to_order') {
    return {
      label: 'Made to Order',
      className: 'bg-purple-50 text-purple-700 border-purple-200',
    }
  }
  if (fulfillmentType === 'backorder') {
    return {
      label: 'Backorder Available',
      className: 'bg-orange-50 text-orange-700 border-orange-200',
    }
  }
  return {
    label: 'In Stock',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view — single-page scrollable order creation form
// ─────────────────────────────────────────────────────────────────────────────

export function OrderCreateView({ onBack, draftId: initialDraftId }: { onBack: () => void; draftId?: string }) {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const queryClient = useQueryClient()
  const canCreate = can(PERMISSIONS.ORDERS_CREATE)

  // ── Form state ────────────────────────────────────────────────────────────
  // Customer — the search, dropdown, and inline-create flow are owned entirely
  // by <CustomerSearchAutocomplete /> + <CreateCustomerForm />. The parent only
  // holds the resulting customer + the per-order address/phone/recipient
  // selection so buildPayload can reference them.
  const [selectedCustomer, setSelectedCustomer] = useState<SelectedCustomer | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [usedCustomerAddressId, setUsedCustomerAddressId] = useState<string | null>(null)
  const [usedCustomerPhoneId, setUsedCustomerPhoneId] = useState<string | null>(null)
  const [recipientName, setRecipientName] = useState('')
  const [saveAddressForNextTime, setSaveAddressForNextTime] = useState(false)

  // Items
  const [cart, setCart] = useState<CartItem[]>([])
  const [variantSearch, setVariantSearch] = useState('')

  // Payment
  const [paymentType, setPaymentType] = useState<PaymentType>('full_cod')
  const [advanceAmount, setAdvanceAmount] = useState('')
  const [advancePaymentMethod, setAdvancePaymentMethod] = useState('')
  const [advancePaymentReference, setAdvancePaymentReference] = useState('')
  // The payment proof is held in browser memory as a raw File during the
  // order creation flow. NO upload happens until the order_id exists.
  const [paymentProofFile, setPaymentProofFile] = useState<File | null>(null)
  const [paymentProofPreview, setPaymentProofPreview] = useState<string>('')
  const [proofError, setProofError] = useState<string | null>(null)

  // Delivery / dispatch / discount — folded into the customer section now,
  // but the underlying state still lives here so the order payload builder
  // and validation can reference it cleanly.
  // The order's own delivery_address/delivery_city are editable snapshots
  // controlled by <AddressSelector /> (it owns the live text; we mirror it
  // here for buildPayload + validation).
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [deliveryCity, setDeliveryCity] = useState('')
  const [courierName, setCourierName] = useState('')
  const [courierIntegrationId, setCourierIntegrationId] = useState('')
  const [dispatchLocationId, setDispatchLocationId] = useState('')
  const [notesForCourier, setNotesForCourier] = useState('')
  // Per-order pickup address override. When empty, booking uses the
  // integration's default pickup address. When set, overrides the default.
  const [pickupAddressId, setPickupAddressId] = useState('')
  const [orderRefNumber, setOrderRefNumber] = useState('')
  const [orderDetail, setOrderDetail] = useState('')
  const [discountAmount, setDiscountAmount] = useState('')
  const [discountReason, setDiscountReason] = useState('')
  const [deliveryCharge, setDeliveryCharge] = useState('')
  const [taxAmount, setTaxAmount] = useState('')
  const [taxLabel, setTaxLabel] = useState('')

  // Validation errors — keyed by Zod issue path (joined with '.')
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Section refs for scrolling to the first error on submit
  const customerSectionRef = useRef<HTMLDivElement | null>(null)
  const itemsSectionRef = useRef<HTMLDivElement | null>(null)
  const paymentSectionRef = useRef<HTMLDivElement | null>(null)
  const variantOptionsRef = useRef<VariantOption[]>([])

  // Track in-flight post-creation upload so we can render a "Saving proof…"
  // state on the submit button.
  const [uploadingProof, setUploadingProof] = useState(false)

  // Idempotency key for order creation — generated once per form session.
  // Prevents duplicate orders from rapid double-clicks. Regenerated on
  // component remount (new useRef initialization).
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID())

  // Track whether the order creation itself is in-flight (separate from
  // uploadingProof which tracks the post-creation payment proof upload).
  const [submittingOrder, setSubmittingOrder] = useState(false)

  // ── Phase 5: Booking failure state for inline Retry UI ──
  // When auto-booking fails after order creation, the order is still saved
  // but we stay on the create page to show an inline banner with a Retry
  // button. This is SEPARATE from the order-created success toast.
  const [bookingFailure, setBookingFailure] = useState<{
    orderId: string
    orderNumber: string
    error: string
  } | null>(null)
  const [retryingBooking, setRetryingBooking] = useState(false)

  // ── Form Guard: dirty-state tracking + save-draft + guard hook ─────────
  const [hasChanges, setHasChanges] = useState(false)
  const markDirty = useCallback(() => { if (!hasChanges) setHasChanges(true) }, [hasChanges])
  const [draftId, setDraftId] = useState<string | undefined>(initialDraftId)

  // Load draft data on mount if a draftId was passed (from the Drafts list "Resume" button)
  useEffect(() => {
    if (!initialDraftId) return
    let cancelled = false
    ;(async () => {
      try {
        const draft = await api.get<{ id: string; draftData: string; draftType: string }>(`/api/drafts?id=${initialDraftId}`)
        if (cancelled || !draft) return
        const data = JSON.parse(draft.draftData) as Record<string, unknown>
        // Pre-fill form fields from draft data
        if (typeof data.recipientName === 'string') setRecipientName(data.recipientName)
        if (typeof data.deliveryAddress === 'string') setDeliveryAddress(data.deliveryAddress)
        if (typeof data.deliveryCity === 'string') setDeliveryCity(data.deliveryCity)
        if (typeof data.courierName === 'string') setCourierName(data.courierName)
        if (typeof data.dispatchLocationId === 'string') setDispatchLocationId(data.dispatchLocationId)
        if (typeof data.notesForCourier === 'string') setNotesForCourier(data.notesForCourier)
        if (typeof data.discountAmount === 'string') setDiscountAmount(data.discountAmount)
        if (typeof data.discountReason === 'string') setDiscountReason(data.discountReason)
        if (typeof data.paymentType === 'string') setPaymentType(data.paymentType as PaymentType)
        if (typeof data.advanceAmount === 'string') setAdvanceAmount(data.advanceAmount)
        if (typeof data.advancePaymentMethod === 'string') setAdvancePaymentMethod(data.advancePaymentMethod)
        if (typeof data.advancePaymentReference === 'string') setAdvancePaymentReference(data.advancePaymentReference)
        if (typeof data.usedCustomerAddressId === 'string') setUsedCustomerAddressId(data.usedCustomerAddressId)
        if (typeof data.usedCustomerPhoneId === 'string') setUsedCustomerPhoneId(data.usedCustomerPhoneId)
        if (typeof data.saveAddressForNextTime === 'boolean') setSaveAddressForNextTime(data.saveAddressForNextTime)
        // Restore cart items
        if (Array.isArray(data.cart)) {
          const restoredCart = (data.cart as Array<{ variantId: string; quantity: number; unitPrice: number }>).map((c) => {
            // Find the variant in the loaded products to get full details
            const variant = variantOptionsRef.current?.find((v) => v.variantId === c.variantId)
            return {
              variantId: c.variantId,
              sku: variant?.sku ?? '',
              productTitle: variant?.productTitle ?? 'Unknown Product',
              primaryImage: variant?.primaryImage ?? null,
              unitPrice: c.unitPrice,
              quantity: c.quantity,
              fulfillmentType: variant?.fulfillmentType ?? 'stock_based',
            }
          })
          setCart(restoredCart)
        }
        toast.info('Draft loaded — continue editing.')
      } catch {
        if (!cancelled) toast.error('Failed to load draft.')
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDraftId])
  const [savingDraft, setSavingDraft] = useState(false)

  const saveDraft = useCallback(async () => {
    setSavingDraft(true)
    try {
      const result = await api.post<{ draftId: string }>('/api/orders/drafts', {
        draftId,
        draftData: {
          selectedCustomer: selectedCustomer?.id ?? null,
          usedCustomerAddressId,
          usedCustomerPhoneId,
          recipientName,
          cart: cart.map((c) => ({ variantId: c.variantId, quantity: c.quantity, unitPrice: c.unitPrice })),
          paymentType,
          advanceAmount,
          advancePaymentMethod,
          advancePaymentReference,
          deliveryAddress,
          deliveryCity,
          courierName,
          dispatchLocationId,
          notesForCourier,
          discountAmount,
          discountReason,
        },
        draftTitle: `Order draft — ${selectedCustomer?.name ?? 'No customer'}`,
      })
      if (result.draftId) setDraftId(result.draftId)
      setHasChanges(false) // Reset guard — just saved
    } finally {
      setSavingDraft(false)
    }
  }, [draftId, selectedCustomer, usedCustomerAddressId, usedCustomerPhoneId,
      recipientName, cart, paymentType, advanceAmount, advancePaymentMethod,
      advancePaymentReference, deliveryAddress, deliveryCity, courierName,
      dispatchLocationId, notesForCourier, discountAmount, discountReason])

  const { ConfirmModal: formGuardModal, attemptNavigation: guardedNavigate } = useFormGuard({
    isDirty: hasChanges && !uploadingProof,
    onSaveDraft: saveDraft,
  })

  // ── Data queries ──────────────────────────────────────────────────────────
  const locationsQuery = useQuery<LocationsResponse>({
    queryKey: ['locations'],
    queryFn: () => api.get<LocationsResponse>('/api/inventory-locations'),
    staleTime: 30_000,
  })

  // Fetch connected courier integrations for the courier dropdown
  const couriersQuery = useQuery<{
    integrations: Array<{
      id: string
      connectionName: string
      isActive: boolean
      provider: { providerKey: string; providerName: string }
    }>
  }>({
    queryKey: ['integrations', 'courier'],
    queryFn: () => api.get('/api/integrations?category=courier'),
    staleTime: 60_000,
  })
  const courierIntegrations = (couriersQuery.data?.integrations ?? []).filter((i) => i.isActive)

  // Fetch order settings to get default courier
  const orderSettingsQuery = useQuery<{
    settings: {
      defaultCourierCompanyIntegrationId: string | null
      courierBookingMode: string
    }
  }>({
    queryKey: ['order-settings'],
    queryFn: () => api.get('/api/order-settings'),
    staleTime: 60_000,
  })

  // Set default courier from settings when data loads
  useEffect(() => {
    if (orderSettingsQuery.data?.settings?.defaultCourierCompanyIntegrationId && !courierIntegrationId) {
      setCourierIntegrationId(orderSettingsQuery.data.settings.defaultCourierCompanyIntegrationId)
    }
  }, [orderSettingsQuery.data, courierIntegrationId])

  // Fetch pickup addresses for the selected courier integration.
  // Used to populate the per-order pickup address override dropdown.
  interface PickupAddressOption {
    id: string
    label: string
    address: string
    cityName: string
    isDefault: boolean
  }
  const pickupAddressesQuery = useQuery<{ addresses: PickupAddressOption[] }>({
    queryKey: ['pickup-addresses', courierIntegrationId],
    queryFn: () => api.get(`/api/integrations/${courierIntegrationId}/pickup-addresses`),
    enabled: !!courierIntegrationId,
    staleTime: 30_000,
  })
  const pickupAddresses = pickupAddressesQuery.data?.addresses ?? []

  // Auto-compute order detail from cart items (moved after variantOptions declaration)
  const productsQuery = useQuery<ProductsResponse>({
    queryKey: ['products', 'for-order-create'],
    queryFn: () => api.get<ProductsResponse>('/api/products?pageSize=100'),
    staleTime: 60_000,
  })

  // ── Variant options (flatten products → variants) ─────────────────────────
  const variantOptions: VariantOption[] = useMemo(() => {
    const list: VariantOption[] = []
    for (const p of productsQuery.data?.products ?? []) {
      for (const v of p.variants) {
        list.push({
          variantId: v.id,
          sku: v.sku,
          productTitle: p.title,
          costPrice: v.costPrice,
          salePrice: v.salePrice,
          fulfillmentType: v.fulfillmentType,
          primaryImage: p.primaryImage,
          attributeValues: v.attributeValues ?? {},
        })
      }
    }
    return list
  }, [productsQuery.data])

  // Keep ref in sync so the draft-loading effect can access variant details
  useEffect(() => {
    variantOptionsRef.current = variantOptions
  }, [variantOptions])

  // Track whether the user has manually edited the Order Detail field.
  // If they have, we DON'T clobber their edit when the cart changes —
  // the auto-computed preview only writes to the field while it remains
  // untouched. On submit, if the user hasn't edited, we send `undefined`
  // so the server generates the canonical version (same format, sourced
  // from the DB — guarantees consistency even if the products list is stale).
  const [orderDetailUserEdited, setOrderDetailUserEdited] = useState(false)

  // Auto-compute order detail preview from cart items.
  // Format mirrors the server's canonical version:
  //   "Product Title (SKU-001, Size: M, Color: Blue) ×2, ..."
  useEffect(() => {
    if (orderDetailUserEdited) return // don't clobber manual edits
    if (cart.length > 0) {
      const details = cart.map((i) => {
        const variant = variantOptions.find((v) => v.variantId === i.variantId)
        const sku = variant?.sku ?? ''
        const title = variant?.productTitle ?? ''
        const attrs = variant?.attributeValues ?? {}
        const attrParts = Object.entries(attrs)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${v}`)
        const inner = [sku, ...attrParts].filter(Boolean).join(', ')
        return `${title}${inner ? ` (${inner})` : ''} ×${i.quantity}`
      })
      setOrderDetail(details.join(', '))
    } else {
      setOrderDetail('')
    }
  }, [cart, variantOptions, orderDetailUserEdited])

  const variantSearchResults = useMemo(() => {
    if (!variantSearch.trim()) return []
    const q = variantSearch.toLowerCase()
    return variantOptions
      .filter(
        (v) => v.sku.toLowerCase().includes(q) || v.productTitle.toLowerCase().includes(q),
      )
      .slice(0, 8)
  }, [variantOptions, variantSearch])

  // ── Computed totals ───────────────────────────────────────────────────────
  const subtotal = useMemo(
    () => cart.reduce((s, i) => s + i.unitPrice * i.quantity, 0),
    [cart],
  )
  const discount = parsePrice(discountAmount)
  const delivery = parsePrice(deliveryCharge)
  const tax = parsePrice(taxAmount)
  const total = Math.max(0, subtotal + delivery + tax - discount)

  const remainingCod =
    paymentType === 'fully_prepaid'
      ? 0
      : paymentType === 'partial_advance'
        ? Math.max(0, total - parsePrice(advanceAmount))
        : total

  // ── Auto-select default dispatch location ─────────────────────────────────
  useEffect(() => {
    if (!dispatchLocationId && locationsQuery.data?.locations.length) {
      const def = locationsQuery.data.locations.find((l) => l.isDefault)
      setDispatchLocationId(def?.id ?? locationsQuery.data.locations[0].id)
    }
  }, [dispatchLocationId, locationsQuery.data])

  // ── Item manipulation ─────────────────────────────────────────────────────
  const addVariant = (v: VariantOption) => {
    setCart((prev) => {
      if (prev.some((i) => i.variantId === v.variantId)) {
        toast.info('That variant is already in the cart.')
        return prev
      }
      const unitPrice = v.salePrice ?? v.costPrice
      return [
        ...prev,
        {
          variantId: v.variantId,
          sku: v.sku,
          productTitle: v.productTitle,
          primaryImage: v.primaryImage,
          unitPrice,
          quantity: 1,
          fulfillmentType: v.fulfillmentType,
        },
      ]
    })
    setVariantSearch('')
    markDirty()
  }

  const removeItem = (variantId: string) => {
    setCart((prev) => prev.filter((i) => i.variantId !== variantId))
    markDirty()
  }

  const updateItem = (variantId: string, patch: Partial<CartItem>) => {
    setCart((prev) =>
      prev.map((i) => (i.variantId === variantId ? { ...i, ...patch } : i)),
    )
  }

  // ── Payment proof file handling ───────────────────────────────────────────
  function handleProofFile(file: File) {
    setProofError(null)
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setProofError('Only JPG, PNG, and WebP images are allowed.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setProofError('File too large. Maximum 5 MB.')
      return
    }
    if (paymentProofPreview) URL.revokeObjectURL(paymentProofPreview)
    setPaymentProofFile(file)
    setPaymentProofPreview(URL.createObjectURL(file))
  }

  function clearProofFile() {
    setProofError(null)
    if (paymentProofPreview) URL.revokeObjectURL(paymentProofPreview)
    setPaymentProofFile(null)
    setPaymentProofPreview('')
  }

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => {
      if (paymentProofPreview) URL.revokeObjectURL(paymentProofPreview)
    }
  }, [paymentProofPreview])

  // ── Customer selection handlers ───────────────────────────────────────────
  // When a customer is picked from the autocomplete (either an existing match
  // or just-created via CreateCustomerForm), pre-select the primary phone,
  // the default address, and default recipient_name to the customer's name.
  function handleSelectCustomer(c: SelectedCustomer) {
    setSelectedCustomer(c)
    setShowCreateForm(false)

    const primaryPhone = c.phones.find((p) => p.isPrimary) ?? c.phones[0] ?? null
    setUsedCustomerPhoneId(primaryPhone?.id ?? null)

    const defaultAddr = c.addresses.find((a) => a.isDefault) ?? c.addresses[0] ?? null
    setUsedCustomerAddressId(defaultAddr?.id ?? null)
    setDeliveryAddress(defaultAddr?.address ?? '')
    setDeliveryCity(defaultAddr?.city ?? '')

    setRecipientName(c.name)
    setSaveAddressForNextTime(false)
    markDirty()
  }

  function handleDeselectCustomer() {
    setSelectedCustomer(null)
    setShowCreateForm(false)
    setUsedCustomerAddressId(null)
    setUsedCustomerPhoneId(null)
    setRecipientName('')
    setSaveAddressForNextTime(false)
    setDeliveryAddress('')
    setDeliveryCity('')
  }

  // When the user clicks "+ Create New Customer" in the autocomplete dropdown,
  // reveal the inline <CreateCustomerForm />. Its onCreated callback receives
  // the new customer ID; we then fetch the full record so we can populate
  // selectedCustomer exactly like a picked search result.
  async function handleCustomerCreated(customerId: string) {
    try {
      const detail = await api.get<CustomerDetail>(`/api/customers/${customerId}`)
      // Map the detail shape → SelectedCustomer shape (the search-result
      // customer carries a slightly smaller field set than the full detail).
      const c: SelectedCustomer = {
        id: detail.id,
        name: detail.name,
        email: detail.email,
        totalOrdersCount: detail.totalOrdersCount,
        totalRtoCount: detail.totalRtoCount,
        isFlagged: detail.isFlagged,
        flaggedReason: detail.flaggedReason,
        phones: detail.phones,
        addresses: detail.addresses,
      }
      handleSelectCustomer(c)
      void queryClient.invalidateQueries({ queryKey: ['customers'] })
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  // ── Build the create-order payload ────────────────────────────────────────
  function buildPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      items: cart.map((i) => ({
        org_variant_id: i.variantId,
        quantity: i.quantity,
        unit_price: i.unitPrice,
      })),
      payment_type: paymentType,
      delivery_address: deliveryAddress.trim(),
      delivery_city: deliveryCity.trim(),
      courier_name: courierName.trim() || undefined,
      courier_company_integration_id: courierIntegrationId || undefined,
      dispatch_location_id: dispatchLocationId,
      // Per-order pickup address override (null = use integration default)
      pickup_address_id: pickupAddressId || undefined,
      notes_for_courier: notesForCourier.trim() || undefined,
      // orderRefNumber (universal courier reference, migration 015):
      // only send if the user typed a custom value — otherwise the server
      // defaults to the freshly-generated ORD-YYYY-NNNNN flowopsOrderNumber.
      order_ref_number: orderRefNumber.trim() || undefined,
      // orderDetail: only send if the user manually edited the auto-computed
      // preview. If they didn't, let the server generate the canonical
      // version (same format, sourced from the DB so it's always accurate).
      order_detail: orderDetailUserEdited ? (orderDetail.trim() || undefined) : undefined,
      discount_amount: discount > 0 ? discount : undefined,
      discount_reason: discountReason.trim() || undefined,
      estimated_delivery_charge: delivery > 0 ? delivery : undefined,
      tax_amount: tax > 0 ? tax : undefined,
      tax_label: taxLabel.trim() || undefined,
    }

    if (paymentType === 'partial_advance' || paymentType === 'fully_prepaid') {
      payload.advance_amount =
        paymentType === 'fully_prepaid' ? total : parsePrice(advanceAmount)
      payload.advance_payment_method = advancePaymentMethod || undefined
      payload.advance_payment_reference = advancePaymentReference.trim() || undefined
      // NOTE: payment proof screenshot URL is intentionally NOT set here.
      // The file is uploaded and persisted AFTER the order is created
      // (see handleSubmit).
    }

    // Customer linkage — by the time the user submits they MUST have a
    // selectedCustomer (existing or just-created). The new schema sends
    // customer_id + the saved address/phone selection + recipient_name +
    // save_address_for_next_time, instead of the old inline `customer` object.
    if (selectedCustomer) {
      payload.customer_id = selectedCustomer.id
      payload.used_customer_address_id = usedCustomerAddressId ?? undefined
      payload.used_customer_phone_id = usedCustomerPhoneId ?? undefined
      payload.recipient_name = recipientName.trim() || undefined
      payload.save_address_for_next_time = saveAddressForNextTime
    }

    return payload
  }

  // ── Validate the full form using the Zod schema ───────────────────────────
  function validate(): Record<string, string> {
    const errs: Record<string, string> = {}
    const payload = buildPayload()
    const result = createManualOrderSchema.safeParse(payload)
    if (!result.success) {
      for (const issue of result.error.issues) {
        const key = issue.path.join('.')
        if (!errs[key]) errs[key] = issue.message
      }
    }
    return errs
  }

  // ── Upload payment proof + persist URL to the order ───────────────────────
  // Returns true on success, false on any failure. NEVER throws.
  async function uploadPaymentProof(orderId: string): Promise<boolean> {
    if (!paymentProofFile) return true

    setUploadingProof(true)
    try {
      const fd = new FormData()
      fd.append('file', paymentProofFile)
      const uploadRes = await fetch(
        `/api/upload?type=payment-proofs&id=${orderId}`,
        { method: 'POST', body: fd, credentials: 'include', headers: getSessionToken() ? { Authorization: `Bearer ${getSessionToken()}` } : {} },
      )
      const uploadText = await uploadRes.text()
      let uploadBody: unknown = null
      if (uploadText) {
        try {
          uploadBody = JSON.parse(uploadText)
        } catch {
          uploadBody = uploadText
        }
      }
      if (!uploadRes.ok) {
        const msg =
          uploadBody && typeof uploadBody === 'object' && 'error' in uploadBody
            ? String((uploadBody as { error: unknown }).error)
            : typeof uploadBody === 'string'
              ? uploadBody
              : `Upload failed (HTTP ${uploadRes.status})`
        throw new Error(msg)
      }
      const { url } = uploadBody as { url: string }

      await api.post(`/api/orders/${orderId}/payment-proof`, {
        advance_payment_screenshot_url: url,
      })
      return true
    } catch {
      return false
    } finally {
      setUploadingProof(false)
    }
  }

  // ── Permission gate (after all hooks) ─────────────────────────────────────
  if (!canCreate) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Create Order"
          description="Manually create a customer order"
          actions={
            <Button variant="outline" size="sm" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" /> Back to Orders
            </Button>
          }
        />
        <Card>
          <CardContent className="p-10 text-center">
            <AlertCircle className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">
              You don&apos;t have permission to create orders.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Submit handler ────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    const errs = validate()
    setErrors(errs)
    if (Object.keys(errs).length > 0) {
      toast.error('Please complete all required fields before creating the order.')
      const firstErrPath = Object.keys(errs)[0]
      const section = sectionForErrorPath(firstErrPath)
      const ref =
        section === 'customer'
          ? customerSectionRef.current
          : section === 'items'
            ? itemsSectionRef.current
            : paymentSectionRef.current
      ref?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }

    const payload = buildPayload()

    setSubmittingOrder(true)
    try {
      const data = await api.post<CreateOrderResponse>('/api/orders', payload, {
        'Idempotency-Key': idempotencyKeyRef.current,
      })

      // ── Order creation is ALWAYS successful at this point ──
      toast.success(`Order ${data.flowopsOrderNumber} created successfully.`)

      // Auto-booking now runs ASYNCHRONOUSLY in the background (PostEx API
      // can take 50-100s). The order is created with courierBookingStatus=
      // 'not_booked', and the background task updates it when PostEx responds.
      // We navigate to the order detail page immediately — the user will see
      // the booking status update live as the background task completes.
      if (data.bookingAttempted) {
        toast.info('Courier booking is in progress… You can track the status on the order detail page.', { duration: 6000 })
      }

      setHasChanges(false)
      if (draftId) {
        await api.delete(`/api/drafts?id=${draftId}`).catch(() => {})
        setDraftId(undefined)
      }
      // Invalidate ALL relevant query keys
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
      void queryClient.invalidateQueries({ queryKey: ['booking-workbench-bookable'] })
      void queryClient.invalidateQueries({ queryKey: ['booking-workbench-activity'] })

      if (paymentProofFile) {
        const ok = await uploadPaymentProof(data.orderId)
        if (!ok) {
          toast.warning(
            'Order created successfully, but the payment proof image failed to upload — you can add it from the order detail page.',
          )
        }
      }

      // Navigate to the order detail page immediately. The booking status
      // will update live as the background task completes (the order detail
      // page polls or refetches).
      navigate({ name: 'order-detail', id: data.orderId })
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSubmittingOrder(false)
    }
  }

  // ── Phase 5: Retry booking handler (uses state declared at top of component) ──
  async function handleRetryBooking() {
    if (!bookingFailure) return
    setRetryingBooking(true)
    try {
      const result = await api.post<{ success: boolean; trackingNumber?: string; error?: string }>(
        '/api/booking-workbench/book',
        {
          orderId: bookingFailure.orderId,
          companyIntegrationId: courierIntegrationId,
        },
      )
      if (result.success && result.trackingNumber) {
        toast.success(`Booking successful! Tracking #: ${result.trackingNumber}`)
        setBookingFailure(null)
        void queryClient.invalidateQueries({ queryKey: ['orders'] })
        void queryClient.invalidateQueries({ queryKey: ['booking-workbench-bookable'] })
        navigate({ name: 'order-detail', id: bookingFailure.orderId })
      } else {
        toast.error(`Retry failed: ${result.error ?? 'Unknown error'}`)
      }
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setRetryingBooking(false)
    }
  }

  // Helper: which section does an error path belong to?
  function sectionForErrorPath(path: string): 'customer' | 'items' | 'payment' {
    if (path.startsWith('customer') || path === 'customer' || path === 'customer_id') return 'customer'
    if (path.startsWith('items')) return 'items'
    return 'payment'
  }

  // Convenience error getter
  const fieldError = (...paths: string[]) => {
    for (const p of paths) if (errors[p]) return errors[p]
    return undefined
  }

  const isSubmitting = uploadingProof || submittingOrder

  // The AddressSelector manages {usedCustomerAddressId, deliveryAddress,
  // deliveryCity, saveAddressForNextTime} as a single value object.
  const addressSelectorValue: AddressSelectorValue = {
    usedCustomerAddressId,
    deliveryAddress,
    deliveryCity,
    saveAddressForNextTime,
  }
  const handleAddressSelectorChange = (v: AddressSelectorValue) => {
    setUsedCustomerAddressId(v.usedCustomerAddressId)
    setDeliveryAddress(v.deliveryAddress)
    setDeliveryCity(v.deliveryCity)
    setSaveAddressForNextTime(v.saveAddressForNextTime)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Create Order"
        description="Fill in customer, items, payment — then submit"
        actions={
          <Button variant="outline" size="sm" onClick={() => guardedNavigate(onBack)}>
            <ArrowLeft className="h-4 w-4" /> Back to Orders
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ── Left column: form sections (stacked, scrollable) ─────────────── */}
        <div className="lg:col-span-2 space-y-6">
          {/* SECTION 1: Customer + Delivery (merged) */}
          <div ref={customerSectionRef}>
            <CustomerSection
              selectedCustomer={selectedCustomer}
              showCreateForm={showCreateForm}
              onShowCreateForm={() => setShowCreateForm(true)}
              onCancelCreateForm={() => setShowCreateForm(false)}
              onSelectCustomer={handleSelectCustomer}
              onDeselectCustomer={handleDeselectCustomer}
              onCustomerCreated={handleCustomerCreated}
              usedCustomerAddressId={usedCustomerAddressId}
              usedCustomerPhoneId={usedCustomerPhoneId}
              setUsedCustomerPhoneId={setUsedCustomerPhoneId}
              recipientName={recipientName}
              setRecipientName={setRecipientName}
              addressSelectorValue={addressSelectorValue}
              onAddressSelectorChange={handleAddressSelectorChange}
              courierProviderKey={
                courierIntegrations.find((c) => c.id === courierIntegrationId)?.provider?.providerKey ?? ''
              }
              courierName={courierName}
              setCourierName={setCourierName}
              courierIntegrationId={courierIntegrationId}
              setCourierIntegrationId={setCourierIntegrationId}
              courierIntegrations={courierIntegrations}
              pickupAddressId={pickupAddressId}
              setPickupAddressId={setPickupAddressId}
              pickupAddresses={pickupAddresses}
              pickupAddressesLoading={pickupAddressesQuery.isLoading}
              dispatchLocationId={dispatchLocationId}
              setDispatchLocationId={setDispatchLocationId}
              notesForCourier={notesForCourier}
              setNotesForCourier={setNotesForCourier}
              orderRefNumber={orderRefNumber}
              setOrderRefNumber={setOrderRefNumber}
              orderDetail={orderDetail}
              setOrderDetail={(v) => {
                setOrderDetail(v)
                setOrderDetailUserEdited(true)
              }}
              discountAmount={discountAmount}
              setDiscountAmount={setDiscountAmount}
              discountReason={discountReason}
              setDiscountReason={setDiscountReason}
              locations={locationsQuery.data?.locations ?? []}
              isLoadingLocations={locationsQuery.isLoading}
              fieldError={fieldError}
            />
          </div>

          {/* SECTION 2: Items */}
          <div ref={itemsSectionRef}>
            <ItemsSection
              cart={cart}
              variantSearch={variantSearch}
              setVariantSearch={setVariantSearch}
              variantSearchResults={variantSearchResults}
              addVariant={addVariant}
              removeItem={removeItem}
              updateItem={updateItem}
              isLoadingProducts={productsQuery.isLoading}
              subtotal={subtotal}
              itemsError={fieldError('items')}
            />
          </div>

          {/* SECTION 3: Payment */}
          <div ref={paymentSectionRef}>
            <PaymentSection
              paymentType={paymentType}
              setPaymentType={setPaymentType}
              advanceAmount={advanceAmount}
              setAdvanceAmount={setAdvanceAmount}
              advancePaymentMethod={advancePaymentMethod}
              setAdvancePaymentMethod={setAdvancePaymentMethod}
              advancePaymentReference={advancePaymentReference}
              setAdvancePaymentReference={setAdvancePaymentReference}
              subtotal={subtotal}
              total={total}
              discount={discount}
              deliveryCharge={deliveryCharge}
              setDeliveryCharge={setDeliveryCharge}
              taxAmount={taxAmount}
              setTaxAmount={setTaxAmount}
              taxLabel={taxLabel}
              setTaxLabel={setTaxLabel}
              remainingCod={remainingCod}
              paymentProofFile={paymentProofFile}
              paymentProofPreview={paymentProofPreview}
              proofError={proofError}
              onProofFile={handleProofFile}
              onClearProof={clearProofFile}
              fieldError={fieldError}
            />
          </div>
        </div>

        {/* ── Right column: sticky summary + create button ─────────────────── */}
        <div className="lg:col-span-1">
          <div className="lg:sticky lg:top-6 space-y-4">
            <SummarySection
              cart={cart}
              subtotal={subtotal}
              discount={discount}
              discountReason={discountReason}
              total={total}
              paymentType={paymentType}
              advanceAmount={parsePrice(advanceAmount)}
              remainingCod={remainingCod}
            />

            <Card>
              <CardContent className="p-4 space-y-3">
                <Button
                  size="lg"
                  className="w-full"
                  onClick={handleSubmit}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Saving proof…
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4" /> Create Order
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={async () => {
                    try { await saveDraft(); toast.success('Draft saved.') }
                    catch { toast.error('Failed to save draft.') }
                  }}
                  disabled={isSubmitting || savingDraft}
                >
                  {savingDraft ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save as Draft
                </Button>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => guardedNavigate(onBack)}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                {Object.keys(errors).length > 0 && (
                  <p className="text-xs text-destructive text-center">
                    {Object.keys(errors).length} field
                    {Object.keys(errors).length === 1 ? '' : 's'} need
                    {Object.keys(errors).length === 1 ? 's' : ''} attention above.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* ── Phase 5: Inline booking-failure banner with Retry button ── */}
      {bookingFailure && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-amber-900">
                  Order {bookingFailure.orderNumber} created, but courier booking failed
                </p>
                <p className="text-xs text-amber-700 mt-1">
                  The order itself is saved and confirmed. You can retry booking now,
                  or fix the issue and book manually from the Booking Workbench.
                </p>
                <p className="text-xs text-amber-800 mt-1.5 font-mono bg-amber-100 rounded px-2 py-1">
                  {bookingFailure.error}
                </p>
                <div className="flex gap-2 mt-3">
                  <Button
                    size="sm"
                    onClick={handleRetryBooking}
                    disabled={retryingBooking || !courierIntegrationId}
                  >
                    {retryingBooking ? (
                      <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Retrying…</>
                    ) : (
                      <><RotateCcw className="h-3.5 w-3.5" /> Retry Booking</>
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigate({ name: 'order-detail', id: bookingFailure.orderId })}
                  >
                    View Order
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setBookingFailure(null)}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {formGuardModal}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: Customer (merged with Delivery & Discount)
// ─────────────────────────────────────────────────────────────────────────────

function CustomerSection({
  selectedCustomer,
  showCreateForm,
  onShowCreateForm,
  onCancelCreateForm,
  onSelectCustomer,
  onDeselectCustomer,
  onCustomerCreated,
  usedCustomerAddressId,
  usedCustomerPhoneId,
  setUsedCustomerPhoneId,
  recipientName,
  setRecipientName,
  addressSelectorValue,
  onAddressSelectorChange,
  courierProviderKey,
  courierName,
  setCourierName,
  courierIntegrationId,
  setCourierIntegrationId,
  courierIntegrations,
  pickupAddressId,
  setPickupAddressId,
  pickupAddresses,
  pickupAddressesLoading,
  dispatchLocationId,
  setDispatchLocationId,
  notesForCourier,
  setNotesForCourier,
  orderRefNumber,
  setOrderRefNumber,
  orderDetail,
  setOrderDetail,
  discountAmount,
  setDiscountAmount,
  discountReason,
  setDiscountReason,
  locations,
  isLoadingLocations,
  fieldError,
}: {
  selectedCustomer: SelectedCustomer | null
  showCreateForm: boolean
  onShowCreateForm: () => void
  onCancelCreateForm: () => void
  onSelectCustomer: (c: SelectedCustomer) => void
  onDeselectCustomer: () => void
  onCustomerCreated: (customerId: string) => void
  usedCustomerAddressId: string | null
  usedCustomerPhoneId: string | null
  setUsedCustomerPhoneId: (id: string | null) => void
  recipientName: string
  setRecipientName: (v: string) => void
  addressSelectorValue: AddressSelectorValue
  onAddressSelectorChange: (v: AddressSelectorValue) => void
  /** Optional: drives CityAutocomplete in AddressSelector (empty = plain text) */
  courierProviderKey?: string
  courierName: string
  setCourierName: (v: string) => void
  courierIntegrationId: string
  setCourierIntegrationId: (v: string) => void
  courierIntegrations: Array<{ id: string; connectionName: string; provider: { providerKey: string; providerName: string } }>
  pickupAddressId: string
  setPickupAddressId: (v: string) => void
  pickupAddresses: Array<{ id: string; label: string; address: string; cityName: string; isDefault: boolean }>
  pickupAddressesLoading: boolean
  dispatchLocationId: string
  setDispatchLocationId: (v: string) => void
  notesForCourier: string
  setNotesForCourier: (v: string) => void
  orderRefNumber: string
  setOrderRefNumber: (v: string) => void
  orderDetail: string
  setOrderDetail: (v: string) => void
  discountAmount: string
  setDiscountAmount: (v: string) => void
  discountReason: string
  setDiscountReason: (v: string) => void
  locations: InventoryLocation[]
  isLoadingLocations: boolean
  fieldError: (...paths: string[]) => string | undefined
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <User className="h-4 w-4" /> 1 · Customer
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ── SEARCH MODE (no customer selected) ──────────────────────────── */}
        {!selectedCustomer && !showCreateForm && (
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row gap-2">
              <CustomerSearchAutocomplete
                onSelect={onSelectCustomer}
                onCreateNew={onShowCreateForm}
                autoFocus
                className="flex-1"
              />
              <Button
                type="button"
                variant="default"
                onClick={onShowCreateForm}
                className="sm:shrink-0"
              >
                <Plus className="h-4 w-4" /> Create New Customer
              </Button>
            </div>
            <p className="text-xs text-muted-foreground text-center">
              Search by phone or name to find an existing customer, or click{' '}
              <span className="font-medium text-foreground">Create New Customer</span>{' '}
              to add a brand-new one.
            </p>
          </div>
        )}

        {/* ── INLINE CREATE MODE (no customer selected + showCreateForm) ──── */}
        {!selectedCustomer && showCreateForm && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium flex items-center gap-1.5">
                <Plus className="h-4 w-4 text-muted-foreground" /> New Customer
              </p>
              <Button
                size="sm"
                variant="ghost"
                onClick={onCancelCreateForm}
                className="h-7 text-xs"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Back to search
              </Button>
            </div>
            <CreateCustomerForm
              compact
              onCreated={onCustomerCreated}
              submitLabel="Create Customer"
            />
          </div>
        )}

        {/* ── SELECTED MODE (customer selected) ──────────────────────────── */}
        {selectedCustomer && (
          <div className="space-y-4">
            {/* Customer info card + CRM stats + address selector + phone + recipient */}
            <div className="rounded-lg border-2 border-primary/30 bg-primary/5 p-3 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2.5 min-w-0">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary shrink-0">
                    <User className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold truncate">{selectedCustomer.name}</p>
                      {selectedCustomer.isFlagged && (
                        <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200 text-[10px]">
                          Flagged
                        </Badge>
                      )}
                    </div>
                    {selectedCustomer.phones[0] && (
                      <p className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                        <Phone className="h-2.5 w-2.5" /> {selectedCustomer.phones[0].phoneRaw}
                      </p>
                    )}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={onDeselectCustomer}>
                  <RotateCcw className="h-3.5 w-3.5" /> Change
                </Button>
              </div>

              {/* Compact CRM stats (informational only) */}
              <CrmStatsWidget customer={selectedCustomer} />

              <Separator />

              {/* Phone selector + Recipient name */}
              <div className="grid sm:grid-cols-2 gap-3">
                {selectedCustomer.phones.length > 1 && (
                  <div className="space-y-1">
                    <Label className="text-xs flex items-center gap-1">
                      <Phone className="h-3 w-3" /> Contact Phone
                    </Label>
                    <Select
                      value={usedCustomerPhoneId ?? undefined}
                      onValueChange={(v) => setUsedCustomerPhoneId(v)}
                    >
                      <SelectTrigger className="text-sm">
                        <SelectValue placeholder="Select phone" />
                      </SelectTrigger>
                      <SelectContent>
                        {selectedCustomer.phones.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            <span className="font-mono">{p.phoneRaw}</span>
                            {p.isPrimary && (
                              <Badge variant="outline" className="ml-2 text-[10px] bg-primary/10 text-primary border-primary/20">
                                Primary
                              </Badge>
                            )}
                            {p.label && (
                              <span className="text-xs text-muted-foreground ml-1">· {p.label}</span>
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="space-y-1">
                  <Label className="text-xs flex items-center gap-1">
                    <User className="h-3 w-3" /> Recipient Name
                  </Label>
                  <Input
                    placeholder="Who is receiving this order?"
                    value={recipientName}
                    onChange={(e) => setRecipientName(e.target.value)}
                    className="text-sm"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Defaults to the customer name — edit if someone else is receiving.
                  </p>
                </div>
              </div>

              {/* ── Address selector (REPLACES the empty address/city inputs) ── */}
              <AddressSelector
                addresses={selectedCustomer.addresses}
                value={addressSelectorValue}
                onChange={onAddressSelectorChange}
                addressError={fieldError('delivery_address')}
                cityError={fieldError('delivery_city')}
                courierProviderKey={courierProviderKey}
              />
            </div>

            {/* ── Delivery Logistics (courier, dispatch, discount — NO address fields here) ── */}
            <div className="space-y-3">
              <p className="text-sm font-medium flex items-center gap-1.5">
                <Truck className="h-4 w-4 text-muted-foreground" /> Delivery Logistics
              </p>
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Courier</Label>
                  <Select
                    value={courierIntegrationId || '__none__'}
                    onValueChange={(v) => {
                      if (v === '__none__') {
                        setCourierIntegrationId('')
                        setCourierName('')
                        setPickupAddressId('')
                      } else {
                        setCourierIntegrationId(v)
                        setPickupAddressId('') // reset pickup address when courier changes
                        const ci = courierIntegrations.find((c) => c.id === v)
                        if (ci) setCourierName(ci.provider.providerName)
                      }
                    }}
                  >
                    <SelectTrigger><SelectValue placeholder="Select courier" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No courier</SelectItem>
                      {courierIntegrations.map((ci) => (
                        <SelectItem key={ci.id} value={ci.id}>
                          {ci.provider.providerName} — {ci.connectionName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {courierIntegrations.length === 0 && (
                    <p className="text-[10px] text-amber-700">
                      No couriers connected. Connect one in Settings → Integrations.
                    </p>
                  )}
                </div>
                {/* Pickup address override — only shown when a courier is selected.
                    Defaults to the integration's default address (marked with ★).
                    User can override to use a different address for this order. */}
                {courierIntegrationId && (
                  <div className="space-y-1">
                    <Label className="text-xs">Pickup / Return Address</Label>
                    {pickupAddressesLoading ? (
                      <Skeleton className="h-9" />
                    ) : pickupAddresses.length === 0 ? (
                      <p className="text-[10px] text-amber-700">
                        No pickup addresses synced. Go to Integrations → PostEx →
                        Sync to import addresses from the courier.
                      </p>
                    ) : (
                      <Select
                        value={pickupAddressId || '__default__'}
                        onValueChange={(v) => setPickupAddressId(v === '__default__' ? '' : v)}
                      >
                        <SelectTrigger><SelectValue placeholder="Default (from courier settings)" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__default__">
                            Default (use courier&apos;s default address)
                          </SelectItem>
                          {pickupAddresses.map((addr) => (
                            <SelectItem key={addr.id} value={addr.id}>
                              {addr.label} — {addr.cityName}
                              {addr.isDefault ? ' ★' : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      Overrides the pickup/return address for this order. Leave as
                      &quot;Default&quot; to use the courier&apos;s default address.
                    </p>
                  </div>
                )}
                <div className="space-y-1">
                  <Label className="text-xs">Dispatch Location *</Label>
                  {isLoadingLocations ? (
                    <Skeleton className="h-9" />
                  ) : (
                    <Select value={dispatchLocationId} onValueChange={setDispatchLocationId}>
                      <SelectTrigger><SelectValue placeholder="Select location" /></SelectTrigger>
                      <SelectContent>
                        {locations.map((l) => (
                          <SelectItem key={l.id} value={l.id}>
                            {l.name}{l.isDefault ? ' (default)' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {fieldError('dispatch_location_id') && (
                    <p className="text-xs text-destructive">{fieldError('dispatch_location_id')}</p>
                  )}
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs">Transaction Notes (for courier)</Label>
                  <Input
                    placeholder="Optional notes for the courier"
                    value={notesForCourier}
                    onChange={(e) => setNotesForCourier(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Order Reference (for courier)</Label>
                  <Input
                    placeholder="Defaults to ORD-YYYY-NNNNN — type to override"
                    value={orderRefNumber}
                    onChange={(e) => setOrderRefNumber(e.target.value)}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Universal courier reference field. Almost every courier
                    (PostEx, TCS, Leopard…) has a reference field — we map
                    this to the courier's own field at booking time. Leave
                    blank to use the auto-generated FlowOps order number.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Order Detail (item summary)</Label>
                  <Input
                    placeholder="Auto-filled from cart items"
                    value={orderDetail}
                    onChange={(e) => setOrderDetail(e.target.value)}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Auto-generated from selected products (title + SKU +
                    variant attributes + qty). Edit to override — otherwise
                    the canonical version is generated server-side at submit.
                  </p>
                </div>
              </div>

              {/* Discount (compact, within logistics section) */}
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Discount (Rs.)</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0"
                    value={discountAmount}
                    onChange={(e) => setDiscountAmount(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Discount reason</Label>
                  <Input
                    placeholder="Optional"
                    value={discountReason}
                    onChange={(e) => setDiscountReason(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CRM Stats widget — shows when a customer is selected
// ─────────────────────────────────────────────────────────────────────────────

function CrmStatsWidget({ customer }: { customer: SelectedCustomer }) {
  const totalOrders = customer.totalOrdersCount
  const totalRto = customer.totalRtoCount
  // Derive a delivery rate from the cached totals (returned orders / total).
  // This is informational — not the source of truth (the live query is).
  const deliveryRate =
    totalOrders > 0 ? ((totalOrders - totalRto) / totalOrders) * 100 : 100
  const rtoRate = totalOrders > 0 ? (totalRto / totalOrders) * 100 : 0
  const deliveredCount = Math.max(0, totalOrders - totalRto)

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatCell label="Total Orders" value={String(totalOrders)} />
        <StatCell
          label="Delivered"
          value={String(deliveredCount)}
          sub={`${deliveryRate.toFixed(1)}%`}
          tone="emerald"
        />
        <StatCell
          label="Returned"
          value={String(totalRto)}
          sub={`${rtoRate.toFixed(1)}%`}
          tone="rose"
        />
        <StatCell
          label="Delivery Rate"
          value={`${deliveryRate.toFixed(1)}%`}
          tone="emerald"
        />
      </div>

      {totalOrders > 0 && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <History className="h-3 w-3" />
          Returning customer — verify address before dispatch.
        </p>
      )}

      {/* Saved address history (from customer.addresses[] with lastUsedAt) */}
      {customer.addresses.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <MapPin className="h-3 w-3" /> Saved addresses
          </p>
          <ul className="space-y-1 max-h-32 overflow-y-auto pr-1 scrollbar-thin">
            {customer.addresses.slice(0, 5).map((a) => (
              <li
                key={a.id}
                className="text-xs flex items-center justify-between gap-2 rounded bg-background/60 px-2 py-1"
              >
                <span className="truncate">
                  {a.address || '—'} · {a.city}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  {a.isDefault && (
                    <Badge variant="outline" className="text-[10px] bg-primary/10 text-primary border-primary/20">
                      Default
                    </Badge>
                  )}
                  <Badge variant="outline" className="text-[10px]">
                    {formatLastUsedShort(a.lastUsedAt)}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Compact relative-time formatter for the inline address list. */
function formatLastUsedShort(iso: string | null): string {
  if (!iso) return 'Never used'
  const date = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / 86_400_000)
  if (diffDays < 1) return 'Today'
  if (diffDays === 1) return '1 day ago'
  if (diffDays < 30) return `${diffDays} days ago`
  return date.toLocaleDateString('en-PK', { day: '2-digit', month: 'short' })
}

const StatCell = memo(function StatCell({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string
  value: string
  sub?: string
  tone?: 'default' | 'emerald' | 'rose'
}) {
  const valueClass =
    tone === 'emerald'
      ? 'text-emerald-700'
      : tone === 'rose'
        ? 'text-rose-700'
        : ''
  return (
    <div className="rounded-md bg-background p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('text-lg font-semibold tabular-nums', valueClass)}>{value}</p>
      {sub && (
        <p className="text-[10px] text-muted-foreground tabular-nums">{sub}</p>
      )}
    </div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: Items
// ─────────────────────────────────────────────────────────────────────────────

function ItemsSection({
  cart,
  variantSearch,
  setVariantSearch,
  variantSearchResults,
  addVariant,
  removeItem,
  updateItem,
  isLoadingProducts,
  subtotal,
  itemsError,
}: {
  cart: CartItem[]
  variantSearch: string
  setVariantSearch: (v: string) => void
  variantSearchResults: VariantOption[]
  addVariant: (v: VariantOption) => void
  removeItem: (id: string) => void
  updateItem: (id: string, patch: Partial<CartItem>) => void
  isLoadingProducts: boolean
  subtotal: number
  itemsError: string | undefined
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Package className="h-4 w-4" /> 2 · Items
          {cart.length > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {cart.length} item{cart.length === 1 ? '' : 's'}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Variant search */}
        <div className="space-y-1.5">
          <Label htmlFor="variant-search">Search products / variants</Label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              id="variant-search"
              placeholder="Search by SKU or product title…"
              className="pl-9"
              value={variantSearch}
              onChange={(e) => setVariantSearch(e.target.value)}
              disabled={isLoadingProducts}
            />
            {isLoadingProducts && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </div>
        </div>

        {/* Search results as cards */}
        {variantSearch.trim() && (
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {isLoadingProducts ? (
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16" />)
            ) : variantSearchResults.length === 0 ? (
              <div className="rounded-md border-2 border-dashed p-6 text-center text-sm text-muted-foreground">
                No variants match &ldquo;{variantSearch}&rdquo;.
              </div>
            ) : (
              variantSearchResults.map((v) => {
                const badge = stockBadgeFor(v.fulfillmentType)
                return (
                  <button
                    key={v.variantId}
                    type="button"
                    onClick={() => addVariant(v)}
                    className="w-full text-left rounded-lg border p-3 hover:border-primary/40 hover:bg-muted/40 transition-colors flex items-center justify-between gap-3"
                  >
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <VariantThumbnail url={v.primaryImage} title={v.productTitle} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{v.productTitle}</p>
                        <p className="text-xs text-muted-foreground font-mono">{v.sku}</p>
                        <Badge variant="outline" className={cn('mt-1 text-[10px]', badge.className)}>
                          {badge.label}
                        </Badge>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-sm font-medium tabular-nums">
                        {v.salePrice ? formatPKR(v.salePrice) : formatPKR(v.costPrice)}
                      </span>
                      <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
                        <Plus className="h-4 w-4" />
                      </div>
                    </div>
                  </button>
                )
              })
            )}
          </div>
        )}

        {/* Cart list with thumbnail / qty / price / line-total / remove */}
        {cart.length === 0 ? (
          <div className="rounded-md border-2 border-dashed p-6 text-center">
            <ShoppingBag className="h-7 w-7 mx-auto text-muted-foreground/40 mb-2" />
            <p className="text-sm font-medium">Cart is empty</p>
            <p className="text-xs text-muted-foreground mt-1">
              Search for a product above to add variants.
            </p>
            {itemsError && <p className="text-xs text-destructive mt-2">{itemsError}</p>}
          </div>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
            {cart.map((item) => {
              const badge = stockBadgeFor(item.fulfillmentType)
              return (
                <div key={item.variantId} className="rounded-md border p-3 space-y-2">
                  <div className="flex items-start gap-3">
                    <VariantThumbnail url={item.primaryImage} title={item.productTitle} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{item.productTitle}</p>
                      <p className="text-xs text-muted-foreground font-mono">{item.sku}</p>
                      <Badge variant="outline" className={cn('mt-1 text-[10px]', badge.className)}>
                        {badge.label}
                      </Badge>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-rose-600 hover:bg-rose-50 shrink-0"
                      onClick={() => removeItem(item.variantId)}
                      aria-label={`Remove ${item.sku}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-[10px] text-muted-foreground">Qty</Label>
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        className="h-8 text-sm tabular-nums"
                        value={item.quantity}
                        onChange={(e) =>
                          updateItem(item.variantId, { quantity: parseQty(e.target.value) })
                        }
                      />
                    </div>
                    <div>
                      <Label className="text-[10px] text-muted-foreground">Unit Price</Label>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        className="h-8 text-sm tabular-nums"
                        value={item.unitPrice}
                        onChange={(e) =>
                          updateItem(item.variantId, {
                            unitPrice: parsePrice(e.target.value),
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Line total</span>
                    <span className="font-medium tabular-nums">
                      {formatPKR(item.quantity * item.unitPrice)}
                    </span>
                  </div>
                </div>
              )
            })}
            <Separator />
            <div className="flex items-center justify-between pt-1">
              <span className="text-sm font-medium">Subtotal</span>
              <span className="text-lg font-bold tabular-nums">{formatPKR(subtotal)}</span>
            </div>
            {itemsError && <p className="text-xs text-destructive">{itemsError}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

const VariantThumbnail = memo(function VariantThumbnail({ url, title }: { url: string | null; title: string }) {
  if (url) {
    return (
       
      <img
        src={url}
        alt={title}
        className="h-12 w-12 rounded-md border object-cover shrink-0"
      />
    )
  }
  return (
    <div className="h-12 w-12 rounded-md border bg-muted flex items-center justify-center shrink-0">
      <Package className="h-5 w-5 text-muted-foreground/50" />
    </div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: Payment
// ─────────────────────────────────────────────────────────────────────────────

function PaymentSection({
  paymentType,
  setPaymentType,
  advanceAmount,
  setAdvanceAmount,
  advancePaymentMethod,
  setAdvancePaymentMethod,
  advancePaymentReference,
  setAdvancePaymentReference,
  subtotal,
  total,
  discount,
  deliveryCharge,
  setDeliveryCharge,
  taxAmount,
  setTaxAmount,
  taxLabel,
  setTaxLabel,
  remainingCod,
  paymentProofFile,
  paymentProofPreview,
  proofError,
  onProofFile,
  onClearProof,
  fieldError,
}: {
  paymentType: PaymentType
  setPaymentType: (p: PaymentType) => void
  advanceAmount: string
  setAdvanceAmount: (v: string) => void
  advancePaymentMethod: string
  setAdvancePaymentMethod: (v: string) => void
  advancePaymentReference: string
  setAdvancePaymentReference: (v: string) => void
  subtotal: number
  total: number
  discount: number
  deliveryCharge: string
  setDeliveryCharge: (v: string) => void
  taxAmount: string
  setTaxAmount: (v: string) => void
  taxLabel: string
  setTaxLabel: (v: string) => void
  remainingCod: number
  paymentProofFile: File | null
  paymentProofPreview: string
  proofError: string | null
  onProofFile: (file: File) => void
  onClearProof: () => void
  fieldError: (...paths: string[]) => string | undefined
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <CreditCard className="h-4 w-4" /> 3 · Payment
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Selectable payment type cards */}
        <div className="grid gap-3">
          <PaymentTypeCard
            active={paymentType === 'full_cod'}
            onClick={() => setPaymentType('full_cod')}
            title="Full COD"
            description="Customer pays the full amount in cash on delivery."
            badge="Cash on Delivery"
            tone="amber"
          />
          <PaymentTypeCard
            active={paymentType === 'partial_advance'}
            onClick={() => setPaymentType('partial_advance')}
            title="Partial Advance"
            description="Customer pays a portion upfront; the rest is collected on delivery."
            badge="Advance + COD"
            tone="sky"
          />
          <PaymentTypeCard
            active={paymentType === 'fully_prepaid'}
            onClick={() => setPaymentType('fully_prepaid')}
            title="Fully Prepaid"
            description="Customer has paid the full amount before dispatch."
            badge="Prepaid"
            tone="emerald"
          />
        </div>

        {/* Expanded fields for advance / prepaid */}
        {paymentType !== 'full_cod' && (
          <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="advance-amount">
                  {paymentType === 'fully_prepaid'
                    ? 'Total paid (auto-calculated)'
                    : 'Advance amount *'}
                </Label>
                <Input
                  id="advance-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder={paymentType === 'fully_prepaid' ? formatPKR(total) : 'e.g. 500'}
                  value={paymentType === 'fully_prepaid' ? String(total) : advanceAmount}
                  onChange={(e) => setAdvanceAmount(e.target.value)}
                  disabled={paymentType === 'fully_prepaid'}
                  aria-invalid={!!fieldError('advance_amount')}
                />
                {fieldError('advance_amount') && (
                  <p className="text-xs text-destructive">{fieldError('advance_amount')}</p>
                )}
                {paymentType === 'partial_advance' && (
                  <p className="text-xs text-muted-foreground">
                    Remaining COD:{' '}
                    <span className="font-medium tabular-nums">{formatPKR(remainingCod)}</span>
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="advance-method">Payment method</Label>
                <Select value={advancePaymentMethod} onValueChange={setAdvancePaymentMethod}>
                  <SelectTrigger id="advance-method">
                    <SelectValue placeholder="Select method" />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_METHODS.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="advance-ref">Reference (transaction ID, etc.)</Label>
                <Input
                  id="advance-ref"
                  placeholder="Optional"
                  value={advancePaymentReference}
                  onChange={(e) => setAdvancePaymentReference(e.target.value)}
                />
              </div>
            </div>

            <ProofFileInput
              file={paymentProofFile}
              preview={paymentProofPreview}
              error={proofError}
              inputRef={fileInputRef}
              onFile={onProofFile}
              onClear={onClearProof}
            />

            <p className="text-xs text-muted-foreground">
              The proof image is attached after the order is created — you can also add it later
              from the order detail page.
            </p>
          </div>
        )}

        {/* Delivery charge + tax (optional) */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="delivery-charge" className="text-xs">
              Delivery Charge (Rs.) — Optional
            </Label>
            <Input
              id="delivery-charge"
              type="number"
              min="0"
              step="0.01"
              placeholder="0"
              value={deliveryCharge}
              onChange={(e) => setDeliveryCharge(e.target.value)}
              className="h-9 text-sm tabular-nums"
            />
            <p className="text-[10px] text-muted-foreground">
              Estimated courier delivery charge. Actual charge is confirmed after settlement.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tax-amount" className="text-xs">
              Tax Amount (Rs.) — Optional
            </Label>
            <Input
              id="tax-amount"
              type="number"
              min="0"
              step="0.01"
              placeholder="0"
              value={taxAmount}
              onChange={(e) => setTaxAmount(e.target.value)}
              className="h-9 text-sm tabular-nums"
            />
            <Input
              type="text"
              placeholder="Tax label (e.g. GST 17%)"
              value={taxLabel}
              onChange={(e) => setTaxLabel(e.target.value)}
              className="h-8 text-xs mt-1"
            />
          </div>
        </div>

        {/* Live total summary */}
        <div className="rounded-md bg-muted/40 p-3 space-y-1 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span className="tabular-nums">{formatPKR(subtotal)}</span>
          </div>
          {deliveryCharge && Number(deliveryCharge) > 0 && (
            <div className="flex items-center justify-between text-sky-700">
              <span>Delivery Charge</span>
              <span className="tabular-nums">+{formatPKR(Number(deliveryCharge))}</span>
            </div>
          )}
          {taxAmount && Number(taxAmount) > 0 && (
            <div className="flex items-center justify-between text-sky-700">
              <span>{taxLabel || 'Tax'}</span>
              <span className="tabular-nums">+{formatPKR(Number(taxAmount))}</span>
            </div>
          )}
          {discount > 0 && (
            <div className="flex items-center justify-between text-rose-600">
              <span>Discount</span>
              <span className="tabular-nums">−{formatPKR(discount)}</span>
            </div>
          )}
          <div className="flex items-center justify-between font-medium pt-1 border-t">
            <span>Total</span>
            <span className="tabular-nums">{formatPKR(total)}</span>
          </div>
          {paymentType !== 'full_cod' && (
            <div className="flex items-center justify-between pt-1 text-amber-700">
              <span className="text-xs">Remaining COD to collect</span>
              <span className="text-xs font-medium tabular-nums">{formatPKR(remainingCod)}</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

const PaymentTypeCard = memo(function PaymentTypeCard({
  active,
  onClick,
  title,
  description,
  badge,
  tone,
}: {
  active: boolean
  onClick: () => void
  title: string
  description: string
  badge: string
  tone: 'amber' | 'sky' | 'emerald'
}) {
  const toneClasses = {
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    sky: 'bg-sky-50 text-sky-700 border-sky-200',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  } as const

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-start gap-3 rounded-lg border p-4 text-left transition-all',
        active
          ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
          : 'border-border hover:bg-muted/40',
      )}
    >
      <div
        className={cn(
          'flex h-5 w-5 items-center justify-center rounded-full border-2 mt-0.5 shrink-0',
          active ? 'border-primary bg-primary' : 'border-muted-foreground/40',
        )}
      >
        {active && <Check className="h-3 w-3 text-primary-foreground" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium">{title}</p>
          <Badge variant="outline" className={cn('text-[10px]', toneClasses[tone])}>
            {badge}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
    </button>
  )
})

/**
 * ProofFileInput
 *
 * Holds the picked File in browser memory ONLY (no upload). The parent
 * component owns the file state and uploads it via /api/upload after
 * createManualOrder() returns the new order_id.
 *
 * Client-side validation mirrors the server (/api/upload): image/jpeg |
 * image/png | image/webp, max 5 MB.
 */
function ProofFileInput({
  file,
  preview,
  error,
  inputRef,
  onFile,
  onClear,
}: {
  file: File | null
  preview: string
  error: string | null
  inputRef: React.RefObject<HTMLInputElement | null>
  onFile: (file: File) => void
  onClear: () => void
}) {
  return (
    <div className="space-y-1.5">
      <Label>Payment proof (optional)</Label>
      <div className="flex items-center gap-3">
        {preview ? (
          <div className="relative group">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="block rounded-md border overflow-hidden"
            >
              { }
              <img
                src={preview}
                alt="Payment proof preview"
                className="h-20 w-20 object-cover"
              />
            </button>
            <button
              type="button"
              onClick={onClear}
              className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow-sm hover:scale-110 transition-transform"
              aria-label="Remove payment proof"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className={cn(
              'flex h-20 w-20 items-center justify-center rounded-md border-2 border-dashed text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors',
            )}
          >
            <Upload className="h-5 w-5" />
          </button>
        )}
        <div className="text-xs text-muted-foreground flex-1">
          {file ? (
            <div className="space-y-0.5">
              <p className="font-medium text-foreground flex items-center gap-1.5">
                <FileImage className="h-3.5 w-3.5" />
                {file.name}
              </p>
              <p>{(file.size / 1024 / 1024).toFixed(2)} MB · {file.type}</p>
              <p className="text-primary">Will upload after order is created.</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              <p>Click to pick a payment proof image.</p>
              <p>JPG, PNG, WebP — max 5 MB</p>
            </div>
          )}
          {error && <p className="text-destructive mt-1">{error}</p>}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onFile(f)
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: Order Summary (sticky sidebar)
// ─────────────────────────────────────────────────────────────────────────────

function SummarySection({
  cart,
  subtotal,
  discount,
  discountReason,
  total,
  paymentType,
  advanceAmount,
  remainingCod,
}: {
  cart: CartItem[]
  subtotal: number
  discount: number
  discountReason: string
  total: number
  paymentType: PaymentType
  advanceAmount: number
  remainingCod: number
}) {
  const paymentLabel =
    paymentType === 'full_cod'
      ? 'Full COD'
      : paymentType === 'partial_advance'
        ? 'Partial Advance'
        : 'Fully Prepaid'

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <PackageCheck className="h-4 w-4" /> Order Summary
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Item count */}
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Items</span>
          <span className="font-medium tabular-nums">
            {cart.reduce((n, i) => n + i.quantity, 0)} ({cart.length} SKU
            {cart.length === 1 ? '' : 's'})
          </span>
        </div>

        <Separator />

        {/* Totals */}
        <div className="space-y-1 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span className="tabular-nums">{formatPKR(subtotal)}</span>
          </div>
          {discount > 0 && (
            <div className="flex items-center justify-between text-rose-600">
              <span>Discount{discountReason ? ` (${discountReason})` : ''}</span>
              <span className="tabular-nums">−{formatPKR(discount)}</span>
            </div>
          )}
        </div>

        <Separator />

        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Total</span>
          <span className="text-xl font-bold tabular-nums">{formatPKR(total)}</span>
        </div>

        {/* Payment summary */}
        <div className="rounded-md bg-muted/40 p-3 space-y-1 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Payment type</span>
            <span className="font-medium">{paymentLabel}</span>
          </div>
          {paymentType !== 'full_cod' && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Advance paid</span>
                <span className="font-medium tabular-nums">
                  {formatPKR(paymentType === 'fully_prepaid' ? total : advanceAmount)}
                </span>
              </div>
              <div className="flex items-center justify-between text-amber-700">
                <span>Remaining COD</span>
                <span className="font-medium tabular-nums">{formatPKR(remainingCod)}</span>
              </div>
            </>
          )}
        </div>

        <Alert>
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>Ready to submit</AlertTitle>
          <AlertDescription className="text-xs">
            Review all sections above, then click <strong>Create Order</strong>. You will be
            taken to the new order&apos;s detail page.
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  )
}
