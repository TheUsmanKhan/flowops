import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Fetch all workspaces for the current user, grouped by organization.
 * Returns the structure used by the WorkspaceSwitcher:
 *
 *   workspaces: [
 *     { org_id, org_name, org_logo_url, org_slug, is_owner, companies: [...] }
 *   ]
 *
 * Companies where the user is NOT an owner of the parent org (i.e. they were
 * invited as an employee) are grouped under a synthetic "OTHER COMPANIES"
 * org so the switcher can render them separately.
 */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')

    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
    })

    const employees = await db.employee.findMany({
      where: { userId: user.id, status: 'active' },
      include: {
        company: { include: { _count: { select: { employees: { where: { status: 'active' } } } } } },
        role: { select: { id: true, name: true, roleTier: true } },
      },
    })

    // Group companies by their organization.
    const orgMap = new Map<
      string,
      {
        org_id: string
        org_name: string
        org_logo_url: string | null
        org_slug: string
        is_owner: boolean
        companies: Array<{
          company_id: string
          company_name: string
          company_logo_url: string | null
          company_slug: string
          base_currency: string
          role_name: string
          role_tier: string
          employee_count: number
          is_active_workspace: boolean
        }>
      }
    >()

    // Cache org lookups (including owner check).
    const orgCache = new Map<
      string,
      { name: string; slug: string; logoUrl: string | null; ownerId: string }
    >()

    for (const emp of employees) {
      const company = emp.company
      if (!company || !company.isActive) continue

      let org = orgCache.get(company.organizationId)
      if (!org) {
        const orgRow = await db.organization.findUnique({
          where: { id: company.organizationId },
          select: { id: true, name: true, slug: true, logoUrl: true, ownerId: true, isActive: true },
        })
        if (!orgRow || !orgRow.isActive) continue
        org = {
          name: orgRow.name,
          slug: orgRow.slug,
          logoUrl: orgRow.logoUrl,
          ownerId: orgRow.ownerId,
        }
        orgCache.set(company.organizationId, org)
      }

      const isOwner = org.ownerId === user.id
      let group = orgMap.get(company.organizationId)
      if (!group) {
        group = {
          org_id: company.organizationId,
          org_name: org.name,
          org_logo_url: org.logoUrl,
          org_slug: org.slug,
          is_owner: isOwner,
          companies: [],
        }
        orgMap.set(company.organizationId, group)
      }

      group.companies.push({
        company_id: company.id,
        company_name: company.name,
        company_logo_url: company.logoUrl,
        company_slug: company.slug,
        base_currency: company.baseCurrency,
        role_name: emp.role.name,
        role_tier: emp.role.roleTier,
        employee_count: company._count.employees,
        is_active_workspace: settings?.activeCompanyId === company.id,
      })
    }

    // Sort: owned orgs first (alphabetical), then invited companies.
    const owned = Array.from(orgMap.values())
      .filter((g) => g.is_owner)
      .sort((a, b) => a.org_name.localeCompare(b.org_name))
    const invited = Array.from(orgMap.values())
      .filter((g) => !g.is_owner)
      .sort((a, b) => a.org_name.localeCompare(b.org_name))

    return Response.json({ workspaces: [...owned, ...invited] })
  } catch (err) {
    return handleError(err)
  }
}
