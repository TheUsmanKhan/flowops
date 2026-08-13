/**
 * Payroll Server Actions — generate, adjust, finalize, mark-paid, list, get payslips.
 *
 * Uses dedicated payroll.* permission keys (NOT finance.*) so salary visibility
 * stays properly restricted — a Manager with finance.view does NOT automatically
 * see payroll.
 *
 * Once finalized, a PayrollRun and its Payslips are IMMUTABLE — corrections happen
 * via new adjustment entries in a LATER run, never silent edits (mirrors the
 * audit-log immutability pattern used throughout FlowOps).
 */

import { db } from '@/lib/db'
import { getWorkspace, requirePermission, ApiError } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'
import { insertAuditLog } from '@/lib/audit'
import { computeCommissionEarned } from '@/lib/analytics/commission'
import { computeAndSettleAdvanceDeduction } from '@/lib/actions/advance.actions'

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// ──────────────────────────────────────────────────────────────
// 1. Generate Payroll Run
// ──────────────────────────────────────────────────────────────

export async function generatePayrollRun(
  periodMonth: number,
  periodYear: number,
): Promise<ActionResult<{ runId: string; payslipCount: number }>> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.PAYROLL_MANAGE)

    if (periodMonth < 1 || periodMonth > 12) {
      return { success: false, error: 'Invalid month (must be 1-12)' }
    }

    // Check for existing run (unique constraint enforcement at app level too)
    const existing = await db.payrollRun.findUnique({
      where: {
        companyId_periodMonth_periodYear: {
          companyId: ctx.company.id,
          periodMonth,
          periodYear,
        },
      },
    })
    if (existing) {
      return {
        success: false,
        error: `A payroll run already exists for ${periodMonth}/${periodYear} (status: ${existing.status})`,
      }
    }

    // Period date range (1st of month to last day of month)
    const periodStart = new Date(periodYear, periodMonth - 1, 1)
    const periodEnd = new Date(periodYear, periodMonth, 0, 23, 59, 59, 999)

    // Fetch all active employees with a salary profile
    const employees = await db.employee.findMany({
      where: {
        companyId: ctx.company.id,
        status: 'active',
        salaryProfile: { status: 'active' },
      },
      include: {
        salaryProfile: true,
        user: { select: { fullName: true } },
      },
    })

    if (employees.length === 0) {
      return { success: false, error: 'No active employees with a salary profile found. Set base salaries first.' }
    }

    // Create the PayrollRun + all Payslips in a transaction
    const run = await db.$transaction(async (tx) => {
      const payrollRun = await tx.payrollRun.create({
        data: {
          companyId: ctx.company.id,
          periodMonth,
          periodYear,
          status: 'draft',
          generatedAt: new Date(),
        },
      })

      let payslipCount = 0
      for (const emp of employees) {
        const baseSalary = Number(emp.salaryProfile!.baseSalary)

        // Compute commission earned for this period
        const commission = await computeCommissionEarned(emp.id, periodStart, periodEnd)
        const commissionEarned = commission.totalEarned

        // Phase 9 — Compute + settle advance deductions from active EmployeeAdvance
        // records. This settles the advances (updates remainingBalance + status)
        // INSIDE the transaction so the advance updates + payslip creation are atomic.
        const advanceDeduction = await computeAndSettleAdvanceDeduction(tx, emp.id)

        const otherAllowances = 0
        const otherDeductions = 0

        const grossPay = baseSalary + commissionEarned + otherAllowances
        const netPay = grossPay - advanceDeduction - otherDeductions

        await tx.payslip.create({
          data: {
            payrollRunId: payrollRun.id,
            employeeId: emp.id,
            baseSalary,
            commissionEarned,
            advanceDeduction,
            otherDeductions,
            otherAllowances,
            grossPay,
            netPay,
            paymentStatus: 'pending',
          },
        })
        payslipCount++
      }

      return { run: payrollRun, payslipCount }
    })

    insertAuditLog({
      action: 'payroll.run_generated',
      entityType: 'payroll_run',
      entityId: run.run.id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { periodMonth, periodYear, payslipCount: run.payslipCount, status: 'draft' },
    })

    return {
      success: true,
      data: { runId: run.run.id, payslipCount: run.payslipCount },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to generate payroll run',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 2. List Payroll Runs
// ──────────────────────────────────────────────────────────────

export async function listPayrollRuns(): Promise<ActionResult<{
  runs: Array<{
    id: string
    periodMonth: number
    periodYear: number
    status: string
    generatedAt: string | null
    finalizedAt: string | null
    payslipCount: number
    totalNetPay: number
  }>
}>> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.PAYROLL_MANAGE)

    const runs = await db.payrollRun.findMany({
      where: { companyId: ctx.company.id },
      include: {
        _count: { select: { payslips: true } },
        payslips: { select: { netPay: true } },
      },
      orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }],
    })

    return {
      success: true,
      data: {
        runs: runs.map((r) => ({
          id: r.id,
          periodMonth: r.periodMonth,
          periodYear: r.periodYear,
          status: r.status,
          generatedAt: r.generatedAt?.toISOString() ?? null,
          finalizedAt: r.finalizedAt?.toISOString() ?? null,
          payslipCount: r._count.payslips,
          totalNetPay: r.payslips.reduce((sum, p) => sum + Number(p.netPay), 0),
        })),
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list payroll runs',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 3. Get Payroll Run Detail (with payslips)
// ──────────────────────────────────────────────────────────────

export async function getPayrollRunDetail(
  runId: string,
): Promise<ActionResult<{
  run: {
    id: string
    periodMonth: number
    periodYear: number
    status: string
    generatedAt: string | null
    finalizedAt: string | null
  }
  payslips: Array<{
    id: string
    employeeId: string
    employeeName: string
    designation: string | null
    baseSalary: number
    commissionEarned: number
    advanceDeduction: number
    otherDeductions: number
    otherAllowances: number
    grossPay: number
    netPay: number
    paymentStatus: string
    paymentDate: string | null
    paymentMethod: string | null
    paymentReference: string | null
  }>
}>> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.PAYROLL_MANAGE)

    const run = await db.payrollRun.findFirst({
      where: { id: runId, companyId: ctx.company.id },
      include: {
        payslips: {
          include: {
            employee: {
              select: {
                id: true,
                designation: true,
                user: { select: { fullName: true } },
              },
            },
          },
          orderBy: { employee: { user: { fullName: 'asc' } } },
        },
      },
    })

    if (!run) return { success: false, error: 'Payroll run not found' }

    return {
      success: true,
      data: {
        run: {
          id: run.id,
          periodMonth: run.periodMonth,
          periodYear: run.periodYear,
          status: run.status,
          generatedAt: run.generatedAt?.toISOString() ?? null,
          finalizedAt: run.finalizedAt?.toISOString() ?? null,
        },
        payslips: run.payslips.map((p) => ({
          id: p.id,
          employeeId: p.employeeId,
          employeeName: p.employee.user.fullName,
          designation: p.employee.designation,
          baseSalary: Number(p.baseSalary),
          commissionEarned: Number(p.commissionEarned),
          advanceDeduction: Number(p.advanceDeduction),
          otherDeductions: Number(p.otherDeductions),
          otherAllowances: Number(p.otherAllowances),
          grossPay: Number(p.grossPay),
          netPay: Number(p.netPay),
          paymentStatus: p.paymentStatus,
          paymentDate: p.paymentDate?.toISOString() ?? null,
          paymentMethod: p.paymentMethod,
          paymentReference: p.paymentReference,
        })),
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to get payroll run detail',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 4. Adjust Payslip (draft status only)
// ──────────────────────────────────────────────────────────────

export async function adjustPayslip(
  payslipId: string,
  adjustments: {
    otherAllowances?: number
    otherDeductions?: number
  },
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.PAYROLL_MANAGE)

    const payslip = await db.payslip.findFirst({
      where: { id: payslipId },
      include: { payrollRun: { select: { id: true, status: true, companyId: true } } },
    })
    if (!payslip) return { success: false, error: 'Payslip not found' }
    if (payslip.payrollRun.companyId !== ctx.company.id) {
      return { success: false, error: 'Payslip not found' }
    }
    if (payslip.payrollRun.status !== 'draft') {
      return { success: false, error: 'Cannot adjust a payslip in a finalized/paid run' }
    }

    const otherAllowances = adjustments.otherAllowances ?? Number(payslip.otherAllowances)
    const otherDeductions = adjustments.otherDeductions ?? Number(payslip.otherDeductions)

    const baseSalary = Number(payslip.baseSalary)
    const commissionEarned = Number(payslip.commissionEarned)
    const advanceDeduction = Number(payslip.advanceDeduction)
    const grossPay = baseSalary + commissionEarned + otherAllowances
    const netPay = grossPay - advanceDeduction - otherDeductions

    await db.payslip.update({
      where: { id: payslipId },
      data: { otherAllowances, otherDeductions, grossPay, netPay },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to adjust payslip',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 5. Finalize Payroll Run (lock it — immutable after this)
// ──────────────────────────────────────────────────────────────

export async function finalizePayrollRun(
  runId: string,
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.PAYROLL_MANAGE)

    const run = await db.payrollRun.findFirst({
      where: { id: runId, companyId: ctx.company.id },
    })
    if (!run) return { success: false, error: 'Payroll run not found' }
    if (run.status !== 'draft') {
      return { success: false, error: `Run is already ${run.status} (cannot finalize)` }
    }

    await db.payrollRun.update({
      where: { id: runId },
      data: {
        status: 'finalized',
        finalizedByEmployeeId: ctx.employee.id,
        finalizedAt: new Date(),
      },
    })

    insertAuditLog({
      action: 'payroll.run_finalized',
      entityType: 'payroll_run',
      entityId: runId,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: { status: 'finalized' },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to finalize payroll run',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 6. Mark Payslip as Paid (finalized runs only)
// ──────────────────────────────────────────────────────────────

export async function markPayslipPaid(
  payslipId: string,
  payment: {
    paymentMethod?: string
    paymentReference?: string
  },
): Promise<ActionResult> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.PAYROLL_MANAGE)

    const payslip = await db.payslip.findFirst({
      where: { id: payslipId },
      include: { payrollRun: { select: { status: true, companyId: true } } },
    })
    if (!payslip) return { success: false, error: 'Payslip not found' }
    if (payslip.payrollRun.companyId !== ctx.company.id) {
      return { success: false, error: 'Payslip not found' }
    }
    if (payslip.payrollRun.status !== 'finalized') {
      return { success: false, error: 'Can only mark payslips as paid in a finalized run' }
    }

    await db.payslip.update({
      where: { id: payslipId },
      data: {
        paymentStatus: 'paid',
        paymentDate: new Date(),
        paymentMethod: payment.paymentMethod ?? null,
        paymentReference: payment.paymentReference ?? null,
      },
    })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to mark payslip as paid',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 7. Bulk Mark All Payslips as Paid
// ──────────────────────────────────────────────────────────────

export async function markAllPayslipsPaid(
  runId: string,
  payment: {
    paymentMethod?: string
    paymentReference?: string
  },
): Promise<ActionResult<{ markedCount: number }>> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.PAYROLL_MANAGE)

    const run = await db.payrollRun.findFirst({
      where: { id: runId, companyId: ctx.company.id },
    })
    if (!run) return { success: false, error: 'Payroll run not found' }
    if (run.status !== 'finalized') {
      return { success: false, error: 'Can only mark payslips as paid in a finalized run' }
    }

    const result = await db.payslip.updateMany({
      where: { payrollRunId: runId, paymentStatus: 'pending' },
      data: {
        paymentStatus: 'paid',
        paymentDate: new Date(),
        paymentMethod: payment.paymentMethod ?? null,
        paymentReference: payment.paymentReference ?? null,
      },
    })

    return { success: true, data: { markedCount: result.count } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to mark payslips as paid',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 8. Get Own Payslips (employee-facing — no permission needed, identity check)
// ──────────────────────────────────────────────────────────────

export async function getOwnPayslips(): Promise<ActionResult<{
  payslips: Array<{
    id: string
    periodMonth: number
    periodYear: number
    runStatus: string
    baseSalary: number
    commissionEarned: number
    advanceDeduction: number
    otherDeductions: number
    otherAllowances: number
    grossPay: number
    netPay: number
    paymentStatus: string
    paymentDate: string | null
  }>
}>> {
  try {
    const ctx = await getWorkspace()

    const payslips = await db.payslip.findMany({
      where: { employeeId: ctx.employee.id },
      include: {
        payrollRun: {
          select: { periodMonth: true, periodYear: true, status: true },
        },
      },
      orderBy: [{ payrollRun: { periodYear: 'desc' } }, { payrollRun: { periodMonth: 'desc' } }],
    })

    return {
      success: true,
      data: {
        payslips: payslips.map((p) => ({
          id: p.id,
          periodMonth: p.payrollRun.periodMonth,
          periodYear: p.payrollRun.periodYear,
          runStatus: p.payrollRun.status,
          baseSalary: Number(p.baseSalary),
          commissionEarned: Number(p.commissionEarned),
          advanceDeduction: Number(p.advanceDeduction),
          otherDeductions: Number(p.otherDeductions),
          otherAllowances: Number(p.otherAllowances),
          grossPay: Number(p.grossPay),
          netPay: Number(p.netPay),
          paymentStatus: p.paymentStatus,
          paymentDate: p.paymentDate?.toISOString() ?? null,
        })),
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to get payslips',
    }
  }
}
