import { handleError } from '@/lib/workspace'
import { getOwnPayslips } from '@/lib/actions/payroll.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/payroll/payslips/own
 * Returns the current employee's own payslips (no special permission needed —
 * identity check only). Only finalized/paid runs' payslips are meaningful,
 * but draft payslips are also returned so the employee can see pending runs.
 */
export async function GET() {
  try {
    const result = await getOwnPayslips()
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}
