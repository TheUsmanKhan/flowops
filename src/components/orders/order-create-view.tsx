'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, FetchError } from '@/lib/api-client'
import { useAppStore, useCan } from '@/stores/app-store'
import { PERMISSIONS } from '@/lib/permissions'
import { PageHeader } from '@/components/layout/dashboard-shell'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
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
  Edit3,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { createManualOrderSchema } from '@/lib/validations/order.schemas'

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

interface CustomerRow {
  id: string
  name: string
  phone: string
  email: string | null
  totalOrdersCount: number
  totalRtoCount: number
  isFlagged: boolean
}

interface CustomersSearchResponse {
  customers: CustomerRow[]
  total: number
}

interface CustomerAddress {
  type?: 'shipping' | 'billing'
  label?: string
  address: string
  city: string
  province?: string
  is_default?: boolean
}

interface CustomerDetailResponse {
  customer: {
    id: string
    name: string
    phone: string
    alternatePhone: string | null
    email: string | null
    addresses: CustomerAddress[]
    totalOrdersCount: number
    totalOrderValue: number
    totalRtoCount: number
    isFlagged: boolean
    flaggedReason: string | null
  }
  recentOrders: Array<{
    id: string
    flowopsOrderNumber: string
    status: string
    totalOrderValue: number
    createdAt: string
  }>
}

