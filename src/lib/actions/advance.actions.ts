/**
 * Employee Salary Advances — record, list, settle against payroll runs.
 *
 * Common in Pakistani SME workplaces — an employee needs cash before payday.
 * Tracked properly + automatically reconciled against future payroll runs.
 *
 * Repayment plans:
 *   lump_sum     — full remainingBalance deducted from the very next payroll run
 *   installments — installmentAmount deducted each run until remainingBalance → 0
 *
 * The deduction logic is wired into generatePayrollRun() via computeAdvanceDeduction().
 */

import { db } from '@/lib/db'
import { getWorkspace, requirePermission, ApiError } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'
import { insertAuditLog } from '@/lib/audit'
import type { Prisma } from '@prisma/client'

interface ActionResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// ──────────────────────────────────────────────────────────────
// 1. Record Advance (requires payroll.manage_advances)
// ──────────────────────────────────────────────────────────────

export async function recordAdvance(input: {
  employeeId: string
  amount: number
  reason: string
  dateGiven?: string
  repaymentPlan: 'lump_sum' | 'installments'
  installmentAmount?: number
}): Promise<ActionResult<{ advanceId: string }>> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.PAYROLL_MANAGE_ADVANCES)

    if (input.amount <= 0) {
      return { success: false, error: 'Amount must be > 0' }
    }
    if (input.repaymentPlan === 'installments') {
      if (!input.installmentAmount || input.installmentAmount <= 0) {
        return { success: false, error: 'Installment amount is required for installment plans and must be > 0' }
      }
      if (input.installmentAmount > input.amount) {
        return { success: false, error: 'Installment amount cannot exceed the advance amount' }
      }
    }

    // Verify the employee belongs to the caller's company
    const employee = await db.employee.findFirst({
      where: { id: input.employeeId, companyId: ctx.company.id, status: 'active' },
      select: { id: true, user: { select: { fullName: true } } },
    })
    if (!employee) return { success: false, error: 'Employee not found or inactive' }

    const advance = await db.employeeAdvance.create({
      data: {
        employeeId: input.employeeId,
        amount: input.amount,
        reason: input.reason,
        dateGiven: input.dateGiven ? new Date(input.dateGiven) : new Date(),
        repaymentPlan: input.repaymentPlan,
        installmentAmount: input.repaymentPlan === 'installments' ? input.installmentAmount : null,
        remainingBalance: input.amount,
        status: 'active',
        createdByEmployeeId: ctx.employee.id,
      },
    })

    insertAuditLog({
      action: 'payroll.advance_recorded',
      entityType: 'employee_advance',
      entityId: advance.id,
      companyId: ctx.company.id,
      organizationId: ctx.company.organizationId,
      userId: ctx.user.id,
      employeeId: ctx.employee.id,
      newValues: {
        employeeId: input.employeeId,
        employeeName: employee.user.fullName,
        amount: input.amount,
        reason: input.reason,
        repaymentPlan: input.repaymentPlan,
        installmentAmount: input.installmentAmount ?? null,
      },
    })

    return { success: true, data: { advanceId: advance.id } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to record advance',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 2. List Advances (requires payroll.manage_advances)
// ──────────────────────────────────────────────────────────────

export async function listAdvances(filter?: {
  employeeId?: string
  status?: 'active' | 'settled'
}): Promise<ActionResult<{
  advances: Array<{
    id: string
    employeeId: string
    employeeName: string
    designation: string | null
    amount: number
    reason: string
    dateGiven: string
    repaymentPlan: string
    installmentAmount: number | null
    remainingBalance: number
    status: string
    createdAt: string
  }>
}>> {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.PAYROLL_MANAGE_ADVANCES)

    // Get employee IDs for this company first
    const companyEmployees = await db.employee.findMany({
      where: { companyId: ctx.company.id },
      select: { id: true },
    })
    const employeeIds = companyEmployees.map((e) => e.id)

    const where: Prisma.EmployeeAdvanceWhereInput = {
      employeeId: { in: employeeIds },
    }
    if (filter?.employeeId) where.employeeId = filter.employeeId
    if (filter?.status) where.status = filter.status

    const advances = await db.employeeAdvance.findMany({
      where,
      include: {
        employee: {
          select: { designation: true, user: { select: { fullName: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return {
      success: true,
      data: {
        advances: advances.map((a) => ({
          id: a.id,
          employeeId: a.employeeId,
          employeeName: a.employee.user.fullName,
          designation: a.employee.designation,
          amount: Number(a.amount),
          reason: a.reason,
          dateGiven: a.dateGiven.toISOString(),
          repaymentPlan: a.repaymentPlan,
          installmentAmount: a.installmentAmount ? Number(a.installmentAmount) : null,
          remainingBalance: Number(a.remainingBalance),
          status: a.status,
          createdAt: a.createdAt.toISOString(),
        })),
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list advances',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 3. Get Own Advances (employee-facing, identity check only)
// ──────────────────────────────────────────────────────────────

export async function getOwnAdvances(): Promise<ActionResult<{
  advances: Array<{
    id: string
    amount: number
    reason: string
    dateGiven: string
    repaymentPlan: string
    installmentAmount: number | null
    remainingBalance: number
    status: string
    createdAt: string
  }>
}>> {
  try {
    const ctx = await getWorkspace()

    const advances = await db.employeeAdvance.findMany({
      where: { employeeId: ctx.employee.id },
      orderBy: { createdAt: 'desc' },
    })

    return {
      success: true,
      data: {
        advances: advances.map((a) => ({
          id: a.id,
          amount: Number(a.amount),
          reason: a.reason,
          dateGiven: a.dateGiven.toISOString(),
          repaymentPlan: a.repaymentPlan,
          installmentAmount: a.installmentAmount ? Number(a.installmentAmount) : null,
          remainingBalance: Number(a.remainingBalance),
          status: a.status,
          createdAt: a.createdAt.toISOString(),
        })),
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to get advances',
    }
  }
}

// ──────────────────────────────────────────────────────────────
// 4. Compute Advance Deduction for a payroll run (internal helper)
// ──────────────────────────────────────────────────────────────
// Called by generatePayrollRun() — for each employee, checks active advances,
// computes the total deduction, and SETTLES the advances (updates remainingBalance
// + status). Must be called INSIDE the payroll run's transaction so the advance
// updates + payslip creation are atomic.
//
// Returns the total deduction amount (sum across all active advances for this employee).

/**
 * Compute + settle advance deductions for an employee within a payroll run transaction.
 *
 * MUST be called inside a db.$transaction — it mutates EmployeeAdvance rows.
 *
 * For each active advance:
 *   lump_sum:     deduct full remainingBalance → set to 0, status='settled'
 *   installments: deduct min(installmentAmount, remainingBalance) → handles final
 *                 partial installment → set status='settled' when remainingBalance=0
 *
 * @param tx         The Prisma transaction client
 * @param employeeId The employee whose advances to settle
 * @returns The total deduction amount for this employee
 */
export async function computeAndSettleAdvanceDeduction(
  tx: Prisma.TransactionClient,
  employeeId: string,
): Promise<number> {
  const activeAdvances = await tx.employeeAdvance.findMany({
    where: { employeeId, status: 'active' },
  })

  let totalDeduction = 0

  for (const advance of activeAdvances) {
    let deduction = 0
    let newRemainingBalance = Number(advance.remainingBalance)
    let newStatus = 'active'

    if (advance.repaymentPlan === 'lump_sum') {
      // Deduct the full remaining balance
      deduction = newRemainingBalance
      newRemainingBalance = 0
      newStatus = 'settled'
    } else if (advance.repaymentPlan === 'installments') {
      // Deduct min(installmentAmount, remainingBalance) — handles final partial installment
      const installment = Number(advance.installmentAmount)
      deduction = Math.min(installment, newRemainingBalance)
      newRemainingBalance = Math.max(0, newRemainingBalance - deduction)
      if (newRemainingBalance === 0) {
        newStatus = 'settled'
      }
    }

    if (deduction > 0) {
      await tx.employeeAdvance.update({
        where: { id: advance.id },
        data: {
          remainingBalance: newRemainingBalance,
          status: newStatus,
        },
      })
      totalDeduction += deduction
    }
  }

  return totalDeduction
}
