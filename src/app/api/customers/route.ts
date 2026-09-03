import { ApiError, handleError, readBody } from '@/lib/workspace'
import {
  listCustomers,
  createCustomer,
  searchCustomersDetailed,
  flagCustomer,
  unflagCustomer,
} from '@/lib/actions/customer.actions'
import type { CreateCustomerInput } from '@/lib/validations/customer.schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/customers
 *
 * List customers for the active organization with optional filters:
 *   - search: matches customer name OR any associated phone (raw/normalized)
 *   - is_flagged: boolean
 *   - date_from / date_to: ISO datetime strings (created_at range)
 *   - limit (max 100, default 50), offset
 *
 * Each row includes the primary phone and default address summary.
 *
 * Special case: when `detailed=1` and search is provided, returns the
 * FULL customer record (phones + addresses) via searchCustomersDetailed().
 * This is a SINGLE optimized DB query (was 8 queries before) that
 * searches across name + email + phone (exact + partial) in one round-trip.
 *
 * Used by the order-create page's live customer search.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const search = url.searchParams.get('search') ?? ''
    const isFlagged = url.searchParams.get('is_flagged')
    const dateFrom = url.searchParams.get('date_from') ?? undefined
    const dateTo = url.searchParams.get('date_to') ?? undefined
    const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined
    const offset = url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : undefined
    // When `detailed=1` and search is provided, return the full customer
    // record (phones + addresses) via the optimized single-query search.
    // Used by the order-create page's live customer search.
    const detailed = url.searchParams.get('detailed') === '1'

    if (detailed && search) {
      // Single optimized DB round-trip — searches name + email + phone
      // (exact + partial) in one query with full includes.
      // Falls back to { found: false } if no match.
      const result = await searchCustomersDetailed(search)
      if (!result.success) {
        throw new ApiError(400, result.error ?? 'Failed to search customer')
      }
      return Response.json(result.data)
    }

    const result = await listCustomers({
      search: search || undefined,
      isFlagged:
        isFlagged === 'true' ? true : isFlagged === 'false' ? false : undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
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
 * 1. Flag / unflag an existing customer:
 *      { customer_id, action: 'flag' | 'unflag', reason? }
 *
 * 2. Create a new customer (full Customer Management System shape):
 *      {
 *        name: string,
 *        email?: string,
 *        phones: [{ phone, label?, is_primary }],
 *        addresses: [{ label?, address, city, is_default }]
 *      }
 *    Validates via createCustomerSchema (exactly one primary phone, exactly
 *    one default address). Returns 201 with { customerId }.
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
      const reason = typeof body.reason === 'string' ? body.reason : undefined

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

    // ── Create customer flow ──────────────────────────────────────────────
    // Delegate to the createCustomer server action, which validates via
    // createCustomerSchema, normalizes phones, checks org-wide uniqueness,
    // and inserts customer + phones + addresses in a single transaction.
    const input = body as unknown as CreateCustomerInput

    // If an idempotency key is provided, wrap the creation in withIdempotency()
    const idempotencyKey = req.headers.get('Idempotency-Key')
    if (idempotencyKey) {
      const { getWorkspace } = await import('@/lib/workspace')
      const ctx = await getWorkspace()
      const { withIdempotency } = await import('@/lib/idempotency')
      const { result, wasReplay } = await withIdempotency({
        key: idempotencyKey,
        companyId: ctx.company.id,
        employeeId: ctx.employee.id,
        actionType: 'customer.create',
        fn: async () => {
          const res = await createCustomer(input)
          if (!res.success || !res.data) {
            throw new ApiError(400, res.error ?? 'Failed to create customer')
          }
          return res.data
        },
      })
      return Response.json(result, { status: wasReplay ? 200 : 201 })
    }

    // No idempotency key — normal flow (backwards-compatible)
    const result = await createCustomer(input)

    if (!result.success || !result.data) {
      throw new ApiError(400, result.error ?? 'Failed to create customer')
    }

    return Response.json(result.data, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
