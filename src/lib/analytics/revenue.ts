/**
 * Shared, currency-aware revenue calculation (Phase F1).
 *
 * Replaces the 3 separate ad-hoc reduces that were all currency-blind:
 *   - orders-view.tsx (client-side reduce)
 *   - order-funnel.ts computeOrderFunnelStats (backend)
 *   - customer.actions.ts updateCustomerStats (cached customer stats)
 *
 * This function returns:
 *   - perCurrency: a Map<currency, total> grouped by the company's base
 *     currency (single-currency, since markets are removed — every order's
 *     revenue is denominated in the company's base currency).
 *   - estimatedTotalBase: same as the perCurrency total (no conversion needed
 *     now that there's a single currency per company).
 *
 * CONVENTION: this function never touches, recalculates, or influences any
 * actual Order's stored price/currency. It is for DISPLAY ONLY.
 */

import { db } from '@/lib/db'

export interface RevenueResult {
  /** Per-currency breakdown: currency code → total amount in that currency.
   * Always accurate (raw sums, no conversion). */
  perCurrency: Map<string, number>
  /** Estimated total converted to the company's baseCurrency using the latest
   * exchange rate snapshots. With markets removed, this equals the
   * perCurrency total (single currency per company). */
  estimatedTotalBase: number | null
  /** The base currency code (e.g. "PKR") for labeling the estimated total. */
  baseCurrency: string
  /** Whether all currencies had rates available (true = estimate is complete).
   * With markets removed, this is always true (single currency per company). */
  estimateComplete: boolean
}

/**
 * Compute revenue from a list of orders, with per-currency breakdown + an
 * estimated converted total.
 *
 * With the market system removed, every order's revenue is denominated in the
 * company's baseCurrency — so the perCurrency breakdown has at most one entry
 * and the estimated total equals the raw sum. The signature is preserved for
 * backwards-compatibility with callers (orders-view, customer stats, etc.).
 *
 * @param companyId the active company (kept for API compatibility — not used)
 * @param orders array of order rows with at least { totalOrderValue }
 * @param baseCurrency the company's baseCurrency (from ctx.company)
 */
export async function computeRevenueWithCurrencies(
  _companyId: string,
  orders: Array<{ totalOrderValue: number; deliveryCountry?: string | null }>,
  baseCurrency: string,
): Promise<RevenueResult> {
  const perCurrency = new Map<string, number>()

  if (orders.length === 0) {
    return { perCurrency, estimatedTotalBase: 0, baseCurrency, estimateComplete: true }
  }

  // Group sums by the company's baseCurrency (single currency now — markets removed).
  let total = 0
  for (const order of orders) {
    total += order.totalOrderValue
  }
  perCurrency.set(baseCurrency, total)

  return { perCurrency, estimatedTotalBase: total, baseCurrency, estimateComplete: true }
}

