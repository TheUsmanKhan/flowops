import { NextRequest } from 'next/server'
import { ApiError, handleError, readBody, getWorkspace } from '@/lib/workspace'
import { recordAdvance, listAdvances } from '@/lib/actions/advance.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/advances — list advances (optional filters: employeeId, status) */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const employeeId = url.searchParams.get('employeeId') || undefined
    const status = url.searchParams.get('status') as 'active' | 'settled' | undefined

    const result = await listAdvances({
      employeeId: employeeId || undefined,
      status: status || undefined,
    })
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}

/** POST /api/advances — record a new advance */
export async function POST(req: NextRequest) {
  try {
    const idempotencyKey = req.headers.get('Idempotency-Key')
    const body = await readBody<{
      employeeId: string
      amount: number
      reason: string
      dateGiven?: string
      repaymentPlan: 'lump_sum' | 'installments'
      installmentAmount?: number
    }>(req)

    // Core creation logic — calls the action function and throws on failure
    // so withIdempotency marks the ticket as 'failed' (allowing genuine retry).
    const runCreate = async () => {
      const result = await recordAdvance(body)
      if (!result.success) {
        throw new ApiError(400, result.error ?? 'Failed to record advance')
      }
      return result.data
    }

    if (idempotencyKey) {
      // Resolve workspace at the route layer so we have companyId/employeeId
      // to scope the idempotency key. The action function re-resolves the
      // same workspace internally — that's a single extra JOIN, acceptable.
      const ctx = await getWorkspace()
      const { withIdempotency } = await import('@/lib/idempotency')
      const { result, wasReplay } = await withIdempotency({
        key: idempotencyKey,
        companyId: ctx.company.id,
        employeeId: ctx.employee.id,
        actionType: 'advance.create',
        fn: runCreate,
      })
      return Response.json(result, { status: wasReplay ? 200 : 201 })
    }

    // No idempotency key — normal flow (backwards-compatible)
    // runCreate() throws an ApiError on failure → handleError returns the
    // original { error } shape with the same status code.
    const result = await runCreate()
    return Response.json(result, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
