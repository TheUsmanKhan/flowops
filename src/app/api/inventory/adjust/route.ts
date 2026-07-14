import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/permissions'
import { processInventoryTransaction } from '@/lib/inventory'
import { adjustStockSchema } from '@/lib/validations/inventory'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Manual stock adjustment (positive or negative).
 * Uses cycle_count_adjust txn type with reference_type = 'manual'.
 * Negative quantity removes stock, positive adds stock.
 */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({
      where: { userId: user.id },
      include: { activeCompany: true },
    })
    const orgId = settings?.activeOrgId
    const company = settings?.activeCompany
    if (!orgId || !company) throw new ApiError(403, 'No active company')

    const caller = await db.employee.findFirst({
      where: { companyId: company.id, userId: user.id, status: 'active' },
      include: { role: true },
    })
    if (!caller) throw new ApiError(403, 'Not a member of this company.')
    const allowed =
      caller.role.roleTier === 'elevated' ||
      (await db.rolePermission.count({
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_ADJUST },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to adjust stock.')

    const body = await readBody(req)
    const parsed = adjustStockSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    const d = parsed.data

    // For negative adjustments, the quantity passed to processInventoryTransaction
    // should be the absolute value (the function handles direction by type)
    // We use cycle_count_adjust which sets on_hand directly when positive
    // For negative, we need to use a write-off type
    const isPositive = d.quantity > 0
    const absQty = Math.abs(d.quantity)

    if (isPositive) {
      // Adding stock — use cycle_count_adjust (sets on_hand)
      const txnResult = await processInventoryTransaction({
        orgVariantId: d.org_variant_id,
        locationId: d.location_id,
        organizationId: orgId,
        companyId: company.id,
        employeeId: caller.id,
        transactionType: 'cycle_count_adjust',
        quantity: absQty,
        referenceType: 'manual',
        notes: `Manual adjustment: ${d.reason}. ${d.notes || ''}`,
      })
      if (!txnResult.success) {
        throw new ApiError(500, `Adjustment failed: ${txnResult.error}`)
      }

      await insertAuditLog({
        action: 'stock.adjusted',
        entityType: 'variant',
        entityId: d.org_variant_id,
        companyId: company.id,
        organizationId: orgId,
        userId: user.id,
        employeeId: caller.id,
        newValues: { adjustment: d.quantity, reason: d.reason, locationId: d.location_id },
      })

      return Response.json({ success: true, transaction_id: txnResult.transactionId })
    } else {
      // Removing stock — use damage_writeoff as a generic removal type
      const txnResult = await processInventoryTransaction({
        orgVariantId: d.org_variant_id,
        locationId: d.location_id,
        organizationId: orgId,
        companyId: company.id,
        employeeId: caller.id,
        transactionType: 'damage_writeoff',
        quantity: absQty,
        referenceType: 'manual',
        notes: `Manual adjustment: ${d.reason}. ${d.notes || ''}`,
      })
      if (!txnResult.success) {
        throw new ApiError(500, `Adjustment failed: ${txnResult.error}`)
      }

      await insertAuditLog({
        action: 'stock.adjusted',
        entityType: 'variant',
        entityId: d.org_variant_id,
        companyId: company.id,
        organizationId: orgId,
        userId: user.id,
        employeeId: caller.id,
        newValues: { adjustment: d.quantity, reason: d.reason, locationId: d.location_id },
      })

      return Response.json({ success: true, transaction_id: txnResult.transactionId })
    }
  } catch (err) {
    return handleError(err)
  }
}
