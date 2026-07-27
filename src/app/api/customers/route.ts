import { ApiError, handleError, readBody } from '@/lib/workspace'
import {
  listCustomers,
  findOrCreateCustomer,
  flagCustomer,
  unflagCustomer,
} from '@/lib/actions/customer.actions'
import type { CustomerInput } from '@/lib/validations/order.schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/customers
 * Search customers by phone / name / email for the active organization.
 * Supports: search, is_flagged, limit, offset.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const search = url.searchParams.get('search') ?? ''
    const isFlagged = url.searchParams.get('is_flagged')
    const limit = url.searchParams.get('limit')
      ? Number(url.searchParams.get('limit'))
      : undefined
    const offset = url.searchParams.get('offset')
      ? Number(url.searchParams.get('offset'))
      : undefined

    const result = await listCustomers({
      search: search || undefined,
      isFlagged:
        isFlagged === 'true' ? true : isFlagged === 'false' ? false : undefined,
      limit,
      offset,
    })

    if (!result.success) {
      throw new ApiError(400, result.error ?? 'Failed to list customers')
    }
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}

/**
 * POST /api/customers
 *
 * Two distinct payloads are supported on this single endpoint:
 *
 * 1. Flag / unflag an existing customer (legacy):
 *      { customer_id, action: 'flag' | 'unflag', reason? }
 *
 * 2. Inline customer creation (Shopify-like flow from the order-create page):
 *      {
 *        name, phone, alternate_phone?, email?,
 *        shipping_address: { address, city },
 *        billing_address?: { address, city },
 *      }
 *    Returns the existing customer if a phone match is found (idempotent —
 *    mirrors the findOrCreateCustomer server-action semantics), otherwise
 *    creates a new one and returns its id.
 *
 * The two flows are distinguished by the presence of `action` + `customer_id`.
 */
export async function POST(req: Request) {
  try {
    const body = await readBody<Record<string, unknown>>(req)

    // ── Flag/unflag flow ──────────────────────────────────────────────────
    if (
      body &&
      typeof body === 'object' &&
      'action' in body &&
      'customer_id' in body
    ) {
      const action = String(body.action)
      const customerId = String(body.customer_id)
      const reason =
        typeof body.reason === 'string' ? body.reason : undefined

      if (action === 'flag') {
        if (!reason || reason.trim().length < 3) {
          throw new ApiError(400, 'A reason (min 3 chars) is required to flag a customer')
        }
        const result = await flagCustomer(customerId, reason.trim())
        if (!result.success) {
          throw new ApiError(400, result.error ?? 'Failed to flag customer')
        }
        return Response.json({ ok: true })
      }

      if (action === 'unflag') {
        const result = await unflagCustomer(customerId)
        if (!result.success) {
          throw new ApiError(400, result.error ?? 'Failed to unflag customer')
        }
        return Response.json({ ok: true })
      }

      throw new ApiError(400, `Unknown action: ${action}`)
    }

    // ── Inline customer creation flow ─────────────────────────────────────
    // Build a CustomerInput payload and delegate to findOrCreateCustomer,
    // which validates via customerInputSchema and is idempotent on phone.
    const input = body as Partial<CustomerInput> & {
      shipping_address?: { address: string; city: string }
      billing_address?: { address: string; city: string }
    }

    const shippingAddress = input.shipping_address ?? {
      address: '',
      city: '',
    }
    // Default billing to shipping when omitted (matches the "same as shipping"
    // UX in the order-create form).
    const billingAddress = input.billing_address ?? shippingAddress

    const result = await findOrCreateCustomer({
      name: typeof input.name === 'string' ? input.name : '',
      phone: typeof input.phone === 'string' ? input.phone : '',
      alternate_phone:
        typeof input.alternate_phone === 'string' ? input.alternate_phone : '',
      email: typeof input.email === 'string' ? input.email : '',
      shipping_address: shippingAddress,
      billing_address: billingAddress,
      // Vestigial — findOrCreateCustomer reads these from the workspace ctx.
      organizationId: '',
      companyId: '',
    })

    if (!result.success || !result.data) {
      throw new ApiError(400, result.error ?? 'Failed to create customer')
    }

    return Response.json(result.data, {
      status: result.data.isNewCustomer ? 201 : 200,
    })
  } catch (err) {
    return handleError(err)
  }
}
