/**
 * Exchange rate utilities (Phase F1).
 *
 * ExchangeRateSnapshot stores rates relative to USD (1 USD = X units of the
 * currency). To convert an amount FROM a source currency TO a target currency:
 *   amountInTarget = amountInSource * (rateToBase_target / rateToBase_source)
 *
 * Used ONLY for display (estimated revenue totals). Never touches stored
 * order prices. If a rate is missing/stale, the per-currency breakdown
 * displays correctly on its own.
 */

import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'

/**
 * Get the latest exchange rate snapshots for a set of currencies.
 * Returns a Map<currency, rate> where rate is relative to USD (1 USD = rate).
 * If no snapshot exists for a currency, it's omitted from the map.
 */
export async function getLatestRates(
  currencies: string[],
): Promise<Map<string, number>> {
  if (currencies.length === 0) return new Map()

  const rates = new Map<string, number>()

  for (const currency of currencies) {
    const snapshot = await db.exchangeRateSnapshot.findFirst({
      where: { currency },
      orderBy: { fetchedAt: 'desc' },
      select: { rateToBaseCurrency: true },
    })
    if (snapshot) {
      rates.set(currency, Number(snapshot.rateToBaseCurrency))
    }
  }

  return rates
}

/**
 * Convert an amount from one currency to another using the latest snapshots.
 * Rates are relative to USD: amountInTarget = amount * (rateTarget / rateSource).
 *
 * @returns the converted amount, or null if either rate is missing.
 */
export function convertAmount(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  rates: Map<string, number>,
): number | null {
  if (fromCurrency === toCurrency) return amount

  const rateFrom = rates.get(fromCurrency)
  const rateTo = rates.get(toCurrency)

  if (!rateFrom || !rateTo) return null

  // amount in USD = amount / rateFrom (rateFrom = units per 1 USD)
  // amount in target = amountInUSD * rateTo
  return (amount / rateFrom) * rateTo
}

/**
 * Fetch current exchange rates from a free FX API and store snapshots.
 *
 * Uses open.er-api.com (free, no API key, returns rates relative to USD).
 * If the fetch fails (network error, API down), logs + returns gracefully —
 * existing snapshots remain usable. The per-currency breakdown works without
 * any rates; only the estimated total is affected.
 *
 * @param currencies the currencies to fetch rates for (e.g. ["PKR", "AED", "GBP"])
 * @returns the number of snapshots stored
 */
export async function syncExchangeRates(
  currencies: string[],
): Promise<{ stored: number; errors: string[] }> {
  const errors: string[] = []
  let stored = 0

  if (currencies.length === 0) return { stored: 0, errors }

  // Always include USD (the base currency for rate storage)
  const currenciesToFetch = [...new Set([...currencies, 'USD'])]

  try {
    // Fetch rates from open.er-api.com (free, no API key needed).
    // Returns { rates: { "PKR": 278.5, "AED": 3.67, ... } } relative to USD.
    const response = await fetch('https://open.er-api.com/v6/latest/USD', {
      headers: { 'Accept': 'application/json' },
      // 10s timeout — this is a fire-and-forget cron job
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      errors.push(`FX API returned ${response.status} ${response.statusText}`)
      return { stored: 0, errors }
    }

    const data = await response.json() as { rates?: Record<string, number> }
    if (!data.rates) {
      errors.push('FX API response missing "rates" field')
      return { stored: 0, errors }
    }

    const now = new Date()

    // Store a snapshot for each requested currency that the API returned
    for (const currency of currenciesToFetch) {
      const rate = data.rates[currency]
      if (rate && rate > 0) {
        await db.exchangeRateSnapshot.create({
          data: {
            currency,
            rateToBaseCurrency: rate,
            fetchedAt: now,
          },
        })
        stored++
      } else {
        errors.push(`No rate returned for ${currency}`)
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'Unknown fetch error')
  }

  return { stored, errors }
}

/**
 * Get all distinct base currencies across all companies.
 * With the market system removed, this is just the distinct baseCurrency
 * values from the company table. Used by the cron job that fetches exchange
 * rate snapshots for display-only revenue conversion.
 */
export async function getActiveCurrencies(_companyId?: string): Promise<string[]> {
  const companies = await db.company.findMany({
    where: _companyId ? { id: _companyId } : undefined,
    select: { baseCurrency: true },
    distinct: ['baseCurrency'],
  })
  return companies.map((c) => c.baseCurrency)
}
