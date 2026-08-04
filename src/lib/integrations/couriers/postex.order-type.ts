/**
 * PostEx Order Type Decision Logic — pure function.
 *
 * Determines which PostEx `orderType` to use for a booking, based on:
 *   - Whether this is a courier_replacement exchange shipment
 *   - The total order weight (from Prompt 1's calculateOrderWeightKg utility)
 *   - Whether any variant's weight is missing (NULL)
 *
 * Confirmed order types from PostEx API: "Normal", "Reversed", "Replacement", "Overland".
 *   - "Reversed" must NEVER be used (explicit PostEx instruction) — no code path
 *     may generate this value. This function does NOT return 'Reversed'.
 *   - "Overland" is used per the weight rule below (heavy packages or missing weight).
 *   - "Replacement" is used only for courier_replacement exchange method bookings.
 *   - "Normal" is the default for all regular orders.
 */

export type PostExOrderType = 'Normal' | 'Replacement' | 'Overland'

/**
 * Determine the PostEx order type for a booking.
 *
 * Logic (in priority order):
 *   1. If isExchangeReplacement is true → always return 'Replacement' regardless
 *      of weight (this is an exchange-method decision, not a weight decision).
 *   2. Else if hasMissingWeight is true → return 'Overland' (safe fallback).
 *   3. Else if totalWeightKg > 1.0 → return 'Overland'.
 *   4. Else → return 'Normal'.
 *
 * 'Reversed' is never returned by this function under any input.
 *
 * @param totalWeightKg - Total order weight in KG (from calculateOrderWeightKg())
 * @param hasMissingWeight - True if any variant's weightKg is NULL (from calculateOrderWeightKg())
 * @param isExchangeReplacement - True if this is a courier_replacement exchange shipment
 * @returns The PostEx order type string to send in the create-order API call
 */
export function determinePostExOrderType(
  totalWeightKg: number,
  hasMissingWeight: boolean,
  isExchangeReplacement: boolean,
): PostExOrderType {
  // Rule 1: Exchange replacement always takes priority — it's an exchange-method
  // decision, not a weight decision. Confirmed: "Replacement" is used only for
  // courier_replacement exchange method bookings.
  if (isExchangeReplacement) {
    return 'Replacement'
  }

  // Rule 2: If weight is missing for ANY item, fall back to Overland (safe default
  // — Overland handles heavier/unknown-weight packages).
  if (hasMissingWeight) {
    return 'Overland'
  }

  // Rule 3: Packages over 1kg go Overland.
  if (totalWeightKg > 1.0) {
    return 'Overland'
  }

  // Rule 4: Default — light packages with known weight go Normal.
  return 'Normal'
}
