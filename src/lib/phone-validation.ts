import { isValidPhoneNumber, parsePhoneNumber } from 'libphonenumber-js'

/**
 * International phone validation + normalization.
 *
 * Design:
 * - normalizePhoneInternational() is a PURE string-transformation function
 *   that ALWAYS produces a consistent E.164 format (no spaces, no dashes,
 *   just `+<countrycode><nationalnumber>`). It does NOT use libphonenumber-js
 *   so it never returns `null` for valid-but-unparseable inputs — it just
 *   applies a deterministic set of string rules. This guarantees the SAME
 *   input always produces the SAME output, which is required for the
 *   `phoneNormalized` unique index to actually prevent duplicates.
 * - isValidPhoneFormat() still uses libphonenumber-js for client-side
 *   format validation (so users see "invalid phone" warnings). The two
 *   functions are intentionally decoupled: validation can be strict while
 *   normalization is permissive (any 7+ digit input normalizes to something).
 *
 * Compatibility with existing normalize_phone() SQL function:
 * - For Pakistani numbers, both produce the same "+923001234567" output.
 * - For international numbers, this helper handles them correctly (the SQL
 *   function historically mangled non-PK numbers). The SQL function is
 *   still used by match_or_create_customer() for legacy compatibility;
 *   the JS function is the authoritative normalizer for the app layer.
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
 * Normalize a phone number to a CONSISTENT E.164 format (e.g. "+923001234567").
 *
 * Algorithm (deterministic — same input always yields the same output):
 *   1. Strip ALL non-digit characters (spaces, dashes, parens, etc).
 *   2. If the original input started with "+", keep the "+" prefix.
 *   3. If the digits start with "0" (Pakistani local format like "0300…"),
 *      replace the "0" with "92" and prepend "+".
 *   4. If the digits start with "92" (already has Pakistan country code),
 *      just prepend "+".
 *   5. If the digits start with any other country code AND the original
 *      input had a "+" prefix, prepend "+".
 *   6. Otherwise (no "+", no "0", no "92" prefix) — default to Pakistan:
 *      prepend "+92".
 *
 * Returns null only for inputs with fewer than 7 digits (too short to be
 * a real phone number).
 *
 * IMPORTANT: This MUST be the only normalization path used anywhere in
 * the app. Any other normalization (e.g. libphonenumber-js's format()
 * variants) will produce different strings and break the unique index.
 */
export function normalizePhoneInternational(
  phone: string,
  _defaultCountry: string = DEFAULT_COUNTRY,
): string | null {
  const trimmed = (phone ?? '').trim()
  if (!trimmed) return null

  const hadPlusPrefix = trimmed.startsWith('+')

  // 1. Strip ALL non-digit characters.
  const digits = trimmed.replace(/\D/g, '')

  // Reject inputs that are clearly not phone numbers.
  if (digits.length < 7) return null
  if (digits.length > 15) return null

  // 2. Pakistani local format: starts with "0" (e.g. "03001234567" → "+923001234567").
  if (digits.startsWith('0')) {
    return '+92' + digits.slice(1)
  }

  // 3. Already has Pakistan country code without "+" (e.g. "923001234567" → "+923001234567").
  if (digits.startsWith('92')) {
    return '+' + digits
  }

  // 4. Original input had a "+" prefix — preserve it for international numbers
  //    (e.g. "+447911123456" → "+447911123456", "+971501234567" → "+971501234567").
  if (hadPlusPrefix) {
    return '+' + digits
  }

  // 5. No "+" prefix and no recognizable Pakistan prefix — default to Pakistan.
  //    This matches the previous behavior where ambiguous numbers were treated
  //    as local Pakistani numbers.
  return '+92' + digits
}

/**
 * Check if a phone number is valid AND get its normalized form in one call.
 * Returns { isValid, normalized } where normalized is E.164 or null.
 *
 * NOTE: `isValid` is computed via libphonenumber-js (strict). `normalized`
 * is computed via the deterministic normalizePhoneInternational() above
 * (permissive). The two are intentionally decoupled — see file header.
 */
export function validateAndNormalizePhone(
  phone: string,
  defaultCountry: string = DEFAULT_COUNTRY,
): { isValid: boolean; normalized: string | null } {
  const normalized = normalizePhoneInternational(phone, defaultCountry)
  return {
    isValid: normalized !== null && isValidPhoneFormat(phone, defaultCountry),
    normalized,
  }
}

/**
 * Best-effort parse via libphonenumber-js. Used by UI components that want
 * to display formatted phone numbers (e.g. "+92 300 1234567" with spaces).
 * NOT used for normalization — see normalizePhoneInternational() above.
 */
export function formatPhoneForDisplay(
  phone: string,
  defaultCountry: string = DEFAULT_COUNTRY,
): string | null {
  try {
    const parsed = parsePhoneNumber(phone.trim(), defaultCountry as any)
    if (!parsed) return null
    return parsed.formatInternational()
  } catch {
    return null
  }
}
