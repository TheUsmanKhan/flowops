import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError, readBody } from '@/lib/workspace'
import { insertAuditLog } from '@/lib/audit'
import { insertMetricEvent } from '@/lib/metrics'
import { PERMISSIONS } from '@/lib/permissions'
import { quarantineStock } from '@/lib/inventory'
import { reportTheftLossSchema } from '@/lib/validations/stock-loss'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Report THEFT — two-stage, quarantine at report time.
 * Does NOT call processInventoryTransaction — only increments reserved (quarantine).
 * investigation_status = 'open', no financial impact until resolution.
 */
export async function POST(req: Request) {
  try {
    const idempotencyKey = req.headers.get('Idempotency-Key')

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
        where: { roleId: caller.roleId, permissionKey: PERMISSIONS.INVENTORY_REPORT_LOSS },
      })) > 0
    if (!allowed) throw new ApiError(403, 'You lack permission to report stock loss.')

    const body = await readBody(req)
    const parsed = reportTheftLossSchema.safeParse(body)
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? 'Invalid input')
    const d = parsed.data

    // Core creation logic — wrapped in a closure so it can be run either
    // directly (no idempotency key, backwards-compatible) or via
    // withIdempotency() (prevents duplicate theft reports).
    const createTheftLoss = async () => {
      // Fetch current avg_cost for cost recording
      const pool = await db.inventoryPool.findUnique({
        where: { orgVariantId_locationId: { orgVariantId: d.org_variant_id, locationId: d.location_id } },
      })
      if (!pool) throw new ApiError(404, 'No inventory at this location for this variant.')
      const avgCost = Number(pool.avgCost)

      // Quarantine the stock (increase reserved, no transaction)
      const quarantineResult = await quarantineStock(d.org_variant_id, d.location_id, d.quantity)
      if (!quarantineResult.success) {
        throw new ApiError(400, quarantineResult.error || 'Failed to quarantine stock.')
      }

      const lossRecord = await db.stockLossRecord.create({
        data: {
          organizationId: orgId,
          companyId: company.id,
          orgVariantId: d.org_variant_id,
          locationId: d.location_id,
          lossType: 'theft',
          subType: d.sub_type,
          quantity: d.quantity,
          costPerUnit: avgCost,
          investigationStatus: 'open',
          resolution: null,
          responsibleParty: 'unknown',
          policeReportRef: d.police_report_ref || null,
          evidenceUrls: JSON.stringify(d.evidence_urls),
          notes: d.notes || null,
          reportedById: caller.id,
        },
      })

      insertAuditLog({
        action: 'stock_loss.theft_reported',
        entityType: 'stock_loss',
        entityId: lossRecord.id,
        companyId: company.id,
        organizationId: orgId,
        userId: user.id,
        employeeId: caller.id,
        newValues: { quantity: d.quantity, subType: d.sub_type, quarantined: true },
      })

      insertMetricEvent({
        companyId: company.id,
        entityType: 'product',
        entityId: d.org_variant_id,
        metricKey: 'inventory.theft_loss',
        numericValue: d.quantity * avgCost,
        dimensions: {
          loss_type: 'theft',
          sub_type: d.sub_type,
          location_id: d.location_id,
          investigation_status: 'open',
          quantity: d.quantity,
        },
      })

      return { success: true, loss_record_id: lossRecord.id }
    }

    if (idempotencyKey) {
      const { withIdempotency } = await import('@/lib/idempotency')
      const { result, wasReplay } = await withIdempotency({
        key: idempotencyKey,
        companyId: company.id,
        employeeId: caller.id,
        actionType: 'stock_loss.theft',
        fn: createTheftLoss,
      })
      return Response.json(result, { status: wasReplay ? 200 : 201 })
    }

    // No idempotency key — normal flow (backwards-compatible)
    const result = await createTheftLoss()
    return Response.json(result)
  } catch (err) {
    return handleError(err)
  }
}
