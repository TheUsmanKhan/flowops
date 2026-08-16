import { NextRequest } from 'next/server'
import { ApiError, handleError, readBody, getWorkspace } from '@/lib/workspace'
import { generatePayrollRun, listPayrollRuns } from '@/lib/actions/payroll.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/payroll — list all payroll runs for the company */
export async function GET() {
  try {
    const result = await listPayrollRuns()
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}

/** POST /api/payroll — generate a new payroll run */
export async function POST(req: NextRequest) {
  try {
    const idempotencyKey = req.headers.get('Idempotency-Key')
    const body = await readBody<{ periodMonth: number; periodYear: number }>(req)

    // Core creation logic — calls the action function and throws on failure
    // so withIdempotency marks the ticket as 'failed' (allowing genuine retry).
    const runCreate = async () => {
      const result = await generatePayrollRun(body.periodMonth, body.periodYear)
      if (!result.success) {
        throw new ApiError(400, result.error ?? 'Failed to generate payroll run')
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
        actionType: 'payroll_run.create',
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
