import { isValidPhoneNumber, parsePhoneNumber } from 'libphonenumber-js'

/**
 * International phone validation + normalization using libphonenumber-js.
 *
 * Design:
 * - If the input starts with '+', it's treated as an international number
 *   and validated against any country's rules.
 * - If the input does NOT start with '+', the defaultCountry ('PK' by default)
 *   is used to interpret it as a local number (e.g., "03001234567" → Pakistan).
 * - isValidPhoneFormat: returns true/false — use for client + server validation.
 * - normalizePhoneInternational: returns E.164 format (e.g., "+923001234567")
 *   if valid, null if not parseable. This is the value to save/compare for dedup.
 *
 * Compatibility with existing normalize_phone() SQL function:
 * - The SQL function (in supabase/functions-only.sql) handles Pakistan-specific
 *   normalization (strips leading 0, adds +92). It is still used by the DB-level
 *   match_or_create_customer() function for fuzzy matching.
 * - This helper EXTENDS that to handle international numbers correctly. For Pakistani
 *   numbers, both produce the same E.164 result (+923001234567). For international
 *   numbers (e.g., +44... or +971...), only this helper handles them — the SQL
 *   function would produce incorrect results for non-PK numbers.
 * - The phoneNormalized column in customer_phones stores this helper's output.
 */

const DEFAULT_COUNTRY = 'PK' as const

/**
 * Check if a phone number is valid in international format.
 * Defaults to Pakistan ('PK') for numbers without a country code.
 */
export function isValidPhoneFormat(phone: string, defaultCountry: string = DEFAULT_COUNTRY): boolean {
  const trimmed = phone.trim()
  if (!trimmed) return false
  try {
    return isValidPhoneNumber(trimmed, defaultCountry as any)
  } catch {
    return false
  }
}

/**
 * Normalize a phone number to E.164 format (e.g., "+923001234567" — NO spaces).
 * Returns null if the number cannot be parsed.
 * Defaults to Pakistan ('PK') for numbers without a country code.
 *
 * IMPORTANT: The output format MUST match the SQL `normalize_phone()` function
 * (stored in the `phone_normalized` DB column). Both produce E.164 without
 * spaces. This allows the pure-JS function to be a drop-in replacement for
 * the SQL function — no network round-trip needed.
 */
export function normalizePhoneInternational(phone: string, defaultCountry: string = DEFAULT_COUNTRY): string | null {
  const trimmed = phone.trim()
  if (!trimmed) return null
  try {
    const parsed = parsePhoneNumber(trimmed, defaultCountry as any)
    if (!parsed) return null
    // isValidPhoneNumber is the authoritative check — parsePhoneNumber can
    // sometimes parse invalid numbers. We only return the normalized form
    // if the number is actually valid.
    if (!isValidPhoneNumber(trimmed, defaultCountry as any)) return null
    // E.164 format: +923001234567 (no spaces) — matches the DB column.
    // Do NOT use formatInternational() — it adds spaces (+92 300 1234567)
    // which won't match the stored phoneNormalized values.
    return parsed.format('E.164')
  } catch {
    return null
  }
}

/**
 * Check if a phone number is valid AND get its normalized form in one call.
 * Returns { isValid, normalized } where normalized is E.164 or null.
 */
export function validateAndNormalizePhone(
  phone: string,
  defaultCountry: string = DEFAULT_COUNTRY,
): { isValid: boolean; normalized: string | null } {
  const normalized = normalizePhoneInternational(phone, defaultCountry)
  return {
    isValid: normalized !== null,
    normalized,
  }
}
