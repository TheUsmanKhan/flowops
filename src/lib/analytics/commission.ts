/**
 * Commission Calculation — computes earned commission for an employee
 * based on their active CommissionRule + order data.
 *
 * Key design principle: once an order/item has crossed the trigger status,
 * it counts as earned PERMANENTLY — no clawback. An order that never reached
 * the trigger status (e.g. cancelled before dispatch when trigger="dispatched")
 * naturally contributes 0 because the trigger timestamp field is null.
 *
 * Basis types:
 *   per_order              → count of qualifying orders × rate (currency amount)
 *   per_item_sold          → sum of OrderItem.quantity × rate (currency amount per item)
 *   percentage_of_revenue  → sum of order revenue × rate (0-1 fraction, e.g. 0.02 = 2%)
 */

import { db } from '@/lib/db'

export interface CommissionEarnedResult {
  totalEarned: number
  qualifyingOrderCount: number
  qualifyingItemQty: number
  qualifyingRevenue: number
  rule: {
    id: string
    basisType: string
    rateValue: number
    triggerStatus: string
  } | null
}

/**
 * Map a trigger status to the corresponding Order timestamp field.
 * If the timestamp is non-null AND within [periodStart, periodEnd], the order
 * qualifies for commission.
 */
function triggerStatusToTimestampField(triggerStatus: string): string | null {
  switch (triggerStatus) {
    case 'confirmed': return 'confirmedAt'
    case 'processing': return 'packedAt' // packed = processing transition
    case 'packed': return 'packedAt'
    case 'dispatched': return 'dispatchedAt'
    case 'delivered': return 'deliveredAt'
    case 'rto': return 'returnedAt'
    case 'cancelled': return 'cancelledAt'
    default: return null
  }
}

/**
 * Compute the commission earned by an employee within a period.
 *
 * @param employeeId   The employee whose commission to compute
 * @param periodStart  Start of the period (inclusive)
 * @param periodEnd    End of the period (inclusive)
 * @returns The computed commission total + breakdown
 */
export async function computeCommissionEarned(
  employeeId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<CommissionEarnedResult> {
  // Fetch the employee's active CommissionRule (v1: one active rule per employee)
  const rule = await db.commissionRule.findFirst({
    where: { employeeId, isActive: true },
    orderBy: { updatedAt: 'desc' }, // if multiple exist, use the most recent
  })

  if (!rule) {
    return {
      totalEarned: 0,
      qualifyingOrderCount: 0,
      qualifyingItemQty: 0,
      qualifyingRevenue: 0,
      rule: null,
    }
  }

  const timestampField = triggerStatusToTimestampField(rule.triggerStatus)
  if (!timestampField) {
    // Unrecognized trigger status — can't compute
    return {
      totalEarned: 0,
      qualifyingOrderCount: 0,
      qualifyingItemQty: 0,
      qualifyingRevenue: 0,
      rule: {
        id: rule.id,
        basisType: rule.basisType,
        rateValue: Number(rule.rateValue),
        triggerStatus: rule.triggerStatus,
      },
    }
  }

  // Build the WHERE clause: orders attributed to this employee where the
  // trigger timestamp is non-null AND within [periodStart, periodEnd].
  //
  // IMPORTANT: we do NOT filter by current status — once an order crossed the
  // trigger, it counts permanently even if it later became RTO/cancelled.
  // The timestamp being non-null is the proof it crossed the trigger.
  const periodEndInclusive = new Date(periodEnd)
  periodEndInclusive.setHours(23, 59, 59, 999)

  // We need to dynamically reference the timestamp field. Since Prisma's
  // type system doesn't allow dynamic field names in where clauses, we use
  // a typed approach: build the filter based on the known field name.
  const whereBase = {
    salesEmployeeId: employeeId,
  }

  // Fetch qualifying orders with their items (for per_item_sold + revenue)
  const qualifyingOrders = await db.order.findMany({
    where: {
      ...whereBase,
      // Dynamic timestamp filter — the field must be non-null AND in range
      AND: [
        { [timestampField]: { not: null } },
        { [timestampField]: { gte: periodStart } },
        { [timestampField]: { lte: periodEndInclusive } },
      ],
    },
    select: {
      id: true,
      totalOrderValue: true,
      items: {
        select: { quantity: true },
      },
    },
  })

  const qualifyingOrderCount = qualifyingOrders.length
  const qualifyingItemQty = qualifyingOrders.reduce(
    (sum, o) => sum + o.items.reduce((s, i) => s + i.quantity, 0),
    0,
  )
  const qualifyingRevenue = qualifyingOrders.reduce(
    (sum, o) => sum + Number(o.totalOrderValue),
    0,
  )

  // Apply the basis calculation
  const rate = Number(rule.rateValue)
  let totalEarned = 0

  switch (rule.basisType) {
    case 'per_order':
      totalEarned = qualifyingOrderCount * rate
      break
    case 'per_item_sold':
      totalEarned = qualifyingItemQty * rate
      break
    case 'percentage_of_revenue':
      totalEarned = qualifyingRevenue * rate
      break
    default:
      totalEarned = 0
  }

  return {
    totalEarned,
    qualifyingOrderCount,
    qualifyingItemQty,
    qualifyingRevenue,
    rule: {
      id: rule.id,
      basisType: rule.basisType,
      rateValue: rate,
      triggerStatus: rule.triggerStatus,
    },
  }
}

/**
 * Get the current calendar month's start + end dates.
 * Used for the "This Month So Far" live preview.
 */
export function getCurrentMonthRange(): { start: Date; end: Date } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
  return { start, end }
}
