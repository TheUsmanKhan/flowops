import { db } from '@/lib/db'
import { getWorkspace, requirePermission, ApiError, handleError } from '@/lib/workspace'
import { PERMISSIONS } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Stock loss stats for the losses dashboard header. */
export async function GET() {
  try {
    const ctx = await getWorkspace()
    await requirePermission(ctx, PERMISSIONS.INVENTORY_VIEW)

    const companyId = ctx.company.id

    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

    const allRecords = await db.stockLossRecord.findMany({
      where: { companyId, createdAt: { gte: startOfMonth } },
      select: { lossType: true, quantity: true, costPerUnit: true, investigationStatus: true, resolution: true, courierClaimStatus: true },
    })

    const stats = {
      damaged: { count: 0, value: 0, quantity: 0 },
      theft: { count: 0, value: 0, quantity: 0 },
      missing: { count: 0, value: 0, quantity: 0 },
      transit_loss: { count: 0, value: 0, quantity: 0 },
      supplier_dispute: { count: 0, value: 0, quantity: 0 },
    }

    for (const r of allRecords) {
      const key = r.lossType as keyof typeof stats
      if (stats[key]) {
        stats[key].count++
        stats[key].quantity += r.quantity
        stats[key].value += r.quantity * Number(r.costPerUnit)
      }
    }

    const activeInvestigations = await db.stockLossRecord.count({
      where: { companyId, investigationStatus: 'open' },
    })

    const pendingCourierClaims = await db.stockLossRecord.count({
      where: {
        companyId,
        lossType: 'transit_loss',
        resolution: null,
      },
    })

    return Response.json({ stats, activeInvestigations, pendingCourierClaims })
  } catch (err) {
    return handleError(err)
  }
}
