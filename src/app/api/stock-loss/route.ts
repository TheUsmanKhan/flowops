import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/session'
import { ApiError, handleError } from '@/lib/workspace'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * List stock loss records for the active company.
 * Supports filtering by: loss_type, investigation_status, location_id.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) throw new ApiError(401, 'Not authenticated')
    const settings = await db.userSetting.findUnique({ where: { userId: user.id } })
    const companyId = settings?.activeCompanyId
    if (!companyId) throw new ApiError(403, 'No active company')

    const url = new URL(req.url)
    const lossType = url.searchParams.get('loss_type') ?? ''
    const investigationStatus = url.searchParams.get('investigation_status') ?? ''

    const records = await db.stockLossRecord.findMany({
      where: {
        companyId,
        ...(lossType ? { lossType } : {}),
        ...(investigationStatus ? { investigationStatus } : {}),
      },
      include: {
        orgVariant: { select: { sku: true, product: { select: { title: true } } } },
        location: { select: { name: true } },
        reportedBy: { select: { user: { select: { fullName: true } } } },
        supplierReturn: { select: { id: true, supplier: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    return Response.json({
      records: records.map((r) => ({
        id: r.id,
        productTitle: r.orgVariant.product.title,
        sku: r.orgVariant.sku,
        location: r.location.name,
        lossType: r.lossType,
        subType: r.subType,
        damageType: r.damageType,
        quantity: r.quantity,
        costPerUnit: Number(r.costPerUnit),
        totalLossValue: Number(r.costPerUnit) * r.quantity,
        investigationStatus: r.investigationStatus,
        resolution: r.resolution,
        responsibleParty: r.responsibleParty,
        courierClaimStatus: r.courierClaimStatus,
        courierRecovered: Number(r.courierRecovered),
        inventoryTxnId: r.inventoryTxnId,
        supplierReturnId: r.supplierReturnId,
        supplierReturn: r.supplierReturn
          ? { id: r.supplierReturn.id, supplierName: r.supplierReturn.supplier.name }
          : null,
        reportedBy: r.reportedBy.user.fullName,
        createdAt: r.createdAt.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
      })),
    })
  } catch (err) {
    return handleError(err)
  }
}
