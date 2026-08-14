import { db } from './db'
import type { SessionResponse } from './types'

/**
 * Build the full session payload returned by /auth/login and /auth/me.
 *
 * PERFORMANCE: This function uses a SINGLE raw SQL query (prisma.$queryRaw)
 * that JOINs Profile + UserSetting + Employee + Company + Role + RolePermission
 * in one statement.
 *
 * Root cause was confirmed via profiling: the previous Prisma call with nested
 * includes generated 3+ separate SQL statements (Prisma splits one-to-many
 * relations into separate queries to avoid row-explosion). Each round-trip costs
 * ~100ms in network latency to Supabase Mumbai, totaling 500-1000ms. EXPLAIN
 * ANALYZE confirmed the actual query execution was 0.195ms — the cost is purely
 * network round-trips. A single raw SQL JOIN collapses this to 1 round-trip.
 *
 * The response shape is IDENTICAL to the previous implementation — the frontend
 * (useAppStore.setSession) expects the exact same SessionResponse structure.
 *
 * Raw SQL follows the same convention as generate_order_number() — see
 * supabase/functions-only.sql for reference SQL style.
 */

interface SessionRow {
  // Profile
  user_id: string
  user_email: string
  user_full_name: string
  user_avatar_url: string | null
  user_phone: string | null
  user_is_onboarded: boolean
  user_created_at: Date
  // UserSetting
  settings_active_company_id: string | null
  // Employee
  employee_id: string
  employee_company_id: string
  employee_joined_at: Date
  // Company
  company_id: string
  company_name: string
  company_legal_name: string | null
  company_slug: string
  company_logo_url: string | null
  company_base_currency: string
  company_country_code: string
  company_tax_id: string | null
  company_tax_id_type: string | null
  company_timezone: string
  company_email: string | null
  company_phone: string | null
  company_website: string | null
  company_address_street: string | null
  company_address_city: string | null
  company_address_province: string | null
  company_address_postal_code: string | null
  company_address_country: string | null
  company_organization_id: string
  company_is_active: boolean
  company_created_at: Date
  // Role
  role_id: string
  role_name: string
  role_tier: string
  role_system_role_key: string | null
  // RolePermission (one row per permission — grouped in JS)
  permission_key: string | null
}

