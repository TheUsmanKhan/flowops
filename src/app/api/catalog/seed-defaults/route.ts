import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { seedDefaultAttributes } from '@/lib/attribute-seeding'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** One-time endpoint to seed default attributes for an existing org that was created before seeding was added. */
export async function POST() {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const orgId = settings?.activeOrgId
    if (!orgId) throw new ApiError(403, 'No active organization')

    const caller = await db.employee.findFirst({
      where: { companyId: settings!.activeCompanyId!, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    if (caller.role.roleTier !== 'elevated') {
      throw new ApiError(403, 'Only elevated employees can seed default attributes.')
    }

    // Check if attributes already exist
    const existingCount = await db.orgAttribute.count({ where: { organizationId: orgId } })
    if (existingCount > 0) {
      return Response.json({ error: 'Attributes already exist for this organization. Use Catalog Settings to manage them.' }, { status: 409 })
    }

    await seedDefaultAttributes(orgId, caller.id)
    return Response.json({ success: true, message: 'Default attributes seeded: Piece Type, Size, Color, Fabric + Unstitched→One Size rule.' })
  } catch (err) {
    return handleError(err)
  }
}
