/**
 * Order weight calculation utility.
 *
 * Sums quantity × weightKg across all order items. This is a standalone
 * utility — NOT wired into order creation or courier booking yet. It is
 * ready for later phases (courier Overland vs Normal order type decision)
 * to import and use.
 *
 * Uses Decimal-aware input (Prisma Decimal or number or null) to avoid
 * floating-point summation errors when many items are summed.
 *
 * If ANY item's weightKg is null, `hasMissingWeight` is true and
 * `totalWeightKg` should be treated as unreliable by callers. The calling
 * code (built in a later prompt) is expected to use `hasMissingWeight` to
 * force a safe "Overland" fallback — that courier-facing decision is NOT
 * implemented here.
 */

/**
 * Input shape — flexible to accept Prisma Decimal, number, or null.
 * `Decimal` from Prisma has a `.toNumber()` method.
 */
interface WeightedItem {
  quantity: number
  variant: {
    // Accept Prisma Decimal (has toNumber()), plain number, or null
    weightKg: { toNumber: () => number } | number | null
  }
}

export interface OrderWeightResult {
  /** Total weight in KG. Unreliable if `hasMissingWeight` is true. */
  totalWeightKg: number
  /** True if any item's weightKg is null. Callers should fall back to a safe
   *  default (e.g. force Overland) when this is true. */
  hasMissingWeight: boolean
}

export function calculateOrderWeightKg(items: WeightedItem[]): OrderWeightResult {
  let totalWeightKg = 0
  let hasMissingWeight = false

  for (const item of items) {
    const w = item.variant?.weightKg
    if (w == null) {
      hasMissingWeight = true
      continue
    }
    const weightNum = typeof w === 'number' ? w : w.toNumber()
    totalWeightKg += item.quantity * weightNum
  }

  // Round to 3 decimal places to match the DB precision (Decimal(6,3))
  return {
    totalWeightKg: Math.round(totalWeightKg * 1000) / 1000,
    hasMissingWeight,
  }
}