export async function buildSessionPayload(
  userId: string,
): Promise<SessionResponse> {
  // SINGLE SQL QUERY — joins 6 tables in one round-trip.
  // Filters: active employees only, active companies only.
  // Ordered by employee.joinedAt so the first row is the fallback active employee.
  const rows = await db.$queryRaw<SessionRow[]>`
    SELECT
      p.id            AS user_id,
      p.email         AS user_email,
      p."fullName"    AS user_full_name,
      p."avatarUrl"   AS user_avatar_url,
      p.phone         AS user_phone,
      p."isOnboarded" AS user_is_onboarded,
      p."createdAt"   AS user_created_at,

      us."activeCompanyId" AS settings_active_company_id,

      e.id            AS employee_id,
      e."companyId"   AS employee_company_id,
      e."joinedAt"    AS employee_joined_at,

      c.id              AS company_id,
      c.name            AS company_name,
      c."legalName"     AS company_legal_name,
      c.slug            AS company_slug,
      c."logoUrl"       AS company_logo_url,
      c."baseCurrency"  AS company_base_currency,
      c."countryCode"   AS company_country_code,
      c."taxId"         AS company_tax_id,
      c."taxIdType"     AS company_tax_id_type,
      c.timezone        AS company_timezone,
      c.email           AS company_email,
      c.phone           AS company_phone,
      c.website         AS company_website,
      c."addressStreet" AS company_address_street,
      c."addressCity"   AS company_address_city,
      c."addressProvince" AS company_address_province,
      c."addressPostalCode" AS company_address_postal_code,
      c."addressCountry" AS company_address_country,
      c."organizationId" AS company_organization_id,
      c."isActive"      AS company_is_active,
      c."createdAt"     AS company_created_at,

      r.id              AS role_id,
      r.name            AS role_name,
      r."roleTier"      AS role_tier,
      r."systemRoleKey" AS role_system_role_key,

      rp."permissionKey" AS permission_key
    FROM "Profile" p
    LEFT JOIN "UserSetting" us ON us."userId" = p.id
    LEFT JOIN "Employee" e ON e."userId" = p.id AND e.status = 'active'
    LEFT JOIN "Company" c ON c.id = e."companyId" AND c."isActive" = true
    LEFT JOIN "Role" r ON r.id = e."roleId"
    LEFT JOIN "RolePermission" rp ON rp."roleId" = r.id
    WHERE p.id = ${userId}
    ORDER BY e."joinedAt" ASC, rp."permissionKey" ASC
  `

  if (rows.length === 0 || !rows[0].user_id) {
    return { user: null, activeCompany: null, companies: [], employee: null }
  }

  const first = rows[0]

  // Group employees: each employee may span multiple rows (one per permission).
  // Build a map of employee_id → { employee, company, role, permissions[] }
  const employeeMap = new Map<string, {
    employeeId: string
    companyId: string
    joinedAt: Date
    company: NonNullable<Parameters<typeof mapCompany>[0]> | null
    role: {
      id: string
      name: string
      roleTier: string
      systemRoleKey: string | null
      permissions: string[]
    }
  }>()

  for (const row of rows) {
    if (!row.employee_id) continue // LEFT JOIN produced nulls (no employees)
    if (!employeeMap.has(row.employee_id)) {
      const company = row.company_id ? {
        id: row.company_id,
        name: row.company_name,
        legalName: row.company_legal_name,
        slug: row.company_slug,
        logoUrl: row.company_logo_url,
        baseCurrency: row.company_base_currency,
        countryCode: row.company_country_code,
        taxId: row.company_tax_id,
        taxIdType: row.company_tax_id_type,
        timezone: row.company_timezone,
        email: row.company_email,
        phone: row.company_phone,
        website: row.company_website,
        addressStreet: row.company_address_street,
        addressCity: row.company_address_city,
        addressProvince: row.company_address_province,
        addressPostalCode: row.company_address_postal_code,
        addressCountry: row.company_address_country,
        organizationId: row.company_organization_id,
        createdAt: row.company_created_at,
      } : null

      employeeMap.set(row.employee_id, {
        employeeId: row.employee_id,
        companyId: row.employee_company_id,
        joinedAt: row.employee_joined_at,
        company,
        role: {
          id: row.role_id,
          name: row.role_name,
          roleTier: row.role_tier,
          systemRoleKey: row.role_system_role_key,
          permissions: [],
        },
      })
    }
    // Add permission key (one row per permission due to LEFT JOIN with RolePermission)
    if (row.permission_key) {
      employeeMap.get(row.employee_id)!.role.permissions.push(row.permission_key)
    }
  }

  const employees = Array.from(employeeMap.values())

  // Build companies list (active companies only — already filtered in SQL)
  const companies = employees
    .map((e) => e.company)
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .map((c) => mapCompany(c))

  // Resolve active employee
  const activeCompanyId = first.settings_active_company_id
  let activeEmployee = employees.find((e) => e.companyId === activeCompanyId)

  // If no active company set, fall back to the first available.
  // This is the ONLY remaining write — and only fires once per user (first login)
  // or if their active company was deleted (SetNull in schema).
  if (!activeEmployee && employees.length > 0) {
    activeEmployee = employees[0]
    await db.userSetting.update({
      where: { userId: first.user_id },
      data: {
        activeCompanyId: activeEmployee.companyId,
        activeOrgId: activeEmployee.company?.organizationId ?? null,
      },
    })
  }

  const activeCompany = activeEmployee?.company ? mapCompany(activeEmployee.company) : null

  const employee = activeEmployee
    ? {
        id: activeEmployee.employeeId,
        roleTier: activeEmployee.role.roleTier,
        roleName: activeEmployee.role.name,
        systemRoleKey: activeEmployee.role.systemRoleKey,
        permissions: activeEmployee.role.permissions,
        isElevated: activeEmployee.role.roleTier === 'elevated',
      }
    : null

  return {
    user: {
      id: first.user_id,
      email: first.user_email,
      fullName: first.user_full_name,
      avatarUrl: first.user_avatar_url,
      phone: first.user_phone,
      isOnboarded: first.user_is_onboarded,
      createdAt: first.user_created_at.toISOString(),
    },
    activeCompany,
    companies,
    employee,
  }
}

function mapCompany(c: {
  id: string
  name: string
  legalName: string | null
  slug: string
  logoUrl: string | null
  baseCurrency: string
  countryCode: string
  taxId: string | null
  taxIdType: string | null
  timezone: string
  email: string | null
  phone: string | null
  website: string | null
  addressStreet: string | null
  addressCity: string | null
  addressProvince: string | null
  addressPostalCode: string | null
  addressCountry: string | null
  organizationId: string
  createdAt: Date
}) {
  return {
    id: c.id,
    name: c.name,
    legalName: c.legalName,
    slug: c.slug,
    logoUrl: c.logoUrl,
    baseCurrency: c.baseCurrency,
    countryCode: c.countryCode,
    taxId: c.taxId,
    taxIdType: c.taxIdType,
    timezone: c.timezone,
    email: c.email,
    phone: c.phone,
    website: c.website,
    addressStreet: c.addressStreet,
    addressCity: c.addressCity,
    addressProvince: c.addressProvince,
    addressPostalCode: c.addressPostalCode,
    addressCountry: c.addressCountry,
    organizationId: c.organizationId,
    createdAt: c.createdAt.toISOString(),
  }
}
