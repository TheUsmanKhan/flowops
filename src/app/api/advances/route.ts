import { NextRequest } from 'next/server'
import { handleError, readBody } from '@/lib/workspace'
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
    const body = await readBody<{
      employeeId: string
      amount: number
      reason: string
      dateGiven?: string
      repaymentPlan: 'lump_sum' | 'installments'
      installmentAmount?: number
    }>(req)

    const result = await recordAdvance(body)
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json(result.data, { status: 201 })
  } catch (err) {
    return handleError(err)
  }
}
