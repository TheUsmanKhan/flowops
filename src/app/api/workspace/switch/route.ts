import { getCurrentUser } from '@/lib/session'
import { db } from '@/lib/db'
import { ApiError, handleError, readBody, invalidateWorkspaceCache } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Switch the user's active company.
 *
 * PERFORMANCE: The old implementation called buildSessionPayload() which
 * re-queried ALL companies, ALL roles, and ALL permissions for the user
 * (7-9 sequential queries). This version returns ONLY the minimal data
 * the client needs to update its store: the active company + the caller's
 * employee/role/permissions in that company. Down to 2 parallel queries.
 */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const { companyId } = await readBody<{ companyId?: string }>(req)
    if (!companyId) throw new ApiError(400, 'companyId is required')

    // Single query: employee + role + rolePermissions + company — all the
    // data we need to validate the switch AND build the response.
    const employee = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: {
        role: { include: { rolePermissions: { select: { permissionKey: true } } } },
        company: true,
      },
    })
    if (!employee) {
      throw new ApiError(403, 'You are not a member of that company.')
    }
    if (!employee.company || !employee.company.isActive) {
      throw new ApiError(403, 'Company unavailable.')
    }

    // Update the active workspace + audit log in parallel (independent writes).
    await Promise.all([
      db.userSetting.update({
        where: { userId: user.id },
        data: {
          activeCompanyId: companyId,
          activeOrgId: employee.company.organizationId,
        },
      }),
      insertAuditLog({
        action: 'workspace.switched',
        entityType: 'company',
        entityId: companyId,
        companyId,
        organizationId: employee.company.organizationId,
        userId: user.id,
        employeeId: employee.id,
        newValues: { companyId, organizationId: employee.company.organizationId },
      }),
    ])

    // Invalidate the cached workspace so the next getWorkspace() call
    // reflects the new active company (not the old one).
    invalidateWorkspaceCache(user.id)

    // Return only the minimal data the client needs — no full session rebuild.
    const c = employee.company
    return Response.json({
      activeCompany: {
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
      },
      employee: {
        id: employee.id,
        roleTier: employee.role.roleTier,
        roleName: employee.role.name,
        systemRoleKey: employee.role.systemRoleKey,
        permissions: employee.role.rolePermissions.map((p) => p.permissionKey),
        isElevated: employee.role.roleTier === 'elevated',
      },
    })
  } catch (err) {
    return handleError(err)
  }
}

export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const payload = await db.employee.findMany({
      where: { userId: user.id, status: 'active' },
      select: {
        companyId: true,
        company: { select: { id: true, name: true, slug: true, logoUrl: true, baseCurrency: true, countryCode: true } },
      },
    })
    return Response.json({
      companies: payload
        .filter((e) => e.company)
        .map((e) => e.company),
    })
  } catch (err) {
    return handleError(err)
  }
}
