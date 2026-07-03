import { db } from './db'
import type { SessionResponse } from './types'

/**
 * Build the full session payload returned by /auth/login and /auth/me:
 * the authenticated user, their list of companies, the active company,
 * and the caller's employee record + resolved permissions in that company.
 */
export async function buildSessionPayload(
  userId: string,
): Promise<SessionResponse> {
  const profile = await db.profile.findUnique({ where: { id: userId } })
  if (!profile) {
    return { user: null, activeCompany: null, companies: [], employee: null }
  }

  const settings = await db.userSetting.findUnique({
    where: { userId: profile.id },
  })

  const employees = await db.employee.findMany({
    where: { userId: profile.id, status: 'active' },
    include: { company: true, role: { include: { rolePermissions: true } } },
  })

  const companies = employees
    .map((e) => e.company)
    .filter((c) => c !== null && c.isActive)
    .map((c) => mapCompany(c))

  const activeCompanyId = settings?.activeCompanyId
  let activeEmployee = employees.find(
    (e) => e.companyId === activeCompanyId,
  )

  // If no active company set, fall back to the first available.
  if (!activeEmployee && employees.length > 0) {
    activeEmployee = employees[0]
    await db.userSetting.update({
      where: { userId: profile.id },
      data: {
        activeCompanyId: activeEmployee.companyId,
        activeOrgId: activeEmployee.company.organizationId,
      },
    })
  }

  const activeCompany = activeEmployee ? mapCompany(activeEmployee.company) : null

  const employee = activeEmployee
    ? {
        id: activeEmployee.id,
        roleTier: activeEmployee.role.roleTier,
        roleName: activeEmployee.role.name,
        systemRoleKey: activeEmployee.role.systemRoleKey,
        permissions: activeEmployee.role.rolePermissions.map(
          (p) => p.permissionKey,
        ),
        isElevated: activeEmployee.role.roleTier === 'elevated',
      }
    : null

  return {
    user: {
      id: profile.id,
      email: profile.email,
      fullName: profile.fullName,
      avatarUrl: profile.avatarUrl,
      phone: profile.phone,
      isOnboarded: profile.isOnboarded,
      createdAt: profile.createdAt.toISOString(),
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