interface VariantOption {
  variantId: string
  sku: string
  productTitle: string
  costPrice: number
  salePrice: number | null
  fulfillmentType: string
  primaryImage: string | null
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

/** Pick the shipping address from a customer's saved addresses array.
 *  Honors the legacy fallback: untyped addresses are treated as shipping. */
function pickShippingAddress(addresses: CustomerAddress[] | undefined): CustomerAddress | null {
  if (!addresses || addresses.length === 0) return null
  return (
    addresses.find((a) => a.type === 'shipping') ??
    addresses.find((a) => !a.type) ??
    addresses[0]
  )
}

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

export function OrderCreateView({ onBack }: { onBack: () => void }) {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const queryClient = useQueryClient()
  const canCreate = can(PERMISSIONS.ORDERS_CREATE)

  // ── Form state ────────────────────────────────────────────────────────────
  // Customer
  const [customerMode, setCustomerMode] = useState<'existing' | 'new'>('existing')
  const [phoneSearch, setPhoneSearch] = useState('')
  const [debouncedPhone, setDebouncedPhone] = useState('')
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerRow | null>(null)

  // New customer fields (with separate shipping + billing)
  const [newCustomer, setNewCustomer] = useState({
    name: '',
    phone: '',
    alternate_phone: '',
    email: '',
    shipping_address: '',
    shipping_city: '',
    shipping_province: '',
    billing_address: '',
    billing_city: '',
    billing_province: '',
  })
  // When true: billing fields are hidden and shipping values are mirrored.
  // CHECKED BY DEFAULT per spec.
  const [billingSameAsShipping, setBillingSameAsShipping] = useState(true)

  // Items
  const [cart, setCart] = useState<CartItem[]>([])
  const [variantSearch, setVariantSearch] = useState('')

  // Payment
  const [paymentType, setPaymentType] = useState<PaymentType>('full_cod')
  const [advanceAmount, setAdvanceAmount] = useState('')
  const [advancePaymentMethod, setAdvancePaymentMethod] = useState('')
  const [advancePaymentReference, setAdvancePaymentReference] = useState('')
  // NEW (Issue 2): the payment proof is held in browser memory as a raw File
  // during the order creation flow. NO upload happens until the order_id exists.
  const [paymentProofFile, setPaymentProofFile] = useState<File | null>(null)
  const [paymentProofPreview, setPaymentProofPreview] = useState<string>('')
  const [proofError, setProofError] = useState<string | null>(null)

  // Delivery
  // When an existing customer is selected, the delivery address is auto-filled
  // from their saved shipping address. Toggling this false lets the user
  // override it.
  const [useCustomerAddress, setUseCustomerAddress] = useState(true)
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [deliveryCity, setDeliveryCity] = useState('')
  const [deliveryProvince, setDeliveryProvince] = useState('')
  const [courierName, setCourierName] = useState('')
  const [dispatchLocationId, setDispatchLocationId] = useState('')
  const [notesForCourier, setNotesForCourier] = useState('')
  const [discountAmount, setDiscountAmount] = useState('')
  const [discountReason, setDiscountReason] = useState('')

  // Validation errors — keyed by Zod issue path (joined with '.')
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Section refs for scrolling to the first error on submit
  const customerSectionRef = useRef<HTMLDivElement | null>(null)
  const itemsSectionRef = useRef<HTMLDivElement | null>(null)
  const paymentSectionRef = useRef<HTMLDivElement | null>(null)
  const deliverySectionRef = useRef<HTMLDivElement | null>(null)

  // Track in-flight post-creation upload so we can render a "Saving proof…"
  // state on the submit button.
  const [uploadingProof, setUploadingProof] = useState(false)

  // ── Debounce phone search ────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setDebouncedPhone(phoneSearch.trim()), 350)
    return () => clearTimeout(t)
  }, [phoneSearch])

  // ── Data queries ──────────────────────────────────────────────────────────
  const locationsQuery = useQuery<LocationsResponse>({
    queryKey: ['locations'],
    queryFn: () => api.get<LocationsResponse>('/api/inventory-locations'),
    staleTime: 30_000,
  })

  const productsQuery = useQuery<ProductsResponse>({
    queryKey: ['products', 'for-order-create'],
    queryFn: () => api.get<ProductsResponse>('/api/products?pageSize=100'),
    staleTime: 60_000,
  })

  const trimmedPhone = debouncedPhone
  const customersQuery = useQuery<CustomersSearchResponse>({
    queryKey: ['customers', 'search', trimmedPhone],
    queryFn: () =>
      api.get<CustomersSearchResponse>(
        `/api/customers?search=${encodeURIComponent(trimmedPhone)}&limit=10`,
      ),
    enabled: trimmedPhone.length >= 4,
    staleTime: 10_000,
  })

  // Fetch the selected customer's full detail (including saved addresses)
  // so we can auto-fill the delivery section from their shipping address.
  const customerDetailQuery = useQuery<CustomerDetailResponse>({
    queryKey: ['customer', 'detail', selectedCustomer?.id],
    queryFn: () =>
      api.get<CustomerDetailResponse>(`/api/customers/${selectedCustomer!.id}`),
    enabled: !!selectedCustomer,
    staleTime: 30_000,
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
        })
      }
    }
    return list
  }, [productsQuery.data])

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
  const total = Math.max(0, subtotal - discount)

  const remainingCod =
    paymentType === 'fully_prepaid'
      ? 0
      : paymentType === 'partial_advance'
        ? Math.max(0, total - parsePrice(advanceAmount))
        : total

  // ── Auto-fill delivery fields when an existing customer's shipping
  // address is available (or when toggling "Use different address"). ─────────
  useEffect(() => {
    if (customerMode !== 'existing' || !selectedCustomer) return
    if (!useCustomerAddress) return // user is overriding — don't clobber their input

    const addrs = customerDetailQuery.data?.customer.addresses
    const shipping = pickShippingAddress(addrs)
    if (shipping) {
      setDeliveryAddress(shipping.address)
      setDeliveryCity(shipping.city)
      setDeliveryProvince(shipping.province ?? '')
    }
  }, [customerMode, selectedCustomer, useCustomerAddress, customerDetailQuery.data])

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
  }

  const removeItem = (variantId: string) => {
    setCart((prev) => prev.filter((i) => i.variantId !== variantId))
  }

  const updateItem = (variantId: string, patch: Partial<CartItem>) => {
    setCart((prev) =>
      prev.map((i) => (i.variantId === variantId ? { ...i, ...patch } : i)),
    )
  }

  // ── Payment proof file handling ───────────────────────────────────────────
  // Issue 2: validate the picked file but DO NOT upload yet — store it
  // locally. The actual upload happens after createManualOrder() returns.
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
    // Revoke any previous preview URL to avoid leaking blob URLs.
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

  // ── Build the new customer addresses array (shipping + billing) ───────────
  function buildNewCustomerAddresses() {
    const shipAddr = newCustomer.shipping_address.trim()
    const shipCity = newCustomer.shipping_city.trim()
    const shipProvince = newCustomer.shipping_province.trim()

    const shippingEntry = {
      type: 'shipping' as const,
      label: 'Shipping',
      address: shipAddr,
      city: shipCity,
      province: shipProvince || undefined,
      is_default: true,
    }

    // When "same as shipping" is checked, mirror shipping values for billing.
    const billAddr = billingSameAsShipping ? shipAddr : newCustomer.billing_address.trim()
    const billCity = billingSameAsShipping ? shipCity : newCustomer.billing_city.trim()
    const billProvince = billingSameAsShipping
      ? shipProvince
      : newCustomer.billing_province.trim()

    const billingEntry = {
      type: 'billing' as const,
      label: 'Billing',
      address: billAddr,
      city: billCity,
      province: billProvince || undefined,
      is_default: false,
    }

    return [shippingEntry, billingEntry]
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
      dispatch_location_id: dispatchLocationId,
      notes_for_courier: notesForCourier.trim() || undefined,
      discount_amount: discount > 0 ? discount : undefined,
      discount_reason: discountReason.trim() || undefined,
    }

    if (paymentType === 'partial_advance' || paymentType === 'fully_prepaid') {
      payload.advance_amount =
        paymentType === 'fully_prepaid' ? total : parsePrice(advanceAmount)
      payload.advance_payment_method = advancePaymentMethod || undefined
      payload.advance_payment_reference = advancePaymentReference.trim() || undefined
      // NOTE: payment proof screenshot URL is intentionally NOT set here.
      // The file is uploaded and persisted AFTER the order is created
      // (see handleSubmit). This is the Issue 2 fix.
    }

    if (customerMode === 'existing' && selectedCustomer) {
      payload.customer_id = selectedCustomer.id
    } else {
      payload.customer = {
        name: newCustomer.name.trim(),
        phone: newCustomer.phone.trim(),
        alternate_phone: newCustomer.alternate_phone.trim() || undefined,
        email: newCustomer.email.trim() || undefined,
        addresses: buildNewCustomerAddresses(),
      }
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
    if (!paymentProofFile) return true // nothing to upload — trivially "success"

    setUploadingProof(true)
    try {
      // Step 1: upload the raw file via /api/upload
      const fd = new FormData()
      fd.append('file', paymentProofFile)
      const uploadRes = await fetch(
        `/api/upload?type=payment-proofs&id=${orderId}`,
        { method: 'POST', body: fd },
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

      // Step 2: persist the URL on the order via the dedicated endpoint
      // (NOT convert-payment — the order already has its payment type set).
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
      // Scroll to the first section that has an error
      const firstErrPath = Object.keys(errs)[0]
      const section = sectionForErrorPath(firstErrPath)
      const ref =
        section === 'customer'
          ? customerSectionRef.current
          : section === 'items'
            ? itemsSectionRef.current
            : section === 'payment'
              ? paymentSectionRef.current
              : deliverySectionRef.current
      ref?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }

    const payload = buildPayload()

    try {
      // Step 1: create the order (no payment proof upload yet — order_id
      // does not exist until this returns).
      const data = await api.post<CreateOrderResponse>('/api/orders', payload)
      toast.success(`Order ${data.flowopsOrderNumber} created successfully.`)
      void queryClient.invalidateQueries({ queryKey: ['orders'] })

      // Step 2: IF a payment proof file is pending, upload + persist it now.
      // If this fails, the order is still created — we surface a dedicated
      // warning (NOT a combined error). User can add the proof later from
      // the order detail page.
      if (paymentProofFile) {
        const ok = await uploadPaymentProof(data.orderId)
        if (!ok) {
          toast.warning(
            'Order created successfully, but the payment proof image failed to upload — you can add it from the order detail page.',
          )
        }
      }

      navigate({ name: 'order-detail', id: data.orderId })
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  // Helper: which section does an error path belong to?
  function sectionForErrorPath(path: string): 'customer' | 'items' | 'payment' | 'delivery' {
    if (path.startsWith('customer') || path === 'customer' || path === 'customer_id') return 'customer'
    if (path.startsWith('items')) return 'items'
    if (path.startsWith('payment') || path.startsWith('advance')) return 'payment'
    return 'delivery'
  }

  // Convenience error getter
  const fieldError = (...paths: string[]) => {
    for (const p of paths) if (errors[p]) return errors[p]
    return undefined
  }

  const isSubmitting = uploadingProof
  // For new customer, mirror billing values when "same as shipping" is checked
  const effectiveBillingAddress = billingSameAsShipping ? newCustomer.shipping_address : newCustomer.billing_address
  const effectiveBillingCity = billingSameAsShipping ? newCustomer.shipping_city : newCustomer.billing_city
  const effectiveBillingProvince = billingSameAsShipping ? newCustomer.shipping_province : newCustomer.billing_province

  return (
    <div className="space-y-6">
      <PageHeader
        title="Create Order"
        description="Fill in customer, items, payment, and delivery — then submit"
        actions={
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" /> Back to Orders
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ── Left column: form sections (stacked, scrollable) ─────────────── */}
        <div className="lg:col-span-2 space-y-6">
          {/* SECTION 1: Customer */}
          <div ref={customerSectionRef}>
            <CustomerSection
              customerMode={customerMode}
              setCustomerMode={(m) => {
                setCustomerMode(m)
                setSelectedCustomer(null)
              }}
              phoneSearch={phoneSearch}
              setPhoneSearch={(v) => {
                setPhoneSearch(v)
                setSelectedCustomer(null)
              }}
              isSearching={customersQuery.isFetching && trimmedPhone.length >= 4}
              selectedCustomer={selectedCustomer}
              setSelectedCustomer={setSelectedCustomer}
              customers={customersQuery.data?.customers ?? []}
              hasSearched={trimmedPhone.length >= 4}
              customerDetail={customerDetailQuery.data}
              newCustomer={newCustomer}
              setNewCustomer={setNewCustomer}
              billingSameAsShipping={billingSameAsShipping}
              setBillingSameAsShipping={(checked) => {
                // When unchecking, copy current shipping values into the
                // billing fields so the user has a starting point.
                if (!checked) {
                  setNewCustomer((p) => ({
                    ...p,
                    billing_address: p.shipping_address,
                    billing_city: p.shipping_city,
                    billing_province: p.shipping_province,
                  }))
                }
                setBillingSameAsShipping(checked)
              }}
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
              remainingCod={remainingCod}
              // Issue 2: payment proof is stored as a raw File locally
              paymentProofFile={paymentProofFile}
              paymentProofPreview={paymentProofPreview}
              proofError={proofError}
              onProofFile={handleProofFile}
              onClearProof={clearProofFile}
              fieldError={fieldError}
            />
          </div>

          {/* SECTION 4: Delivery & Discount */}
          <div ref={deliverySectionRef}>
            <DeliverySection
              customerMode={customerMode}
              selectedCustomer={selectedCustomer}
              customerShippingAddress={
                pickShippingAddress(customerDetailQuery.data?.customer.addresses)
              }
              useCustomerAddress={useCustomerAddress}
              setUseCustomerAddress={(v) => {
                setUseCustomerAddress(v)
                // When turning back ON, re-pull the saved shipping address.
                if (v && customerDetailQuery.data?.customer.addresses) {
                  const s = pickShippingAddress(customerDetailQuery.data.customer.addresses)
                  if (s) {
                    setDeliveryAddress(s.address)
                    setDeliveryCity(s.city)
                    setDeliveryProvince(s.province ?? '')
                  }
                }
              }}
              deliveryAddress={deliveryAddress}
              setDeliveryAddress={setDeliveryAddress}
              deliveryCity={deliveryCity}
              setDeliveryCity={setDeliveryCity}
              deliveryProvince={deliveryProvince}
              setDeliveryProvince={setDeliveryProvince}
              courierName={courierName}
              setCourierName={setCourierName}
              dispatchLocationId={dispatchLocationId}
              setDispatchLocationId={setDispatchLocationId}
              notesForCourier={notesForCourier}
              setNotesForCourier={setNotesForCourier}
              discountAmount={discountAmount}
              setDiscountAmount={setDiscountAmount}
              discountReason={discountReason}
              setDiscountReason={setDiscountReason}
              locations={locationsQuery.data?.locations ?? []}
              isLoadingLocations={locationsQuery.isLoading}
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
                  onClick={onBack}
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

      {/* Hidden values to satisfy "effective" reads without dead-code warnings */}
      <span className="hidden" aria-hidden>
        {effectiveBillingAddress}
        {effectiveBillingCity}
        {effectiveBillingProvince}
      </span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: Customer
// ─────────────────────────────────────────────────────────────────────────────

function CustomerSection({
  customerMode,
  setCustomerMode,
  phoneSearch,
  setPhoneSearch,
  isSearching,
  selectedCustomer,
  setSelectedCustomer,
  customers,
  hasSearched,
  customerDetail,
  newCustomer,
  setNewCustomer,
  billingSameAsShipping,
  setBillingSameAsShipping,
  fieldError,
}: {
  customerMode: 'existing' | 'new'
  setCustomerMode: (m: 'existing' | 'new') => void
  phoneSearch: string
  setPhoneSearch: (v: string) => void
  isSearching: boolean
  selectedCustomer: CustomerRow | null
  setSelectedCustomer: (c: CustomerRow | null) => void
  customers: CustomerRow[]
  hasSearched: boolean
  customerDetail: CustomerDetailResponse | undefined
  newCustomer: {
    name: string
    phone: string
    alternate_phone: string
    email: string
    shipping_address: string
    shipping_city: string
    shipping_province: string
    billing_address: string
    billing_city: string
    billing_province: string
  }
  setNewCustomer: React.Dispatch<
    React.SetStateAction<{
      name: string
      phone: string
      alternate_phone: string
      email: string
      shipping_address: string
      shipping_city: string
      shipping_province: string
      billing_address: string
      billing_city: string
      billing_province: string
    }>
  >
  billingSameAsShipping: boolean
  setBillingSameAsShipping: (checked: boolean) => void
  fieldError: (...paths: string[]) => string | undefined
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <User className="h-4 w-4" /> 1 · Customer
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Mode toggle cards */}
        <div className="grid sm:grid-cols-2 gap-3">
          <ModeCard
            active={customerMode === 'existing'}
            onClick={() => setCustomerMode('existing')}
            title="Existing Customer"
            description="Search by phone, name, or email"
            icon={<Search className="h-4 w-4" />}
          />
          <ModeCard
            active={customerMode === 'new'}
            onClick={() => setCustomerMode('new')}
            title="Add New Customer"
            description="Create a new customer record"
            icon={<Plus className="h-4 w-4" />}
          />
        </div>

        {customerMode === 'existing' ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="phone-search">
                <span className="flex items-center gap-1.5">
                  <Phone className="h-3.5 w-3.5" /> Search by phone, name, or email
                </span>
              </Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="phone-search"
                  placeholder="e.g. 03001234567 or Ayesha"
                  className="pl-9"
                  value={phoneSearch}
                  onChange={(e) => setPhoneSearch(e.target.value)}
                />
                {isSearching && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Type at least 4 characters to search. Search is debounced.
              </p>
            </div>

            {/* Search results */}
            {hasSearched && !selectedCustomer && (
              <div className="rounded-md border bg-popover shadow-sm max-h-72 overflow-y-auto">
                {customers.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground text-center">
                    {isSearching ? (
                      <span className="flex items-center justify-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" /> Searching…
                      </span>
                    ) : (
                      <>
                        No matching customers.{' '}
                        <button
                          type="button"
                          className="text-primary underline underline-offset-2"
                          onClick={() => setCustomerMode('new')}
                        >
                          Add a new customer
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <ul className="divide-y">
                    {customers.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedCustomer(c)}
                          className="w-full text-left px-3 py-2.5 hover:bg-muted/60 transition-colors flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{c.name}</p>
                            <p className="text-xs text-muted-foreground font-mono">{c.phone}</p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {c.isFlagged && (
                              <Badge
                                variant="outline"
                                className="bg-rose-50 text-rose-700 border-rose-200 text-[10px]"
                              >
                                Flagged
                              </Badge>
                            )}
                            <span className="text-xs text-muted-foreground">
                              {c.totalOrdersCount} order{c.totalOrdersCount === 1 ? '' : 's'}
                            </span>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Selected customer card with history summary */}
            {selectedCustomer && (
              <div className="rounded-lg border-2 border-primary/40 bg-primary/5 p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary shrink-0">
                      <User className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold truncate">{selectedCustomer.name}</p>
                        {selectedCustomer.isFlagged && (
                          <Badge
                            variant="outline"
                            className="bg-rose-50 text-rose-700 border-rose-200 text-[10px]"
                          >
                            Flagged
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground font-mono">
                        {selectedCustomer.phone}
                      </p>
                      {selectedCustomer.email && (
                        <p className="text-xs text-muted-foreground">{selectedCustomer.email}</p>
                      )}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setSelectedCustomer(null)}>
                    Change
                  </Button>
                </div>
                <Separator />
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-md bg-background p-2.5">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Previous Orders
                    </p>
                    <p className="text-lg font-semibold">
                      {customerDetail?.customer.totalOrdersCount ?? selectedCustomer.totalOrdersCount}
                    </p>
                  </div>
                  <div className="rounded-md bg-background p-2.5">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Total RTOs
                    </p>
                    <p
                      className={cn(
                        'text-lg font-semibold',
                        selectedCustomer.totalRtoCount > 0 ? 'text-rose-600' : '',
                      )}
                    >
                      {selectedCustomer.totalRtoCount}
                    </p>
                  </div>
                </div>
                {selectedCustomer.totalOrdersCount > 0 && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <History className="h-3 w-3" />
                    Returning customer — verify address before dispatch.
                  </p>
                )}
                {fieldError('customer', 'customer_id') && (
                  <p className="text-xs text-destructive">{fieldError('customer', 'customer_id')}</p>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-5">
            {/* Basic contact info */}
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="nc-name">Full name *</Label>
                <Input
                  id="nc-name"
                  placeholder="e.g. Ayesha Khan"
                  value={newCustomer.name}
                  onChange={(e) => setNewCustomer((p) => ({ ...p, name: e.target.value }))}
                  aria-invalid={!!fieldError('customer.name')}
                />
                {fieldError('customer.name') && (
                  <p className="text-xs text-destructive">{fieldError('customer.name')}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nc-phone">Phone *</Label>
                <Input
                  id="nc-phone"
                  placeholder="e.g. 03001234567"
                  value={newCustomer.phone}
                  onChange={(e) => setNewCustomer((p) => ({ ...p, phone: e.target.value }))}
                  aria-invalid={!!fieldError('customer.phone')}
                />
                {fieldError('customer.phone') && (
                  <p className="text-xs text-destructive">{fieldError('customer.phone')}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nc-alt">Alternate phone</Label>
                <Input
                  id="nc-alt"
                  placeholder="Optional"
                  value={newCustomer.alternate_phone}
                  onChange={(e) =>
                    setNewCustomer((p) => ({ ...p, alternate_phone: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nc-email">Email</Label>
                <Input
                  id="nc-email"
                  type="email"
                  placeholder="Optional"
                  value={newCustomer.email}
                  onChange={(e) => setNewCustomer((p) => ({ ...p, email: e.target.value }))}
                />
                {fieldError('customer.email') && (
                  <p className="text-xs text-destructive">{fieldError('customer.email')}</p>
                )}
              </div>
            </div>

            <Separator />

            {/* Shipping Address (required) */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Truck className="h-4 w-4 text-muted-foreground" />
                <p className="text-sm font-medium">Shipping Address *</p>
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="nc-ship-addr">Address *</Label>
                  <Textarea
                    id="nc-ship-addr"
                    placeholder="House #, street, area"
                    value={newCustomer.shipping_address}
                    onChange={(e) =>
                      setNewCustomer((p) => ({ ...p, shipping_address: e.target.value }))
                    }
                    aria-invalid={!!fieldError('customer.addresses.0.address')}
                  />
                  {fieldError('customer.addresses.0.address') && (
                    <p className="text-xs text-destructive">
                      {fieldError('customer.addresses.0.address')}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nc-ship-city">City *</Label>
                  <Input
                    id="nc-ship-city"
                    placeholder="e.g. Lahore"
                    value={newCustomer.shipping_city}
                    onChange={(e) =>
                      setNewCustomer((p) => ({ ...p, shipping_city: e.target.value }))
                    }
                    aria-invalid={!!fieldError('customer.addresses.0.city')}
                  />
                  {fieldError('customer.addresses.0.city') && (
                    <p className="text-xs text-destructive">
                      {fieldError('customer.addresses.0.city')}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nc-ship-prov">Province</Label>
                  <Input
                    id="nc-ship-prov"
                    placeholder="e.g. Punjab"
                    value={newCustomer.shipping_province}
                    onChange={(e) =>
                      setNewCustomer((p) => ({ ...p, shipping_province: e.target.value }))
                    }
                  />
                </div>
              </div>
            </div>

            <Separator />

            {/* Billing Address with "Same as shipping" checkbox (checked by default) */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <CreditCard className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm font-medium">Billing Address</p>
                </div>
                <label
                  htmlFor="billing-same"
                  className="flex items-center gap-2 text-sm cursor-pointer select-none"
                >
                  <Checkbox
                    id="billing-same"
                    checked={billingSameAsShipping}
                    onCheckedChange={(v) => setBillingSameAsShipping(v === true)}
                  />
                  <span>Same as shipping address</span>
                </label>
              </div>

              {billingSameAsShipping ? (
                <div className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground flex items-start gap-2">
                  <Check className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>
                    Billing address will mirror the shipping address entered above.
                    Uncheck the box to enter a separate billing address.
                  </span>
                </div>
              ) : (
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="nc-bill-addr">Billing address *</Label>
                    <Textarea
                      id="nc-bill-addr"
                      placeholder="House #, street, area"
                      value={newCustomer.billing_address}
                      onChange={(e) =>
                        setNewCustomer((p) => ({ ...p, billing_address: e.target.value }))
                      }
                      aria-invalid={!!fieldError('customer.addresses.1.address')}
                    />
                    {fieldError('customer.addresses.1.address') && (
                      <p className="text-xs text-destructive">
                        {fieldError('customer.addresses.1.address')}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="nc-bill-city">Billing city *</Label>
                    <Input
                      id="nc-bill-city"
                      placeholder="e.g. Lahore"
                      value={newCustomer.billing_city}
                      onChange={(e) =>
                        setNewCustomer((p) => ({ ...p, billing_city: e.target.value }))
                      }
                      aria-invalid={!!fieldError('customer.addresses.1.city')}
                    />
                    {fieldError('customer.addresses.1.city') && (
                      <p className="text-xs text-destructive">
                        {fieldError('customer.addresses.1.city')}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="nc-bill-prov">Billing province</Label>
                    <Input
                      id="nc-bill-prov"
                      placeholder="e.g. Punjab"
                      value={newCustomer.billing_province}
                      onChange={(e) =>
                        setNewCustomer((p) => ({ ...p, billing_province: e.target.value }))
                      }
                    />
                  </div>
                </div>
              )}
            </div>

            {fieldError('customer.addresses') && (
              <p className="text-xs text-destructive">{fieldError('customer.addresses')}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ModeCard({
  active,
  onClick,
  title,
  description,
  icon,
}: {
  active: boolean
  onClick: () => void
  title: string
  description: string
  icon: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-start gap-3 rounded-lg border p-4 text-left transition-colors',
        active ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'border-border hover:bg-muted/40',
      )}
    >
      <div
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-md shrink-0',
          active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
        )}
      >
        {icon}
      </div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </button>
  )
}

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

function VariantThumbnail({ url, title }: { url: string | null; title: string }) {
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
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
}

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
  remainingCod: number
  // Issue 2: raw File + local preview URL — NO upload yet
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

            {/* Issue 2: payment proof held locally — uploaded AFTER order creation */}
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

        {/* Live total summary */}
        <div className="rounded-md bg-muted/40 p-3 space-y-1 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span className="tabular-nums">{formatPKR(subtotal)}</span>
          </div>
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

function PaymentTypeCard({
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
}

/**
 * ProofFileInput — Issue 2 fix.
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
              {/* eslint-disable-next-line @next/next/no-img-element */}
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
// SECTION 4: Delivery & Discount
// ─────────────────────────────────────────────────────────────────────────────

function DeliverySection({
  customerMode,
  selectedCustomer,
  customerShippingAddress,
  useCustomerAddress,
  setUseCustomerAddress,
  deliveryAddress,
  setDeliveryAddress,
  deliveryCity,
  setDeliveryCity,
  deliveryProvince,
  setDeliveryProvince,
  courierName,
  setCourierName,
  dispatchLocationId,
  setDispatchLocationId,
  notesForCourier,
  setNotesForCourier,
  discountAmount,
  setDiscountAmount,
  discountReason,
  setDiscountReason,
  locations,
  isLoadingLocations,
  fieldError,
}: {
  customerMode: 'existing' | 'new'
  selectedCustomer: CustomerRow | null
  customerShippingAddress: CustomerAddress | null
  useCustomerAddress: boolean
  setUseCustomerAddress: (v: boolean) => void
  deliveryAddress: string
  setDeliveryAddress: (v: string) => void
  deliveryCity: string
  setDeliveryCity: (v: string) => void
  deliveryProvince: string
  setDeliveryProvince: (v: string) => void
  courierName: string
  setCourierName: (v: string) => void
  dispatchLocationId: string
  setDispatchLocationId: (v: string) => void
  notesForCourier: string
  setNotesForCourier: (v: string) => void
  discountAmount: string
  setDiscountAmount: (v: string) => void
  discountReason: string
  setDiscountReason: (v: string) => void
  locations: InventoryLocation[]
  isLoadingLocations: boolean
  fieldError: (...paths: string[]) => string | undefined
}) {
  // The "Use different address" affordance is only relevant for existing
  // customers who have a saved shipping address on file.
  const showUseCustomerAddressToggle =
    customerMode === 'existing' && !!selectedCustomer && !!customerShippingAddress

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Truck className="h-4 w-4" /> 4 · Delivery &amp; Discount
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Existing-customer shipping address affordance */}
        {showUseCustomerAddressToggle && (
          <div className="rounded-md border bg-muted/30 p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1 min-w-0">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Saved shipping address
                </p>
                {useCustomerAddress && customerShippingAddress ? (
                  <div className="text-sm">
                    <p className="font-medium">{customerShippingAddress.address}</p>
                    <p className="text-muted-foreground">
                      {customerShippingAddress.city}
                      {customerShippingAddress.province
                        ? `, ${customerShippingAddress.province}`
                        : ''}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Using a different address — fields below are editable.
                  </p>
                )}
              </div>
              <Button
                type="button"
                size="sm"
                variant={useCustomerAddress ? 'outline' : 'default'}
                onClick={() => setUseCustomerAddress(!useCustomerAddress)}
              >
                {useCustomerAddress ? (
                  <>
                    <Edit3 className="h-3.5 w-3.5" /> Use different address
                  </>
                ) : (
                  <>
                    <Check className="h-3.5 w-3.5" /> Use saved address
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="del-address">
              <span className="flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5" /> Delivery address *
              </span>
            </Label>
            <Textarea
              id="del-address"
              placeholder="House #, street, area"
              value={deliveryAddress}
              onChange={(e) => setDeliveryAddress(e.target.value)}
              disabled={showUseCustomerAddressToggle && useCustomerAddress}
              aria-invalid={!!fieldError('delivery_address')}
            />
            {fieldError('delivery_address') && (
              <p className="text-xs text-destructive">{fieldError('delivery_address')}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="del-city">City *</Label>
            <Input
              id="del-city"
              placeholder="e.g. Lahore"
              value={deliveryCity}
              onChange={(e) => setDeliveryCity(e.target.value)}
              disabled={showUseCustomerAddressToggle && useCustomerAddress}
              aria-invalid={!!fieldError('delivery_city')}
            />
            {fieldError('delivery_city') && (
              <p className="text-xs text-destructive">{fieldError('delivery_city')}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="del-province">Province</Label>
            <Input
              id="del-province"
              placeholder="e.g. Punjab"
              value={deliveryProvince}
              onChange={(e) => setDeliveryProvince(e.target.value)}
              disabled={showUseCustomerAddressToggle && useCustomerAddress}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="del-courier">Courier name</Label>
            <Input
              id="del-courier"
              placeholder="e.g. TCS, Leopards"
              value={courierName}
              onChange={(e) => setCourierName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="del-loc">
              <span className="flex items-center gap-1.5">
                <Truck className="h-3.5 w-3.5" /> Dispatch location *
              </span>
            </Label>
            {isLoadingLocations ? (
              <Skeleton className="h-9" />
            ) : (
              <Select value={dispatchLocationId} onValueChange={setDispatchLocationId}>
                <SelectTrigger id="del-loc">
                  <SelectValue placeholder="Select dispatch location" />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name} {l.isDefault && '(default)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {fieldError('dispatch_location_id') && (
              <p className="text-xs text-destructive">{fieldError('dispatch_location_id')}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Stock will be reserved from this location.
            </p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="del-notes">Notes for courier</Label>
            <Textarea
              id="del-notes"
              placeholder="Optional delivery instructions"
              value={notesForCourier}
              onChange={(e) => setNotesForCourier(e.target.value)}
            />
          </div>
        </div>

        <div className="rounded-lg border p-4 space-y-4">
          <p className="text-sm font-medium">Discount (optional)</p>
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="disc-amt">Discount amount</Label>
              <Input
                id="disc-amt"
                type="number"
                min="0"
                step="0.01"
                placeholder="0"
                value={discountAmount}
                onChange={(e) => setDiscountAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="disc-reason">Discount reason</Label>
              <Input
                id="disc-reason"
                placeholder="e.g. repeat customer"
                value={discountReason}
                onChange={(e) => setDiscountReason(e.target.value)}
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5: Order Summary (sticky sidebar)
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
