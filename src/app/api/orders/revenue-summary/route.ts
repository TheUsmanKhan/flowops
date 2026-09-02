import { db } from '@/lib/db'
import { getWorkspace, ApiError, handleError } from '@/lib/workspace'
import { computeRevenueWithCurrencies } from '@/lib/analytics/revenue'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/orders/revenue-summary
 *
 * Returns currency-aware revenue for the orders-view stat card (Phase F1).
 * Computes the per-currency breakdown + an estimated total in the company's
 * baseCurrency using the latest ExchangeRateSnapshot.
 *
 * Query params (same filters as /api/orders):
 *   - statuses: comma-separated status filter (default: all non-cancelled)
 *   - dateFrom, dateTo: date range
 *
 * Response:
 *   {
 *     perCurrency: { "PKR": 50000, "AED": 3000, ... },
 *     estimatedTotalBase: 52300,  // converted to baseCurrency (or null if rates missing)
 *     baseCurrency: "PKR",
 *     estimateComplete: boolean
 *   }
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await getWorkspace()

    const url = new URL(req.url)
    const statusesParam = url.searchParams.get('statuses')
    const dateFrom = url.searchParams.get('dateFrom')
    const dateTo = url.searchParams.get('dateTo')

    const where: {
      companyId: string
      status?: { in: string[] }
      createdAt?: { gte?: Date; lte?: Date }
    } = { companyId: ctx.company.id }

    // Default: non-cancelled (same as the existing orders-view revenue card)
    if (statusesParam) {
      where.status = { in: statusesParam.split(',') }
    } else {
      // Exclude cancelled by default (matches the existing stat card logic)
      // We can't do status: { not: 'cancelled' } with the typed where easily,
      // so we fetch all + filter client-side in the revenue function
    }

    if (dateFrom || dateTo) {
      where.createdAt = {}
      if (dateFrom) where.createdAt.gte = new Date(dateFrom)
      if (dateTo) {
        const end = new Date(dateTo)
        end.setHours(23, 59, 59, 999)
        where.createdAt.lte = end
      }
    }

    const orders = await db.order.findMany({
      where,
      select: {
        totalOrderValue: true,
        status: true,
        deliveryCountry: true,
      },
    })

    // Filter out cancelled (matches existing orders-view revenue logic)
    const revenueOrders = orders
      .filter((o) => o.status !== 'cancelled')
      .map((o) => ({
        totalOrderValue: Number(o.totalOrderValue),
        deliveryCountry: o.deliveryCountry,
      }))

    const result = await computeRevenueWithCurrencies(
      ctx.company.id,
      revenueOrders,
      ctx.company.baseCurrency,
    )

    return Response.json({
      perCurrency: Object.fromEntries(result.perCurrency),
      estimatedTotalBase: result.estimatedTotalBase,
      baseCurrency: result.baseCurrency,
      estimateComplete: result.estimateComplete,
    })
  } catch (err) {
    return handleError(err)
  }
}
