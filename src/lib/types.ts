/** App-level TypeScript types shared between client and server. */

export interface UserPublic {
  id: string
  email: string
  fullName: string
  avatarUrl: string | null
  phone: string | null
  isOnboarded: boolean
  createdAt: string
}

export interface CompanyPublic {
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
  createdAt: string
}

export interface OrganizationPublic {
  id: string
  name: string
  slug: string
  logoUrl: string | null
  subscriptionPlan: string
  subscriptionStatus: string
  ownerId: string
  createdAt: string
}

export interface RolePublic {
  id: string
  name: string
  description: string | null
  roleTier: string
  isSystemRole: boolean
  systemRoleKey: string | null
  isActive: boolean
  companyId: string
  permissions: string[]
  /** Data scope for the Orders module: "own" = see only own orders, "all" = see all company orders. Elevated roles always behave as "all". */
  ordersDataScope: 'own' | 'all'
  employeeCount?: number
}

export interface EmployeePublic {
  id: string
  employeeCode: string | null
  department: string | null
  designation: string | null
  status: string
  joinedAt: string
  terminatedAt: string | null
  terminationReason: string | null
  user: UserPublic
  role: {
    id: string
    name: string
    roleTier: string
    isSystemRole: boolean
    systemRoleKey: string | null
    ordersDataScope: 'own' | 'all'
  }
  directManager: { id: string; user: { fullName: string } } | null
}

export interface InvitationPublic {
  id: string
  token: string
  invitedEmail: string
  status: string
  message: string | null
  expiresAt: string
  createdAt: string
  role: { id: string; name: string }
  company: { id: string; name: string }
  invitedBy: { id: string; fullName: string }
}

export interface AuditLogPublic {
  id: string
  action: string
  entityType: string
  entityId: string | null
  createdAt: string
  metadata: Record<string, unknown>
  newValues: Record<string, unknown> | null
  oldValues: Record<string, unknown> | null
  user: { id: string; fullName: string; email: string } | null
}

export interface SessionResponse {
  user: UserPublic | null
  activeCompany: CompanyPublic | null
  companies: CompanyPublic[]
  employee?: {
    id: string
    roleTier: string
    roleName: string
    systemRoleKey: string | null
    permissions: string[]
    isElevated: boolean
    ordersDataScope: 'own' | 'all'
  } | null
  sessionToken?: string
}

/** Result type for API responses. */
export interface ApiResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}
