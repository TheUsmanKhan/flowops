import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Update/resolve a stock loss record.
 * Can approve, update investigation status, set resolution, add claim references.
 */
export async function PATCH(
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

    const { id } = await params
    const record = await db.stockLossRecord.findFirst({ where: { id, companyId } })
    if (!record) throw new ApiError(404, 'Stock loss record not found.')

    const caller = await db.employee.findFirst({
      where: { companyId, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')

    const body = await readBody<{
      investigation_status?: string
      resolution?: string
      responsible_party?: string
      police_report_ref?: string
      insurance_claim_ref?: string
      insurance_recovered?: number
      courier_claim_ref?: string
      courier_claim_status?: string
      courier_recovered?: number
      notes?: string
      approved?: boolean
    }>(req)

    // If approving: require manage_loss permission
    if (body.approved) {
      const canApprove =
        caller.role.roleTier === 'elevated' ||
        (await db.rolePermission.count({
          where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_MANAGE_LOSS },
        })) > 0
      if (!canApprove) throw new ApiError(403, 'You lack permission to approve stock loss records.')
    }
    // If updating investigation/resolution: require report_loss or manage_loss
    const canUpdate =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: {
          roleId: caller.roleId,
          permissionKey: { in: [PERMISSIONS.INVENTORY_REPORT_LOSS, PERMISSIONS.INVENTORY_MANAGE_LOSS] },
        },
      })) > 0
    if (!canUpdate) throw new ApiError(403, 'You lack permission to update stock loss records.')

    const oldValues = {
      investigationStatus: record.investigationStatus,
      resolution: record.resolution,
      responsibleParty: record.responsibleParty,
    }

    const updateData: Record<string, unknown> = {}
    if (body.investigation_status !== undefined) updateData.investigationStatus = body.investigation_status
    if (body.resolution !== undefined) updateData.resolution = body.resolution
    if (body.responsible_party !== undefined) updateData.responsibleParty = body.responsible_party || null
    if (body.police_report_ref !== undefined) updateData.policeReportRef = body.police_report_ref || null
    if (body.insurance_claim_ref !== undefined) updateData.insuranceClaimRef = body.insurance_claim_ref || null
    if (body.insurance_recovered !== undefined) updateData.insuranceRecovered = body.insurance_recovered
    if (body.courier_claim_ref !== undefined) updateData.courierClaimRef = body.courier_claim_ref || null
    if (body.courier_claim_status !== undefined) updateData.courierClaimStatus = body.courier_claim_status
    if (body.courier_recovered !== undefined) updateData.courierRecovered = body.courier_recovered
    if (body.notes !== undefined) updateData.notes = body.notes
    if (body.approved) {
      updateData.approvedById = caller.id
      updateData.resolvedById = caller.id
      updateData.resolvedAt = new Date()
    }

    const updated = await db.stockLossRecord.update({
      where: { id },
      data: updateData,
    })

    await insertAuditLog({
      action: 'stock_loss.updated',
      entityType: 'stock_loss',
      entityId: id,
      companyId,
      organizationId: orgId,
      userId: user.id,
      employeeId: caller.id,
      oldValues,
      newValues: body,
    })

    return Response.json({ id: updated.id })
  } catch (err) {
    return handleError(err)
  }
}
