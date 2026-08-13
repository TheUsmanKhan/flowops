import { NextRequest } from 'next/server'
import { handleError, readBody } from '@/lib/workspace'
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
    const body = await readBody<{ periodMonth: number; periodYear: number }>(req)
    const result = await generatePayrollRun(body.periodMonth, body.periodYear)
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json(result.data, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
