/**
 * CUS-001, CUS-002, CUS-003, CUS-006, CUS-007, CUS-009 — DB repair script.
 *
 * One-time backfill that repairs all customer-management data integrity
 * issues identified in the Customer Management audit:
 *
 *   CUS-001 — Customers with zero CustomerPhone records (delete test
 *             customers with no orders; log real customers for manual review).
 *   CUS-002 — Re-normalize ALL phoneNormalized values via the fixed
 *             normalizePhoneInternational() function so duplicates with
 *             the same phone collapse onto the same canonical E.164.
 *   CUS-003 — Customers with zero CustomerAddress records (same approach
 *             as CUS-001).
 *   CUS-006 — Recompute cached stats for ALL customers (totalOrdersCount,
 *             totalOrderValue, totalRtoCount, lastOrderAt).
 *   CUS-007 — Backfill RTO flags: flag every customer with 3+ RTOs who
 *             isn't currently flagged.
 *   CUS-009 — Convert country NAMES stored on customer_addresses /
 *             orders.deliveryCountry to ISO 3166-1 alpha-2 codes.
 *
 * Writes an audit log to scripts/customer-repair-audit.json.
 *
 * Run with: bun run scripts/customer-repair.ts
 */
import { PrismaClient } from '@prisma/client'
import { writeFileSync } from 'node:fs'

// ── Inline port of normalizePhoneInternational (from src/lib/phone-validation.ts) ──
// Inlined here so this script doesn't need the Next.js alias resolution.
function normalizePhoneInternational(phone: string): string | null {
  const trimmed = (phone ?? '').trim()
  if (!trimmed) return null

  const hadPlusPrefix = trimmed.startsWith('+')
  const digits = trimmed.replace(/\D/g, '')

  if (digits.length < 7) return null
  if (digits.length > 15) return null

  if (digits.startsWith('0')) return '+92' + digits.slice(1)
  if (digits.startsWith('92')) return '+' + digits
  if (hadPlusPrefix) return '+' + digits
  return '+92' + digits
}

// Country NAME → alpha-2 code (CUS-009). Mirrors src/lib/data/countries.ts.
const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  pakistan: 'PK',
  'united arab emirates': 'AE',
  'united kingdom': 'GB',
  'united states': 'US',
  'united states of america': 'US',
  'saudi arabia': 'SA',
  canada: 'CA',
  australia: 'AU',
  india: 'IN',
  bangladesh: 'BD',
  china: 'CN',
  germany: 'DE',
  france: 'FR',
  italy: 'IT',
  spain: 'ES',
  netherlands: 'NL',
  turkey: 'TR',
  malaysia: 'MY',
  indonesia: 'ID',
  japan: 'JP',
  'south korea': 'KR',
  singapore: 'SG',
  thailand: 'TH',
  philippines: 'PH',
  vietnam: 'VN',
  egypt: 'EG',
  nigeria: 'NG',
  'south africa': 'ZA',
  kenya: 'KE',
  brazil: 'BR',
  mexico: 'MX',
  argentina: 'AR',
  russia: 'RU',
  ukraine: 'UA',
  poland: 'PL',
  sweden: 'SE',
  norway: 'NO',
  switzerland: 'CH',
  'new zealand': 'NZ',
  iraq: 'IQ',
  iran: 'IR',
  afghanistan: 'AF',
  'sri lanka': 'LK',
  nepal: 'NP',
  bahrain: 'BH',
  kuwait: 'KW',
  qatar: 'QA',
  oman: 'OM',
  jordan: 'JO',
  lebanon: 'LB',
  yemen: 'YE',
  algeria: 'DZ',
  morocco: 'MA',
  tunisia: 'TN',
  libya: 'LY',
  sudan: 'SD',
  ethiopia: 'ET',
  ghana: 'GH',
  tanzania: 'TZ',
  uganda: 'UG',
  portugal: 'PT',
  greece: 'GR',
  ireland: 'IE',
  austria: 'AT',
  belgium: 'BE',
  denmark: 'DK',
  finland: 'FI',
  czechia: 'CZ',
  hungary: 'HU',
  romania: 'RO',
  bulgaria: 'BG',
  croatia: 'HR',
  slovakia: 'SK',
  slovenia: 'SI',
  lithuania: 'LT',
  latvia: 'LV',
  estonia: 'EE',
  iceland: 'IS',
  luxembourg: 'LU',
  malta: 'MT',
  cyprus: 'CY',
  colombia: 'CO',
  chile: 'CL',
  peru: 'PE',
  venezuela: 'VE',
  ecuador: 'EC',
  bolivia: 'BO',
  paraguay: 'PY',
  uruguay: 'UY',
}

