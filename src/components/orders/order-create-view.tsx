'use client'

import { useEffect, useMemo, useState } from 'react'
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  ArrowLeft,
  ArrowRight,
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
} from 'lucide-react'
import { cn } from '@/lib/utils'

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

interface VariantOption {
  variantId: string
  sku: string
  productTitle: string
  costPrice: number
  salePrice: number | null
  fulfillmentType: string
}

interface ProductsResponse {
  products: Array<{
    id: string
    title: string
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

const STEPS = [
  { num: 1, label: 'Customer', icon: User },
  { num: 2, label: 'Items', icon: Package },
  { num: 3, label: 'Payment', icon: CreditCard },
  { num: 4, label: 'Delivery', icon: Truck },
  { num: 5, label: 'Review', icon: CheckCircle2 },
] as const

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function OrderCreateView() {
  const navigate = useAppStore((s) => s.navigate)
  const can = useCan()
  const queryClient = useQueryClient()
  const canCreate = can(PERMISSIONS.ORDERS_CREATE)

  const [step, setStep] = useState(1)

  // ── Form state ────────────────────────────────────────────────────────────
  // Customer
  const [customerMode, setCustomerMode] = useState<'existing' | 'new'>('existing')
  const [phoneSearch, setPhoneSearch] = useState('')
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerRow | null>(null)
  const [newCustomer, setNewCustomer] = useState({
    name: '',
    phone: '',
    alternate_phone: '',
    email: '',
    address: '',
    city: '',
  })

  // Items
  const [cart, setCart] = useState<CartItem[]>([])
  const [variantSearch, setVariantSearch] = useState('')

  // Payment
  const [paymentType, setPaymentType] = useState<PaymentType>('full_cod')
  const [advanceAmount, setAdvanceAmount] = useState('')
  const [advancePaymentMethod, setAdvancePaymentMethod] = useState('')
  const [advancePaymentReference, setAdvancePaymentReference] = useState('')
  const [advancePaymentScreenshotUrl, setAdvancePaymentScreenshotUrl] = useState('')

  // Delivery
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [deliveryCity, setDeliveryCity] = useState('')
  const [courierName, setCourierName] = useState('')
  const [dispatchLocationId, setDispatchLocationId] = useState('')
  const [notesForCourier, setNotesForCourier] = useState('')
  const [discountAmount, setDiscountAmount] = useState('')
  const [discountReason, setDiscountReason] = useState('')

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

  // Customer phone search — debounced via staleTime + query key
  const trimmedPhone = phoneSearch.trim()
  const customersQuery = useQuery<CustomersSearchResponse>({
    queryKey: ['customers', 'search', trimmedPhone],
    queryFn: () =>
      api.get<CustomersSearchResponse>(
        `/api/customers?search=${encodeURIComponent(trimmedPhone)}&limit=10`,
      ),
    enabled: trimmedPhone.length >= 4,
    staleTime: 10_000,
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

  // ── Auto-fill delivery from customer ──────────────────────────────────────
  useEffect(() => {
    if (customerMode === 'existing' && selectedCustomer) {
      // No addresses returned by customer search — let user type.
    }
  }, [customerMode, selectedCustomer])

  // When switching to "new" customer, pre-fill delivery fields from their input.
  useEffect(() => {
    if (customerMode === 'new') {
      if (newCustomer.address && !deliveryAddress) {
        setDeliveryAddress(newCustomer.address)
      }
      if (newCustomer.city && !deliveryCity) {
        setDeliveryCity(newCustomer.city)
      }
      if (newCustomer.phone && !courierName) {
        // leave courier blank — not derivable
      }
    }
  }, [customerMode, newCustomer.address, newCustomer.city, newCustomer.phone, courierName, deliveryAddress, deliveryCity])

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

  // ── Step validation ───────────────────────────────────────────────────────
  const customerStepValid =
    customerMode === 'existing'
      ? !!selectedCustomer
      : newCustomer.name.trim().length >= 2 &&
        newCustomer.phone.trim().length >= 7 &&
        newCustomer.address.trim().length >= 2 &&
        newCustomer.city.trim().length >= 2

  const itemsStepValid = cart.length > 0 && cart.every((i) => i.quantity > 0 && i.unitPrice >= 0)

  const paymentStepValid =
    paymentType === 'full_cod' ||
    (paymentType === 'partial_advance' && parsePrice(advanceAmount) > 0) ||
    paymentType === 'fully_prepaid'

  const deliveryStepValid =
    deliveryAddress.trim().length >= 2 &&
    deliveryCity.trim().length >= 2 &&
    !!dispatchLocationId

  const canGoNext = (): boolean => {
    if (step === 1) return customerStepValid
    if (step === 2) return itemsStepValid
    if (step === 3) return paymentStepValid
    if (step === 4) return deliveryStepValid
    return true
  }

  // ── Mutation: create order ────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: async (payload: unknown) =>
      api.post<CreateOrderResponse>('/api/orders', payload),
    onSuccess: (data) => {
      toast.success(`Order ${data.flowopsOrderNumber} created successfully.`)
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
      navigate({ name: 'order-detail', id: data.orderId })
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  // ── Permission gate (after all hooks) ─────────────────────────────────────
  if (!canCreate) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Create Order"
          description="Manually create a customer order"
          actions={
            <Button variant="outline" size="sm" onClick={() => navigate({ name: 'orders' })}>
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

  // ── Build payload + submit ────────────────────────────────────────────────
  const handleSubmit = () => {
    if (!customerStepValid || !itemsStepValid || !paymentStepValid || !deliveryStepValid) {
      toast.error('Please complete all required fields before creating the order.')
      return
    }

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
      payload.advance_payment_screenshot_url = advancePaymentScreenshotUrl.trim() || undefined
    }

    if (customerMode === 'existing' && selectedCustomer) {
      payload.customer_id = selectedCustomer.id
    } else {
      payload.customer = {
        name: newCustomer.name.trim(),
        phone: newCustomer.phone.trim(),
        alternate_phone: newCustomer.alternate_phone.trim() || undefined,
        email: newCustomer.email.trim() || undefined,
        addresses: [
          {
            label: 'Home',
            address: newCustomer.address.trim(),
            city: newCustomer.city.trim(),
            is_default: true,
          },
        ],
      }
    }

    createMutation.mutate(payload)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Create Order"
        description="Manually create a customer order"
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate({ name: 'orders' })}>
            <ArrowLeft className="h-4 w-4" /> Back to Orders
          </Button>
        }
      />

      {/* ── Stepper ─────────────────────────────────────────────────────────── */}
      <Stepper currentStep={step} />

      {/* ── Step content ────────────────────────────────────────────────────── */}
      {step === 1 && (
        <CustomerStep
          customerMode={customerMode}
          setCustomerMode={setCustomerMode}
          phoneSearch={phoneSearch}
          setPhoneSearch={setPhoneSearch}
          selectedCustomer={selectedCustomer}
          setSelectedCustomer={setSelectedCustomer}
          newCustomer={newCustomer}
          setNewCustomer={setNewCustomer}
          customers={customersQuery.data?.customers ?? []}
          isSearching={customersQuery.isFetching}
        />
      )}

      {step === 2 && (
        <ItemsStep
          cart={cart}
          variantSearch={variantSearch}
          setVariantSearch={setVariantSearch}
          variantSearchResults={variantSearchResults}
          addVariant={addVariant}
          removeItem={removeItem}
          updateItem={updateItem}
          isLoadingProducts={productsQuery.isLoading}
          subtotal={subtotal}
        />
      )}

      {step === 3 && (
        <PaymentStep
          paymentType={paymentType}
          setPaymentType={setPaymentType}
          advanceAmount={advanceAmount}
          setAdvanceAmount={setAdvanceAmount}
          advancePaymentMethod={advancePaymentMethod}
          setAdvancePaymentMethod={setAdvancePaymentMethod}
          advancePaymentReference={advancePaymentReference}
          setAdvancePaymentReference={setAdvancePaymentReference}
          advancePaymentScreenshotUrl={advancePaymentScreenshotUrl}
          setAdvancePaymentScreenshotUrl={setAdvancePaymentScreenshotUrl}
          subtotal={subtotal}
          total={total}
          discount={discount}
        />
      )}

      {step === 4 && (
        <DeliveryStep
          deliveryAddress={deliveryAddress}
          setDeliveryAddress={setDeliveryAddress}
          deliveryCity={deliveryCity}
          setDeliveryCity={setDeliveryCity}
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
          subtotal={subtotal}
          discount={discount}
          total={total}
        />
      )}

      {step === 5 && (
        <ReviewStep
          customerMode={customerMode}
          selectedCustomer={selectedCustomer}
          newCustomer={newCustomer}
          cart={cart}
          paymentType={paymentType}
          advanceAmount={advanceAmount}
          advancePaymentMethod={advancePaymentMethod}
          advancePaymentReference={advancePaymentReference}
          deliveryAddress={deliveryAddress}
          deliveryCity={deliveryCity}
          courierName={courierName}
          dispatchLocationId={dispatchLocationId}
          locations={locationsQuery.data?.locations ?? []}
          notesForCourier={notesForCourier}
          discountAmount={discountAmount}
          discountReason={discountReason}
          subtotal={subtotal}
          discount={discount}
          total={total}
        />
      )}

      {/* ── Step navigation ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <Button
          variant="outline"
          onClick={() => (step === 1 ? navigate({ name: 'orders' }) : setStep(step - 1))}
          disabled={createMutation.isPending}
        >
          <ArrowLeft className="h-4 w-4" />
          {step === 1 ? 'Cancel' : 'Back'}
        </Button>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          Step {step} of {STEPS.length}
        </div>

        {step < 5 ? (
          <Button onClick={() => setStep(step + 1)} disabled={!canGoNext()}>
            Continue
            <ArrowRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            onClick={handleSubmit}
            disabled={
              createMutation.isPending ||
              !customerStepValid ||
              !itemsStepValid ||
              !paymentStepValid ||
              !deliveryStepValid
            }
          >
            {createMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Creating…
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4" /> Create Order
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Stepper
// ─────────────────────────────────────────────────────────────────────────────

function Stepper({ currentStep }: { currentStep: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <ol className="flex items-center justify-between gap-2">
          {STEPS.map((s, idx) => {
            const Icon = s.icon
            const isComplete = currentStep > s.num
            const isCurrent = currentStep === s.num
            return (
              <li key={s.num} className="flex items-center flex-1 last:flex-none">
                <div className="flex items-center gap-2">
                  <div
                    className={cn(
                      'flex h-8 w-8 items-center justify-center rounded-full border-2 transition-colors',
                      isComplete && 'bg-primary border-primary text-primary-foreground',
                      isCurrent && 'border-primary text-primary',
                      !isComplete && !isCurrent && 'border-muted text-muted-foreground',
                    )}
                  >
                    {isComplete ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                  </div>
                  <span
                    className={cn(
                      'text-sm font-medium hidden sm:inline',
                      isCurrent ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {s.label}
                  </span>
                </div>
                {idx < STEPS.length - 1 && (
                  <div
                    className={cn(
                      'h-0.5 flex-1 mx-2 rounded-full transition-colors',
                      isComplete ? 'bg-primary' : 'bg-muted',
                    )}
                  />
                )}
              </li>
            )
          })}
        </ol>
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Customer
// ─────────────────────────────────────────────────────────────────────────────

function CustomerStep({
  customerMode,
  setCustomerMode,
  phoneSearch,
  setPhoneSearch,
  selectedCustomer,
  setSelectedCustomer,
  newCustomer,
  setNewCustomer,
  customers,
  isSearching,
}: {
  customerMode: 'existing' | 'new'
  setCustomerMode: (m: 'existing' | 'new') => void
  phoneSearch: string
  setPhoneSearch: (v: string) => void
  selectedCustomer: CustomerRow | null
  setSelectedCustomer: (c: CustomerRow | null) => void
  newCustomer: {
    name: string
    phone: string
    alternate_phone: string
    email: string
    address: string
    city: string
  }
  setNewCustomer: React.Dispatch<
    React.SetStateAction<{
      name: string
      phone: string
      alternate_phone: string
      email: string
      address: string
      city: string
    }>
  >
  customers: CustomerRow[]
  isSearching: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Customer</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <RadioGroup
          value={customerMode}
          onValueChange={(v) => {
            setCustomerMode(v as 'existing' | 'new')
            setSelectedCustomer(null)
          }}
          className="grid sm:grid-cols-2 gap-3"
        >
          <label
            htmlFor="mode-existing"
            className={cn(
              'flex items-start gap-3 rounded-lg border p-4 cursor-pointer transition-colors',
              customerMode === 'existing'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-muted/40',
            )}
          >
            <RadioGroupItem value="existing" id="mode-existing" className="mt-1" />
            <div>
              <p className="text-sm font-medium">Existing customer</p>
              <p className="text-xs text-muted-foreground">
                Search by phone, name, or email
              </p>
            </div>
          </label>
          <label
            htmlFor="mode-new"
            className={cn(
              'flex items-start gap-3 rounded-lg border p-4 cursor-pointer transition-colors',
              customerMode === 'new'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-muted/40',
            )}
          >
            <RadioGroupItem value="new" id="mode-new" className="mt-1" />
            <div>
              <p className="text-sm font-medium">Add new customer</p>
              <p className="text-xs text-muted-foreground">
                Create a new customer record
              </p>
            </div>
          </label>
        </RadioGroup>

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
                  placeholder="e.g. 03001234567"
                  className="pl-9"
                  value={phoneSearch}
                  onChange={(e) => {
                    setPhoneSearch(e.target.value)
                    setSelectedCustomer(null)
                  }}
                />
                {isSearching && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Type at least 4 characters to search.
              </p>
            </div>

            {phoneSearch.trim().length >= 4 && !selectedCustomer && (
              <div className="rounded-md border bg-popover shadow-sm max-h-72 overflow-y-auto scrollbar-thin">
                {customers.length === 0 ? (
                  <div className="p-3 text-sm text-muted-foreground">
                    {isSearching
                      ? 'Searching…'
                      : 'No matching customers. Switch to "Add new customer".'}
                  </div>
                ) : (
                  <ul className="divide-y">
                    {customers.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedCustomer(c)}
                          className="w-full text-left px-3 py-2 hover:bg-muted/60 transition-colors flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{c.name}</p>
                            <p className="text-xs text-muted-foreground font-mono">{c.phone}</p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {c.isFlagged && (
                              <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200 text-[10px]">
                                Flagged
                              </Badge>
                            )}
                            <span className="text-xs text-muted-foreground">
                              {c.totalOrdersCount} orders
                            </span>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {selectedCustomer && (
              <Alert>
                <User className="h-4 w-4" />
                <AlertTitle>Selected customer</AlertTitle>
                <AlertDescription>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">{selectedCustomer.name}</p>
                      <p className="text-xs text-muted-foreground font-mono">
                        {selectedCustomer.phone}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSelectedCustomer(null)}
                    >
                      Change
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="nc-name">Full name *</Label>
              <Input
                id="nc-name"
                placeholder="e.g. Ayesha Khan"
                value={newCustomer.name}
                onChange={(e) => setNewCustomer((p) => ({ ...p, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nc-phone">Phone *</Label>
              <Input
                id="nc-phone"
                placeholder="e.g. 03001234567"
                value={newCustomer.phone}
                onChange={(e) => setNewCustomer((p) => ({ ...p, phone: e.target.value }))}
              />
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
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="nc-address">Address *</Label>
              <Textarea
                id="nc-address"
                placeholder="House #, street, area"
                value={newCustomer.address}
                onChange={(e) => setNewCustomer((p) => ({ ...p, address: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nc-city">City *</Label>
              <Input
                id="nc-city"
                placeholder="e.g. Lahore"
                value={newCustomer.city}
                onChange={(e) => setNewCustomer((p) => ({ ...p, city: e.target.value }))}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Items
// ─────────────────────────────────────────────────────────────────────────────

function ItemsStep({
  cart,
  variantSearch,
  setVariantSearch,
  variantSearchResults,
  addVariant,
  removeItem,
  updateItem,
  isLoadingProducts,
  subtotal,
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
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Items</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="variant-search">Add products</Label>
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

        {variantSearch.trim() && (
          <div className="rounded-md border bg-popover shadow-sm max-h-64 overflow-y-auto scrollbar-thin">
            {variantSearchResults.length === 0 ? (
              <div className="p-3 text-sm text-muted-foreground">
                {isLoadingProducts ? 'Loading variants…' : 'No variants match your search.'}
              </div>
            ) : (
              <ul className="divide-y">
                {variantSearchResults.map((v) => (
                  <li key={v.variantId}>
                    <button
                      type="button"
                      onClick={() => addVariant(v)}
                      className="w-full text-left px-3 py-2 hover:bg-muted/60 transition-colors flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{v.productTitle}</p>
                        <p className="text-xs text-muted-foreground font-mono">{v.sku}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge
                          variant="outline"
                          className={cn(
                            'text-[10px]',
                            v.fulfillmentType === 'made_to_order'
                              ? 'bg-purple-50 text-purple-700 border-purple-200'
                              : 'bg-sky-50 text-sky-700 border-sky-200',
                          )}
                        >
                          {v.fulfillmentType === 'made_to_order' ? 'MTO' : 'Stock'}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {v.salePrice ? formatPKR(v.salePrice) : formatPKR(v.costPrice)}
                        </span>
                        <Plus className="h-3.5 w-3.5 text-primary" />
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Variant</TableHead>
                <TableHead className="w-24">Qty</TableHead>
                <TableHead className="w-32">Unit price</TableHead>
                <TableHead className="text-right w-28">Line total</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {cart.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="text-center text-sm text-muted-foreground py-8"
                  >
                    No items added yet. Search above to add variants.
                  </TableCell>
                </TableRow>
              ) : (
                cart.map((item) => (
                  <TableRow key={item.variantId}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="text-sm font-medium">{item.productTitle}</span>
                        <span className="text-xs text-muted-foreground font-mono">
                          {item.sku}
                        </span>
                        <Badge
                          variant="outline"
                          className={cn(
                            'text-[10px] w-fit mt-1',
                            item.fulfillmentType === 'made_to_order'
                              ? 'bg-purple-50 text-purple-700 border-purple-200'
                              : 'bg-sky-50 text-sky-700 border-sky-200',
                          )}
                        >
                          {item.fulfillmentType === 'made_to_order' ? 'MTO' : 'Stock'}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        className="h-8 tabular-nums"
                        value={item.quantity}
                        onChange={(e) =>
                          updateItem(item.variantId, { quantity: parseQty(e.target.value) })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        className="h-8 tabular-nums"
                        value={item.unitPrice}
                        onChange={(e) =>
                          updateItem(item.variantId, { unitPrice: parsePrice(e.target.value) })
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatPKR(item.quantity * item.unitPrice)}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-rose-600 hover:bg-rose-50"
                        onClick={() => removeItem(item.variantId)}
                        aria-label={`Remove ${item.sku}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex items-center justify-end gap-3">
          <span className="text-sm text-muted-foreground">Subtotal</span>
          <span className="text-lg font-semibold tabular-nums">{formatPKR(subtotal)}</span>
        </div>
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Payment
// ─────────────────────────────────────────────────────────────────────────────

function PaymentStep({
  paymentType,
  setPaymentType,
  advanceAmount,
  setAdvanceAmount,
  advancePaymentMethod,
  setAdvancePaymentMethod,
  advancePaymentReference,
  setAdvancePaymentReference,
  advancePaymentScreenshotUrl,
  setAdvancePaymentScreenshotUrl,
  subtotal,
  total,
  discount,
}: {
  paymentType: PaymentType
  setPaymentType: (p: PaymentType) => void
  advanceAmount: string
  setAdvanceAmount: (v: string) => void
  advancePaymentMethod: string
  setAdvancePaymentMethod: (v: string) => void
  advancePaymentReference: string
  setAdvancePaymentReference: (v: string) => void
  advancePaymentScreenshotUrl: string
  setAdvancePaymentScreenshotUrl: (v: string) => void
  subtotal: number
  total: number
  discount: number
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Payment</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <RadioGroup
          value={paymentType}
          onValueChange={(v) => setPaymentType(v as PaymentType)}
          className="grid gap-3"
        >
          <PaymentOption
            value="full_cod"
            title="Full COD"
            description="Customer pays the full amount in cash on delivery."
            current={paymentType}
          />
          <PaymentOption
            value="partial_advance"
            title="Partial Advance"
            description="Customer pays a portion upfront; the rest is collected on delivery."
            current={paymentType}
          />
          <PaymentOption
            value="fully_prepaid"
            title="Fully Prepaid"
            description="Customer has paid the full amount before dispatch."
            current={paymentType}
          />
        </RadioGroup>

        {paymentType !== 'full_cod' && (
          <div className="grid sm:grid-cols-2 gap-4 rounded-lg border bg-muted/30 p-4">
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
              />
              {paymentType === 'partial_advance' && (
                <p className="text-xs text-muted-foreground">
                  Remaining COD: {formatPKR(Math.max(0, total - parsePrice(advanceAmount)))}
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
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="advance-shot">Screenshot URL</Label>
              <Input
                id="advance-shot"
                type="url"
                placeholder="https://…"
                value={advancePaymentScreenshotUrl}
                onChange={(e) => setAdvancePaymentScreenshotUrl(e.target.value)}
              />
            </div>
          </div>
        )}

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
        </div>
      </CardContent>
    </Card>
  )
}

function PaymentOption({
  value,
  title,
  description,
  current,
}: {
  value: string
  title: string
  description: string
  current: string
}) {
  return (
    <label
      htmlFor={`pay-${value}`}
      className={cn(
        'flex items-start gap-3 rounded-lg border p-4 cursor-pointer transition-colors',
        current === value ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40',
      )}
    >
      <RadioGroupItem value={value} id={`pay-${value}`} className="mt-1" />
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </label>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: Delivery
// ─────────────────────────────────────────────────────────────────────────────

function DeliveryStep({
  deliveryAddress,
  setDeliveryAddress,
  deliveryCity,
  setDeliveryCity,
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
  subtotal,
  discount,
  total,
}: {
  deliveryAddress: string
  setDeliveryAddress: (v: string) => void
  deliveryCity: string
  setDeliveryCity: (v: string) => void
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
  subtotal: number
  discount: number
  total: number
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Delivery & Discount</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
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
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="del-city">City *</Label>
            <Input
              id="del-city"
              placeholder="e.g. Lahore"
              value={deliveryCity}
              onChange={(e) => setDeliveryCity(e.target.value)}
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
          <div className="space-y-1.5 sm:col-span-2">
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
        </div>
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5: Review
// ─────────────────────────────────────────────────────────────────────────────

function ReviewStep({
  customerMode,
  selectedCustomer,
  newCustomer,
  cart,
  paymentType,
  advanceAmount,
  advancePaymentMethod,
  advancePaymentReference,
  deliveryAddress,
  deliveryCity,
  courierName,
  dispatchLocationId,
  locations,
  notesForCourier,
  discountAmount,
  discountReason,
  subtotal,
  discount,
  total,
}: {
  customerMode: 'existing' | 'new'
  selectedCustomer: CustomerRow | null
  newCustomer: {
    name: string
    phone: string
    alternate_phone: string
    email: string
    address: string
    city: string
  }
  cart: CartItem[]
  paymentType: PaymentType
  advanceAmount: string
  advancePaymentMethod: string
  advancePaymentReference: string
  deliveryAddress: string
  deliveryCity: string
  courierName: string
  dispatchLocationId: string
  locations: InventoryLocation[]
  notesForCourier: string
  discountAmount: string
  discountReason: string
  subtotal: number
  discount: number
  total: number
}) {
  const dispatchLocation = locations.find((l) => l.id === dispatchLocationId)
  const remainingCod =
    paymentType === 'fully_prepaid'
      ? 0
      : paymentType === 'partial_advance'
        ? Math.max(0, total - parsePrice(advanceAmount))
        : total

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Customer</CardTitle>
        </CardHeader>
        <CardContent>
          {customerMode === 'existing' && selectedCustomer ? (
            <div>
              <p className="text-sm font-medium">{selectedCustomer.name}</p>
              <p className="text-xs text-muted-foreground font-mono">{selectedCustomer.phone}</p>
              <p className="text-xs text-muted-foreground">
                {selectedCustomer.totalOrdersCount} previous order
                {selectedCustomer.totalOrdersCount === 1 ? '' : 's'}
                {selectedCustomer.isFlagged && (
                  <Badge variant="outline" className="ml-2 bg-rose-50 text-rose-700 border-rose-200 text-[10px]">
                    Flagged
                  </Badge>
                )}
              </p>
            </div>
          ) : (
            <div>
              <p className="text-sm font-medium">{newCustomer.name}</p>
              <p className="text-xs text-muted-foreground font-mono">{newCustomer.phone}</p>
              {newCustomer.email && (
                <p className="text-xs text-muted-foreground">{newCustomer.email}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Items ({cart.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Variant</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cart.map((item) => (
                <TableRow key={item.variantId}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">{item.productTitle}</span>
                      <span className="text-xs text-muted-foreground font-mono">{item.sku}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{item.quantity}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatPKR(item.unitPrice)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {formatPKR(item.quantity * item.unitPrice)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid sm:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ReviewRow
              label="Type"
              value={
                paymentType === 'full_cod'
                  ? 'Full COD'
                  : paymentType === 'partial_advance'
                    ? 'Partial Advance'
                    : 'Fully Prepaid'
              }
            />
            {paymentType !== 'full_cod' && (
              <>
                <ReviewRow
                  label="Advance"
                  value={formatPKR(
                    paymentType === 'fully_prepaid' ? total : parsePrice(advanceAmount),
                  )}
                />
                <ReviewRow
                  label="Method"
                  value={
                    PAYMENT_METHODS.find((m) => m.value === advancePaymentMethod)?.label ?? '—'
                  }
                />
                {advancePaymentReference && (
                  <ReviewRow label="Reference" value={advancePaymentReference} />
                )}
                <ReviewRow label="Remaining COD" value={formatPKR(remainingCod)} />
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Delivery</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ReviewRow label="Address" value={deliveryAddress} />
            <ReviewRow label="City" value={deliveryCity} />
            <ReviewRow label="Courier" value={courierName || '—'} />
            <ReviewRow label="Dispatch from" value={dispatchLocation?.name ?? '—'} />
            {notesForCourier && <ReviewRow label="Notes" value={notesForCourier} />}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Totals</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <ReviewRow label="Subtotal" value={formatPKR(subtotal)} />
          {discount > 0 && (
            <>
              <ReviewRow
                label="Discount"
                value={`−${formatPKR(discount)}`}
                valueClassName="text-rose-600"
              />
              {discountReason && <ReviewRow label="Reason" value={discountReason} />}
            </>
          )}
          <div className="flex items-center justify-between pt-2 border-t">
            <span className="font-medium">Total</span>
            <span className="text-lg font-semibold tabular-nums">{formatPKR(total)}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function ReviewRow({
  label,
  value,
  valueClassName,
}: {
  label: string
  value: string
  valueClassName?: string
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={cn('font-medium text-right', valueClassName)}>{value}</span>
    </div>
  )
}
