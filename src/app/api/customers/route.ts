import { ApiError, handleError, readBody } from '@/lib/workspace'
import {
  listCustomers,
  createCustomer,
  searchCustomersDetailed,
  searchCustomersMulti,
  flagCustomer,
  unflagCustomer,
} from '@/lib/actions/customer.actions'
import {
  createCustomerSchema,
  type CreateCustomerInput,
} from '@/lib/validations/customer.schemas'

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
 * CUS-019: when `multi=1` is also passed, returns up to 10 matches instead
 * of just the first.
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
      // CUS-019: `multi=1` returns up to 10 matches (instead of just the
      // first) so the autocomplete dropdown can show all of them. Backwards
      // compatible — without `multi=1` the original single-result shape is
      // returned.
      if (url.searchParams.get('multi') === '1') {
        const result = await searchCustomersMulti(search, 10)
        if (!result.success) {
          throw new ApiError(400, result.error ?? 'Failed to search customers')
        }
        return Response.json(result.data)
      }
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

// ─────────────────────────────────────────────────────────────────────────────
// CUS-020: Zod schemas for the POST route layer.
//
// The customer create route previously used readBody<CreateCustomerInput>()
// (typed but NOT runtime-validated). Unexpected fields or invalid types
// could pass through to the action layer. These schemas add an explicit
// runtime check at the route boundary so malformed payloads are rejected
// with a clear 400 BEFORE the action function runs.
// ─────────────────────────────────────────────────────────────────────────────

// Re-export the existing createCustomerSchema (already defined in
// customer.schemas.ts). The route handler uses safeParse to validate the
// raw body before delegating to the createCustomer action. The action
// ALSO validates (defensive depth) — this route-level check is the
// first line of defense.
const routeCreateCustomerSchema = createCustomerSchema

// Flag/unflag payload schema — used for the action:{flag|unflag} branch.
const routeFlagCustomerSchema = {
  validate: (body: Record<string, unknown>): { ok: true; data: { customerId: string; action: 'flag' | 'unflag'; reason?: string } } | { ok: false; error: string } => {
    if (typeof body.customer_id !== 'string' || !body.customer_id.trim()) {
      return { ok: false, error: 'customer_id is required' }
    }
    if (body.action !== 'flag' && body.action !== 'unflag') {
      return { ok: false, error: `action must be 'flag' or 'unflag' (got: ${String(body.action)})` }
    }
    const reason = typeof body.reason === 'string' ? body.reason : undefined
    if (body.action === 'flag' && (!reason || reason.trim().length < 3)) {
      return { ok: false, error: 'A reason (min 3 chars) is required to flag a customer' }
    }
    return { ok: true, data: { customerId: body.customer_id, action: body.action, reason } }
  },
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
 *        addresses: [{ label?, address, city, country?, is_default }]
 *      }
 *    Validates via createCustomerSchema (exactly one primary phone, exactly
 *    one default address). Returns 201 with { customerId }.
 *
 * CUS-020: both branches now safeParse the raw body at the route layer —
 * unexpected fields or invalid types are rejected with 400 BEFORE the
 * action function runs.
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
      // CUS-020: route-layer Zod-style validation (manual safeParse via
      // routeFlagCustomerSchema since the flag/unflag shape isn't a Zod
      // schema anywhere else yet).
      const parsed = routeFlagCustomerSchema.validate(body)
      if (!parsed.ok) {
        throw new ApiError(400, parsed.error)
      }
      const { customerId, action, reason } = parsed.data

      if (action === 'flag') {
        const result = await flagCustomer(customerId, reason!.trim())
        if (!result.success) {
          throw new ApiError(400, result.error ?? 'Failed to flag customer')
        }
        return Response.json({ ok: true })
      }

      // action === 'unflag'
      const result = await unflagCustomer(customerId)
      if (!result.success) {
        throw new ApiError(400, result.error ?? 'Failed to unflag customer')
      }
      return Response.json({ ok: true })
    }

    // ── Create customer flow ──────────────────────────────────────────────
    // CUS-020: route-layer safeParse BEFORE delegating to the action. The
    // action also validates (defensive depth), but the route-level check
    // rejects malformed payloads with a clear 400 and never reaches the
    // action function. This blocks unexpected fields, invalid types, and
    // missing required fields at the boundary.
    const parsedCreate = routeCreateCustomerSchema.safeParse(body)
    if (!parsedCreate.success) {
      const firstIssue = parsedCreate.error.issues[0]
      const msg = firstIssue
        ? `${firstIssue.path.join('.') || 'body'}: ${firstIssue.message}`
        : 'Invalid customer payload'
      throw new ApiError(400, msg)
    }
    const input = parsedCreate.data as CreateCustomerInput

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
