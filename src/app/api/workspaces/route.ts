import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Fetch all workspaces for the current user, grouped by organization.
 *
 * PERFORMANCE: This uses a SINGLE database query with nested includes to
 * fetch employees + companies + organizations + active-employee counts +
 * role in one round-trip. The previous implementation did an N+1 (one
 * extra query per org), which was the main cause of slow switcher load.
 */
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')

    // Single query: employees → company → organization, plus role + counts.
    // This replaces the old N+1 loop with one round-trip to Supabase.
    const [settings, employees] = await Promise.all([
      db.userSetting.findUnique({ where: { userId: user.id } }),
      db.employee.findMany({
        where: { userId: user.id, status: 'active' },
        include: {
          role: { select: { id: true, name: true, roleTier: true } },
          company: {
            include: {
              organization: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                  logoUrl: true,
                  ownerId: true,
                  isActive: true,
                },
              },
              _count: {
                select: { employees: { where: { status: 'active' } } },
              },
            },
          },
        },
        orderBy: { joinedAt: 'asc' },
      }),
    ])

    const activeCompanyId = settings?.activeCompanyId

    // Group companies by organization — in memory, no extra queries.
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

    for (const emp of employees) {
      const company = emp.company
      if (!company || !company.isActive) continue
      const org = company.organization
      if (!org || !org.isActive) continue

      const isOwner = org.ownerId === user.id
      let group = orgMap.get(org.id)
      if (!group) {
        group = {
          org_id: org.id,
          org_name: org.name,
          org_logo_url: org.logoUrl,
          org_slug: org.slug,
          is_owner: isOwner,
          companies: [],
        }
        orgMap.set(org.id, group)
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
        is_active_workspace: activeCompanyId === company.id,
      })
    }

    // Sort: owned orgs first (alphabetical), then invited.
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
