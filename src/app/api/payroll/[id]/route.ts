import { NextRequest } from 'next/server'
import { handleError, readBody } from '@/lib/workspace'
import {
  getPayrollRunDetail,
  finalizePayrollRun,
  markAllPayslipsPaid,
  adjustPayslip,
  markPayslipPaid,
} from '@/lib/actions/payroll.actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/payroll/[id] — get payroll run detail with payslips */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const result = await getPayrollRunDetail(id)
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 })
    }
    return Response.json(result.data)
  } catch (err) {
    return handleError(err)
  }
}

/** PATCH /api/payroll/[id] — finalize or mark-all-paid (via action body) */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await readBody<{
      action: 'finalize' | 'mark_all_paid'
      paymentMethod?: string
      paymentReference?: string
    }>(req)

    if (body.action === 'finalize') {
      const result = await finalizePayrollRun(id)
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 })
      }
      return Response.json({ success: true })
    }

    if (body.action === 'mark_all_paid') {
      const result = await markAllPayslipsPaid(id, {
        paymentMethod: body.paymentMethod,
        paymentReference: body.paymentReference,
      })
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 })
      }
      return Response.json(result.data)
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    return handleError(err)
  }
}

/** PUT /api/payroll/[id] — adjust a payslip or mark individual payslip as paid */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: runId } = await params
    const body = await readBody<{
      payslipId: string
      action: 'adjust' | 'mark_paid'
      otherAllowances?: number
      otherDeductions?: number
      paymentMethod?: string
      paymentReference?: string
    }>(req)

    if (body.action === 'adjust') {
      const result = await adjustPayslip(body.payslipId, {
        otherAllowances: body.otherAllowances,
        otherDeductions: body.otherDeductions,
      })
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 })
      }
      return Response.json({ success: true })
    }

    if (body.action === 'mark_paid') {
      const result = await markPayslipPaid(body.payslipId, {
        paymentMethod: body.paymentMethod,
        paymentReference: body.paymentReference,
      })
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 })
      }
      return Response.json({ success: true })
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    return handleError(err)
  }
}