function countryNameToCode(name: string | null | undefined): string | null {
  if (!name) return null
  const trimmed = name.trim()
  if (!trimmed) return null
  // Already a 2-letter code → return as-is (uppercased).
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase()
  return COUNTRY_NAME_TO_CODE[trimmed.toLowerCase()] ?? null
}

interface AuditEntry {
  step: string
  timestamp: string
  details: Record<string, unknown>
}

const auditLog: AuditEntry[] = []
function logAudit(step: string, details: Record<string, unknown>) {
  const entry: AuditEntry = { step, timestamp: new Date().toISOString(), details }
  auditLog.push(entry)
  console.log(`[${entry.timestamp}] [${step}]`, JSON.stringify(details))
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const db = new PrismaClient({
    log: ['error', 'warn'],
    datasources: { db: { url: process.env.DATABASE_URL! } },
  })

  try {
    logAudit('start', { message: 'Customer DB repair script starting' })

    // ────────────────────────────────────────────────────────────────────
    // CUS-009 — Convert country NAMES → alpha-2 codes (do this FIRST so
    // subsequent steps see clean country values).
    // ────────────────────────────────────────────────────────────────────
    {
      const addressUpdates: Array<{ id: string; oldCountry: string; newCountry: string }> = []
      const orderUpdates: Array<{ id: string; oldCountry: string | null; newCountry: string | null }> = []

      // CustomerAddress.country — currently mostly 'PK' but some rows have
      // the full name 'Pakistan' (or other country names).
      const addresses = await db.customerAddress.findMany({
        where: { country: { not: { equals: '' } } },
        select: { id: true, country: true },
      })
      for (const a of addresses) {
        const code = countryNameToCode(a.country)
        if (code && code !== a.country) {
          await db.customerAddress.update({ where: { id: a.id }, data: { country: code } })
          addressUpdates.push({ id: a.id, oldCountry: a.country, newCountry: code })
        }
      }

      // Order.deliveryCountry — same problem, snapshot at order creation.
      const orders = await db.order.findMany({
        where: { deliveryCountry: { not: null } },
        select: { id: true, deliveryCountry: true },
      })
      for (const o of orders) {
        const code = countryNameToCode(o.deliveryCountry)
        if (code && code !== o.deliveryCountry) {
          await db.order.update({ where: { id: o.id }, data: { deliveryCountry: code } })
          orderUpdates.push({ id: o.id, oldCountry: o.deliveryCountry, newCountry: code })
        }
      }

      logAudit('CUS-009_country_codes', {
        customerAddressRowsInspected: addresses.length,
        customerAddressRowsUpdated: addressUpdates.length,
        orderRowsInspected: orders.length,
        orderRowsUpdated: orderUpdates.length,
        addressUpdates: addressUpdates.slice(0, 20), // first 20 for sampling
        orderUpdates: orderUpdates.slice(0, 20),
      })
    }

    // ────────────────────────────────────────────────────────────────────
    // CUS-002 — Re-normalize ALL phoneNormalized values via the fixed
    // normalizePhoneInternational() function.
    // ────────────────────────────────────────────────────────────────────
    {
      const phoneRows = await db.customerPhone.findMany({
        select: { id: true, phoneRaw: true, phoneNormalized: true, organizationId: true, customerId: true },
      })
      let updatedCount = 0
      const sampleChanges: Array<{ id: string; oldNorm: string; newNorm: string; raw: string }> = []
      const collisionWarnings: Array<{ orgId: string; norm: string; phoneIds: string[] }> = []

      // Group by target normalized value to detect collisions (same target
      // normalized value but different customerId → real duplicate that
      // needs manual merge).
      const byNormalized = new Map<string, Array<{ phoneId: string; customerId: string; orgId: string }>>()

      for (const p of phoneRows) {
        const newNorm = normalizePhoneInternational(p.phoneRaw)
        if (!newNorm) continue // can't normalize — leave as-is

        if (newNorm !== p.phoneNormalized) {
          updatedCount++
          if (sampleChanges.length < 20) {
            sampleChanges.push({ id: p.id, oldNorm: p.phoneNormalized, newNorm: newNorm, raw: p.phoneRaw })
          }
        }

        const key = `${p.organizationId}::${newNorm}`
        const list = byNormalized.get(key) ?? []
        list.push({ phoneId: p.id, customerId: p.customerId, orgId: p.organizationId })
        byNormalized.set(key, list)
      }

      // Detect collisions BEFORE writing — we can't update phoneNormalized
      // for collisions because that would violate the unique constraint.
      // For non-collisions, we update in place.
      const collisionNorms = new Set<string>()
      for (const [key, list] of byNormalized.entries()) {
        const distinctCustomers = new Set(list.map((x) => x.customerId))
        if (distinctCustomers.size > 1) {
          // Real duplicate — same normalized phone on multiple customers.
          // Log for manual review, DON'T touch the DB (the existing values
          // will stay as they are until a human merges the customers).
          const [orgId, norm] = key.split('::')
          collisionWarnings.push({
            orgId,
            norm,
            phoneIds: list.map((x) => x.phoneId),
          })
          collisionNorms.add(key)
        }
      }

      // Apply non-colliding updates.
      for (const p of phoneRows) {
        const newNorm = normalizePhoneInternational(p.phoneRaw)
        if (!newNorm) continue
        if (newNorm === p.phoneNormalized) continue
        const key = `${p.organizationId}::${newNorm}`
        if (collisionNorms.has(key)) continue // skip — would violate unique
        try {
          await db.customerPhone.update({
            where: { id: p.id },
            data: { phoneNormalized: newNorm },
          })
        } catch (err) {
          // If still collides at write time (race), log and continue.
          console.error(`[CUS-002] Failed to update phone ${p.id}:`, err)
        }
      }

      logAudit('CUS-002_phone_normalization', {
        phoneRowsInspected: phoneRows.length,
        phoneRowsUpdated: updatedCount,
        sampleChanges,
        duplicateCustomersNeedingManualMerge: collisionWarnings,
      })
    }

    // ────────────────────────────────────────────────────────────────────
    // CUS-001 — Customers with ZERO CustomerPhone records.
    //   - Test customers (no orders): delete them.
    //   - Real customers (with orders): log for manual review.
    // ────────────────────────────────────────────────────────────────────
    {
      const customersWithoutPhones = await db.$queryRaw<Array<{ id: string; name: string; organizationId: string }>>`
        SELECT c.id, c.name, c."organizationId"
        FROM "Customer" c
        WHERE NOT EXISTS (
          SELECT 1 FROM "customer_phones" cp WHERE cp."customerId" = c.id
        )
      `

      const deletedTestCustomers: Array<{ id: string; name: string }> = []
      const realCustomersForManualReview: Array<{ id: string; name: string; organizationId: string }> = []

      for (const c of customersWithoutPhones) {
        // Check if this customer has any orders
        const orderCount = await db.order.count({ where: { customerId: c.id } })
        if (orderCount === 0) {
          // Test customer with no orders — safe to delete. The cascade
          // will also clean up customer_addresses / external_identities.
          try {
            await db.customer.delete({ where: { id: c.id } })
            deletedTestCustomers.push({ id: c.id, name: c.name })
          } catch (err) {
            console.error(`[CUS-001] Failed to delete customer ${c.id}:`, err)
            realCustomersForManualReview.push({
              id: c.id,
              name: c.name,
              organizationId: c.organizationId,
            })
          }
        } else {
          realCustomersForManualReview.push({
            id: c.id,
            name: c.name,
            organizationId: c.organizationId,
          })
        }
      }

      logAudit('CUS-001_customers_without_phones', {
        totalCustomersWithoutPhones: customersWithoutPhones.length,
        testCustomersDeleted: deletedTestCustomers.length,
        realCustomersForManualReview: realCustomersForManualReview.length,
        deletedTestCustomers,
        realCustomersForManualReview,
      })
    }

    // ────────────────────────────────────────────────────────────────────
    // CUS-003 — Customers with ZERO CustomerAddress records.
    //   Same approach as CUS-001.
    // ────────────────────────────────────────────────────────────────────
    {
      const customersWithoutAddresses = await db.$queryRaw<Array<{ id: string; name: string; organizationId: string }>>`
        SELECT c.id, c.name, c."organizationId"
        FROM "Customer" c
        WHERE NOT EXISTS (
          SELECT 1 FROM "customer_addresses" ca WHERE ca."customerId" = c.id
        )
      `

      const deletedTestCustomers: Array<{ id: string; name: string }> = []
      const realCustomersForManualReview: Array<{ id: string; name: string; organizationId: string }> = []

      for (const c of customersWithoutAddresses) {
        const orderCount = await db.order.count({ where: { customerId: c.id } })
        if (orderCount === 0) {
          try {
            // Don't double-delete if CUS-001 already removed it.
            await db.customer.delete({ where: { id: c.id } })
            deletedTestCustomers.push({ id: c.id, name: c.name })
          } catch (err) {
            // Likely already deleted by CUS-001 step (cascade).
            // Or a real DB error — log and move on.
            const message = err instanceof Error ? err.message : String(err)
            if (!message.includes('Record to delete does not exist')) {
              console.error(`[CUS-003] Failed to delete customer ${c.id}:`, err)
            }
            realCustomersForManualReview.push({
              id: c.id,
              name: c.name,
              organizationId: c.organizationId,
            })
          }
        } else {
          realCustomersForManualReview.push({
            id: c.id,
            name: c.name,
            organizationId: c.organizationId,
          })
        }
      }

      logAudit('CUS-003_customers_without_addresses', {
        totalCustomersWithoutAddresses: customersWithoutAddresses.length,
        testCustomersDeleted: deletedTestCustomers.length,
        realCustomersForManualReview: realCustomersForManualReview.length,
        deletedTestCustomers,
        realCustomersForManualReview,
      })
    }

    // ────────────────────────────────────────────────────────────────────
    // CUS-006 — Recompute cached stats for ALL customers.
    //   Direct SQL (no action-function permission check needed — this is a
    //   maintenance script run by an admin).
    // ────────────────────────────────────────────────────────────────────
    {
      const customers = await db.customer.findMany({
        select: { id: true, name: true, totalOrdersCount: true, totalOrderValue: true, totalRtoCount: true },
      })
      let updated = 0
      const sampleUpdates: Array<{ id: string; name: string; before: { orders: number; value: number; rto: number }; after: { orders: number; value: number; rto: number } }> = []

      for (const c of customers) {
        const orders = await db.order.findMany({
          where: { customerId: c.id, status: { not: 'cancelled' } },
          select: { totalOrderValue: true, status: true },
        })
        const totalOrdersCount = orders.length
        const revenueOrders = orders.filter((o) => o.status === 'delivered' || o.status === 'dispatched')
        const totalOrderValue = revenueOrders.reduce((sum, o) => sum + Number(o.totalOrderValue), 0)
        const totalRtoCount = orders.filter((o) => o.status === 'rto').length

        const before = { orders: c.totalOrdersCount, value: Number(c.totalOrderValue), rto: c.totalRtoCount }
        const after = { orders: totalOrdersCount, value: totalOrderValue, rto: totalRtoCount }

        if (
          before.orders !== after.orders ||
          before.value !== after.value ||
          before.rto !== after.rto
        ) {
          updated++
          if (sampleUpdates.length < 20) {
            sampleUpdates.push({ id: c.id, name: c.name, before, after })
          }
          await db.customer.update({
            where: { id: c.id },
            data: { totalOrdersCount, totalOrderValue, totalRtoCount },
          })
        }
      }

      logAudit('CUS-006_recompute_stats', {
        customersInspected: customers.length,
        customersUpdated: updated,
        sampleUpdates,
      })
    }

    // ────────────────────────────────────────────────────────────────────
    // CUS-007 — Backfill RTO flags for customers with 3+ RTOs.
    // ────────────────────────────────────────────────────────────────────
    {
      const flagged = await db.customer.updateMany({
        where: { totalRtoCount: { gte: 3 }, isFlagged: false },
        data: {
          isFlagged: true,
          flaggedReason: 'Auto-flagged: 3+ RTO rate exceeded (backfill)',
          flaggedAt: new Date(),
          flaggedBy: null,
        },
      })

      logAudit('CUS-007_backfill_rto_flags', {
        customersFlagged: flagged.count,
        reason: 'Auto-flagged: 3+ RTO rate exceeded (backfill)',
      })
    }

    // ────────────────────────────────────────────────────────────────────
    // Done. Write audit log to disk.
    // ────────────────────────────────────────────────────────────────────
    const auditPath = new URL('../scripts/customer-repair-audit.json', import.meta.url).pathname
    writeFileSync(auditPath, JSON.stringify(auditLog, null, 2))
    logAudit('done', {
      message: 'Customer DB repair complete. Audit log written.',
      auditPath,
    })
  } finally {
    await db.$disconnect()
  }
}

main().catch((err) => {
  console.error('Customer DB repair script FAILED:', err)
  process.exit(1)
})
