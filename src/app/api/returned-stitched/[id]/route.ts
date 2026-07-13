import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { markSoldSchema, writeOffSchema } from '@/lib/validations/product'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Mark a returned item as sold or written off.
 * Action determined by the `action` field in the body: 'sold' | 'write_off'.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const companyId = settings?.activeCompanyId
    const orgId = settings?.activeOrgId
    if (!companyId || !orgId) throw new ApiError(403, 'No active company')

    const { id: recordId } = await params
    const record = await db.returnedStitchedInventory.findFirst({
      where: { id: recordId, companyId },
    })
    if (!record) throw new ApiError(404, 'Returned item not found.')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')

    const body = await readBody<{ action?: string }>(req)
    const action = body.action

    if (action === 'sold') {
      // Permission: inventory.manage_loss or elevated
      const allowed =
        caller.role.roleTier === 'elevated' ||
        (await db.rolePermission.count({
          where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_MANAGE_LOSS },
        })) > 0
      if (!allowed) throw new ApiError(403, 'You lack permission to mark items as sold.')

      const parsed = markSoldSchema.safeParse(body)
      if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')

      if (record.status !== 'available') {
        throw new ApiError(400, `Item is not available (status: ${record.status}).`)
      }

      await db.returnedStitchedInventory.update({
        where: { id: recordId },
        data: {
          status: 'sold',
          soldAt: new Date(),
          soldOrderReference: parsed.data.sold_order_reference,
        },
      })

      await insertAuditLog({
        action: 'returned_stitched.sold',
        entityType: 'returned_stitched',
        entityId: recordId,
        companyId,
        organizationId: orgId,
        userId: user.id,
        employeeId: caller.id,
        newValues: { soldOrderReference: parsed.data.sold_order_reference },
      })

      return Response.json({ success: true, status: 'sold' })
    } else if (action === 'write_off') {
      // Permission: inventory.manage_loss or elevated
      const allowed =
        caller.role.roleTier === 'elevated' ||
        (await db.rolePermission.count({
          where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_MANAGE_LOSS },
        })) > 0
      if (!allowed) throw new ApiError(403, 'You lack permission to write off items.')

      const parsed = writeOffSchema.safeParse(body)
      if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')

      if (record.status !== 'available') {
        throw new ApiError(400, `Item is not available (status: ${record.status}).`)
      }

      await db.returnedStitchedInventory.update({
        where: { id: recordId },
        data: {
          status: 'written_off',
          writtenOffAt: new Date(),
          writtenOffById: caller.id,
          writeOffReason: parsed.data.reason,
        },
      })

      await insertAuditLog({
        action: 'returned_stitched.written_off',
        entityType: 'returned_stitched',
        entityId: recordId,
        companyId,
        organizationId: orgId,
        userId: user.id,
        employeeId: caller.id,
        newValues: { reason: parsed.data.reason },
      })

      return Response.json({ success: true, status: 'written_off' })
    } else {
      throw new ApiError(400, "Action must be 'sold' or 'write_off'.")
    }
  } catch (err) {
    return handleError(err)
  }
}
