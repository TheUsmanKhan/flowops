import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, getWorkspace } from '@/lib/workspace'
import { generatePayslipPdfBuffer } from '@/lib/utils/payslip-pdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/payroll/payslips/own/[payslipId]
 *
 * Returns the employee's own payslip detail (finalized/paid only — never draft).
 * Also supports ?format=pdf to download the PDF.
 *
 * Access control: identity check only — an employee can only ever view/download
 * their OWN payslips. payroll.view_all is NOT needed here (that's for the
 * Finance-side admin views in Phase 8).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ payslipId: string }> },
) {
  try {
    const ctx = await getWorkspace()
    const { payslipId } = await params

    // Fetch the payslip — MUST belong to the current employee (identity check)
    const payslip = await db.payslip.findFirst({
      where: { id: payslipId, employeeId: ctx.employee.id },
      include: {
        payrollRun: {
          select: {
            id: true,
            periodMonth: true,
            periodYear: true,
            status: true,
            companyId: true,
          },
        },
        employee: {
          select: {
            id: true,
            designation: true,
            user: { select: { fullName: true } },
          },
        },
      },
    })

    if (!payslip) throw new ApiError(404, 'Payslip not found')

    // Only show finalized/paid runs — never draft figures
    if (payslip.payrollRun.status === 'draft') {
      throw new ApiError(403, 'This payslip is not yet finalized — check back after the payroll run is finalized.')
    }

    // If ?format=pdf, generate and stream the PDF
    const url = new URL(req.url)
    if (url.searchParams.get('format') === 'pdf') {
      // Fetch company name for the PDF header
      const company = await db.company.findUnique({
        where: { id: payslip.payrollRun.companyId },
        select: { name: true, baseCurrency: true },
      })

      const pdfData = {
        companyName: company?.name ?? 'Unknown Company',
        employeeName: payslip.employee.user.fullName,
        designation: payslip.employee.designation,
        periodMonth: payslip.payrollRun.periodMonth,
        periodYear: payslip.payrollRun.periodYear,
        baseSalary: Number(payslip.baseSalary),
        commissionEarned: Number(payslip.commissionEarned),
        otherAllowances: Number(payslip.otherAllowances),
        advanceDeduction: Number(payslip.advanceDeduction),
        otherDeductions: Number(payslip.otherDeductions),
        grossPay: Number(payslip.grossPay),
        netPay: Number(payslip.netPay),
        paymentStatus: payslip.paymentStatus,
        paymentDate: payslip.paymentDate?.toISOString() ?? null,
        currency: company?.baseCurrency ?? 'PKR',
        generatedAt: new Date().toISOString(),
      }

      const buffer = await generatePayslipPdfBuffer(pdfData)

      return new Response(buffer, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="payslip-${payslip.payrollRun.periodYear}-${String(payslip.payrollRun.periodMonth).padStart(2, '0')}.pdf"`,
        },
      })
    }

    // Default: return JSON detail
    return Response.json({
      payslip: {
        id: payslip.id,
        periodMonth: payslip.payrollRun.periodMonth,
        periodYear: payslip.payrollRun.periodYear,
        runStatus: payslip.payrollRun.status,
        baseSalary: Number(payslip.baseSalary),
        commissionEarned: Number(payslip.commissionEarned),
        advanceDeduction: Number(payslip.advanceDeduction),
        otherDeductions: Number(payslip.otherDeductions),
        otherAllowances: Number(payslip.otherAllowances),
        grossPay: Number(payslip.grossPay),
        netPay: Number(payslip.netPay),
        paymentStatus: payslip.paymentStatus,
        paymentDate: payslip.paymentDate?.toISOString() ?? null,
        paymentMethod: payslip.paymentMethod,
        paymentReference: payslip.paymentReference,
      },
    })
  } catch (err) {
    return handleError(err)
  }
}
